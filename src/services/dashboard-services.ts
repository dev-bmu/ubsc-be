// ===== Service dashboard admin =====
// Padanan controller inline `Route::get('/')` (routes/web.php, blok Dashboard) yang merender
// Pages/Admin/Dashboard.tsx. Mereproduksi query & bentuk datanya di Prisma.
//
// Waktu: SELALU Jakarta (R13) lewat helper clock.ts — tidak ada NOW() SQL. Batas bulan untuk
// kolom instan (paidAt) dihitung sebagai tengah malam Jakarta-sebagai-UTC (jakartaWallTimeToUtc),
// bukan dateOnly() (yang tengah malam UTC), supaya pembayaran di jam-jam tepi bulan tidak salah
// terhitung 7 jam.

import { prismaClient } from '../application/database'
import { blocking } from './availability-services'
import { getGymTraffic } from './cms-services'
import { gymVisitsOn } from './gym-services'
import { daysInMonth, dateOnly, jakartaDate, jakartaWallTimeToUtc, now, toMinutes, translatedDate } from '../utils/clock'
import { transferTotal } from '../utils/money'
import type { DashboardDto, OccupancyFacilityDto, RecentActivityDto } from '../../shared/contracts'

// Palet warna okupansi — verbatim dari controller Laravel ($COLORS).
const OCCUPANCY_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#6b7280', '#ec4899', '#14b8a6']

// Jendela operasional = 15 jam = 900 menit (komentar controller Laravel).
const OPERATING_MINUTES = 900

const pad2 = (value: number): string => String(value).padStart(2, '0')
const round1 = (value: number): number => Math.round(value * 10) / 10
const rupiahThousand = (amount: number): string => new Intl.NumberFormat('id-ID').format(amount)

/**
 * Waktu relatif Bahasa Indonesia gaya Carbon `diffForHumans()` ("2 jam yang lalu").
 * Perkiraan bulan = 30 hari, tahun = 365 hari (cukup untuk tampilan).
 *
 * Diekspor karena dipakai juga oleh antrean identitas (Fase 8E) — Laravel memanggil
 * `updated_at->diffForHumans()` dengan APP_LOCALE=id di sana. Satu implementasi, bukan dua salinan.
 */
export function timeAgoId(from: Date, to: Date): string {
  const seconds = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000))
  if (seconds < 60) return `${seconds} detik yang lalu`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} menit yang lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam yang lalu`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} hari yang lalu`
  if (days < 30) return `${Math.floor(days / 7)} minggu yang lalu`
  if (days < 365) return `${Math.floor(days / 30)} bulan yang lalu`
  return `${Math.floor(days / 365)} tahun yang lalu`
}

