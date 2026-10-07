// ===== Kontrak respons API UBSC (SUMBER KEBENARAN) =====
//
// Tipe di file ini dipakai tiga repo sekaligus: ubsc-api menulisnya, ubsc-landing dan
// ubsc-admin menyalinnya lewat npm run sync:contracts. Isinya murni tipe — tidak ada nilai
// runtime — supaya bisa diimpor dengan import type dan hilang total saat build FE.
//
// Baca shared/README.md sebelum menambah apa pun di sini: satu field baru = tiga commit.

import type { PermissionCode } from './permissions'
import type { SeoPageKey } from './seo'

// ===== Envelope =====
//
// Menyimpang dari boilerplate yang mengembalikan { errors: "<string>" } dengan seluruh
// ZodError ter-serialisasi di dalam satu string. Bentuk itu tidak bisa dipakai ~40 form
// aplikasi ini: pesan error tidak punya tempat menempel per field. Envelope di bawah punya
// peta fields, dan satu helper applyApiErrors(error, form) di FE memetakannya ke setError.

/** Meta paginasi. Selalu di level envelope, tidak pernah di dalam data. */
export interface ApiMeta {
  page: number
  perPage: number
  total: number
  lastPage: number
}

export interface ApiSuccess<T> {
  success: true
  data: T
  meta?: ApiMeta
}

/**
 * Isi error. code dibaca mesin (FE bercabang di atasnya), message dibaca manusia dan SELALU
 * bahasa Indonesia, fields hanya ada pada VALIDATION_ERROR, requestId ikut masuk log winston
 * sehingga keluhan user bisa ditelusuri ke satu baris log.
 */
export interface ApiErrorBody {
  code: ErrorCode
  message: string
  fields?: Record<string, string[]>
  requestId?: string
}

