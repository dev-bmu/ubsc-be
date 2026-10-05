import { PaymentStatus, Prisma } from '@prisma/client'
import type { AdminFinanceDto, FinanceBreakdownRowDto, FinanceLedgerRowDto, FinanceStatsDto, FinanceTypeBreakdownDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { dateOnly, daysInMonth, formatInstant, jakartaDate, jakartaWallTimeToUtc, now } from '../utils/clock'
import { transferTotal } from '../utils/money'

// ============================================================================
// === Laporan keuangan — port Admin\FinanceReportController ===
// ============================================================================
// ZONA WAKTU. Laravel menyimpan timestamp sebagai jam dinding WIB (APP_TIMEZONE Asia/Jakarta), jadi
// whereMonth/whereYear/DAY()/MONTH() di SQL-nya dievaluasi dalam WIB. Prisma menyimpan UTC. Padanannya:
//   - "paidAt di bulan M tahun Y" = [00:00 WIB tgl 1 bulan M, 00:00 WIB tgl 1 bulan M+1) sebagai instan
//     UTC (jakartaWallTimeToUtc) — pola yang sama dengan dashboard-services.ts (Fase 7).
//   - DAY()/MONTH() = pengelompokan per tanggal/bulan WIB, dikerjakan di JS atas baris yang sudah
//     diambil (jakartaDate), juga seperti dashboard-services.ts.
//   - bookingDate kolom @db.Date (tanggal kalender, tengah malam UTC) -> rentang dateOnly().
//
// SATU query utama (transactionsForPeriod + relasi) menjadi sumber stats, dailyRevenue, facilityRevenue,
// membershipPlanRevenue, dan ledger — himpunan yang Laravel ambil lewat query terpisah semuanya adalah
// irisan dari himpunan itu (lihat komentar per bagian).
//
// UANG. Laravel menjumlahkan `amount` saja. Sejak biaya admin (2026-09) total pendapatan, tren, grafik,
// dan ledger memakai transferTotal() = harga + biaya admin + kode unik — uang yang benar-benar masuk
// rekening, sama dengan yang kelak diekspor ke Accurate. Rincian per fasilitas / per paket dan pendapatan
// reservasi / membership tetap `amount` supaya cocok dengan daftar harga; biaya admin dan kode unik
// punya barisnya sendiri, sehingga keempatnya berjumlah total pendapatan.

const BREAKDOWN_COLORS = ['#E35336', '#0EA5E9', '#10B981', '#A855F7', '#F59E0B', '#64748B']

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** round() PHP: setengah menjauhi nol (Math.round membulatkan -2.5 ke -2, PHP ke -3). */
function phpRound(value: number, precision = 0): number {
  const factor = 10 ** precision
  return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor
}

/**
 * `(int) $value` PHP untuk nilai query string: string numerik diawali angka dibaca sampai karakter
 * non-numerik pertama ('12abc' -> 12, '3.9' -> 3, '1e1' -> 10), selain itu 0. Array non-kosong -> 1.
 */
function phpInt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
  if (Array.isArray(value)) return value.length > 0 ? 1 : 0
  if (typeof value !== 'string') return 0
  const match = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(value)
  if (!match) return 0
  const parsed = Math.trunc(Number(match[0]))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * `(int) request('month', now()->month)`: parameter ABSEN -> default bulan/tahun berjalan WIB. Parameter
 * yang ADA tapi kosong (?month=) menjadi null lewat ConvertEmptyStringsToNull -> (int) null = 0 -> di-clamp.
 */
function periodFrom(query: unknown): { month: number; year: number } {
  const q = (query ?? {}) as Record<string, unknown>
  const [currentYear, currentMonth] = jakartaDate(now()).split('-').map(Number)
  const month = q.month === undefined ? currentMonth : phpInt(q.month)
  const year = q.year === undefined ? currentYear : phpInt(q.year)
  return { month: Math.min(Math.max(month, 1), 12), year: Math.min(Math.max(year, 2020), 2100) }
}

/** Instan UTC dari 00:00 WIB tanggal 1 bulan tsb. month boleh 13 (-> Januari tahun berikutnya). */
function monthStartUtc(year: number, month: number): Date {
  const y = month > 12 ? year + 1 : year
  const m = month > 12 ? month - 12 : month
  return jakartaWallTimeToUtc(`${y}-${pad2(m)}-01`, '00:00')
}

/** transactionsForPeriod(): (paidAt terisi DAN di bulan tsb) ATAU (paidAt null DAN createdAt di bulan tsb). */
function periodWhere(year: number, month: number): Prisma.TransactionWhereInput {
  const range = { gte: monthStartUtc(year, month), lt: monthStartUtc(year, month + 1) }
  return { OR: [{ paidAt: { not: null, ...range } }, { paidAt: null, createdAt: range }] }
}

// ===== Pemuat (padanan with(['user','transactionable']) + loadMorph) =====

const LEDGER_INCLUDE = {
  user: { select: { name: true } },
  booking: {
    select: {
      customerName: true,
      facility: { select: { name: true } },
      facilityUnit: { select: { name: true } }
    }
  },
  membership: { select: { customerName: true, membershipPlan: { select: { name: true } } } }
} satisfies Prisma.TransactionInclude

type LedgerTransaction = Prisma.TransactionGetPayload<{ include: typeof LEDGER_INCLUDE }>

const sumAmount = (rows: Array<{ amount: number }>): number => rows.reduce((total, row) => total + row.amount, 0)
const sumTransferred = (rows: Array<Parameters<typeof transferTotal>[0]>): number => rows.reduce((total, row) => total + transferTotal(row), 0)

// ===== Breakdown =====

/** mapBreakdownRows(): share dari total baris (min 1), warna berputar sesuai indeks. */
function mapBreakdownRows(rows: Array<{ name: string; revenue: number; count: number }>): FinanceBreakdownRowDto[] {
  const total = Math.max(sumAmount(rows.map((row) => ({ amount: row.revenue }))), 1)
  return rows.map((row, index) => ({
    name: row.name,
    revenue: row.revenue,
    count: row.count,
    share: phpRound((row.revenue / total) * 100),
    color: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length]
  }))
}

