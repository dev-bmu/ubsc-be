import { Prisma } from '@prisma/client'
import type {
  ApprovedReviewDto,
  ApprovedReviewIndexDto,
  BookingFacilityDto,
  BookingFacilityIndexDto,
  BookingFacilityUnitDto,
  CustomerTransactionDto,
  CustomerTransactionIndexDto,
  MyReviewDto,
  ReviewEligibilityDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, formatInstant, now } from '../utils/clock'
import { transferTotal } from '../utils/money'
import { CustomerReviewValidation } from '../validation/customer-review-validation'
import { Validation } from '../validation/Validation'
import { adminFee, uniqueCodeMax } from './manual-payment-services'
import { firstUrlFor, listFor } from './media-services'
import { listPublicFacilities } from './public-facility-services'

// ============================================================================
// === Area customer Fase 6 — halaman /booking, ulasan, dan riwayat transaksi ===
// ============================================================================
// Empat sumber Laravel, satu berkas:
//
//   routes/web.php:149-178   closure halaman /booking  -> facilities (dengan units.media),
//                            can_review, existing_review, approved_reviews
//   routes/web.php:254-308   closure JSON /user/transactions (20 terbaru)
//   Public/ReviewController  store() — updateOrCreate per user
//   FacilityResource.php     blok `units` pada whenLoaded('units')
//
// TIGA keputusan yang mengikat seluruh berkas ini:
//
// 1. TRANSFORM FASILITAS TIDAK DITULIS ULANG. listBookingFacilities() memanggil
//    listPublicFacilities() apa adanya lalu MENEMPELKAN `units`. Di Laravel keduanya memang satu
//    FacilityResource yang sama; yang membedakan hanya eager-load `units.media` di jalur /booking
//    (routes/web.php:158). Menyalin transform-nya ke sini berarti priceRange, image, kategori, dan
//    urutan punya dua implementasi yang bisa menyimpang diam-diam.
//
// 2. WAKTU SELALU DIHITUNG DI WIB, lewat utils/clock.ts. Tidak ada satu pun `new Date()` telanjang
//    dan tidak ada NOW() di SQL (R13).
//
// 3. TIDAK ADA N+1. Unit + media unit diambil batch (satu findMany + satu listFor); transaksi
//    membawa booking→facility dan membership→plan dalam SATU query lewat select bersarang.

/** Nama penulis saat ulasan tidak punya reviewerName maupun user (routes/web.php:172). */
const FALLBACK_AUTHOR_NAME = 'Pengguna'

/**
 * Avatar default kartu ulasan (routes/web.php:176).
 *
 * Path aset milik repo landing, disalin APA ADANYA. API tidak menyajikan berkas ini dan memang tidak
 * perlu: landing yang me-render-nya, sama seperti Laravel yang menaruhnya di public/.
 */
const DEFAULT_REVIEW_AVATAR = '/assets/icons/ulasan-malang-tennis-academy-ubsc.avif'

/** Pesan abort_unless() Laravel, PERSIS (Public/ReviewController.php:29). */
const NO_COMPLETED_BOOKING_MESSAGE = 'Anda harus memiliki setidaknya satu riwayat pemesanan yang selesai untuk memberikan ulasan.'

/** `whereIn('status', ['confirmed', 'completed'])` — dipakai can_review DAN ReviewController. */
const REVIEWABLE_BOOKING_STATUSES = ['confirmed', 'completed'] as const

/**
 * Padanan `Carbon::toDateTimeString()` -> 'YYYY-MM-DD HH:mm:ss', dirender di WIB.
 *
 * formatInstant() merender Y-m-d H:i di jam Jakarta tapi tidak mengenal token detik, jadi detiknya
 * ditempel dari getUTCSeconds(): offset Asia/Jakarta +07:00 bulat, sehingga detik UTC dan detik WIB
 * selalu sama. Menambah token 's' ke clock.ts akan menyentuh berkas milik fase lain — sengaja tidak
 * dilakukan, sama persis dengan wibDateTimeString() di news-admin-services.ts:86-95.
 */