export async function getDashboard(): Promise<DashboardDto> {
  const at = now()
  const todayStr = jakartaDate(at)
  const [year, month] = todayStr.split('-').map(Number)
  const currentDayInMonth = Number(todayStr.split('-')[2])
  const dim = daysInMonth(year, month)

  // Batas bulan sebagai instan (jam Jakarta 00:00).
  const monthStart = jakartaWallTimeToUtc(`${year}-${pad2(month)}-01`, '00:00')
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  const prevMonthStart = jakartaWallTimeToUtc(`${prevYear}-${pad2(prevMonth)}-01`, '00:00')

  // ===== Pendapatan bulan ini vs bulan lalu =====
  // Uang masuk (harga + biaya admin + kode unik), sama dengan Total Pendapatan laporan keuangan.
  const MONEY = { amount: true, adminFee: true, uniqueCode: true } as const
  const [currentAgg, lastAgg, paidThisMonth] = await Promise.all([
    prismaClient.transaction.aggregate({ _sum: MONEY, where: { paymentStatus: 'PAID', paidAt: { gte: monthStart, lte: at } } }),
    prismaClient.transaction.aggregate({ _sum: MONEY, where: { paymentStatus: 'PAID', paidAt: { gte: prevMonthStart, lt: monthStart } } }),
    prismaClient.transaction.findMany({
      where: { paymentStatus: 'PAID', paidAt: { gte: monthStart, lte: at } },
      select: { paidAt: true, ...MONEY }
    })
  ])
  const summed = (s: typeof currentAgg._sum) => transferTotal({ amount: s.amount ?? 0, adminFee: s.adminFee ?? 0, uniqueCode: s.uniqueCode })
  const currentRevenue = summed(currentAgg._sum)
  const lastMonthRevenue = summed(lastAgg._sum)
  const revenueTrend = lastMonthRevenue > 0 ? round1(((currentRevenue - lastMonthRevenue) / lastMonthRevenue) * 100) : currentRevenue > 0 ? 100 : 0

  // Pendapatan harian: bucket per tanggal (jam Jakarta), penuhi 1..dim dengan 0.
  const dailyRevenue = Array.from({ length: dim }, () => 0)
  for (const row of paidThisMonth) {
    if (!row.paidAt) continue
    const day = Number(jakartaDate(row.paidAt).split('-')[2])
    if (day >= 1 && day <= dim) dailyRevenue[day - 1] += transferTotal(row)
  }

  // ===== Stats + daftar fasilitas aktif (dipakai lagi untuk okupansi) =====
  const [pendingIdentities, activeFacilityList, todaysBookings, activeMemberships] = await Promise.all([
    prismaClient.user.count({ where: { identityStatus: 'pending' } }),
    prismaClient.facility.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, bookingMode: true } }),
    prismaClient.booking.count({ where: { bookingDate: dateOnly(todayStr), status: { in: ['pending', 'confirmed'] } } }),
    prismaClient.membership.count({ where: { status: 'active' } })
  ])

  // ===== Okupansi hari ini per LAPANGAN (bookingMode 'court' saja) =====
  // Kelas dikecualikan: kelas mem-booking satu baris PER PESERTA, sehingga menjumlahkan durasi
  // membuat satu kelas 20-kursi terbaca 100% (komentar controller Laravel).
  const courts = activeFacilityList.filter((facility) => facility.bookingMode === 'court')
  const courtIds = courts.map((court) => court.id)
  const todayCourtBookings = courtIds.length
    ? await prismaClient.booking.findMany({
        where: { AND: [{ facilityId: { in: courtIds }, bookingDate: dateOnly(todayStr) }, blocking(at)] },
        select: { facilityId: true, startTime: true, endTime: true }
      })
    : []
  const bookedMinutes = new Map<string, number>()
  for (const booking of todayCourtBookings) {
    const minutes = toMinutes(booking.endTime) - toMinutes(booking.startTime)
    bookedMinutes.set(booking.facilityId, (bookedMinutes.get(booking.facilityId) ?? 0) + minutes)
  }
  const occupancyData: OccupancyFacilityDto[] = courts.map((facility, index) => ({
    name: facility.name,
    pct: Math.min(100, Math.round(((bookedMinutes.get(facility.id) ?? 0) / OPERATING_MINUTES) * 100)),
    color: OCCUPANCY_COLORS[index % OCCUPANCY_COLORS.length]
  }))

  // ===== Feed aktivitas terbaru (booking + membership + payment) =====
  const [recentBookings, recentMemberships, recentPayments, infoBannerRows] = await Promise.all([
    prismaClient.booking.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, customerName: true, createdAt: true, user: { select: { name: true } }, facility: { select: { name: true } } }
    }),
    prismaClient.membership.findMany({
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, customerName: true, createdAt: true, user: { select: { name: true } } }
    }),
    prismaClient.transaction.findMany({
      where: { paymentStatus: 'PAID' },
      orderBy: { paidAt: 'desc' },
      take: 5,
      select: {
        id: true,
        ...MONEY,
        paidAt: true,
        createdAt: true,
        user: { select: { name: true } },
        booking: { select: { customerName: true } },
        membership: { select: { customerName: true } }
      }
    }),
    prismaClient.infoBanner.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, message: true, isActive: true, sortOrder: true }
    })
  ])

  type ActivityWithTs = RecentActivityDto & { ts: number }
  const bookingActivities: ActivityWithTs[] = recentBookings.map((booking) => ({
    id: booking.id,
    type: 'booking',
    title: 'Reservasi Baru',
    subtitle: `${booking.customerName ?? booking.user?.name ?? 'Guest'} · ${booking.facility?.name ?? '-'}`,
    time: timeAgoId(booking.createdAt, at),
    ts: booking.createdAt.getTime()
  }))
  const membershipActivities: ActivityWithTs[] = recentMemberships.map((membership) => ({
    id: membership.id,
    type: 'membership',
    title: 'Membership Baru',
    subtitle: membership.customerName ?? membership.user?.name ?? 'Guest',
    time: timeAgoId(membership.createdAt, at),
    ts: membership.createdAt.getTime()
  }))
  const paymentActivities: ActivityWithTs[] = recentPayments.map((transaction) => {
    const when = transaction.paidAt ?? transaction.createdAt
    return {
      id: transaction.id,
      type: 'payment',
      title: 'Pembayaran Diterima',
      subtitle: `Rp ${rupiahThousand(transferTotal(transaction))} ·${transaction.user?.name ?? transaction.booking?.customerName ?? transaction.membership?.customerName ?? 'Guest'}`,
      time: timeAgoId(when, at),
      ts: when.getTime()
    }
  })
  // Laravel mengurutkan dengan sortByDesc('time') pada STRING "…yang lalu" — string-sort yang
  // sebetulnya bug (urutan tak kronologis). Di sini diurut kronologis DESC berdasar timestamp
  // asli (perilaku yang dimaksud), lalu ambil 8. Lihat catatan di docs/fase-7.md.
  const recentActivity: RecentActivityDto[] = [...bookingActivities, ...membershipActivities, ...paymentActivities]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8)
    .map(({ ts: _ts, ...activity }) => activity)

  const [gymTraffic, gymVisitsToday] = await Promise.all([getGymTraffic(), gymVisitsOn(todayStr)])

  return {
    gymVisitsToday,
    stats: {
      pendingIdentities,
      activeFacilities: activeFacilityList.length,
      todaysBookings,
      totalRevenue: currentRevenue,
      activeMemberships
    },
    revenueTrend,
    dailyRevenue,
    daysInMonth: dim,
    currentDayInMonth,
    currentMonthLabel: translatedDate(`${year}-${pad2(month)}-01`, 'M Y'),
    occupancyData,
    recentActivity,
    gymTraffic,
    infoBanners: infoBannerRows
  }
}
