import { rmSync } from 'fs'
import { resolve } from 'path'
import { IdentityCategory, IdentityStatus, Prisma } from '@prisma/client'
import { prismaClient } from '../../src/application/database'
import { UserWithRelations } from '../../src/type/user-request'
import { dateOnly, jakartaWallTimeToUtc, setNowForTests } from '../../src/utils/clock'
import { signAccessToken, TokenAudience } from '../../src/utils/jwt'
import { waitForPendingMail } from '../../src/utils/mailer'
import { randomAlphanumeric } from '../../src/utils/random'

// ===== Fixture test domain booking =====
// Setiap test membuat fasilitas dan pelanggannya SENDIRI, jadi test dalam satu berkas tidak saling
// mengganggu tanpa perlu mengosongkan database di antara test (TRUNCATE ~40 tabel per test terlalu
// lambat). Pengosongan penuh hanya sekali per berkas, di beforeAll.

let sequence = 0
const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++sequence}`

/** Senin 5 Oktober 2026 08:00 WIB. Semua test berjalan pada jam beku ini kecuali memajukannya sendiri. */
export const FROZEN_NOW = jakartaWallTimeToUtc('2026-10-05', '08:00')

export function freezeAt(dateStr: string, hm: string): void {
  setNowForTests(jakartaWallTimeToUtc(dateStr, hm))
}

/**
 * Kosongkan seluruh tabel database test. TRUNCATE lewat raw SQL di sini disengaja dan aman: nama
 * database sudah dijaga berakhiran _test (tests/test-database.ts), dan larangan raw DELETE (R2) menjaga
 * kode aplikasi, bukan pembersihan database sekali pakai.
 */
export async function resetDatabase(): Promise<void> {
  const [{ name }] = await prismaClient.$queryRaw<Array<{ name: string }>>`SELECT DATABASE() AS name`
  if (!name.endsWith('_test')) throw new Error(`Menolak mengosongkan database "${name}"`)

  const tables = await prismaClient.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`
  for (const table of tables) await prismaClient.$executeRawUnsafe(`TRUNCATE TABLE \`${table.name}\``)

  rmSync(resolve(process.cwd(), process.env.PRIVATE_STORAGE_DIR as string), { recursive: true, force: true })
}

export async function closeDatabase(): Promise<void> {
  setNowForTests(null)
  // Email keputusan pembayaran dikirim `void` setelah commit; tunggu dulu, kalau tidak kiriman itu
  // menabrak $disconnect, Prisma membuka pool baru, dan Jest tidak pernah keluar.
  await waitForPendingMail(10_000)
  await prismaClient.$disconnect()
}

// ===== Akun =====

interface CustomerOptions {
  verified?: boolean
  identityCategory?: IdentityCategory | null
  identityStatus?: IdentityStatus
}

export async function createCustomer(options: CustomerOptions = {}): Promise<UserWithRelations> {
  return prismaClient.user.create({
    data: {
      name: 'Pelanggan Uji',
      email: `${unique('pelanggan')}@test.ubsc.id`,
      emailVerifiedAt: options.verified === false ? null : new Date(),
      phoneNumber: '081234567890',
      identityCategory: options.identityCategory ?? null,
      identityStatus: options.identityStatus ?? 'unverified'
    },
    include: { role: true }
  })
}

export async function createStaff(roleName: string): Promise<UserWithRelations> {
  const role = await prismaClient.role.upsert({ where: { name: roleName }, update: {}, create: { name: roleName } })
  return prismaClient.user.create({
    data: { name: `Staff ${roleName}`, email: `${unique('staff')}@test.ubsc.id`, emailVerifiedAt: new Date(), roleId: role.id },
    include: { role: true }
  })
}

export function bearer(user: UserWithRelations, audience: TokenAudience): string {
  return `Bearer ${signAccessToken({ userId: user.id, role: user.role?.name ?? null }, audience)}`
}

// ===== Pengaturan & jadwal =====

export async function configurePayments(holdMinutes = 120): Promise<void> {
  const settings: Record<string, string> = {
    payment_bank_name: 'BCA',
    payment_bank_account_number: '1234567890',
    payment_bank_account_holder: 'UB Sport Center (UJI)',
    payment_hold_minutes: String(holdMinutes)
  }
  for (const [key, value] of Object.entries(settings)) {
    await prismaClient.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
  }
}

