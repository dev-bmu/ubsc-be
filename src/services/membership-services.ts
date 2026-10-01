import { Prisma, UserCategory } from '@prisma/client'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { addDays, addMonths, dateOnly, dateOnlyToString, jakartaDate } from '../utils/clock'
import { receiptNumber } from '../utils/money'
import { withConflictRetry } from '../utils/prisma-errors'
import { openTransfer, recordFreeTransaction } from './manual-payment-services'
import { membershipPriceFor, membershipTariffCategory, priceCategoryFor } from './pricing-services'

// ============================================================================
// === MembershipLifecycleService — port dari app/Services ===
// ============================================================================
// Membership meja depan dibuat pending_payment dengan transfer terbuka (harga + biaya admin + kode unik)
// sejak catatan client 2026-09-28: sebelumnya langsung PAID, sehingga pelanggan tidak tahu harus
// membayar berapa dan FO tidak punya jejak apakah uangnya sudah masuk. Invoice-nya tampil di layar FO,
// dashboard pelanggan, dan email; FO menekan "Tandai Lunas" setelah mutasi cocok, atau pelanggan
// mengunggah bukti — keduanya lewat approve() → activatePendingMembership(). Nominal 0 tetap langsung
// aktif. Setiap perubahan dicatat ke membership_histories untuk audit.
//
// PENCEGAHAN OVERLAP — perbedaan penting dari Laravel:
// Laravel memakai `Membership::where(overlap)->lockForUpdate()->exists()`. Kalau BELUM ada baris yang
// cocok, tidak ada baris yang terkunci. Di Laravel itu tetap "selamat" hanya karena isolasi bawaan
// MySQL REPEATABLE READ mengambil gap lock pada rentang indeks, sehingga dua create bersamaan berakhir
// deadlock dan salah satunya gagal. Transaksi di sini memakai ReadCommitted (Rewrite.md) — di level
// itu gap lock TIDAK diambil dan dua membership tumpang tindih bisa sama-sama lolos.
// Solusinya: kunci baris `users` milik pelanggan (baris yang PASTI ada) sebelum mengecek. Semua
// operasi membership untuk satu pelanggan kini antre di belakang kunci itu, apa pun level isolasinya.

type Db = Prisma.TransactionClient

export interface CreateMembershipInput {
  userId?: string | null
  customerName?: string | null
  membershipPlanId?: string | null
  startDate: string
  endDate?: string | null
  amount?: number | null
  source?: string | null
  actorId?: string | null
}

export interface RenewMembershipInput {
  membershipPlanId?: string | null
  amount?: number | null
  source?: string | null
  actorId?: string | null
}

async function resolvePlan(tx: Db, planId: string | null | undefined) {
  if (!planId) return null
  const plan = await tx.membershipPlan.findUnique({ where: { id: planId } })
  if (!plan) throw new ResponseError(404, 'Paket membership tidak ditemukan')
  return plan
}

function resolveEndDate(startDate: string, plan: { durationMonths: number } | null, manualEndDate: string | null | undefined): string {
  if (plan) return addMonths(startDate, plan.durationMonths)
  if (!manualEndDate) {
    throw new ResponseError(422, 'Tanggal selesai wajib diisi jika tidak memilih paket.', 'VALIDATION_ERROR', {
      endDate: ['Tanggal selesai wajib diisi jika tidak memilih paket.']
    })
  }
  if (manualEndDate <= startDate) {
    throw new ResponseError(422, 'Tanggal selesai harus setelah tanggal mulai.', 'VALIDATION_ERROR', {
      endDate: ['Tanggal selesai harus setelah tanggal mulai.']
    })
  }
  return manualEndDate
}

function resolveAmount(
  plan: { price: number; wargaPrice: number | null } | null,
  manualAmount: number | null | undefined,
  category: UserCategory
): number {
  if (plan) return membershipPriceFor(plan, category)
  return Math.max(0, Math.trunc(manualAmount ?? 0))
}

/** Kategori harga pemilik membership (tarif Warga UB butuh identitas terverifikasi). Tanpa akun = umum. */
async function categoryOf(tx: Db, userId: string | null | undefined): Promise<UserCategory> {
  if (!userId) return 'umum'
  return priceCategoryFor(await tx.user.findUnique({ where: { id: userId }, select: { identityCategory: true, identityStatus: true } }))
}

