import { Prisma } from '@prisma/client'
import { prismaClient } from '../application/database'
import { addDays, dateOnly, dateOnlyToString, daysInMonth, now } from '../utils/clock'

// ============================================================================
// === Ketersediaan slot — invarian tunggal ===
// ============================================================================
// Bug 1 Rewrite.md lahir dari DUA aturan okupansi: scopeBlocking() mengecualikan hold yang lewat,
// sementara roster kelas admin memakai whereIn(status, [pending, confirmed, completed]) — kursi yang
// sudah kembali dijual terbaca "penuh" dan meja depan menolak walk-in. Semua pembaca okupansi di
// sistem ini WAJIB lewat blocking(), satu fragment, tidak pernah disalin.

type Db = Prisma.TransactionClient | typeof prismaClient

/**
 * Booking yang MENAHAN slot dari orang lain.
 *
 * Dinyatakan sebagai PENGECUALIAN, bukan daftar status yang memblokir: status yang lupa ditambahkan
 * ke daftar diam-diam mengembalikan slot ke penjualan. `completed` persis contohnya — sesi yang
 * sudah selesai adalah riwayat, bukan inventori bebas.
 *
 * Hanya dua hal yang membebaskan slot: `cancelled`, dan `pending` yang hold-nya sudah lewat.
 * holdExpiresAt NULL berarti "ditahan SELAMANYA" (dibuat staff, atau bukti sudah diunggah).
 *
 * `at` dikirim sebagai parameter — tidak pernah NOW() SQL (R13).
 */
export function blocking(at: Date = now()): Prisma.BookingWhereInput {
  return {
    status: { not: 'cancelled' },
    OR: [{ status: { not: 'pending' } }, { holdExpiresAt: null }, { holdExpiresAt: { gt: at } }]
  }
}

/**
 * Booking tanpa unit (dibuat sebelum fasilitas punya unit) menahan SEMUA unit fasilitas itu.
 * Dibungkus AND di pemanggil karena fragment ini memakai OR.
 */
function unitScope(unitId: string | null): Prisma.BookingWhereInput {
  return unitId ? { OR: [{ facilityUnitId: unitId }, { facilityUnitId: null }] } : {}
}

function monthRange(year: number, month: number) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  return { gte: dateOnly(first), lt: dateOnly(addDays(first, daysInMonth(year, month))) }
}

const monthKey = (dateStr: string, startTime: string) => `${dateStr} ${startTime.slice(0, 5)}`

interface OccupiedRow {
  startTime: string
  endTime: string
  pax: number
}

/**
 * Semua booking yang memblokir pada SATU tanggal, dalam satu query.
 *
 * Bug 5 Rewrite.md: slots() Laravel menembak satu query okupansi per slot — sampai 16 query per render
 * grid, pada 120 permintaan/menit. Satu query per tanggal lalu dicocokkan di memori.
 *
 * `excludeId`: booking yang sedang dipindah jadwalnya tidak dihitung melawan dirinya sendiri — tanpa
 * ini pindah 10-12 -> 11-13 di lapangan berkapasitas 1 ditolak oleh booking itu sendiri.
 */
export async function blockingForDay(
  db: Db,
  facilityId: string,
  unitId: string | null,
  dateStr: string,
  at: Date = now(),
  excludeId?: string
): Promise<OccupiedRow[]> {
  return db.booking.findMany({
    where: {
      AND: [{ facilityId, bookingDate: dateOnly(dateStr) }, blocking(at), unitScope(unitId), excludeId ? { id: { not: excludeId } } : {}]
    },
    select: { startTime: true, endTime: true, pax: true }
  })
}

/**
 * Serialisasi setiap penulis okupansi pada resource ini SEBELUM membaca ketersediaan. Mengunci baris
 * booking yang AKAN bertabrakan tidak cukup: bila belum ada booking yang tumpang tindih, tidak ada yang
 * terkunci, dan dua request sama-sama membaca "kosong". Baris induk memberi mereka sesuatu yang nyata
 * untuk mengantre — dan untuk paket, satu kunci mencakup semua sesinya.
 *
 * WAJIB statement pertama transaksi, SEBELUM kunci transaksi/grup (manual-payment-services): approve,
 * reject, expire, dan attachProof tidak pernah mengambil kunci unit, jadi pemegang kunci transaksi/grup
 * tidak pernah menunggu baris unit — urutan ini tidak bisa membentuk siklus.
 *
 * Serialisasinya per unit (atau per fasilitas bila tanpa unit). Cukup untuk volume ini; bila satu
 * fasilitas suatu saat menanggung booking bersamaan yang padat, pindah ke satu baris per slot dengan
 * unique index (unit, tanggal, jam mulai).
 */