export async function openMonth(year: number, month: number, closedDates: string[] = [], isOpen = true): Promise<void> {
  await prismaClient.bookingSchedule.upsert({
    where: { month_year: { month, year } },
    update: { isOpen, closedDates },
    create: { month, year, isOpen, closedDates }
  })
}

// ===== Fasilitas =====

interface FacilityOptions {
  mode?: 'court' | 'class'
  capacity?: number
  /** Harga per sesi kategori umum (label Reguler). */
  price?: number
  /** Harga per sesi kategori warga_ub; default sama dengan price. */
  wargaPrice?: number
  durationMinutes?: number
  /** null = belum ada jadwal mingguan (grid 06:00-22:00). */
  activeSlots?: Record<string, string[]> | null
  /** Harga paket sebulan kategori umum. */
  packagePrice?: number
  isActive?: boolean
  units?: Array<{ name?: string; capacity?: number; isActive?: boolean }>
}

export async function createFacility(options: FacilityOptions = {}) {
  const category = await prismaClient.facilityCategory.upsert({
    where: { slug: 'kategori-uji' },
    update: {},
    create: { name: 'Kategori Uji', slug: 'kategori-uji' }
  })
  const price = options.price ?? 100_000
  const duration = options.durationMinutes ?? 60

  const prices: Prisma.FacilityPriceCreateWithoutFacilityInput[] = [
    { userCategory: 'umum', label: 'Reguler', price, durationMinutes: duration },
    { userCategory: 'warga_ub', label: 'Reguler', price: options.wargaPrice ?? price, durationMinutes: duration }
  ]
  if (options.packagePrice) {
    prices.push({
      userCategory: 'umum',
      priceType: 'monthly_package',
      label: 'Paket Bulanan',
      price: options.packagePrice,
      durationMinutes: duration
    })
  }

  const name = unique('Fasilitas Uji')
  return prismaClient.facility.create({
    data: {
      facilityCategoryId: category.id,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      capacity: options.capacity ?? 1,
      bookingMode: options.mode ?? 'court',
      activeSlots: options.activeSlots === undefined || options.activeSlots === null ? Prisma.DbNull : options.activeSlots,
      isActive: options.isActive ?? true,
      prices: { create: prices },
      units: options.units
        ? { create: options.units.map((u, i) => ({ name: u.name ?? `Unit ${i + 1}`, capacity: u.capacity ?? 1, isActive: u.isActive ?? true })) }
        : undefined
    },
    include: { units: { orderBy: { name: 'asc' } } }
  })
}

// ===== Booking langsung (di luar alur POST) =====

interface DirectBookingOptions {
  facilityId: string
  facilityUnitId?: string | null
  userId?: string | null
  date: string
  startTime: string
  endTime: string
  status?: 'pending' | 'confirmed' | 'cancelled' | 'completed'
  holdExpiresAt?: Date | null
  pax?: number
}

/** Booking yang ditanam langsung — mewakili booking staff, booking lama, atau hold milik orang lain. */
export async function insertBooking(options: DirectBookingOptions) {
  return prismaClient.booking.create({
    data: {
      facilityId: options.facilityId,
      facilityUnitId: options.facilityUnitId ?? null,
      userId: options.userId ?? null,
      customerName: 'Tamu Uji',
      bookingDate: dateOnly(options.date),
      startTime: options.startTime,
      endTime: options.endTime,
      startsAt: jakartaWallTimeToUtc(options.date, options.startTime),
      endsAt: jakartaWallTimeToUtc(options.date, options.endTime),
      pax: options.pax ?? 1,
      subtotalPrice: 100_000,
      status: options.status ?? 'confirmed',
      holdExpiresAt: options.holdExpiresAt ?? null,
      checkInToken: randomAlphanumeric(32)
    }
  })
}

// ===== Hasil konkuren =====

export async function settle<T>(tasks: Array<Promise<T>>): Promise<{ fulfilled: T[]; rejected: unknown[] }> {
  const results = await Promise.allSettled(tasks)
  const fulfilled: T[] = []
  const rejected: unknown[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value as T)
    else rejected.push(result.reason)
  }
  return { fulfilled, rejected }
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