function wibDateTimeString(instant: Date): string {
  return `${formatInstant(instant, 'Y-m-d H:i')}:${String(instant.getUTCSeconds()).padStart(2, '0')}`
}

// ===== 1. Fasilitas halaman /booking =====

/**
 * Predikat scopeEnded() Laravel (Booking.php:149-155):
 *
 *   whereRaw("CONCAT(DATE(booking_date), ' ', end_time) <= ?", [now()->format('Y-m-d H:i:s')])
 *
 * Perbandingannya DATETIME (tanggal + jam selesai), bukan tanggal saja — sesi 09:00-10:00 hari ini
 * baru "ended" pukul 10:00, bukan tengah malam nanti. APP_TIMEZONE Laravel 'Asia/Jakarta'
 * (config/app.php:68), jadi baik sisi kiri maupun `now()` adalah jam dinding WIB.
 *
 * Di sini CONCAT itu TIDAK diport sebagai raw SQL, melainkan sebagai kolom denormalisasi `endsAt`
 * yang memang ditulis untuk keperluan ini: schema.prisma:543-548 menyebutnya "SATU-SATUNYA kolom yang
 * boleh dipakai untuk query rentang waktu — CONCAT() tidak bisa di-index", dan @@index([endsAt])
 * (schema.prisma:577-578) secara eksplisit berkomentar "Mendukung scopeEnded — jalan tiap submit
 * review". endsAt diisi jakartaWallTimeToUtc(bookingDate, endTime) di booking-services.ts:557,
 * sehingga `endsAt <= now()` adalah instan yang sama persis dengan string WIB yang dibandingkan
 * Laravel — bukan pendekatan, melainkan bentuk ter-index dari ekspresi yang sama.
 */
function endedBookingWhere(userId: string): Prisma.BookingWhereInput {
  return {
    userId,
    status: { in: [...REVIEWABLE_BOOKING_STATUSES] },
    endsAt: { lte: now() }
  }
}

/**
 * Kolom unit yang dikirim BookingFacilityUnitDto. `capacity` SENGAJA tidak diambil — lihat catatan
 * penyimpangan di listBookingFacilities().
 */
const BOOKING_UNIT_SELECT = {
  id: true,
  facilityId: true,
  name: true
} as const satisfies Prisma.FacilityUnitSelect

/**
 * Fasilitas halaman /booking — FacilityDto beranda PLUS `units` (routes/web.php:157-159).
 *
 * Filter dan urutan fasilitas TIDAK diulang di sini: keduanya milik listPublicFacilities()
 * (isActive, sortOrder ASC) dan dipakai apa adanya, jadi kartu di /booking tidak akan pernah berbeda
 * urutan dari kartu di beranda.
 *
 * UNIT: `->where('is_active', true)->sortBy('id')` (FacilityResource.php:26-35). `sortBy('id')` di
 * Laravel berarti urutan penyisipan karena PK-nya auto-increment; PK di sini uuid v4 (acak), jadi
 * padanannya createdAt ASC dengan id sebagai kunci ketiga yang deterministik — alasan yang sama
 * persis dengan media-services.ts:121 dan public-facility-services.ts.
 *
 * DUA PENYIMPANGAN DARI FacilityResource, KEDUANYA MENGIKUTI KONTRAK, KEDUANYA DISENGAJA:
 *
 *   a. `image` = getFirstMediaUrl('unit_image') SAJA, '' bila kosong. Laravel menulis
 *      `$unit->getFirstMediaUrl('unit_image') ?: $this->getFirstMediaUrl('hero')` — unit tanpa foto
 *      meminjam foto hero fasilitasnya. BookingFacilityUnitDto (shared/contracts.ts:1583-1584)
 *      mendokumentasikan "'unit_image', '' bila kosong", jadi bentuk itu yang diimplementasikan.
 *      Konsekuensinya NYATA: unit tanpa unit_image kehilangan gambar yang di Laravel tetap ada.
 *      Kalau fallback-nya dikehendaki, satu baris: `|| firstUrlFor(heroes, facility.id, 'hero')`,
 *      dan hero-nya harus ikut diambil di sini karena listPublicFacilities() tidak mengembalikannya
 *      sebagai map (FacilityDto.image sudah berupa URL jadi bisa dipakai langsung).
 *
 *   b. `capacity` TIDAK dikirim. FacilityResource.php:33 mengirim `(int) ($unit->capacity ?? 1)`;
 *      BookingFacilityUnitDto tidak punya field itu, dan menambahkannya akan ditolak compiler.
 */