export async function lockResource(tx: Prisma.TransactionClient, facilityId: string, unitId: string | null): Promise<void> {
  if (unitId) await tx.$queryRaw`SELECT id FROM facility_units WHERE id = ${unitId} FOR UPDATE`
  else await tx.$queryRaw`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`
}

/** Pax yang tumpang tindih (setengah terbuka) dengan [start, end). */
export function paxOverlapping(rows: OccupiedRow[], startTime: string, endTime: string): number {
  return rows.reduce((sum, b) => (b.startTime < endTime && b.endTime > startTime ? sum + b.pax : sum), 0)
}

/**
 * Okupansi sebulan penuh dalam SATU query, dikunci "YYYY-MM-DD HH:mm" (cocok persis jam mulai,
 * sama seperti Laravel — kelas berjalan di slot tetap).
 */
export async function occupiedPaxForMonth(
  facilityId: string,
  unitId: string | null,
  year: number,
  month: number,
  at: Date = now()
): Promise<Map<string, number>> {
  const rows = await prismaClient.booking.findMany({
    where: { AND: [{ facilityId, bookingDate: monthRange(year, month) }, blocking(at), unitScope(unitId)] },
    select: { bookingDate: true, startTime: true, pax: true }
  })
  const map = new Map<string, number>()
  for (const b of rows) {
    const key = monthKey(dateOnlyToString(b.bookingDate), b.startTime)
    map.set(key, (map.get(key) ?? 0) + b.pax)
  }
  return map
}

export interface SessionInput {
  date: string
  startTime: string
  endTime: string
}

/**
 * Okupansi banyak sesi dalam SATU query — dipanggil SAMBIL memegang kunci resource, jadi harus
 * pendek berapa pun jumlah sesi paketnya. Pencocokan setengah terbuka.
 */
export async function occupiedPaxForSessions(
  db: Db,
  facilityId: string,
  unitId: string | null,
  sessions: SessionInput[],
  at: Date = now()
): Promise<Map<string, number>> {
  const dates = [...new Set(sessions.map((s) => s.date))]
  const rows = await db.booking.findMany({
    where: { AND: [{ facilityId, bookingDate: { in: dates.map(dateOnly) } }, blocking(at), unitScope(unitId)] },
    select: { bookingDate: true, startTime: true, endTime: true, pax: true }
  })

  const occupied = new Map<string, number>()
  for (const s of sessions) {
    const sameDay = rows.filter((b) => dateOnlyToString(b.bookingDate) === s.date)
    occupied.set(monthKey(s.date, s.startTime), paxOverlapping(sameDay, s.startTime, s.endTime))
  }
  return occupied
}

/**
 * Sesi milik pengunjung sendiri bulan ini — ditampilkan sebagai "sudah dipesan", bukan ditawarkan
 * ulang. Laravel memakai `where facility_unit_id = unit` di sini (tanpa OR NULL); dipertahankan.
 */
export async function ownSessionKeysForMonth(
  userId: string | null,
  facilityId: string,
  unitId: string | null,
  year: number,
  month: number,
  at: Date = now()
): Promise<Set<string>> {
  if (!userId) return new Set()
  const rows = await prismaClient.booking.findMany({
    where: { AND: [{ userId, facilityId, bookingDate: monthRange(year, month) }, unitId ? { facilityUnitId: unitId } : {}, blocking(at)] },
    select: { bookingDate: true, startTime: true }
  })
  return new Set(rows.map((b) => monthKey(dateOnlyToString(b.bookingDate), b.startTime)))
}

/** Pertemuan yang dibatalkan staff, sebagai kunci "YYYY-MM-DD HH:mm". Hanya berlaku bila ada unit. */
export async function cancelledSessionKeys(db: Db, unitId: string | null, year: number, month: number): Promise<Set<string>> {
  if (!unitId) return new Set()
  const rows = await db.classSessionException.findMany({
    where: { facilityUnitId: unitId, sessionDate: { gte: monthRange(year, month).gte, lt: monthRange(year, month).lt } },
    select: { sessionDate: true, startTime: true }
  })
  return new Set(rows.map((r) => monthKey(dateOnlyToString(r.sessionDate), r.startTime)))
}