/**
 * GROUP BY <nama mentah> + COALESCE(nama, fallback), ORDER BY revenue DESC. Kunci grup adalah nama MENTAH
 * (null terpisah dari string), persis GROUP BY facilities.name. Seri revenue di MySQL tidak berurutan
 * pasti; di sini dipecah nama ASC supaya deterministik.
 */
function groupByName(rows: Array<{ name: string | null; amount: number }>, fallback: string) {
  const groups = new Map<string | null, { name: string; revenue: number; count: number }>()
  for (const row of rows) {
    const group = groups.get(row.name) ?? { name: row.name ?? fallback, revenue: 0, count: 0 }
    group.revenue += row.amount
    group.count += 1
    groups.set(row.name, group)
  }
  return [...groups.values()].sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name))
}

/**
 * typeBreakdown(): Reservasi dan Membership (baris tetap Laravel) + Biaya Admin dan Kode Unik, share
 * terhadap total pendapatan (min 1). Keempatnya berjumlah total pendapatan.
 */
function typeBreakdown(stats: FinanceStatsDto): FinanceTypeBreakdownDto[] {
  const safeTotal = Math.max(stats.totalRevenue, 1)
  const row = (name: string, type: FinanceTypeBreakdownDto['type'], revenue: number, color: string): FinanceTypeBreakdownDto => ({
    name,
    type,
    revenue,
    share: phpRound((revenue / safeTotal) * 100),
    color
  })
  return [
    row('Reservasi', 'booking', stats.bookingRevenue, '#E35336'),
    row('Membership', 'membership', stats.membershipRevenue, '#10B981'),
    row('Biaya Admin', 'admin_fee', stats.adminFeeRevenue, '#0EA5E9'),
    row('Kode Unik', 'unique_code', stats.uniqueCodeRevenue, '#A855F7')
  ]
}