export async function listBookingFacilities(): Promise<BookingFacilityDto[]> {
  const facilities = await listPublicFacilities()

  const units = await prismaClient.facilityUnit.findMany({
    where: { isActive: true, facilityId: { in: facilities.map((facility) => facility.id) } },
    select: BOOKING_UNIT_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  })

  const unitImages = await listFor(
    'FacilityUnit',
    units.map((unit) => unit.id),
    'unit_image'
  )

  const byFacility = new Map<string, BookingFacilityUnitDto[]>()
  for (const unit of units) {
    const dto: BookingFacilityUnitDto = {
      id: unit.id,
      name: unit.name,
      // Lihat penyimpangan (a) di atas: TANPA fallback ke hero fasilitas.
      image: firstUrlFor(unitImages, unit.id, 'unit_image')
    }
    const bucket = byFacility.get(unit.facilityId)
    if (bucket) bucket.push(dto)
    else byFacility.set(unit.facilityId, [dto])
  }

  // Fasilitas tanpa unit aktif mengirim [] — di Laravel jalur ini memang selalu eager-load `units`,
  // jadi whenLoaded() menghasilkan array kosong, BUKAN key yang hilang seperti di beranda.
  return facilities.map((facility) => ({ ...facility, units: byFacility.get(facility.id) ?? [] }))
}

// ===== 2. Ulasan yang sudah disetujui (publik) =====

/**
 * `Review::approved()->with('user')->latest()->get()` (routes/web.php:167-177).
 *
 * TANPA limit — berbeda dari cms-services.listReviews() yang melayani beranda dengan take 10 dan
 * bentuk DTO yang lain (ReviewDto: reviewerName + fallback 'Guest', tanpa tanggal dan avatar).
 * Keduanya memang dua payload berbeda di Laravel; jangan disatukan.
 *
 * `latest()` = createdAt DESC, satu kunci urut tanpa tie-breaker — sama dengan listReviews(), dan
 * alasannya sama (butir 4 di kepala cms-services.ts: pada tabel ini kunci primernya SUDAH createdAt,
 * jadi tidak ada kunci kedua yang bisa menolong).
 *
 * authorName: `$r->reviewer_name ?? $r->user?->name ?? 'Pengguna'` — `??`, jadi string kosong
 * diteruskan apa adanya, bukan jatuh ke nama user.
 *
 * authorDate: `$r->created_at->format('d M Y')`. format() Carbon TIDAK PERNAH dilokalkan — bulannya
 * bahasa Inggris ('05 Sep 2026'), bukan translatedFormat() yang akan menulis 'Sep'/'Agt' versi id.
 * formatInstant() sudah memakai EN_MONTHS_SHORT untuk token 'M'; jangan tukar dengan translatedDate().
 *
 * avatar: '/storage/' + users.avatar APA ADANYA bila user punya avatar, selain itu aset ikon default.
 * Prefiks '/storage/' DIPERTAHANKAN 1:1 meskipun API ini tidak me-mount /storage — keputusan yang
 * sama dengan avatar penulis berita di 8F (news-admin-services.ts:155-167): API mengirim string yang
 * dikirim Laravel, dan repo yang me-render-lah yang memutuskan cara menyajikannya. Termasuk cacat
 * bawaan Laravel untuk avatar Google berbentuk URL absolut, yang jadi '/storage/https://lh3...'.
 */