const OVERLAP_MESSAGE =
  'User ini masih memiliki membership aktif pada periode tersebut. Gunakan perpanjang atau upgrade agar masa aktif tidak bertabrakan.'

async function ensureNoOverlappingActiveMembership(
  tx: Db,
  userId: string | null | undefined,
  startDate: string,
  endDate: string,
  allowedPreviousId?: string,
  message = OVERLAP_MESSAGE
) {
  if (!userId) return

  // Kunci baris pelanggan — lihat catatan di atas berkas.
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`

  const overlap = await tx.membership.count({
    where: {
      userId,
      // pending_payment ikut menahan periodenya: tanpa itu satu orang bisa membeli membership yang
      // sama berkali-kali selama transfernya belum diverifikasi.
      status: { in: ['active', 'pending_payment'] },
      ...(allowedPreviousId ? { id: { not: allowedPreviousId } } : {}),
      startDate: { lte: dateOnly(endDate) },
      endDate: { gte: dateOnly(startDate) }
    }
  })

  if (overlap > 0) throw new ResponseError(422, message, 'VALIDATION_ERROR', { membership: [message] })
}

async function writeHistory(
  tx: Db,
  membershipId: string,
  transaction: { id: string; amount: number; paymentStatus: string; receiptSequence: number } | null,
  action: string,
  actorId: string | null | undefined,
  actorType: string
) {
  const m = await tx.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { membershipPlan: { select: { name: true } } } })
  await tx.membershipHistory.create({
    data: {
      membershipId: m.id,
      userId: m.userId,
      membershipPlanId: m.membershipPlanId,
      transactionId: transaction?.id ?? null,
      renewedFromMembershipId: m.renewedFromMembershipId,
      actorId: actorId ?? null,
      actorType,
      action,
      startDate: m.startDate,
      endDate: m.endDate,
      amount: transaction?.amount ?? null,
      paymentStatus: transaction?.paymentStatus ?? null,
      // Kunci snake_case dipertahankan — ini format data audit yang sama dengan Laravel.
      metadata: { plan_name: m.membershipPlan?.name ?? null, receipt_number: transaction ? receiptNumber(transaction.receiptSequence) : null }
    }
  })
}

/**
 * Transfer membership meja depan: nominal > 0 = transfer terbuka tanpa batas waktu (FO yang menandai
 * lunas atau membatalkan), membership menunggu pembayaran. Nominal 0 = langsung lunas dan aktif.
 */
async function openDeskTransfer(tx: Db, membershipId: string, userId: string | null, amount: number, tariff: UserCategory) {
  return amount > 0 ? openTransfer(tx, { membershipId }, userId, amount, null, tariff) : recordFreeTransaction(tx, { membershipId }, userId)
}

export async function createMembership(input: CreateMembershipInput) {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const plan = await resolvePlan(tx, input.membershipPlanId)
      const startDate = input.startDate
      const endDate = resolveEndDate(startDate, plan, input.endDate)
      const userId = input.userId ?? null
      const category = await categoryOf(tx, userId)
      const amount = resolveAmount(plan, input.amount, category)

      await ensureNoOverlappingActiveMembership(tx, userId, startDate, endDate)

      const membership = await tx.membership.create({
        data: {
          userId,
          customerName: input.customerName ?? null,
          membershipPlanId: plan?.id ?? null,
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
          status: amount > 0 ? 'pending_payment' : 'active',
          createdById: input.actorId ?? null,
          createdVia: input.source ?? 'admin'
        }
      })

      const transaction = await openDeskTransfer(tx, membership.id, userId, amount, membershipTariffCategory(plan, category))
      await writeHistory(tx, membership.id, transaction, 'created', input.actorId, input.source ?? 'admin')
      return membership
    }, TX_OPTIONS)
  )
}

export async function renewMembership(sourceMembershipId: string, input: RenewMembershipInput) {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memberships WHERE id = ${sourceMembershipId} FOR UPDATE`
      const source = await tx.membership.findUnique({ where: { id: sourceMembershipId } })
      if (!source) throw new ResponseError(404, 'Membership tidak ditemukan')
      if (source.status === 'cancelled') {
        const msg = 'Membership yang dibatalkan tidak dapat diperpanjang.'
        throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
      }
      if (source.status === 'pending_payment') {
        const msg = 'Membership yang belum dibayar tidak dapat diperpanjang.'
        throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
      }

      const plan = await resolvePlan(tx, input.membershipPlanId ?? source.membershipPlanId)
      const startDate = addDays(dateOnlyToString(source.endDate), 1)
      const endDate = resolveEndDate(startDate, plan, null)
      const category = await categoryOf(tx, source.userId)
      const amount = resolveAmount(plan, input.amount, category)

      await ensureNoOverlappingActiveMembership(tx, source.userId, startDate, endDate, source.id)

      const renewal = await tx.membership.create({
        data: {
          userId: source.userId,
          customerName: source.customerName,
          membershipPlanId: plan?.id ?? null,
          renewedFromMembershipId: source.id,
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
          status: amount > 0 ? 'pending_payment' : 'active',
          createdById: input.actorId ?? null,
          createdVia: input.source ?? 'admin'
        }
      })

      const transaction = await openDeskTransfer(tx, renewal.id, source.userId, amount, membershipTariffCategory(plan, category))
      await writeHistory(tx, renewal.id, transaction, 'renewed', input.actorId, input.source ?? 'admin')
      return renewal
    }, TX_OPTIONS)
  )
}