// ===== Ledger =====

/** transactionType(): dari kolom subjek (padanan transactionable_type), bukan dari relasi yang termuat. */
function transactionType(t: LedgerTransaction): 'booking' | 'membership' | 'other' {
  if (t.bookingId) return 'booking'
  if (t.membershipId) return 'membership'
  return 'other'
}

/** transactionSubject(): `instanceof` = relasi yang benar-benar termuat. */
function transactionSubject(t: LedgerTransaction): string {
  if (t.booking) {
    const facility = t.booking.facility?.name ?? 'Booking fasilitas'
    const unit = t.booking.facilityUnit?.name
    return unit ? `${facility} - ${unit}` : facility
  }
  if (t.membership) return t.membership.membershipPlan?.name ?? 'Membership manual'
  return 'Transaksi'
}

/** customerName(): user->name ?? transactionable->customer_name ?? 'Guest'. */
function customerName(t: LedgerTransaction): string {
  return t.user?.name ?? t.booking?.customerName ?? t.membership?.customerName ?? 'Guest'
}

/** ledgerRow(). Xendit tidak ada di sistem baru: invoiceId & checkoutUrl selalu null. */
function ledgerRow(t: LedgerTransaction): FinanceLedgerRowDto {
  return {
    id: t.id,
    receiptNumber: t.invoiceNumber,
    invoiceId: null,
    checkoutUrl: null,
    customerName: customerName(t),
    type: transactionType(t),
    subject: transactionSubject(t),
    amount: t.amount,
    adminFee: t.adminFee,
    uniqueCode: t.uniqueCode ?? 0,
    total: transferTotal(t),
    paymentStatus: t.paymentStatus,
    paidAt: t.paidAt ? formatInstant(t.paidAt, 'Y-m-d H:i') : null,
    createdAt: formatInstant(t.createdAt, 'Y-m-d H:i')
  }
}

// ===== Laporan =====

const PENDING_FAILED: readonly PaymentStatus[] = ['UNPAID', 'FAILED', 'EXPIRED']