export async function listApprovedReviews(): Promise<ApprovedReviewDto[]> {
  const reviews = await prismaClient.review.findMany({
    where: { isApproved: true },
    select: {
      id: true,
      reviewerName: true,
      rating: true,
      text: true,
      createdAt: true,
      user: { select: { name: true, avatar: true } }
    },
    orderBy: [{ createdAt: 'desc' }]
  })

  return reviews.map((review) => ({
    id: review.id,
    rating: review.rating,
    text: review.text,
    authorName: review.reviewerName ?? review.user?.name ?? FALLBACK_AUTHOR_NAME,
    authorDate: formatInstant(review.createdAt, 'd M Y'),
    // `? :` PHP: avatar berisi string kosong ikut jatuh ke aset default, bukan jadi '/storage/'.
    avatar: review.user?.avatar ? `/storage/${review.user.avatar}` : DEFAULT_REVIEW_AVATAR
  }))
}

// ===== 3. Kelayakan & penyimpanan ulasan (customer) =====

/**
 * Ulasan milik satu user, atau null.
 *
 * `Review::where('user_id', $user->id)->first()` (routes/web.php:154) tidak menulis orderBy sama
 * sekali, jadi Laravel menyerahkannya ke urutan fisik MySQL yang praktis = PK menaik. Padanan urutan
 * penyisipan di skema uuid adalah createdAt ASC (butir 4 cms-services.ts), dengan id sebagai kunci
 * kedua yang deterministik. Normalnya hanya ada satu baris per user — updateOrCreate menjaga itu —
 * jadi urutannya hanya berlaku untuk data yang terlanjur ganda.
 */