// ===== Checkout web (tahap C) =====

export interface MembershipCheckoutInput {
  userId: string
  customerName: string
  plan: { id: string; durationMonths: number }
  /** Harga sesuai kategori pembeli (membershipPriceFor), belum termasuk biaya admin dan kode unik. */
  amount: number
  /** Tarif yang menghasilkan amount (membershipTariffCategory) — nomor item Accurate. */
  priceCategory: UserCategory
  holdExpiresAt: Date
}

/** Membership aktif yang masih berjalan (berakhir hari ini atau nanti) — pembelian baru jadi perpanjangannya. */
export function currentActiveMembership(db: Pick<Db, 'membership'>, userId: string) {
  return db.membership.findFirst({
    where: { userId, status: 'active', endDate: { gte: dateOnly(jakartaDate()) } },
    orderBy: { endDate: 'desc' },
    select: { id: true, endDate: true }
  })
}

const CHECKOUT_OVERLAP_MESSAGE = 'Anda sudah punya membership aktif atau pembelian yang menunggu pembayaran untuk periode ini.'

/**
 * Pembelian membership lewat web: membership pending_payment + transfer ber-hold dalam satu
 * transaksi DB. Masih punya membership aktif = perpanjangan, dicatat mulai sehari setelah masa aktif
 * itu berakhir; selain itu mulai hari ini. Keduanya tanggal SEMENTARA — ditetapkan ulang saat
 * transfernya disetujui (activatePendingMembership). Satu paket per orang: periode bertumpuk ditolak.
 */
export async function openMembershipCheckout(input: MembershipCheckoutInput) {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      // Kunci dulu, baru baca membership yang berjalan: dua checkout bersamaan antre di baris ini.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`
      const current = await currentActiveMembership(tx, input.userId)
      const startDate = current ? addDays(dateOnlyToString(current.endDate), 1) : jakartaDate()
      const endDate = addMonths(startDate, input.plan.durationMonths)
      await ensureNoOverlappingActiveMembership(tx, input.userId, startDate, endDate, undefined, CHECKOUT_OVERLAP_MESSAGE)

      const membership = await tx.membership.create({
        data: {
          userId: input.userId,
          customerName: input.customerName,
          membershipPlanId: input.plan.id,
          renewedFromMembershipId: current?.id ?? null,
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
          status: 'pending_payment',
          createdVia: 'self'
        }
      })
      const transaction = await openTransfer(
        tx,
        { membershipId: membership.id },
        input.userId,
        input.amount,
        input.holdExpiresAt,
        input.priceCategory
      )
      await writeHistory(tx, membership.id, transaction, current ? 'renewed' : 'created', input.userId, 'self')
      return membership
    }, TX_OPTIONS)
  )
}