export async function getFinanceReport(query: unknown): Promise<AdminFinanceDto> {
  const { month, year } = periodFrom(query)
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year

  const [periodRows, lastMonthAgg, yearPaid, totalBookings, activeMemberships] = await Promise.all([
    // $allPeriodTransactions — urutan COALESCE(paid_at, created_at) DESC dikerjakan di bawah (Prisma
    // tidak bisa ORDER BY ekspresi).
    prismaClient.transaction.findMany({ where: periodWhere(year, month), include: LEDGER_INCLUDE }),
    prismaClient.transaction.aggregate({
      _sum: { amount: true, adminFee: true, uniqueCode: true },
      where: { AND: [periodWhere(prevYear, prevMonth), { paymentStatus: 'PAID' }] }
    }),
    // monthlyRevenue(): PAID, paidAt di tahun tsb (WIB) — dikelompokkan per bulan WIB di JS.
    prismaClient.transaction.findMany({
      where: { paymentStatus: 'PAID', paidAt: { gte: monthStartUtc(year, 1), lt: monthStartUtc(year + 1, 1) } },
      select: { paidAt: true, amount: true, adminFee: true, uniqueCode: true }
    }),
    // whereMonth/whereYear pada kolom DATE = rentang tanggal kalender.
    prismaClient.booking.count({
      where: {
        bookingDate: {
          gte: dateOnly(`${year}-${pad2(month)}-01`),
          lt: month === 12 ? dateOnly(`${year + 1}-01-01`) : dateOnly(`${year}-${pad2(month + 1)}-01`)
        }
      }
    }),
    prismaClient.membership.count({ where: { status: 'active' } })
  ])

  // Seri COALESCE tidak berurutan pasti di MySQL; dipecah receiptSequence DESC (padanan PK Laravel).
  const allPeriod = [...periodRows].sort(
    (a, b) => (b.paidAt ?? b.createdAt).getTime() - (a.paidAt ?? a.createdAt).getTime() || b.receiptSequence - a.receiptSequence
  )

  // $paidTransactions = transactionsForPeriod + PAID — irisan persis dari $allPeriodTransactions.
  const paid = allPeriod.filter((t) => t.paymentStatus === 'PAID')
  const totalRevenue = sumTransferred(paid)
  const bookingRevenue = sumAmount(paid.filter((t) => t.bookingId))
  const membershipRevenue = sumAmount(paid.filter((t) => t.membershipId))
  const adminFeeRevenue = paid.reduce((total, t) => total + t.adminFee, 0)
  const uniqueCodeRevenue = paid.reduce((total, t) => total + (t.uniqueCode ?? 0), 0)
  const pendingFailedAmount = sumTransferred(allPeriod.filter((t) => PENDING_FAILED.includes(t.paymentStatus)))
  const lastSum = lastMonthAgg._sum
  const lastMonthRevenue = transferTotal({ amount: lastSum.amount ?? 0, adminFee: lastSum.adminFee ?? 0, uniqueCode: lastSum.uniqueCode })

  const revenueTrend = lastMonthRevenue > 0 ? phpRound(((totalRevenue - lastMonthRevenue) / lastMonthRevenue) * 100, 1) : totalRevenue > 0 ? 100 : 0

  // dailyRevenue/facilityRevenue/membershipPlanRevenue memfilter `whereMonth('paid_at')` SAJA (tanpa
  // cabang createdAt): baris PAID ber-paidAt dari himpunan periode = persis PAID dengan paidAt di bulan tsb.
  const paidInMonth = paid.filter((t): t is typeof t & { paidAt: Date } => t.paidAt !== null)

  const dim = daysInMonth(year, month)
  const dailyRevenue = Array.from({ length: dim }, () => 0)
  for (const t of paidInMonth) {
    const day = Number(jakartaDate(t.paidAt).split('-')[2])
    dailyRevenue[day - 1] += transferTotal(t)
  }

  const monthlyRevenue = Array.from({ length: 12 }, () => 0)
  for (const t of yearPaid) {
    if (!t.paidAt) continue
    const m = Number(jakartaDate(t.paidAt).split('-')[1])
    monthlyRevenue[m - 1] += transferTotal(t)
  }

  // JOIN bookings (inner) + LEFT JOIN facilities: transaksi yang baris booking-nya tidak ada tidak ikut.
  const facilityRevenue = mapBreakdownRows(
    groupByName(
      paidInMonth.filter((t) => t.booking).map((t) => ({ name: t.booking?.facility?.name ?? null, amount: t.amount })),
      'Tanpa fasilitas'
    )
  )
  // JOIN memberships (inner) + LEFT JOIN membership_plans.
  const membershipPlanRevenue = mapBreakdownRows(
    groupByName(
      paidInMonth.filter((t) => t.membership).map((t) => ({ name: t.membership?.membershipPlan?.name ?? null, amount: t.amount })),
      'Manual'
    )
  )

  const stats: FinanceStatsDto = {
    totalRevenue,
    bookingRevenue,
    membershipRevenue,
    adminFeeRevenue,
    uniqueCodeRevenue,
    paidTransactions: paid.length,
    pendingFailedAmount,
    averagePaidTransaction: paid.length > 0 ? phpRound(totalRevenue / paid.length) : 0,
    totalBookings,
    activeMemberships
  }

  // `recentTransactions` Laravel tidak dibaca halaman Finance dan tidak ada di AdminFinanceDto — dibuang.
  return {
    stats,
    revenueTrend,
    dailyRevenue,
    monthlyRevenue,
    facilityRevenue,
    membershipPlanRevenue,
    typeBreakdown: typeBreakdown(stats),
    ledger: allPeriod.map(ledgerRow),
    period: { month, year }
  }
}