async function findMyReview(userId: string): Promise<MyReviewDto | null> {
  const review = await prismaClient.review.findFirst({
    where: { userId },
    select: { id: true, rating: true, text: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  })

  return review ? { id: review.id, rating: review.rating, text: review.text } : null
}

/**
 * GET /api/customer/reviews/eligibility — padanan `can_review` + `existing_review`
 * (routes/web.php:150-156, 160-164).
 *
 * canReview: minimal satu booking milik pemanggil berstatus confirmed/completed yang SUDAH berakhir.
 * `$user &&` di Laravel tidak diport karena endpoint ini sudah di belakang customerAuthRequired —
 * pemanggil anonim tidak pernah sampai ke sini (dan di Laravel halamannya memang mengirim false).
 *
 * rating dikirim `(float)`; kolomnya sudah Float di schema.prisma:779, jadi tanpa konversi.
 */
export async function reviewEligibility(userId: string): Promise<ReviewEligibilityDto> {
  const [endedBooking, existingReview] = await Promise.all([
    prismaClient.booking.findFirst({ where: endedBookingWhere(userId), select: { id: true } }),
    findMyReview(userId)
  ])

  return { canReview: endedBooking !== null, existingReview }
}

/**
 * POST /api/customer/reviews — port ReviewController::store().
 *
 * URUTAN LANGKAHNYA SAMA DENGAN LARAVEL DAN ITU PENTING: validate() dulu (422), baru cek riwayat
 * booking (403). Membaliknya membuat payload sampah dari pemanggil tanpa booking dijawab 403 alih-alih
 * 422, dan itu pesan yang berbeda di layar.
 *
 * updateOrCreate(['user_id' => ...], [...]) TIDAK bisa jadi prisma upsert: kolom userId hanya
 * @@index, bukan @unique (schema.prisma:775, 786) — dan memang tidak boleh di-@unique karena kolomnya
 * nullable dan ulasan tanpa user tetap sah. Jadi bentuknya findFirst + update/create, persis seperti
 * firstOrNew()->fill()->save() yang dijalankan Eloquent. Dibungkus satu transaksi supaya dua submit
 * beruntun dari tab yang sama tidak menghasilkan dua baris; balapan yang benar-benar bersamaan tetap
 * mungkin, sama seperti di Laravel yang juga tidak punya unique constraint di sana.
 *
 * DUA FIELD YANG SELALU DITULIS ULANG, bukan hanya saat create:
 *   reviewerName: null  — nama penulis SELALU diambil dari relasi user (komentar Laravel sendiri)
 *   isApproved:   false — setiap penyimpanan mengembalikan ulasan ke antrean moderasi
 *
 * Laravel membalas redirect back() dengan flash; di sini yang dikembalikan adalah barisnya
 * (MyReviewDto) supaya klien tidak perlu memanggil /eligibility lagi setelah menyimpan.
 */
export async function storeReview(userId: string, request: unknown): Promise<MyReviewDto> {
  const v = Validation.validate(CustomerReviewValidation.STORE, request)

  const hasCompleted = await prismaClient.booking.findFirst({ where: endedBookingWhere(userId), select: { id: true } })
  if (!hasCompleted) throw new ResponseError(403, NO_COMPLETED_BOOKING_MESSAGE)

  const saved = await prismaClient.$transaction(async (tx) => {
    const existing = await tx.review.findFirst({
      where: { userId },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })

    const data = { reviewerName: null, rating: v.rating, text: v.text, isApproved: false }

    if (existing) {
      return tx.review.update({ where: { id: existing.id }, data, select: { id: true, rating: true, text: true } })
    }

    return tx.review.create({ data: { userId, ...data }, select: { id: true, rating: true, text: true } })
  })

  return { id: saved.id, rating: saved.rating, text: saved.text }
}

// ===== 4. Riwayat transaksi customer =====

/**
 * Kolom satu baris riwayat transaksi. Relasi booking→facility dan membership→membershipPlan ikut di
 * select bersarang: padanan `loadMissing('facility')` / `loadMissing('plan')` Laravel
 * (routes/web.php:261-267) yang di sana berjalan PER BARIS — di sini satu query untuk kedua puluhnya.
 */
const CUSTOMER_TRANSACTION_SELECT = {
  id: true,
  receiptSequence: true,
  invoiceNumber: true,
  amount: true,
  adminFee: true,
  uniqueCode: true,
  membershipId: true,
  paymentStatus: true,
  verificationStatus: true,
  rejectionReason: true,
  paidAt: true,
  createdAt: true,
  booking: { select: { id: true, bookingDate: true, facility: { select: { name: true } } } },
  membership: { select: { status: true, startDate: true, endDate: true, membershipPlan: { select: { name: true } } } }
} as const satisfies Prisma.TransactionSelect

type CustomerTransactionRow = Prisma.TransactionGetPayload<{ select: typeof CUSTOMER_TRANSACTION_SELECT }>

/** Jumlah baris yang dikirim modal riwayat — `->take(20)` (routes/web.php:259). */
export const CUSTOMER_TRANSACTION_LIMIT = 20

/**
 * `route('booking.payment', $booking)` (routes/web.php:285-287) — jalan kembali ke layar pembayaran.
 *
 * Dikirim ROOT-RELATIF, bukan absolut ke LANDING_URL seperti PendingPaymentDto.url. Itu yang
 * didokumentasikan CustomerTransactionDto (shared/contracts.ts:1657-1658), dan di sini memang cukup:
 * modal riwayat dirender oleh landing itu sendiri, jadi href relatif menunjuk ke halaman yang sama
 * tanpa mengikat API pada env milik repo lain. PendingPaymentDto berbeda karena nilainya juga dipakai
 * di luar konteks halaman landing.
 */
function paymentUrlFor(bookingId: string): string {
  return `/booking/${bookingId}/pembayaran`
}

/**
 * Satu baris modal riwayat pembayaran — routes/web.php:269-306.
 *
 * `type` mengikuti Laravel PERSIS: `instanceof Membership ? 'membership' : 'booking'`. Baris tanpa
 * booking DAN tanpa membership (cacat data — schema.prisma:726-731 menyerahkan invarian "tepat satu
 * terisi" ke service) karena itu terbaca 'booking' dengan facilityName '-', bukan dilempar error.
 *
 * invoiceId dan checkoutUrl SELALU null: Xendit tidak ada di sistem baru, sama seperti ledger 8D.
 * Field-nya tetap dikirim supaya bentuk JSON-nya tidak berubah untuk klien yang sudah membacanya.
 *
 * transferTotal = amount + adminFee + uniqueCode — port Transaction::getTransferTotalAttribute()
 * (Transaction.php:73-76) ditambah biaya admin (utils/money.ts). uniqueCode sendiri tetap dikirim
 * apa adanya (null tetap null), sama seperti Laravel.
 *
 * paidAt/createdAt: `toDateTimeString()` -> 'YYYY-MM-DD HH:mm:ss' WIB.
 * bookingDate: kolom @db.Date, dikirim 'YYYY-MM-DD'. Laravel meneruskan objek Carbon-nya ke
 * response()->json(), yang men-serialize cast 'date' sebagai 'YYYY-MM-DD' — bukan ISO penuh.
 */
function toTransactionDto(row: CustomerTransactionRow): CustomerTransactionDto {
  const isMembership = row.membership !== null

  return {
    id: row.id,
    receiptNumber: row.invoiceNumber,
    invoiceId: null,
    amount: row.amount,
    transferTotal: transferTotal(row),
    uniqueCode: row.uniqueCode,
    paymentStatus: row.paymentStatus,
    verificationStatus: row.verificationStatus,
    rejectionReason: row.rejectionReason,
    paymentUrl: row.booking ? paymentUrlFor(row.booking.id) : row.membershipId ? `/membership/${row.membershipId}/pembayaran` : null,
    checkoutUrl: null,
    paidAt: row.paidAt ? wibDateTimeString(row.paidAt) : null,
    createdAt: wibDateTimeString(row.createdAt),
    type: isMembership ? 'membership' : 'booking',
    // `$t->transactionable->facility?->name ?? '-'`: relationMode="prisma" menghapus foreign key,
    // jadi facilityId yang menunjuk baris terhapus memang mungkin.
    facilityName: row.booking ? (row.booking.facility?.name ?? '-') : '-',
    bookingDate: row.booking ? dateOnlyToString(row.booking.bookingDate) : null,
    membershipPlan: row.membership ? (row.membership.membershipPlan?.name ?? 'Manual') : null,
    membershipStatus: row.membership?.status ?? null,
    membershipPeriod: row.membership
      ? { startDate: dateOnlyToString(row.membership.startDate), endDate: dateOnlyToString(row.membership.endDate) }
      : null
  }
}

/**
 * GET /api/customer/transactions — `Transaction::where('user_id', ...)->latest()->take(20)`
 * (routes/web.php:255-259).
 *
 * URUTAN. `latest()` = createdAt DESC. Kunci kedua receiptSequence MENAIK, dan arahnya bukan salah
 * ketik: pada nilai seri MySQL mengembalikan baris dalam urutan PK auto-increment menaik, dan
 * receiptSequence ADALAH padanan PK itu di skema ini (schema.prisma:722-724). Argumen lengkapnya ada
 * di butir 4 kepala cms-services.ts. Di koleksi ber-take seperti ini kunci kedua bukan cuma menggeser
 * urutan, ia menentukan BARIS MANA yang masuk 20 — walau serinya sendiri praktis mustahil di sini
 * (createdAt DATETIME(3), satu user, checkout berurutan).
 */
export async function customerTransactions(userId: string): Promise<CustomerTransactionDto[]> {
  const rows = await prismaClient.transaction.findMany({
    where: { userId },
    select: CUSTOMER_TRANSACTION_SELECT,
    orderBy: [{ createdAt: 'desc' }, { receiptSequence: 'asc' }],
    take: CUSTOMER_TRANSACTION_LIMIT
  })

  return rows.map(toTransactionDto)
}

// ===== 5. Pembungkus envelope endpoint =====
// Ketiga DTO index di kontrak adalah OBJEK berkunci tunggal, bukan array telanjang — supaya field
// tambahan (paginasi, penanda cache) bisa masuk kelak tanpa mengubah bentuk root balasan. Dibungkus
// di service, bukan di controller: controller di repo ini tidak pernah membentuk data.

/** GET /api/public/booking/facilities */
export async function bookingFacilityIndex(): Promise<BookingFacilityIndexDto> {
  const [facilities, fee, codeMax] = await Promise.all([listBookingFacilities(), adminFee(), uniqueCodeMax()])
  return { facilities, adminFee: fee, uniqueCodeMax: codeMax }
}

/** GET /api/public/booking/reviews */
export async function approvedReviewIndex(): Promise<ApprovedReviewIndexDto> {
  return { reviews: await listApprovedReviews() }
}

/** GET /api/customer/transactions */
export async function customerTransactionIndex(userId: string): Promise<CustomerTransactionIndexDto> {
  return { transactions: await customerTransactions(userId) }
}