export interface ApiFailure {
  success: false
  error: ApiErrorBody
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

/**
 * Respons daftar ter-paginasi: data berisi array, meta wajib ada.
 * Contoh pemakaian nanti: PaginatedData<BookingDto>.
 */
export interface PaginatedData<T> extends ApiSuccess<T[]> {
  meta: ApiMeta
}

// ===== Kode error =====
//
// Union ini WAJIB sama persis dengan ERROR_CODES di src/utils/respond.ts. Di sanalah
// nilainya hidup sebagai konstanta runtime; di sini hanya bayangannya sebagai tipe, karena
// file ini sengaja bebas nilai runtime agar aman disalin ke repo Next.
// Menambah kode berarti menyentuh dua file, lalu npm run sync:contracts di kedua repo Next.

export type ErrorCode =
  | 'VALIDATION_ERROR' // 422 — payload gagal validasi Zod, selalu disertai fields
  | 'UNAUTHENTICATED' // 401 — tidak ada sesi, token kedaluwarsa, atau audience tidak cocok
  | 'FORBIDDEN' // 403 — sesi sah tapi permission kurang
  | 'NOT_FOUND' // 404 — resource tidak ada, atau bukan milik pemanggil
  | 'CONFLICT' // 409 — bentrok status, misal membership tumpang tindih
  | 'RATE_LIMITED' // 429 — melewati batas percobaan login/booking
  | 'PAYLOAD_TOO_LARGE' // 413 — unggahan melebihi batas multer
  | 'HOLD_LAPSED' // 409 — hold pembayaran sudah lewat saat bukti masuk (Fase 3)
  | 'PENDING_TOTAL_EXHAUSTED' // 409 — 25 percobaan kode nominal unik habis (Fase 3, R11)
  | 'SERVICE_UNAVAILABLE' // 502/503/504 — dependensi luar (DB, SMTP, Google) sedang tidak bisa dihubungi; boleh dicoba lagi
  | 'INTERNAL_ERROR' // 500 — pesan generik; detail hanya masuk log, tidak pernah ke klien

// ===== Meta & health =====

export interface HealthDto {
  status: 'ok' | 'degraded'
  service: string
  /** ISO-8601 UTC. Opsional karena /api/health dangkal tidak perlu menyentuh apa pun. */
  timestamp?: string
}

/**
 * Balasan GET /api/meta/contract-hash.
 *
 * hash        sha256 deterministik atas isi folder shared/ (lihat src/utils/contract-hash.ts)
 * files       nama file yang ikut dihitung, urut — supaya selisih salinan bisa ditunjuk
 * generatedAt ISO-8601 UTC, waktu hash dihitung pertama kali di proses ini
 *
 * Kedua app Next memanggil endpoint ini saat boot dev dan console.warn bila berbeda dengan
 * hash salinannya. Itu yang mengubah drift kontrak dari bug misterius di produksi (R12)
 * jadi peringatan di terminal.
 */
export interface ContractHashDto {
  hash: string
  files: string[]
  generatedAt: string
}

// ===== Auth =====
//
// Dua audience terpisah, masing-masing punya cookie, secret JWT, dan claim aud sendiri.
// Token customer ditolak di route staff dan sebaliknya — itu properti yang diuji di Fase 1.

export type AuthAudience = 'customer' | 'staff'

/**
 * Identitas pemakai yang dikembalikan endpoint auth dan dipegang AuthContext di kedua app Next.
 *
 * role null untuk customer: mereka bukan staf dan tidak punya baris role sama sekali.
 * permissions selalu ada, array kosong untuk customer. Keduanya hanya untuk UX di FE —
 * gate yang sesungguhnya selalu dijalankan server lewat requirePermission per baris route.
 */
export interface AuthUserDto {
  id: string
  name: string
  email: string
  role: string | null
  permissions: PermissionCode[]
  /** ISO 8601; null = email belum diverifikasi (situs publik menampilkan penanda + tombol kirim ulang). */
  emailVerifiedAt: string | null
}

/**
 * POST /api/customer/profile/resend-verification — kirim ulang email verifikasi untuk akun yang login.
 * Dibatasi per akun supaya SMTP tidak dihujani: jeda antar-kiriman dan batas harian. sent=false berarti
 * ditahan jeda/batas (atau email sudah terverifikasi); retryAfterSeconds = sisa tunggu, 0 bila boleh.
 */
export interface ResendVerificationDto {
  sent: boolean
  retryAfterSeconds: number
  alreadyVerified: boolean
}

/**
 * GET /api/customer/transactions/:id/invoice dan GET /api/admin/payments/:id/invoice — invoice/kuitansi
 * satu transaksi sebagai dokumen HTML siap cetak (tombol "Cetak / Simpan PDF" di dalamnya). Frontend
 * menulisnya ke tab baru; isinya sama dengan email tagihan membership.
 */
export interface InvoiceDto {
  /** Nomor invoice 'UBSC-X-2026-0001' (bulan romawi, tahun, urutan per tahun). */
  number: string
  html: string
}

/** Balasan endpoint login/refresh/me. Access token hidup di memori JS, tidak pernah di localStorage. */
export interface AuthSessionDto {
  user: AuthUserDto
  audience: AuthAudience
  accessToken: string
  /** Detik sampai accessToken kedaluwarsa, untuk penjadwalan refresh single-flight di FE. */
  expiresIn: number
}

// ===== DTO domain =====
//
// SELESAI Fase 4a: seluruh DTO beranda di blok bawah sudah punya endpoint — GET /api/public/home
// (agregat HomeDto) plus sepuluh endpoint granular per koleksi. Daftar path lengkapnya di
// src/routes/details/public-home.ts; penomoran fasenya HANYA di sini dan di file itu.
// Sisa Fase 4a yang belum diendpoint-kan: PendingPaymentDto — per-user, jadi tempatnya customer-api
// dan tidak boleh ikut ter-cache bersama HomeDto.
//
// Fase 5 SELESAI tanpa DTO unit: halaman /facilities dan /pricing ternyata TIDAK memuat units
//              (controller-nya hanya eager-load category+prices). Yang butuh unit adalah /booking —
//              lihat BookingFacilityDto di blok Fase 6.
// Fase 6 SELESAI: sisi CUSTOMER (booking, riwayat, transaksi, profil, identitas, ulasan) ada di blok
// "Fase 6" di bawah. Sisi admin sudah ada di blok 8C/8E.
// Fase 8G SELESAI: layar Role & Access + Internal Users memakai AdminRoleDto / AdminStaffUserDto
// di blok "Fase 8G" di bawah.
//
// Aturannya sama untuk semuanya: DTO ditulis DI SINI lebih dulu, baru service API
// mengembalikannya. Setiap penambahan atau perubahan field WAJIB diikuti
// npm run sync:contracts di ubsc-landing DAN ubsc-admin pada commit yang sama-sama
// di-review, kalau tidak /api/meta/contract-hash akan mulai berteriak saat boot dev.

// ===== Beranda publik (Fase 4a) =====
//
// Padanan satu-lawan-satu payload Inertia HomeController@index (HomeController.php:23-77) ditambah dua
// prop publik dari HandleInertiaRequests::share (announcements, gym_traffic), MINUS seluruh prop per-user
// (auth, flash, admin_notifications, pending_payment). Kunci snake_case Laravel dikonversi ke camelCase
// sesuai ketetapan Fase 3 (docs/fase-3.md) — `venue_type` -> `venueType`, `price_range` -> `priceRange`,
// `reviewer_name` -> `reviewerName`, dan seterusnya.
//
// EMPAT aturan yang mengikat seluruh blok ini. Melanggarnya mengubah TAMPILAN, bukan cuma tipe:
//
// 1. MEDIA KOSONG = "" (string kosong), BUKAN null. spatie getFirstMediaUrl() mengembalikan string kosong
//    saat koleksi kosong, dan ImageCarousel.tsx:19 membuang slide berdasarkan `src` yang falsy. Berlaku
//    untuk PromoDto.src, SponsorDto.img, NewsDto.image, ReelDto.thumbnail, ReelDto.videoUrl, FacilityDto.image.
//    PENGECUALIAN: TestimonialDto.image dan TestimonialDto.authorLogo memang `string | null` di Laravel
//    (Testimonial::imageUrl()/logoUrl(), Testimonial.php:34-42) — jangan diseragamkan jadi "".
//
// 2. TANGGAL DIKIRIM SEBAGAI STRING TER-FORMAT, bukan ISO. 'd.m.Y' (news) dan 'd/m Y' (reels) bukan pola
//    yang bisa dihasilkan opsi Intl mana pun; mengirim ISO memaksa formatter kedua di sisi Next dan itu
//    dilarang R13 (format-parity.mjs akan gagal). Port-nya: formatDateDotID / formatDateSlashSpaceID di
//    shared/format.ts. Instan ISO-8601 UTC hanya dipakai PendingPaymentDto.holdExpiresAt, persis Fase 3.
//
// 3. UANG DIKIRIM MENTAH (number) di blok ini, berbeda dari blok booking Fase 3. Laravel mengirim
//    `price` dan `total` sebagai int dan TSX yang memformatnya (SectionTwo.tsx:113 Intl.NumberFormat("id-ID")
//    -> formatNumberID di FE). Satu-satunya string uang di sini adalah FacilityDto.priceRange, yang memang
//    sudah dirakit server oleh Laravel.
//
// 4. ID adalah uuid String (bukan int seperti Laravel). Tipe FE yang masih mengunci `id: number`
//    (PublicReview, MembershipPlanItem, HomeFacility, pending_payment.booking_id) dilonggarkan saat port.

/**
 * Satu baris info banner.
 *
 * Laravel mengirim ARRAY STRING POLOS, bukan array objek: InfoBanner::active()->ordered()->pluck('message')
 * (HandleInertiaRequests.php:52-54). Alias ini hanya memberi bentuk itu sebuah nama — jangan dinaikkan jadi
 * interface: InfoBanner.tsx:13-17 merender elemennya apa adanya, objek akan tampil "[object Object]".
 * Urutan: sortOrder ASC lalu createdAt ASC — port scopeOrdered `orderBy('sort_order')->orderBy('id')`
 * (InfoBanner.php:22-25), di mana kunci kedua atas PK auto-increment berarti urutan penyisipan. PK di sini
 * uuid v4 (acak) dan karena itu TIDAK dipakai sebagai kunci urut. Tanpa limit.
 */
export type AnnouncementDto = string

/**
 * Isi system_settings.value untuk key 'gym_traffic', APA ADANYA.
 *
 * SENGAJA `string`, BUKAN union. Laravel meneruskan isi kolom tanpa memeriksanya (`SystemSetting::get`,
 * HandleInertiaRequests.php:56-58) dan GymTrafficBadge.tsx merender nilai itu sebagai TEKS badge. Union di
 * tipe ini memaksa service menjatuhkan nilai di luar keempatnya ke 'Low Occupancy', sehingga teks badge
 * berbeda dari Laravel untuk baris yang sama — tipe tidak boleh mengubah data. Warnanya tidak pernah ikut
 * bergantung pada union ini: GymTrafficBadge.tsx:20-44 sudah punya cabang `default` = warna Low.
 *
 * Yang TETAP jatuh ke 'Low Occupancy' hanya tiga keadaan yang Laravel juga default-kan: baris tidak ada,
 * kolom value null, dan tabelnya belum ada (`Schema::hasTable`). Lihat getGymTraffic()
 * (src/services/cms-services.ts).
 */
export type GymTrafficDto = string

/**
 * Empat nilai yang ditegakkan validasi `in:` pada jalur tulis admin (routes/web.php:620) — DOKUMENTASI dan
 * bahan jalur TULIS, bukan penyempit GymTrafficDto.
 *
 * Jangan memakai tipe ini untuk menyaring atau menyempitkan nilai yang dikirim endpoint publik: itu persis
 * penyimpangan yang dibuang di atas. Tempatnya adalah validasi input admin, di mana Laravel pun menolak
 * nilai lain.
 */
export type KnownGymTrafficDto = 'High Occupancy' | 'Medium Occupancy' | 'Low Occupancy' | 'We Are Close'

/**
 * Kartu paket membership di beranda dan halaman pricing.
 *
 * Dibentuk manual lewat ->map() di HomeController.php:32-46 (BUKAN JsonResource), jadi daftar field di
 * bawah lengkap apa adanya. Filter isActive=true, urut sortOrder ASC tanpa tie-breaker, tanpa limit.
 *
 * price mentah — SectionTwo.tsx:486 yang memformatnya. features memakai fallback [] saat kolom json null
 * (`$p->features ?? []`), jangan dikirim null. activeMembersCount = COUNT(memberships WHERE
 * membership_plan_id = plan.id AND status='active') — withCount, bukan kolom (HomeController.php:27-29).
 */
export interface MembershipPlanDto {
  id: string
  name: string
  description: string | null
  publicBadge: string | null
  savingsLabel: string | null
  ctaLabel: string | null
  cardImageUrl: string | null
  /** Harga umum. */
  price: number
  /** Harga Warga UB terverifikasi; null = paket tanpa tarif khusus (harga umum berlaku). */
  wargaPrice: number | null
  durationMonths: number
  features: string[]
  isActive: boolean
  sortOrder: number
  activeMembersCount: number
}

/**
 * Slide carousel promo — PromoCarouselResource.php:12-16.
 *
 * src = media koleksi 'slide' singleFile, "" bila kosong (aturan 1; ImageCarousel.tsx:19 membuang slide itu).
 * alt = kolom title yang memang nullable. Filter isActive, urut sortOrder ASC, tanpa limit.
 */
export interface PromoDto {
  id: string
  src: string
  alt: string | null
}

/**
 * Logo sponsor untuk LogoMarquee — SponsorLogoResource.php:12-16.
 *
 * img = media koleksi 'logo', "" bila kosong. Field `link` yang ada di tipe FE (LogoMarquee.tsx:3-8) TIDAK
 * pernah dikirim server dan tidak ditambahkan di sini. Filter isActive, urut sortOrder ASC, tanpa limit.
 */
export interface SponsorDto {
  id: string
  name: string
  img: string
}

/**
 * Kartu berita/artikel — NewsResource.php:12-20.
 *
 * date sudah terformat 'd.m.Y' ("05.10.2026", formatDateDotID) dan WAJIB "" bila publishedAt null, bukan
 * '-' bawaan format.ts: baris berstatus published dengan publishedAt null tetap lolos filter (NewsResource.php:15).
 * category adalah NAMA NewsCategory dan wajib persis 'Berita' atau 'Artikel' — NewsCard.tsx:5 mengetiknya
 * sebagai union dan memilih layoutOverride dari situ; "" bila relasi tidak ada. image = media 'thumbnail', ""
 * bila kosong. description = kolom excerpt. Filter status='published', urut publishedAt DESC, LIMIT 7.
 */
export interface NewsDto {
  id: string
  title: string
  slug: string
  date: string
  category: string
  image: string
  description: string | null
  /** Bagian URL publik: /artikel/<slug> bila slug kategori 'artikel', selain itu (termasuk tanpa kategori) /berita/<slug>. */
  section: NewsSection
  /** ISO 8601 UTC — untuk <time dateTime>, JSON-LD, dan sitemap. `date` tetap teks tampilan. */
  publishedAt: string | null
  /** ISO 8601 UTC. */
  updatedAt: string
  noindex: boolean
}

export type NewsSection = 'berita' | 'artikel'

/**
 * SEO artikel yang SUDAH diresolusi server: title = metaTitle || judul; description = metaDescription ||
 * (excerpt || teks isi), keduanya dipotong ~160 karakter di batas kata + '…'; ogImage = media 'og_image' ||
 * thumbnail || '' (URL seperti publicUrl: relatif '/uploads/...' di lokal, absolut di R2).
 */
export interface NewsSeoDto {
  title: string
  description: string
  ogImage: string
  noindex: boolean
}

/** GET /api/public/news/:slug — hanya status 'published', selain itu 404. */
export interface NewsDetailDto extends NewsDto {
  /** HTML yang sudah disanitasi server (aman untuk dangerouslySetInnerHTML). */
  content: string
  authorName: string
  readingMinutes: number
  seo: NewsSeoDto
  /** Maks 3 artikel terbit terbaru di section yang sama, tanpa artikel ini. */
  related: NewsDto[]
}

/**
 * GET /api/public/seo — HANYA halaman yang punya baris di DB. null = pakai default SEO_PAGES (shared/seo.ts).
 * ogImage null = pakai OG image bawaan landing.
 */
export interface PageSeoDto {
  key: SeoPageKey
  title: string | null
  description: string | null
  ogImage: string | null
  noindex: boolean
}

/** GET /api/admin/seo-pages — SELURUH SEO_PAGES (urutan yang sama), digabung dengan baris DB. */
export interface AdminPageSeoDto extends PageSeoDto {
  label: string
  path: string
  defaultTitle: string
  defaultDescription: string
  /** Waktu relatif Bahasa Indonesia (diffForHumans), null bila belum pernah disimpan. */
  updatedAt: string | null
}

/** POST /api/admin/news/content-images — gambar yang disisipkan ke isi artikel lewat editor. */
export interface NewsContentImageDto {
  url: string
}

/**
 * Kartu reel — ReelResource.php:12-19.
 *
 * date terformat 'd/m Y' ("05/10 2026", formatDateSlashSpaceID) dari createdAt yang NOT NULL. thumbnail dan
 * videoUrl = media 'thumbnail'/'video', "" bila kosong. isActive selalu true karena sudah difilter scope —
 * dipertahankan hanya demi paritas bentuk dengan ReelItem (ReelCard.tsx:4-11).
 * Filter isActive, urut createdAt DESC (latest() tanpa argumen), LIMIT 8.
 */
export interface ReelDto {
  id: string
  title: string
  date: string
  thumbnail: string
  videoUrl: string
  isActive: boolean
}

/**
 * Testimoni — ->map() manual di HomeController.php:62-69; Laravel sudah memakai camelCase di sini.
 *
 * image dan authorLogo SENGAJA `string | null` (pengecualian aturan 1): Testimonial::imageUrl() dan
 * logoUrl() memakai `?:` sehingga string kosong media jatuh ke null (Testimonial.php:34-42).
 *
 * Rantai fallback berkas statis per author_name (Testimonial.php:44-59: 'ub football club' |
 * 'malang tennis academy' | 'brawijaya badminton club' -> assets/icons/*.avif, dijaga file_exists(public_path))
 * TIDAK ikut ke API: ubsc-api tidak bisa memeriksa public/ milik repo Next dan tidak boleh menebak URL aset
 * yang dimiliki repo lain. API mengembalikan URL media atau null; pemetaan nama->aset hidup di ubsc-landing
 * berdampingan dengan SectionSeven (berkas .avif-nya memang sudah diimpor di SectionSeven.tsx:6-7), dan
 * semantik akhirnya tetap sama: media -> aset statis -> null.
 * Filter isActive, urut sortOrder ASC, tanpa limit.
 */
export interface TestimonialDto {
  id: string
  image: string | null
  quote: string
  authorName: string
  authorRole: string
  authorLogo: string | null
}

/**
 * Ulasan publik — ->map() manual di HomeController.php:70-75.
 *
 * reviewerName memakai fallback 'Guest' saat kolom null (`$r->reviewer_name ?? 'Guest'`). userId, isApproved,
 * dan createdAt sengaja TIDAK dikirim. rating Float (decimal(3,1) di Laravel).
 * Filter isApproved, urut createdAt DESC, LIMIT 10.
 *
 * Catatan status: di BERANDA ini prop mati — SectionSeven.tsx:50 mendeklarasikan `reviews` tapi tidak pernah
 * men-destructure-nya, jadi tidak ada satu piksel pun yang bergantung padanya. DTO tetap ada karena halaman
 * lain memakainya; jangan menghapusnya hanya karena beranda tidak membacanya.
 */
export interface ReviewDto {
  id: string
  reviewerName: string
  rating: number
  text: string
}

/** Kategori yang melekat pada BARIS HARGA (bukan pada user). Cermin enum UserCategory di schema.prisma. */
export type UserCategory = 'warga_ub' | 'umum'

/**
 * Satu baris harga fasilitas — FacilityPriceResource.php:12-25.
 *
 * startsAt/endsAt "HH:mm" (Laravel memotong substr 0,5 dari kolom time; di Prisma kolomnya memang VarChar(5)).
 * startsOn/endsOn tanggal kalender "YYYY-MM-DD" tanpa zona. applicableDays array hari dari kolom json, null
 * bila kosong. scheduleType tetap String bebas ('regular' adalah tier fallback, bukan rule).
 * Kolom priceType dan sortOrder ADA di schema.prisma tetapi TIDAK dikirim Laravel di jalur publik ini —
 * jangan ditambahkan, bentuk JSON-nya akan berbeda dari Laravel.
 */
export interface FacilityPriceDto {
  id: string
  userCategory: UserCategory
  label: string
  price: number
  durationMinutes: number | null
  scheduleType: string
  applicableDays: string[] | null
  startsAt: string | null
  endsAt: string | null
  startsOn: string | null
  endsOn: string | null
  notes: string | null
}

/**
 * Fasilitas untuk kartu beranda — FacilityResource.php:12-38 pada jalur HomeController.
 *
 * TIDAK ADA `units` DI SINI, DAN ITU DISENGAJA. FacilityResource.php:26 memakai whenLoaded('units')
 * sedangkan HomeController.php:60 hanya eager-load 'category' dan 'prices', jadi key-nya dibuang total
 * (MissingValue) — bukan dikirim sebagai array kosong. Karena field-nya tidak ada di tipe ini, service yang
 * mencoba menambahkannya akan ditolak compiler, dan itu penjaga yang diinginkan. Halaman fasilitas (Fase 5)
 * yang memang butuh unit mendapat DTO sendiri yang memperluas tipe ini.
 *
 * image = media 'hero', "" bila kosong. category = NAMA FacilityCategory, "" bila relasi tidak dimuat, dan
 * WAJIB persis 'Lapangan & Arena' / 'Kelas & Kebugaran' — SectionFour.tsx:276,289,300 memfilter dengan
 * string literal itu; salah satu spasi saja membuat section kosong tanpa error. bookingMode default 'court',
 * capacity default 1, rating Float default 5.0.
 *
 * prices: SELURUH baris harga fasilitas, TANPA filter dan TANPA urutan (Facility::prices(), Facility.php:58-61
 * tidak punya orderBy; kolom facility_prices.sort_order tidak dipakai di jalur ini).
 *
 * priceRange: string siap tampil, dirakit server (FacilityResource.php:41-54). BUKAN formatRupiah — Laravel
 * memakai 'Rp' + number_format(n,0,',','.') TANPA SPASI. Port-nya formatRupiahTight():
 *   kosong        -> 'Harga belum tersedia'
 *   min === max   -> `${formatRupiahTight(min)} / Jam`
 *   selain itu    -> `${formatRupiahTight(min)} - ${formatRupiahTight(max)} / Jam`
 * min/max diambil dari SELURUH baris harga, lintas userCategory dan lintas scheduleType.
 *
 * Filter isActive, urut sortOrder ASC, tanpa limit.
 */
export interface FacilityDto {
  id: string
  name: string
  slug: string
  image: string
  category: string
  location: string | null
  venueType: string | null
  bookingMode: string
  capacity: number
  classCode: string | null
  rating: number
  displayMetadata: Record<string, unknown> | null
  prices: FacilityPriceDto[]
  priceRange: string
}

/**
 * GET /api/public/home — seluruh data beranda dalam satu balasan.
 *
 * Isinya persis prop PUBLIK payload Inertia '/' (HomePage.tsx:88-97 + HandleInertiaRequests::share), tidak
 * lebih dan tidak kurang. Prop per-user TIDAK boleh masuk ke sini: `auth` dan `pendingPayment` diambil
 * terpisah lewat TanStack Query dengan enabled:!!user supaya '/' tetap bisa ISR 300s, `flash` diganti store
 * toast klien, dan `admin_notifications` dibuang (selalu payload kosong di landing, hanya dibaca Admin/Topbar).
 *
 * Ringkasan sort/limit yang wajib dipegang service. LIMIT di bawah milik BERANDA, bukan milik service-nya:
 * listNews/listReels/listReviews menerima limit sebagai argumen wajib (HOME_*_LIMIT di cms-services.ts),
 * supaya halaman granular yang di Laravel tidak dibatasi tidak ikut terpotong.
 *   membershipPlans  isActive,          sortOrder ASC,                tanpa limit
 *   promos           isActive,          sortOrder ASC,                tanpa limit
 *   sponsors         isActive,          sortOrder ASC,                tanpa limit
 *   news             status=published,  publishedAt DESC,             LIMIT 7
 *   reels            isActive,          createdAt DESC,               LIMIT 8
 *   facilities       isActive,          sortOrder ASC,                tanpa limit
 *   testimonials     isActive,          sortOrder ASC,                tanpa limit
 *   reviews          isApproved,        createdAt DESC,               LIMIT 10
 *   announcements    isActive,          sortOrder ASC lalu createdAt ASC, tanpa limit
 *
 * Media untuk promos/sponsors/news/reels/facilities WAJIB dimuat sebagai satu batch lewat
 * media-services.listFor() (schema.prisma:790-793) — bukan satu query per baris.
 */
export interface HomeDto {
  membershipPlans: MembershipPlanDto[]
  promos: PromoDto[]
  sponsors: SponsorDto[]
  news: NewsDto[]
  reels: ReelDto[]
  facilities: FacilityDto[]
  testimonials: TestimonialDto[]
  reviews: ReviewDto[]
  announcements: AnnouncementDto[]
  gymTraffic: GymTrafficDto
}

/**
 * Transfer tertunda paling mendesak milik satu customer, atau null — padanan prop per-user `pending_payment`
 * (HandleInertiaRequests.php:62 dan 71-103). Dibaca Navbar lewat TanStack Query, BUKAN RSC: nilainya
 * bergantung pemanggil dan tidak boleh ikut ter-cache bersama HomeDto.
 *
 * count           jumlah booking pending yang hold-nya belum lewat (hold null = ditahan selamanya, ikut dihitung)
 * awaitingCount   di antaranya yang buktinya sudah diunggah (verificationStatus='awaiting')
 * bookingId       booking terpilih: yang PERTAMA bukan 'awaiting', kalau tidak ada baru elemen pertama
 * receipt         nomor invoice 'UBSC-X-2026-0001'; null bila transaksinya tidak terbaca
 * total           amount + adminFee + uniqueCode, MENTAH (Navbar yang memformat), 0 bila transaksi tidak ada
 * holdExpiresAt   ISO-8601 UTC atau null
 * url             tujuan pill. Padanan route('booking.payment', $booking) Laravel, dirakit dari env LANDING_URL
 *                 + '/booking/{bookingId}/pembayaran' supaya href-nya identik dan landing tidak perlu logika
 *                 tambahan. Satu-satunya URL milik repo lain yang dirakit API di Fase 4a.
 *
 * null juga saat user adalah staff (di Laravel staff tidak pernah sampai ke '/').
 */
export interface PendingPaymentDto {
  count: number
  awaitingCount: number
  bookingId: string
  receipt: string | null
  awaiting: boolean
  total: number
  holdExpiresAt: string | null
  url: string
}

// ===== Booking & pembayaran (Fase 3) =====
//
// Nilai string harga (`price`, `total`) sudah terformat "Rp 1.500.000" dengan SPASI BIASA, persis
// keluaran number_format() Laravel — bukan Intl (yang memakai non-breaking space). Klien boleh
// menampilkan apa adanya; untuk hitungan selalu pakai pasangan `...Raw`.
// Tanggal kalender "YYYY-MM-DD" dan jam "HH:mm" selalu waktu Jakarta. Instan (holdExpiresAt,
// proofUploadedAt) ISO-8601 UTC.

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed'
export type PaymentStatus = 'UNPAID' | 'PAID' | 'EXPIRED' | 'FAILED'
export type VerificationStatus = 'awaiting' | 'rejected'

/** Status satu slot lapangan. Tiga keadaan, bukan dua: slot yang lewat tidak sama dengan slot yang terjual. */
export type SlotStatus = 'available' | 'booked' | 'past'

export interface SlotDto {
  startTime: string
  endTime: string
  label: string
  price: string
  priceRaw: number
  status: SlotStatus
  past: boolean
  wasBooked: boolean
  remaining: number
  capacity: number
  facilityUnitId: string | null
}

export type ClosedReason = 'month_closed' | 'date_closed'

/** GET /api/public/booking/slots */
export interface SlotsDto {
  closed: boolean
  reason?: ClosedReason
  requiresUnit?: boolean
  slots: SlotDto[]
  closedDates: string[]
}

/** Status satu sesi kelas. `full` diuji sebelum `past` supaya sesi yang habis lalu berjalan tidak mengaku kosong. */
export type SessionStatus = 'available' | 'full' | 'past' | 'closed' | 'cancelled'

export interface MonthSessionDto {
  date: string
  startTime: string
  endTime: string
  label: string
  price: string
  priceRaw: number
  status: SessionStatus
  past: boolean
  wasBooked: boolean
  remaining: number
  capacity: number
  alreadyBooked: boolean
  facilityUnitId: string | null
}

export interface MonthDayDto {
  weekday: string
  closed: boolean
  sessions: MonthSessionDto[]
}

export interface MonthPatternDto {
  weekday: string
  weekdayLabel: string
  startTime: string
  endTime: string
  sessionCount: number
}

export interface MonthPackageDto {
  priceRaw: number
  price: string
  sessionCount: number
  savingRaw: number
}

export interface MonthSummaryDto {
  sessionCount: number
  availableCount: number
  totalRaw: number
  total: string
  package: MonthPackageDto | null
}

/** GET /api/public/booking/month */
export interface MonthDto {
  month: string
  monthLabel: string
  closedDates: string[]
  closed: boolean
  reason: ClosedReason | null
  requiresUnit: boolean
  capacity?: number
  sessionNote?: string
  /** Dikunci "YYYY-MM-DD"; hanya tanggal yang punya sesi. */
  days: Record<string, MonthDayDto>
  patterns: MonthPatternDto[]
  summary: MonthSummaryDto
}

/** POST /api/customer/booking — satu rentang lapangan ATAU banyak sesi kelas. */
export interface CreateBookingRequest {
  facilityId: string
  facilityUnitId?: string | null
  bookingDate?: string
  startTime?: string
  endTime?: string
  sessions?: Array<{ date: string; startTime: string; endTime: string }>
  notes?: string | null
}

export interface BookingCreatedDto {
  /** Booking lead — id yang dipakai halaman pembayaran. */
  bookingId: string
  transactionId: string
  holdExpiresAt: string
}

export interface BookingSessionDto {
  id: string
  /** Carbon translatedFormat('D, d M Y'): "Sen, 17 Agt 2026". */
  date: string
  /** "08:00 – 09:00" (en dash). */
  time: string
  status: BookingStatus
  checkedInAt?: string | null
  checkInUrl?: string | null
}

/**
 * GET /api/customer/booking/:bookingId/pembayaran bila id yang diminta adalah ANGGOTA paket.
 * Hanya lead yang memegang transfer; klien mengganti URL ke lead lalu meminta ulang.
 */
export interface PaymentRedirectDto {
  redirectToBookingId: string
}

/** Instruksi + status satu transfer manual — dipakai halaman bayar booking dan membership. */
export interface TransferPaymentDto {
  receiptNumber: string
  amount: number
  adminFee: number
  uniqueCode: number
  /** amount + adminFee + uniqueCode — nominal yang harus ditransfer persis. */
  total: number
  paymentStatus: PaymentStatus
  verificationStatus: VerificationStatus | null
  rejectionReason: string | null
  proofUploadedAt: string | null
  hasProof: boolean
  canUpload: boolean
}

/**
 * GET /api/customer/booking/:bookingId/pembayaran, dan balasan
 * POST /api/customer/booking/:bookingId/pembayaran/bukti (keadaan terbaru setelah bukti masuk).
 */
export interface PaymentDetailDto {
  /** Hanya untuk paket: seluruh sesinya, urut tanggal lalu jam. */
  sessions: BookingSessionDto[] | null
  booking: {
    id: string
    facilityName: string
    unitName: string | null
    date: string
    startTime: string
    endTime: string
    status: BookingStatus
    holdExpiresAt: string | null
  }
  payment: TransferPaymentDto
  bank: { bank: string; accountNumber: string; accountHolder: string }
  /** QRIS merchant; bila ada, halaman bayar memakainya alih-alih rekening bank. */
  qris: PaymentQrisDto | null
  ticket: { checkInUrl: string; checkedInAt: string | null } | null
}

/** GET /api/customer/booking — satu kartu per pembelian (paket = satu kartu), maksimal 50. */
export interface BookingHistoryItemDto {
  sessions: BookingSessionDto[] | null
  id: string
  facilityName: string
  unitName: string | null
  date: string
  startTime: string
  endTime: string
  status: BookingStatus
  amount: number
  paymentStatus: PaymentStatus
  verificationStatus: VerificationStatus | null
  transferTotal: number
  hasPayment: boolean
  holdExpiresAt: string | null
  hasTicket: boolean
  checkedInAt: string | null
  receipt: string | null
  createdAt: string
}

/** POST /api/admin/payments/:transactionId/approve | reject */
export interface PaymentDecisionDto {
  transactionId: string
  receiptNumber: string
  /**
   * true bila email pemberitahuan SUDAH DIANTREKAN ke pelanggan (pelanggan punya alamat email).
   * BUKAN "terkirim": email dikirim `void` setelah commit (R8), jadi hasil SMTP tidak ditunggu.
   * Kegagalan kirim tercatat di email_logs dan bisa dikirim ulang dari panel admin.
   */
  mailQueued: boolean
}

// ===== Dashboard admin (GET /api/admin/dashboard) =====
//
// Padanan controller inline Laravel `Route::get('/')` di routes/web.php (blok Dashboard) yang
// merender Pages/Admin/Dashboard.tsx. Semua uang mentah `number` (rupiah) — FE yang memformat.
// Field snake_case Laravel (gym_traffic, info_banners, is_active, sort_order) DIUBAH ke camelCase
// di kabel; port Dashboard.tsx menyesuaikan namanya.

/** Kartu statistik atas dashboard. */
export interface DashboardStatsDto {
  pendingIdentities: number
  activeFacilities: number
  todaysBookings: number
  totalRevenue: number
  activeMemberships: number
}

/** Satu bar okupansi lapangan hari ini (hanya fasilitas bookingMode 'court'). */
export interface OccupancyFacilityDto {
  name: string
  pct: number
  color: string
}

/** Satu baris feed aktivitas terbaru (gabungan booking/membership/payment). */
export interface RecentActivityDto {
  id: string
  type: 'booking' | 'membership' | 'payment'
  title: string
  subtitle: string
  /** Waktu relatif Indonesia, mis. "2 jam yang lalu". */
  time: string
}

/**
 * Info banner dashboard. Laravel mengirim is_active/sort_order (snake); di sini camelCase.
 * Semua banner dikirim (bukan hanya isActive), diurut sortOrder ASC — panel mengelola aktif/nonaktif.
 * TULIS (tambah/edit/hapus/urut) ditunda Fase 8; Fase 7 hanya membaca.
 */
export interface InfoBannerDto {
  id: string
  message: string
  isActive: boolean
  sortOrder: number
}

export interface DashboardDto {
  /** Kunjungan gym tercatat hari ini (tahap D) — acuan saat mengisi label gym traffic yang manual. */
  gymVisitsToday: number
  stats: DashboardStatsDto
  /** Persentase perubahan pendapatan vs bulan lalu (1 desimal). */
  revenueTrend: number
  /** Pendapatan per hari bulan berjalan (1 nilai per tanggal, 0 bila kosong), sampai hari ini. */
  dailyRevenue: number[]
  daysInMonth: number
  currentDayInMonth: number
  /** Label bulan Indonesia, mis. "Sep 2025" (translatedFormat 'M Y'). */
  currentMonthLabel: string
  occupancyData: OccupancyFacilityDto[]
  recentActivity: RecentActivityDto[]
  /** Nilai SystemSetting 'gym_traffic' (default 'Low Occupancy'). */
  gymTraffic: string
  infoBanners: InfoBannerDto[]
}

// ===== Admin: Facilities (Fase 8A) =====
//
// Bentuk mengikuti transformFacility()/transformUnit() controller Laravel, tapi camelCase di kabel
// (FE port yang rename dari snake_case Laravel). Uang mentah Int. Slot/kuota/metadata = Json apa adanya.

/** Referensi satu berkas media (hero/gallery/unit image). */
export interface MediaRefDto {
  id: string
  url: string
  name: string
  orderColumn: number | null
}

/** Slot jadwal mingguan: { "Wednesday": ["15:00","16:00"] }. */
export type WeeklySlotsDto = Record<string, string[]>
/** Kuota per slot: { "Wednesday": { "15:00": 10 } }. */
export type SlotQuotasDto = Record<string, Record<string, number>>

/** Kategori fasilitas (panel inline di halaman index). */
export interface FacilityCategoryDto {
  id: string
  name: string
  slug: string
  description: string | null
  sortOrder: number
  facilitiesCount: number
}

/** Satu baris harga (fasilitas ATAU unit) — schedule_type regular/always/weekly/date_range. */
export interface FacilityPriceRowDto {
  id?: string
  userCategory: 'warga_ub' | 'umum'
  priceType?: string
  label: string
  price: number
  durationMinutes: number | null
  scheduleType: string
  applicableDays: string[] | null
  startsAt: string | null
  endsAt: string | null
  startsOn: string | null
  endsOn: string | null
  notes: string | null
  sortOrder: number
}

/** Kartu fasilitas admin (list index + edit). displayMetadata bentuk bebas (MetadataBuilder FE). */
export interface AdminFacilityDto {
  id: string
  name: string
  slug: string
  description: string | null
  location: string | null
  venueType: string | null
  capacity: number
  bookingMode: string
  activeSlots: WeeklySlotsDto | null
  slotQuotas: SlotQuotasDto | null
  sessionNote: string | null
  classCode: string | null
  /** Nomor barang/jasa Accurate (kolom ITEM:ITEM NO export faktur) untuk tarif umum. */
  accurateItemNo: string | null
  /** Nomor barang/jasa Accurate untuk tarif Warga UB — Accurate memakai item berbeda per tarif. */
  accurateItemNoWarga: string | null
  rating: number
  displayMetadata: unknown
  isActive: boolean
  sortOrder: number
  pricesCount: number
  unitsCount: number
  category: { id: string; name: string; slug: string } | null
  hero: MediaRefDto | null
  gallery: MediaRefDto[]
}

/** GET /api/admin/facilities — daftar penuh + kategori (tanpa paginasi, mirip .get() Laravel). */
export interface AdminFacilityIndexDto {
  facilities: AdminFacilityDto[]
  categories: FacilityCategoryDto[]
}

/** GET /api/admin/facilities/:id (edit) atau /create — payload form. facility null = create. */
export interface AdminFacilityFormDto {
  facility: AdminFacilityDto | null
  categories: { id: string; name: string }[]
  customScheduleGroups: string[]
  sessionNoteDefault: string
}

/** GET /api/admin/facilities/:id/pricing. */
export interface AdminFacilityPricingDto {
  facility: { id: string; name: string; bookingMode: string }
  prices: FacilityPriceRowDto[]
}

/** Satu unit fasilitas (di mode class = grup kelas paralel). */
export interface AdminFacilityUnitDto {
  id: string
  facilityId: string
  name: string
  capacity: number
  isActive: boolean
  useCustomSchedule: boolean
  activeSlots: WeeklySlotsDto | null
  slotQuotas: SlotQuotasDto | null
  useCustomPricing: boolean
  prices: FacilityPriceRowDto[]
  imageUrl: string | null
  createdAt: string
}

/** GET /api/admin/facilities/:id/units. */
export interface AdminFacilityUnitsDto {
  facility: { id: string; name: string; slug: string; bookingMode: string; category: string | null; image: string | null }
  units: AdminFacilityUnitDto[]
}

// ===== Admin: Booking / Check-in / Class roster (Fase 8B) =====
//
// Bentuk mengikuti transformBooking()/present()/buildMonth() controller Laravel, camelCase di kabel.
// Uang mentah Int. date/time/today di bawah = string yang SUDAH diformat server (translatedDate).

/** Transaksi yang menempel pada satu booking (via payableTransaction = lead group). */
export interface BookingTransactionDto {
  id: string
  amount: number
  adminFee: number
  uniqueCode: number | null
  /** amount + adminFee + uniqueCode — yang ditransfer pelanggan walk-in. */
  total: number
  paymentStatus: PaymentStatus
  receiptNumber: string | null
  checkoutUrl: string | null
  paidAt: string | null
  verificationStatus: VerificationStatus | null
  proofUploadedAt: string | null
  proofUrl: string | null
  rejectionReason: string | null
}

/** Baris booking di halaman kelola reservasi (transformBooking). */
export interface AdminBookingDto {
  id: string
  userId: string | null
  facilityId: string
  facilityUnitId: string | null
  bookingDate: string
  startTime: string
  endTime: string
  subtotalPrice: number
  status: BookingStatus
  notes: string | null
  customerName: string
  customerPhone: string | null
  isFree: boolean
  userCategory: 'warga_ub' | 'umum'
  effectiveStatus: BookingStatus
  facilityName: string
  bookingMode: string
  facilityUnitName: string | null
  checkedInAt: string | null
  checkedInBy: string | null
  checkInUrl: string | null
  hasEnded: boolean
  transaction: BookingTransactionDto | null
}

/** Opsi fasilitas untuk filter + form create. */
export interface FacilityOptionDto {
  id: string
  name: string
  bookingMode: string
  units: { id: string; name: string }[]
}

/** GET /api/admin/bookings — daftar penuh (tanpa paginasi, seperti Laravel) + opsi fasilitas. */
export interface AdminBookingIndexDto {
  bookings: AdminBookingDto[]
  facilities: FacilityOptionDto[]
}

/** POST /api/admin/bookings — walk-in staff. */
export interface AdminBookingCreatedDto {
  bookingId: string
  transactionId: string
  /** Nominal yang harus ditransfer tamu (harga + biaya admin + kode unik); 0 untuk booking gratis. */
  total: number
}

/** Baris meja check-in (present()). date/time = string terformat. */
export interface DeskBookingDto {
  id: string
  receiptNumber: string
  customer: { name: string; email: string | null; phone: string | null }
  facility: string
  unit: string | null
  date: string
  isToday: boolean
  time: string
  status: BookingStatus
  paymentStatus: PaymentStatus
  amount: number
  checkedInAt: string | null
  checkedInBy: string | null
  checkInUrl: string | null
}

/** GET /api/admin/checkin?q= — daftar hari ini + query + label tanggal. */
export interface CheckInIndexDto {
  bookings: DeskBookingDto[]
  search: string
  today: string
}

/** GET /api/admin/checkin/:token — satu booking untuk konfirmasi (identityStatus ikut). */
export interface CheckInDetailDto {
  id: string
  receiptNumber: string
  customer: { name: string; email: string | null; phone: string | null; identityStatus: string | null }
  facility: string
  unit: string | null
  date: string
  isToday: boolean
  time: string
  status: BookingStatus
  paymentStatus: PaymentStatus
  amount: number
  checkedInAt: string | null
  checkedInBy: string | null
}

// ---- Class roster ----
export interface ClassOptionDto {
  id: string
  name: string
  units: { id: string; name: string; capacity: number }[]
}

export interface SessionCellDto {
  startTime: string
  endTime: string
  taken: number
  capacity: number
  cancelled: boolean
}

export interface DayCellDto {
  weekday: string
  closed: boolean
  sessions: SessionCellDto[]
}

export interface RosterRowDto {
  id: string
  startTime: string
  name: string
  phone: string | null
  status: string
  paymentStatus: string
  receipt: string | null
  checkedInAt: string | null
  isPackage: boolean
}

/** GET /api/admin/classes — roster bulanan kelas. days keyed "YYYY-MM-DD". */
export interface ClassRosterDto {
  classes: ClassOptionDto[]
  facility: { id: string; name: string } | null
  unit: { id: string; name: string } | null
  month: string
  monthLabel: string
  days: Record<string, DayCellDto>
  date: string | null
  roster: RosterRowDto[]
}

// ===== Admin: Membership + Paket (Fase 8C) =====
//
// Bentuk mengikuti MembershipController::transform() + MembershipPlanController::index() Laravel,
// camelCase di kabel. Membership TIDAK punya kolom harga — nominal ada di Transaction (membershipId).
// Tanggal "YYYY-MM-DD"; timestamp "Y-m-d H:i" (formatInstant).

/**
 * pending_payment: dibeli online, transfer belum diverifikasi. Menahan periode (tidak bisa ditumpuk),
 * belum memberi akses; aktif saat transfer disetujui, batal bila kedaluwarsa atau ditolak.
 */
export type MembershipStatus = 'active' | 'expired' | 'cancelled' | 'pending_payment'

/** Transaksi yang menempel pada satu membership (dibuat PAID oleh lifecycle admin). */
export interface MembershipTransactionDto {
  id: string
  amount: number
  adminFee: number
  uniqueCode: number | null
  /** amount + adminFee + uniqueCode — yang ditransfer pelanggan di meja depan. */
  total: number
  paymentStatus: PaymentStatus
  receiptNumber: string | null
  checkoutUrl: string | null
  paidAt: string | null
}

/** Satu baris riwayat (created/renewed/status_changed/cancelled/...). */
export interface MembershipHistoryDto {
  id: string
  action: string
  planName: string
  startDate: string
  endDate: string
  transactionId: string | null
  receiptNumber: string | null
  renewedFromMembershipId: string | null
  renewedFromLabel: string | null
  actorName: string | null
  actorType: string
  amount: number | null
  paymentStatus: string | null
  createdAt: string | null
}

/** Baris membership di halaman kelola anggota (transform()). */
export interface AdminMembershipDto {
  id: string
  userId: string | null
  /** 'UB-7K3F-92QX'; null untuk walk-in tanpa akun. */
  customerNumber: string | null
  /** Foto wajah pemilik akun (tahap B/C); null bila belum ada atau walk-in tanpa akun. */
  memberPhotoUrl: string | null
  memberPhotoStatus: MemberPhotoStatus | null
  membershipPlanId: string | null
  renewedFromMembershipId: string | null
  renewedFromLabel: string | null
  createdByName: string | null
  createdVia: string | null
  planName: string | null
  customerName: string
  customerPhone: string | null
  startDate: string
  endDate: string
  status: MembershipStatus
  transaction: MembershipTransactionDto | null
  histories: MembershipHistoryDto[]
}

/** Opsi paket untuk form create/renew. */
export interface MembershipPlanOptionDto {
  id: string
  name: string
  price: number
  /** null = tanpa tarif Warga UB. */
  wargaPrice: number | null
  durationMonths: number
}

/** GET /api/admin/memberships — daftar penuh (tanpa paginasi, seperti Laravel .get()) + opsi paket. */
export interface AdminMembershipIndexDto {
  memberships: AdminMembershipDto[]
  plans: MembershipPlanOptionDto[]
}

/** POST /api/admin/customers — akun minimal walk-in (tanpa password), balasannya CustomerHitDto. */
export interface CustomerCreatePayload {
  name: string
  email: string
  phoneNumber: string | null
}

/** GET /api/admin/customers/search?q= — maks 8 akun customer (non-staff). q juga cocok ke nomor pelanggan. */
export interface CustomerHitDto {
  id: string
  name: string
  email: string
  phone: string | null
  identityStatus: string
  /** 'UB-7K3F-92QX'. */
  customerNumber: string
  /** Kategori harga (warga_ub hanya bila identitas Warga UB terverifikasi) — menentukan harga paket. */
  priceCategory: UserCategory
}

/** GET /api/admin/memberships/plans — SEMUA paket (aktif & nonaktif), bentuk sama MembershipPlanDto. */
/** Paket di panel admin — MembershipPlanDto beranda + nomor barang/jasa Accurate per tarif (tidak dikirim ke publik). */
export interface AdminMembershipPlanDto extends MembershipPlanDto {
  accurateItemNo: string | null
  accurateItemNoWarga: string | null
}

export interface AdminMembershipPlanIndexDto {
  plans: AdminMembershipPlanDto[]
}

// ============================================================================
// Fase 8D — Verifikasi pembayaran + Laporan keuangan (admin)
// ============================================================================

export type PaymentQueueTab = 'awaiting' | 'rejected' | 'paid'

/** Satu kartu antrean verifikasi (PaymentVerificationController::present Laravel). */
export interface AdminPaymentRowDto {
  id: string
  receiptNumber: string
  amount: number
  adminFee: number
  uniqueCode: number
  /** amount + adminFee + uniqueCode — yang ditransfer pelanggan. */
  total: number
  paymentStatus: PaymentStatus
  verificationStatus: 'awaiting' | 'rejected' | null
  rejectionReason: string | null
  /** Path API relatif ('/admin/payments/:id/bukti') — diambil lewat axios (Bearer) lalu dibuka sebagai blob. */
  proofUrl: string | null
  /** 'd M Y H:i' (mis. '23 Sep 2026 14:05'). */
  proofUploadedAt: string | null
  paidAt: string | null
  verifiedBy: string | null
  customer: { name: string; email: string | null; phone: string | null }
  type: 'booking' | 'membership'
  /** booking: { facility, unit, date ('d M Y'), time ('HH:MM - HH:MM'), status } · membership: { plan }. */
  subject: Record<string, string | null>
}

export interface PaymentBankDto {
  bank: string
  accountNumber: string
  accountHolder: string
}

/**
 * QRIS statis merchant (keputusan client 2026-10-01): pelanggan memindai gambar ini lalu mengetik
 * nominal persis (harga + biaya admin + kode unik) sendiri. imageUrl root-relatif '/uploads/qris/...'.
 */
export interface PaymentQrisDto {
  imageUrl: string
  merchantName: string | null
}

/** Pengaturan pembayaran tersimpan — bagian dari GET /api/admin/payments, dan balasan POST /settings. */
export interface PaymentSettingsDto {
  bank: PaymentBankDto
  /** null = gambar QRIS belum diunggah (POST /api/admin/payments/settings/qris). */
  qris: PaymentQrisDto | null
  holdMinutes: number
  /** Rupiah per transaksi; 0 = biaya admin dimatikan. */
  adminFee: number
  /** Batas atas kode unik (1..999). */
  uniqueCodeMax: number
  /** Kode akun Kas/Bank Accurate untuk export Penerimaan Penjualan; '' = belum diisi. */
  accurateCashAccountNo: string
}

/**
 * GET /api/admin/payments?tab=&q=&page=&perPage= — metode manual, ter-paginasi (perPage 1..100, default 20;
 * meta paginasi di envelope). q mencari invoice, nama/email/no. HP pelanggan, fasilitas, paket, dan nominal
 * (harga atau total transfer). counts tidak terpengaruh q.
 */
export interface AdminPaymentIndexDto extends PaymentSettingsDto {
  tab: PaymentQueueTab
  transactions: AdminPaymentRowDto[]
  counts: { awaiting: number; rejected: number }
}

/** POST /api/admin/payments/settings */
export interface PaymentSettingsPayload {
  /** Rekening opsional ('' boleh) — dipakai hanya bila QRIS belum diunggah. */
  bankName: string
  accountNumber: string
  accountHolder: string
  /** Nama merchant yang tercetak di QRIS; '' boleh. Gambarnya lewat endpoint unggah tersendiri. */
  qrisMerchantName: string
  holdMinutes: number
  /** 0..10000 rupiah. */
  adminFee: number
  /** 100..999. */
  uniqueCodeMax: number
  /** Maks 30 karakter; '' boleh (export Penerimaan Penjualan lalu ditolak sampai diisi). */
  accurateCashAccountNo: string
}

/**
 * totalRevenue = uang masuk (harga + biaya admin + kode unik) =
 * bookingRevenue + membershipRevenue + adminFeeRevenue + uniqueCodeRevenue. Dua yang pertama harga saja.
 * pendingFailedAmount dan averagePaidTransaction juga berbasis uang masuk.
 */
export interface FinanceStatsDto {
  totalRevenue: number
  bookingRevenue: number
  membershipRevenue: number
  adminFeeRevenue: number
  uniqueCodeRevenue: number
  paidTransactions: number
  pendingFailedAmount: number
  averagePaidTransaction: number
  totalBookings: number
  activeMemberships: number
}

export interface FinanceBreakdownRowDto {
  name: string
  revenue: number
  count: number
  share: number
  color: string
}

export interface FinanceTypeBreakdownDto {
  name: string
  type: 'booking' | 'membership' | 'admin_fee' | 'unique_code'
  revenue: number
  share: number
  color: string
}

export interface FinanceLedgerRowDto {
  id: string
  receiptNumber: string
  /** Xendit tidak ada di sistem baru → selalu null (UI menampilkan '-'). */
  invoiceId: string | null
  checkoutUrl: string | null
  customerName: string
  type: 'booking' | 'membership' | 'other'
  subject: string
  /** Harga saja. */
  amount: number
  adminFee: number
  uniqueCode: number
  /** amount + adminFee + uniqueCode. */
  total: number
  paymentStatus: PaymentStatus
  /** 'YYYY-MM-DD HH:mm' (WIB). */
  paidAt: string | null
  createdAt: string | null
}

/** GET /api/admin/finance?month=&year= — month di-clamp 1..12, year 2020..2100 (default bulan berjalan WIB). */
export interface AdminFinanceDto {
  stats: FinanceStatsDto
  revenueTrend: number
  /** Satu angka per hari di bulan tsb (panjang = jumlah hari). */
  dailyRevenue: number[]
  /** 12 angka (Jan..Des) untuk tahun tsb. */
  monthlyRevenue: number[]
  facilityRevenue: FinanceBreakdownRowDto[]
  membershipPlanRevenue: FinanceBreakdownRowDto[]
  typeBreakdown: FinanceTypeBreakdownDto[]
  ledger: FinanceLedgerRowDto[]
  period: { month: number; year: number }
}

// ============================================================================
// Fase 8E — Antrean verifikasi identitas (admin)
// ============================================================================

export type IdentityCategory = 'umum' | 'warga_kampus'
export type IdentityStatus = 'unverified' | 'pending' | 'verified' | 'rejected'

/** Satu baris antrean identitas (IdentityQueueController::index Laravel). */
export interface IdentityUserDto {
  id: string
  name: string
  email: string
  phoneNumber: string | null
  /** Nullable di DB (kolom opsional); halaman menampilkan '-' bila kosong. */
  identityCategory: IdentityCategory | null
  identityNumber: string | null
  identityStatus: IdentityStatus
  hasDocument: boolean
  /**
   * Path API relatif ('/admin/identity/:id/document') — BUKAN URL siap pakai: berkasnya privat dan
   * butuh Bearer, jadi halaman mengambilnya lewat axios lalu merender object URL blob-nya.
   */
  documentUrl: string | null
  /** Waktu relatif Bahasa Indonesia ala Carbon diffForHumans ('2 jam yang lalu'). */
  updatedAt: string
}

/** GET /api/admin/identity — semua user dengan identityStatus != unverified, terbaru dulu. */
export interface AdminIdentityIndexDto {
  users: IdentityUserDto[]
}

/** PATCH /api/admin/identity/:id/verify — identityCategory opsional (koreksi pilihan user saat daftar). */
export interface IdentityVerifyPayload {
  status: 'verified' | 'rejected'
  identityCategory?: IdentityCategory | null
}

// ===== Foto member (PRD tambahan 2026-09, tahap B) =====

/** Foto wajah untuk validasi di meja gym; berlaku setelah 'approved'. Unggah ulang kembali ke 'pending'. */
export type MemberPhotoStatus = 'pending' | 'approved' | 'rejected'

/** Balasan POST /api/customer/member-photo (multipart, field `photo`). */
export interface MemberPhotoStateDto {
  /** URL ber-root ('/uploads/members/<uuid>.webp') — langsung untuk <img src>. */
  memberPhotoUrl: string | null
  memberPhotoStatus: MemberPhotoStatus | null
}

// ===== Checkout membership lewat web (tahap C) =====

/**
 * GET /api/customer/memberships/checkout/:planId — semua yang perlu ditampilkan SEBELUM tombol bayar,
 * dihitung server dengan aturan yang sama dengan checkout-nya.
 */
export interface MembershipCheckoutPreviewDto {
  plan: { id: string; name: string; durationMonths: number; price: number; wargaPrice: number | null }
  /** Harga untuk pembeli ini (tarif Warga UB hanya bila identitasnya terverifikasi). */
  amount: number
  priceCategory: UserCategory
  identityStatus: IdentityStatus
  /** Biaya admin per transaksi; kode unik (1..uniqueCodeMax) baru diketahui setelah checkout. */
  adminFee: number
  uniqueCodeMax: number
  /** Perpanjangan: masa aktif baru mulai tanggal ini ('YYYY-MM-DD'). null = mulai saat pembayaran diverifikasi. */
  startsAfterCurrent: string | null
  /** Hari terakhir membership yang sedang aktif ('YYYY-MM-DD'), null bila tidak punya. */
  activeUntil: string | null
  /**
   * Masih aktif dan BELUM masuk 7 hari terakhir: pembelian baru dibuka mulai tanggal ini ('YYYY-MM-DD').
   * null = boleh membeli sekarang. Checkout menolak 422 selama nilai ini terisi.
   */
  renewalOpensOn: string | null
  memberPhotoUrl: string | null
  memberPhotoStatus: MemberPhotoStatus | null
  /** Pembelian yang masih menunggu pembayaran — halaman mengarahkan ke sana, bukan membuat yang baru. */
  pendingMembershipId: string | null
}

/** POST /api/customer/memberships */
export interface MembershipCheckoutPayload {
  membershipPlanId: string
}

/** Balasan POST /api/customer/memberships (201; 200 bila pembelian yang sama masih menunggu pembayaran). */
export interface MembershipCheckoutDto {
  membershipId: string
}

/**
 * GET /api/customer/memberships/:membershipId/pembayaran, dan balasan POST .../bukti (multipart,
 * field `proof`).
 */
export interface MembershipPaymentDetailDto {
  membership: {
    id: string
    planName: string
    status: MembershipStatus
    /** 'YYYY-MM-DD'. Selama pending_payment masih sementara — ditetapkan saat transfer disetujui. */
    startDate: string
    endDate: string
    /** Batas transfer (ISO UTC); null bila bukti sudah masuk atau tidak ada batas. */
    holdExpiresAt: string | null
  }
  payment: TransferPaymentDto
  bank: PaymentBankDto
  qris: PaymentQrisDto | null
}

// ===== Gym: kartu member, meja check-in, analitik (tahap D) =====

/** Membership ringkas untuk kartu dan meja check-in. Tanggal 'YYYY-MM-DD'. */
export interface MembershipBriefDto {
  id: string
  planName: string
  startDate: string
  endDate: string
  status: MembershipStatus
}

/**
 * GET /api/customer/memberships/card — kartu member di dashboard pelanggan. QR-nya meng-encode
 * customerNumber apa adanya; pengaman sebenarnya adalah foto yang dicocokkan petugas.
 *
 * state:
 *   active          membership berlaku hari ini dan foto disetujui — boleh masuk gym
 *   photo_required  membership berlaku, foto belum ada / belum disetujui / ditolak
 *   upcoming        membership berikutnya baru mulai nanti
 *   pending_payment transfer belum diverifikasi
 *   expired         membership terakhir sudah lewat atau dibatalkan
 *   none            belum pernah punya membership
 */
export interface MembershipCardDto {
  customerNumber: string
  name: string
  photoUrl: string | null
  photoStatus: MemberPhotoStatus | null
  membership: MembershipBriefDto | null
  state: 'active' | 'photo_required' | 'upcoming' | 'pending_payment' | 'expired' | 'none'
  /** Sisa hari termasuk hari ini (active / photo_required); null untuk state lain. */
  daysRemaining: number | null
}

/**
 * ok                    hijau — boleh dicatat
 * already_checked_in    kuning — sudah mencapai batas harian; hanya dengan alasan
 * photo_not_approved    kuning — setujui foto / ambil foto dulu
 * no_active_membership  merah — tawarkan perpanjangan
 * not_found             merah — nomor tidak dikenal
 */
export type GymCheckInVerdict = 'ok' | 'already_checked_in' | 'photo_not_approved' | 'no_active_membership' | 'not_found'

export interface GymVisitRowDto {
  id: string
  customerNumber: string
  memberName: string
  planName: string
  /** 'YYYY-MM-DD' WIB. */
  visitDate: string
  /** 'HH:mm' WIB. */
  time: string
  /** '-' bila akun staff pencatatnya sudah dihapus. */
  checkedInBy: string
  source: 'scan' | 'manual'
  isOverride: boolean
  overrideReason: string | null
}

/** GET /api/admin/gym/checkin/lookup?code= — dan balasan POST /api/admin/gym/checkin (keadaan terbaru). */
export interface GymCheckInLookupDto {
  verdict: GymCheckInVerdict
  member: { userId: string; customerNumber: string; name: string; photoUrl: string | null; photoStatus: MemberPhotoStatus | null } | null
  /** Membership yang berlaku hari ini; bila tidak ada, yang terakhir (untuk menawarkan perpanjangan). */
  membership: MembershipBriefDto | null
  /** Kunjungan member ini hari ini, urut waktu. */
  visitsToday: GymVisitRowDto[]
  /** Batas kunjungan per hari; 0 = tanpa batas. */
  maxPerDay: number
}

/** POST /api/admin/gym/checkin */
export interface GymCheckInPayload {
  /** Nomor member hasil scan atau ketikan: 'UB-7K3F-92QX', huruf kecil, atau tanpa strip/prefiks. */
  code: string
  source: 'scan' | 'manual'
  /** Wajib untuk mengizinkan masuk ulang (verdict already_checked_in); maks 120 karakter. */
  overrideReason?: string | null
}

/** GET /api/admin/gym/checkin — kunjungan hari ini, terbaru dulu, maks 100. */
export interface GymDeskDto {
  /** 'YYYY-MM-DD' WIB. */
  today: string
  visits: GymVisitRowDto[]
}

/** GET /api/admin/gym/visits?from=&to= — rentang tanggal WIB, maks 92 hari; default hari ini. */
export interface GymVisitReportDto {
  range: { from: string; to: string }
  summary: {
    totalVisits: number
    uniqueMembers: number
    /** Rata-rata kunjungan per hari dalam rentang, 1 desimal. */
    averagePerDay: number
    /** Jam WIB (0–23) dengan kunjungan terbanyak; null bila kosong. */
    peakHour: number | null
    overrides: number
  }
  /** 24 angka: kedatangan per jam WIB sepanjang rentang. */
  hourly: number[]
  /** 7 × 24: Senin..Minggu × jam WIB. */
  heatmap: number[][]
  daily: { date: string; visits: number }[]
  /** Log terbaru dulu, maks 500 baris. */
  visits: GymVisitRowDto[]
}

/** Satu baris antrean foto member di halaman verifikasi identitas. */
export interface MemberPhotoReviewDto {
  id: string
  name: string
  email: string
  phoneNumber: string | null
  /** 'UB-7K3F-92QX'. */
  customerNumber: string
  /** URL ber-root ('/uploads/members/...'), publik — tidak perlu diambil lewat axios. */
  photoUrl: string
  status: MemberPhotoStatus
  /** Waktu relatif ('2 jam yang lalu'). */
  updatedAt: string
}

/** GET /api/admin/identity/member-photos — menunggu tinjauan dulu, lalu terbaru; maks 200. */
export interface AdminMemberPhotoIndexDto {
  users: MemberPhotoReviewDto[]
}

/**
 * PATCH /api/admin/identity/:userId/member-photo. photoUrl = foto yang DILIHAT staff; bila pelanggan
 * sudah menggantinya, balasannya 409 dan staff harus meninjau ulang.
 */
export interface MemberPhotoDecisionPayload {
  status: 'approved' | 'rejected'
  photoUrl: string
}

// ============================================================================
// Fase 8F — CMS admin (News + kategori + info banner, Promo, Sponsor, Reel, Testimoni + Review)
// ============================================================================
// Semua digerbangi cms.manage, KECUALI menerbitkan berita yang juga butuh news.publish.
// Semua endpoint tulis menerima multipart bila membawa berkas (lihat catatan tiap DTO).

export type NewsStatus = 'draft' | 'published' | 'archived'

export interface NewsAuthorDto {
  /** '' bila artikel tak punya penulis (Laravel mengirim 0 karena PK int; uuid tidak punya padanan). */
  id: string
  name: string
  avatar: string | null
  avatarUrl: string | null
}

export interface NewsCategoryRefDto {
  id: string
  name: string
  slug: string
}

export interface AdminNewsDto {
  id: string
  title: string
  slug: string
  excerpt: string | null
  content: string
  status: NewsStatus
  /** 'YYYY-MM-DD HH:mm:ss' WIB (Carbon toDateTimeString), null bila belum pernah terbit. */
  publishedAt: string | null
  /** Waktu relatif Bahasa Indonesia (diffForHumans). */
  updatedAt: string
  category: NewsCategoryRefDto | null
  author: NewsAuthorDto
  thumbnail: string | null
  section: NewsSection
  metaTitle: string | null
  metaDescription: string | null
  /** URL media 'og_image' milik artikel; null = landing memakai thumbnail. */
  ogImage: string | null
  noindex: boolean
}

/** Kategori + jumlah artikel (withCount) untuk panel kategori di halaman News. */
export interface AdminNewsCategoryDto {
  id: string
  name: string
  slug: string
  newsCount: number
}

/** GET /api/admin/news — daftar penuh + kategori + info banner (ketiganya dirender satu halaman). */
export interface AdminNewsIndexDto {
  news: AdminNewsDto[]
  categories: AdminNewsCategoryDto[]
  infoBanners: InfoBannerDto[]
}

/** GET /api/admin/news/create dan /api/admin/news/:id/edit — `article` null saat create. */
export interface AdminNewsFormDto {
  article: AdminNewsDto | null
  categories: Pick<NewsCategoryRefDto, 'id' | 'name'>[]
}

/**
 * POST/PUT /api/admin/news — multipart: berkas `thumbnail` dan `ogImage` (keduanya opsional), plus
 * `removeOgImage` ('1') untuk menghapus OG image lama. `content` = HTML editor; server menyanitasinya.
 */
export interface NewsPayload {
  newsCategoryId: string | null
  title: string
  slug: string
  excerpt: string | null
  content: string
  status: NewsStatus
  /** Dikirim apa adanya dari form; server yang memutuskan nilai akhir (lihat resolvePublishedAt). */
  publishedAt: string | null
  /** '' / null = pakai judul. */
  metaTitle: string | null
  /** '' / null = pakai excerpt atau potongan isi. */
  metaDescription: string | null
  noindex: boolean
}

export interface NewsCategoryPayload {
  name: string
}

export interface InfoBannerPayload {
  message: string
  isActive: boolean
  sortOrder: number
}

// ---- Promo carousel ----
export interface AdminPromoDto {
  id: string
  title: string | null
  isActive: boolean
  sortOrder: number
  slideUrl: string | null
}

export interface AdminPromoIndexDto {
  items: AdminPromoDto[]
}

export interface PromoPayload {
  title: string | null
  isActive: boolean
  sortOrder: number
}

// ---- Sponsor logo ----
export interface AdminSponsorDto {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  logoUrl: string | null
}

export interface AdminSponsorIndexDto {
  items: AdminSponsorDto[]
}

export interface SponsorPayload {
  name: string
  isActive: boolean
  sortOrder: number
}

// ---- Reel ----
export interface AdminReelDto {
  id: string
  title: string
  isActive: boolean
  thumbnailUrl: string | null
  videoUrl: string | null
}

export interface AdminReelIndexDto {
  items: AdminReelDto[]
}

export interface ReelPayload {
  title: string
  isActive: boolean
}

// ---- Testimoni + Review ----
export interface AdminTestimonialDto {
  id: string
  authorName: string
  authorRole: string
  quote: string
  isActive: boolean
  sortOrder: number
  imageUrl: string | null
  logoUrl: string | null
}

export interface AdminReviewDto {
  id: string
  reviewerName: string
  rating: number
  text: string
  isApproved: boolean
  /** Waktu relatif Bahasa Indonesia (diffForHumans). */
  createdAt: string
}

/** GET /api/admin/testimonials — testimoni kurasi + review masuk dari customer, satu halaman. */
export interface AdminTestimonialIndexDto {
  testimonials: AdminTestimonialDto[]
  reviews: AdminReviewDto[]
}

export interface TestimonialPayload {
  authorName: string
  authorRole: string
  quote: string
  isActive: boolean
  sortOrder: number
}

/** Badan POST reorder milik promo / sponsors / testimonials / info-banners. */
export interface ReorderPayload {
  ids: string[]
}

/** PUT /api/admin/settings/gym-traffic — empat nilai sah ada di GYM_TRAFFIC_VALUES. */
export interface GymTrafficPayload {
  value: string
}

// ============================================================================
// Fase 8G — Settings: Roles (RBAC), Schedules, Users, Notifikasi, Profil staf
// ============================================================================

// ---- Roles / RBAC ----
export interface AdminRoleDto {
  /** Nama role adalah kuncinya (RolePermission.roleName), bukan uuid — lihat skema. */
  name: string
  permissions: string[]
  usersCount: number
  /**
   * Laravel menghitung baris tabel `sessions` dengan last_activity <= 15 menit.
   * API ini stateless (JWT), jadi padanannya: RefreshToken staff yang belum dicabut
   * dengan lastUsedAt <= 15 menit, dihitung distinct per user.
   */
  onlineUsersCount: number
}

/** GET /api/admin/settings/roles — Administrator dikecualikan; non-Administrator hanya melihat role-nya sendiri. */
export interface AdminRoleIndexDto {
  roles: AdminRoleDto[]
}

/** PUT /api/admin/settings/roles/:name — hanya Administrator; role Administrator sendiri ditolak 403. */
export interface RolePermissionsPayload {
  permissions: string[]
}

// ---- Schedules ----
export interface AdminScheduleMonthDto {
  month: number
  year: number
  /** 'Januari 2026' — nama bulan Bahasa Indonesia. */
  label: string
  isOpen: boolean
  /** 'YYYY-MM-DD', sudah dibersihkan ke bulan itu saja, unik, terurut. */
  closedDates: string[]
}

/** GET /api/admin/settings/schedules — 7 bulan mulai bulan berjalan (WIB). */
export interface AdminScheduleIndexDto {
  schedules: AdminScheduleMonthDto[]
}

export interface ScheduleTogglePayload {
  month: number
  year: number
}

export interface ScheduleClosedDatesPayload {
  month: number
  year: number
  closedDates: string[]
}

// ---- Users (staf) ----
export interface AdminStaffUserDto {
  id: string
  name: string
  email: string
  /** '' bila entah bagaimana tanpa role (Laravel: getRoleNames()->first() ?? ''). */
  role: string
  avatar: string | null
  avatarUrl: string | null
}

/** GET /api/admin/settings/users — staf saja, diurut nama lalu dirapikan per urutan role. */
export interface AdminStaffUserIndexDto {
  users: AdminStaffUserDto[]
  /** Role yang boleh diberikan dari halaman ini — Administrator TIDAK termasuk. */
  roles: string[]
  canManageUsers: boolean
}

export interface StaffUserPayload {
  name: string
  email: string
  /** Wajib saat create, opsional saat update (kosong = password tidak diubah). */
  password?: string | null
  role: string
}

// ---- Notifikasi admin ----
export type AdminNotificationTone = 'info' | 'success' | 'warning' | 'critical'

export interface AdminNotificationItemDto {
  id: string
  title: string
  description: string
  /** Waktu relatif Bahasa Indonesia, atau '' untuk item tanpa waktu. */
  time: string
  read: boolean
  tone: AdminNotificationTone
  href: string | null
  important: boolean
  /** Badge asal item ('Identity', 'Bookings', 'Finance', 'Content', 'System'). Dirender Topbar. */
  source: string
  /** Label tombol aksi ('Review', 'Open', 'Inspect', …); null bila item tidak punya aksi. */
  actionLabel: string | null
}

export interface AdminNotificationsDto {
  items: AdminNotificationItemDto[]
  unreadCount: number
  importantCount: number
  /** ISO 8601 — dipakai Topbar sebagai penanda "terakhir disinkronkan". */
  generatedAt: string
}

/** POST /api/admin/notifications/read dan /clear-read — `ids` kosong/absen berarti SEMUA yang terlihat. */
export interface NotificationIdsPayload {
  ids?: string[]
}

// ---- Profil staf (dipakai ProfileModal) ----
export interface StaffProfileDto {
  id: string
  name: string
  email: string
  role: string | null
  avatar: string | null
  avatarUrl: string | null
  /** ISO 8601, null bila email belum terverifikasi. */
  emailVerifiedAt: string | null
}

/** PATCH /api/admin/profile — multipart bila `avatar` ikut. */
export interface StaffProfilePayload {
  name: string
  email: string
}

/** PUT /api/admin/profile/password */
export interface StaffPasswordPayload {
  currentPassword: string
  password: string
  passwordConfirmation: string
}

/** DELETE /api/admin/profile — Laravel meminta password sebagai konfirmasi. */
export interface StaffAccountDeletePayload {
  password: string
}

// ============================================================================
// Fase 6 — Area customer (booking, riwayat, pembayaran, profil, ulasan)
// ============================================================================
// Semua di blok ini PER-USER dan dilayani /api/customer/* (kecuali BookingFacilityDto yang publik).
// Itulah sebabnya tidak satu pun boleh masuk HomeDto: jawabannya tidak boleh ikut ter-cache bersama.

/** Satu unit fasilitas yang bisa dipilih customer — FacilityUnitResource pada jalur `units.media`. */
export interface BookingFacilityUnitDto {
  id: string
  name: string
  /** media 'unit_image', "" bila kosong. */
  image: string
}

/**
 * Fasilitas untuk halaman /booking. Persis FacilityDto PLUS `units`, karena hanya jalur ini yang
 * eager-load `units.media` (routes/web.php:158). Halaman /facilities dan /pricing TIDAK memuatnya.
 */
export interface BookingFacilityDto extends FacilityDto {
  units: BookingFacilityUnitDto[]
}

/** GET /api/public/booking/facilities */
export interface BookingFacilityIndexDto {
  facilities: BookingFacilityDto[]
  /**
   * Biaya admin per transaksi (rupiah, 0 = tidak ada) untuk ringkasan sebelum checkout. Kode unik
   * baru diketahui setelah checkout, jadi yang ditampilkan di sini hanya batas atasnya.
   */
  adminFee: number
  uniqueCodeMax: number
}

/** Ulasan yang sudah disetujui, bentuk kartu di halaman /booking (routes/web.php:170-179). */
export interface ApprovedReviewDto {
  id: string
  rating: number
  text: string
  authorName: string
  /** 'd M Y' (mis. '05 Sep 2026'). */
  authorDate: string
  /** '/storage/<avatar>' bila user punya avatar, selain itu aset ikon default. */
  avatar: string
}

/** GET /api/public/booking/reviews — ulasan disetujui, terbaru dulu. */
export interface ApprovedReviewIndexDto {
  reviews: ApprovedReviewDto[]
}

/** Ulasan milik pemanggil, bila ada. */
export interface MyReviewDto {
  id: string
  rating: number
  text: string
}

/**
 * GET /api/customer/reviews/eligibility — padanan `can_review` + `existing_review`.
 * canReview true bila pemanggil punya minimal satu booking confirmed/completed yang SUDAH berakhir.
 */
export interface ReviewEligibilityDto {
  canReview: boolean
  existingReview: MyReviewDto | null
}

/** POST /api/customer/reviews — updateOrCreate per user; menyimpan selalu mereset isApproved ke false. */
export interface ReviewPayload {
  /** 0.5 – 5, kelipatan bebas (Laravel: numeric min:0.5 max:5). */
  rating: number
  /** 10 – 1000 karakter. */
  text: string
}

/**
 * Satu baris di modal riwayat pembayaran customer (routes/web.php:254-307).
 *
 * `invoiceId` dan `checkoutUrl` selalu null: Xendit tidak ada di sistem baru (sama seperti ledger 8D).
 * `paymentUrl` adalah jalan kembali ke layar pembayaran booking atau membership.
 */
export interface CustomerTransactionDto {
  id: string
  receiptNumber: string
  invoiceId: string | null
  amount: number
  /** amount + adminFee + uniqueCode — yang benar-benar ditransfer pelanggan. */
  transferTotal: number
  uniqueCode: number | null
  paymentStatus: PaymentStatus
  verificationStatus: 'awaiting' | 'rejected' | null
  rejectionReason: string | null
  /** '/booking/:bookingId/pembayaran' atau '/membership/:membershipId/pembayaran'. */
  paymentUrl: string | null
  checkoutUrl: string | null
  /** 'YYYY-MM-DD HH:mm:ss' WIB. */
  paidAt: string | null
  createdAt: string
  type: 'booking' | 'membership'
  /** '-' bila bukan booking. */
  facilityName: string
  /** 'YYYY-MM-DD', null bila bukan booking. */
  bookingDate: string | null
  membershipPlan: string | null
  membershipStatus: MembershipStatus | null
  membershipPeriod: { startDate: string; endDate: string } | null
}

/** GET /api/customer/transactions — 20 terbaru milik pemanggil. */
export interface CustomerTransactionIndexDto {
  transactions: CustomerTransactionDto[]
}

/** GET /api/customer/profile */
export interface CustomerProfileDto {
  id: string
  name: string
  email: string
  phoneNumber: string | null
  birthPlace: string | null
  /** 'YYYY-MM-DD'. */
  birthDate: string | null
  avatar: string | null
  avatarUrl: string | null
  /** ISO 8601, null bila email belum terverifikasi. */
  emailVerifiedAt: string | null
  identityCategory: IdentityCategory | null
  identityNumber: string | null
  identityStatus: IdentityStatus
  /** 'UB-7K3F-92QX' — tetap seumur akun, dipakai kartu member. */
  customerNumber: string
  memberPhotoUrl: string | null
  memberPhotoStatus: MemberPhotoStatus | null
}

/** POST /api/customer/profile — multipart bila `avatar` ikut. */
export interface CustomerProfilePayload {
  name: string
  birthPlace: string | null
  birthDate: string | null
}

/** PUT /api/customer/password */
export interface CustomerPasswordPayload {
  currentPassword: string
  password: string
  passwordConfirmation: string
}

/**
 * POST /api/customer/identity — multipart, berkas di field `identityFile`.
 * Laravel mengunci kategori ke 'warga_kampus' (hanya itu yang masuk akal diajukan) dan menolak
 * pengajuan bila status sudah 'verified'.
 */
export interface CustomerIdentityPayload {
  identityCategory: 'warga_kampus'
  identityNumber: string
}
