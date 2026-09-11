import { BookingStatus, PaymentStatus } from '@prisma/client'
import { combineDateTime, dateOnly, prisma, tally } from './shared'

// ============================================================================
// === ReviewSeeder + BookingSeeder (DATA DEMO) ===
// ============================================================================
// Hanya jalan bila SEED_DEMO=true. Di Laravel, DatabaseSeeder SELALU
// memanggil BookingSeeder, sehingga 20 booking palsu ikut tertanam ke database
// mana pun yang kebetulan di-seed. Gerbang env ini yang mencegahnya sampai ke
// produksi, dan itu satu-satunya perbedaan perilaku yang disengaja di sini.

const REVIEWS = [
  {
    reviewerName: 'Ahmad Farid',
    rating: 5,
    text: 'Lapangan futsal sangat bersih dan terawat. Harga juga terjangkau. Pasti akan kembali lagi!',
    isApproved: true
  },
  {
    reviewerName: 'Siti Rahayu',
    rating: 4,
    text: 'Pelayanan ramah dan proses booking mudah. Fasilitas loker perlu sedikit peningkatan.',
    isApproved: false
  },
  {
    reviewerName: 'Budi Santoso',
    rating: 5,
    text: 'Kelas yoga di sini instrukturnya profesional dan suasananya kondusif. Sangat direkomendasikan!',
    isApproved: true
  }
]

/** [tanggal dalam bulan, mulai, selesai, indeks fasilitas, indeks user] */
const SLOTS: [number, string, string, number, number][] = [
  [1, '08:00', '10:00', 0, 0],
  [2, '09:00', '11:00', 1, 1],
  [3, '13:00', '15:00', 0, 0],
  [5, '07:00', '09:00', 2, 1],
  [6, '10:00', '12:00', 0, 0],
  [7, '14:00', '16:00', 1, 1],
  [8, '08:00', '10:00', 3, 0],
  [10, '09:00', '11:00', 0, 1],
  [12, '13:00', '15:00', 2, 0],
  [13, '10:00', '12:00', 1, 1],
  [14, '08:00', '09:00', 0, 0],
  [15, '15:00', '17:00', 3, 1],
  [16, '09:00', '11:00', 0, 0],
  [17, '07:00', '09:00', 1, 1],
  [18, '13:00', '14:00', 2, 0],
  [20, '10:00', '12:00', 0, 1],
  [21, '14:00', '16:00', 3, 0],
  [22, '08:00', '10:00', 1, 1],
  [24, '09:00', '11:00', 0, 0],
  [25, '13:00', '15:00', 2, 1]
]

// 12 PAID, 5 UNPAID, 3 gagal — sama persis dengan Laravel.
const PAYMENT_STATUSES: PaymentStatus[] = [
  ...Array<PaymentStatus>(12).fill('PAID'),
  ...Array<PaymentStatus>(5).fill('UNPAID'),
  'EXPIRED',
  'FAILED',
  'FAILED'
]

const BOOKING_STATUSES: BookingStatus[] = [
  ...Array<BookingStatus>(6).fill('confirmed'),
  ...Array<BookingStatus>(6).fill('completed'),
  ...Array<BookingStatus>(5).fill('pending'),
  ...Array<BookingStatus>(3).fill('cancelled')
]

export async function seedReviews() {
  console.log('Review (demo)')
  let created = 0

  for (const review of REVIEWS) {
    const existing = await prisma.review.findFirst({ where: { reviewerName: review.reviewerName }, select: { id: true } })
    if (existing) continue
    await prisma.review.create({ data: review })
    created++
  }

  tally('reviews', { baru: created })
}

export async function seedBookings() {
  console.log('Booking + transaksi (demo)')

  const users = await prisma.user.findMany({ take: 2, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (users.length === 0) {
    console.warn('  ! tidak ada user — seeder booking dilewati')
    return
  }

  const facilities = await prisma.facility.findMany({
    where: { isActive: true },
    take: 4,
    orderBy: { sortOrder: 'asc' },
    select: { id: true, prices: { take: 1, orderBy: { sortOrder: 'asc' }, select: { price: true } } }
  })
  if (facilities.length === 0) {
    console.warn('  ! tidak ada fasilitas aktif — seeder booking dilewati')
    return
  }

  // Idempoten: kalau sudah ada booking demo, jangan menambah 20 lagi tiap
  // seeder dijalankan.
  const existing = await prisma.booking.count()
  if (existing > 0) {
    tally('bookings', { 'sudah ada': existing })
    return
  }

  const now = new Date()
  const month = now.getMonth()
  const year = now.getFullYear()

  let bookingsCreated = 0
  let transactionsCreated = 0

  for (const [index, [day, startTime, endTime, facilityIndex, userIndex]] of SLOTS.entries()) {
    const facility = facilities[facilityIndex] ?? facilities[0]
    const user = users[userIndex] ?? users[0]

    const bookingDate = dateOnly(new Date(Date.UTC(year, month, day)))
    const subtotalPrice = facility.prices[0]?.price ?? 50_000

    const paymentStatus = PAYMENT_STATUSES[index]
    const status = BOOKING_STATUSES[index]

    const booking = await prisma.booking.create({
      data: {
        userId: user.id,
        facilityId: facility.id,
        bookingDate,
        startTime,
        endTime,
        // Denormalisasi WAJIB ditulis bersamaan — ini satu-satunya kolom yang
        // boleh dipakai untuk query rentang waktu (bug 11).
        startsAt: combineDateTime(bookingDate, startTime),
        endsAt: combineDateTime(bookingDate, endTime),
        subtotalPrice,
        status
      }
    })
    bookingsCreated++

    await prisma.transaction.create({
      data: {
        userId: user.id,
        // Pengganti polymorphic transactionable. Kolom xenditInvoiceId dan
        // checkoutUrl memang tidak ada lagi (bug 3).
        bookingId: booking.id,
        amount: subtotalPrice,
        method: 'manual',
        paymentStatus,
        paidAt: paymentStatus === 'PAID' ? combineDateTime(bookingDate, '12:00') : null
      }
    })
    transactionsCreated++
  }

  tally('bookings', { booking: bookingsCreated, transaksi: transactionsCreated })
}