// ===== pending_payment: membership yang dibeli online (PRD tambahan 2026-09, 4.4) =====
// Dipanggil approve()/reject()/expire() di manual-payment-services, DI DALAM transaksi mereka dan
// setelah baris transaksi dikunci. Modul itu juga diimpor dari sini (openTransfer) — siklus impor ini
// aman karena hanya fungsi yang dipakai, dan ekspor fungsi TypeScript di-hoist sebelum require.

const DAY_MS = 24 * 60 * 60 * 1000

type TransactionForHistory = { id: string; amount: number; paymentStatus: string; receiptSequence: number } | null

function transactionForHistory(tx: Db, membershipId: string): Promise<TransactionForHistory> {
  return tx.transaction.findUnique({
    where: { membershipId },
    select: { id: true, amount: true, paymentStatus: true, receiptSequence: true }
  })
}

/**
 * Transfer disetujui: membership aktif, masa aktif mulai hari verifikasi (keputusan client #5).
 * Dua pengecualian supaya tidak ada hari yang hilang:
 *   - tidak pernah mundur dari tanggal mulai sementaranya — perpanjangan online yang dicatat mulai
 *     sehari setelah masa lama berakhir tetap mulai di sana;
 *   - digeser ke sehari setelah membership aktif lain yang bertumpuk, pola yang sama dengan renew.
 * No-op untuk status selain pending_payment.
 */
export async function activatePendingMembership(tx: Db, membershipId: string, actorId: string | null): Promise<void> {
  const m = await tx.membership.findUnique({ where: { id: membershipId }, include: { membershipPlan: { select: { durationMonths: true } } } })
  if (!m || m.status !== 'pending_payment') return

  // Urutan kunci sama dengan createMembership: baris users untuk semua operasi membership satu orang.
  if (m.userId) await tx.$queryRaw`SELECT id FROM users WHERE id = ${m.userId} FOR UPDATE`

  const provisionalStart = dateOnlyToString(m.startDate)
  const today = jakartaDate()
  let start = today > provisionalStart ? today : provisionalStart
  // Paket yang terhapus di antara checkout dan verifikasi: pertahankan panjang periode sementaranya.
  const spanDays = Math.round((m.endDate.getTime() - m.startDate.getTime()) / DAY_MS)
  const endFor = (from: string): string => (m.membershipPlan ? addMonths(from, m.membershipPlan.durationMonths) : addDays(from, spanDays))

  // Berhenti karena setiap putaran memindahkan start melewati ujung satu membership aktif.
  while (m.userId) {
    const clash = await tx.membership.findFirst({
      where: {
        userId: m.userId,
        status: 'active',
        id: { not: m.id },
        startDate: { lte: dateOnly(endFor(start)) },
        endDate: { gte: dateOnly(start) }
      },
      orderBy: { endDate: 'desc' },
      select: { endDate: true }
    })
    if (!clash) break
    start = addDays(dateOnlyToString(clash.endDate), 1)
  }

  await tx.membership.update({ where: { id: m.id }, data: { status: 'active', startDate: dateOnly(start), endDate: dateOnly(endFor(start)) } })
  await writeHistory(tx, m.id, await transactionForHistory(tx, m.id), 'activated', actorId, 'admin')
}

/**
 * Transfer kedaluwarsa atau ditolak: membership batal sehingga periodenya tidak lagi ditahan.
 * No-op untuk status selain pending_payment. actorId null = sweep otomatis.
 */
export async function lapsePendingMembership(
  tx: Db,
  membershipId: string,
  action: 'payment_expired' | 'payment_rejected',
  actorId: string | null
): Promise<void> {
  const m = await tx.membership.findUnique({ where: { id: membershipId }, select: { status: true } })
  if (m?.status !== 'pending_payment') return

  await tx.membership.update({ where: { id: membershipId }, data: { status: 'cancelled' } })
  await writeHistory(tx, membershipId, await transactionForHistory(tx, membershipId), action, actorId, actorId ? 'admin' : 'system')
}

/** Catat perubahan status (batal, kedaluwarsa, dsb.) — dipakai panel admin di Fase 8. */
export async function writeStatusHistory(membershipId: string, action: string, actorId?: string | null) {
  await prismaClient.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({
      where: { membershipId },
      select: { id: true, amount: true, paymentStatus: true, receiptSequence: true }
    })
    await writeHistory(tx, membershipId, transaction, action, actorId, 'admin')
  }, TX_OPTIONS)
}
