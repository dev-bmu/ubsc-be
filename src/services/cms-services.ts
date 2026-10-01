import { Prisma } from '@prisma/client'
import type {
  AnnouncementDto,
  GymTrafficDto,
  KnownGymTrafficDto,
  MembershipPlanDto,
  NewsDto,
  PromoDto,
  ReelDto,
  ReviewDto,
  SponsorDto,
  TestimonialDto
} from '../../shared/contracts'
import { formatDateDotID, formatDateSlashSpaceID } from '../../shared/format'
import { prismaClient } from '../application/database'
import { logger } from '../utils/logger'
import { firstUrlFor, listFor } from './media-services'

// ============================================================================
// === Konten CMS beranda — port HomeController@index + HandleInertiaRequests::share ===
// ============================================================================
// Satu fungsi per koleksi, masing-masing padanan SATU baris payload Inertia '/'. Fasilitas TIDAK ada
// di sini — kartu fasilitas punya resource sendiri dan hidup di public-facility-services.ts.
//
// EMPAT hal yang mengubah TAMPILAN kalau dilanggar, bukan cuma tipe:
//
// 1. MEDIA KOSONG = '' (string kosong), BUKAN null. firstUrlFor() sudah memegang semantik
//    getFirstMediaUrl() spatie; ImageCarousel.tsx:19 membuang slide yang src-nya falsy. PENGECUALIAN
//    tunggal: testimonials.image dan testimonials.authorLogo memang null di Laravel (Testimonial.php:34-42
//    memakai `?:`), jadi DI SANA SAJA hasil firstUrlFor() dilewatkan `|| null`.
//
// 2. MEDIA DIAMBIL BATCH. Satu listFor() per koleksi, bukan satu query per baris — Media tidak punya
//    relasi Prisma (schema.prisma:786-822) sehingga N+1-nya tidak akan ketahuan sendiri. Reel dan
//    Testimonial masing-masing butuh DUA koleksi; listFor() dipanggil TANPA argumen collectionName
//    supaya keduanya tetap satu query.
//
// 3. TANGGAL SUDAH TERFORMAT di kabel ('d.m.Y' untuk news, 'd/m Y' untuk reels), bukan ISO — kedua pola
//    tidak bisa dihasilkan opsi Intl mana pun dan formatter kedua di sisi Next dilarang R13. Port-nya
//    formatDateDotID / formatDateSlashSpaceID; tidak ada pemformatan angka/tanggal lain di file ini.
//
// 4. TIE-BREAKER ADALAH `createdAt` MENAIK — SELALU, DAN ARAHNYA BUKAN SALAH KETIK.
//    Laravel hanya menulis `orderBy('sort_order')` / `latest()`, lalu pada nilai seri MySQL mengembalikan
//    baris dalam urutan PK auto-increment MENAIK — yaitu urutan penyisipan. Jadi aturan Laravel yang
//    sebenarnya berlaku bukan "satu kunci urut", melainkan "satu kunci urut, seri dipecah urutan
//    penyisipan menaik". Padanannya di skema uuid adalah `createdAt: 'asc'`.
//
//    Dua hal yang SALAH dan sudah pernah ditulis di berkas ini:
//      - `id` sebagai tie-breaker. PK di sini uuid v4 — ACAK, bukan monoton — jadi ia tidak meniru urutan
//        penyisipan, ia mengarang urutan yang tidak pernah ada di Laravel.
//      - `createdAt: 'desc'` sebagai tie-breaker. Arahnya terbalik: ia secara deterministik MEMBALIK
//        baris-baris yang seri.
//    Membuang tie-breaker sama sekali juga bukan jawaban — filesort MySQL tidak stabil, sehingga urutan
//    seri jadi tak tentu antar request.
//
//    Diverifikasi langsung ke kedua database, bukan disimpulkan:
//      Laravel  `ORDER BY published_at DESC`                 -> id 1 (Berita), id 2 (Artikel)
//      Port     `... DESC, createdAt ASC`                    -> Berita, Artikel   ← cocok
//      Port     `... DESC, createdAt DESC`                   -> Artikel, Berita   ← terbalik
//    Taruhannya nyata: prisma/seeders/cms.ts:15-16 menulis dua berita bertanggal '2026-02-26', satu
//    'berita' satu 'artikel', dan NewsCard.tsx:5 memilih layoutOverride dari `category` — yang tertukar
//    adalah LAYOUT dua kartu teratas SectionFive, bukan sekadar judulnya.
//
//    Pada koleksi BER-LIMIT tie-breaker bukan cuma menggeser urutan, ia menentukan BARIS MANA yang masuk
//    limit — di sanalah kunci yang salah paling mahal. Koleksi sort_order TANPA limit memakai pola yang
//    sama; sebagian masih menyertakan `id` uuid sebagai kunci ketiga, yang tidak berbahaya di sana (tanpa
//    take ia tak bisa mengubah baris mana yang tampil) tapi juga tidak menambah apa pun di atas `createdAt`.
//
//    CATATAN TERPISAH — listReels dan listReviews tidak punya kunci kedua yang bisa menolong: kunci
//    primernya SUDAH `createdAt`. Di sana masalahnya ada di DATA, bukan di query: Laravel `timestamps()`
//    menulis presisi DETIK sehingga seluruh batch seeder jatuh pada detik yang sama dan terurut penyisipan,
//    sementara Prisma memetakan ke DATETIME(3) sehingga tiap baris beda milidetik dan `DESC` membalikkannya.
//    Diperbaiki di prisma/seeders/, bukan di sini.

/**
 * Limit yang ditulis HomeController: news :54, reels :57, reviews :74. Sisanya memang tanpa limit.
 *
 * Diekspor dan dioper pemanggil, BUKAN default tersembunyi di dalam service: listNews/listReels/listReviews
 * juga melayani endpoint granular, dan di Laravel `/news` TIDAK dibatasi 7. Limit yang tertanam di service
 * akan memotong grid /news secara permanen begitu Fase 5 membangun halamannya, tanpa satu pun error.
 */
export const HOME_NEWS_LIMIT = 7
export const HOME_REELS_LIMIT = 8
export const HOME_REVIEWS_LIMIT = 10

/** `$r->reviewer_name ?? 'Guest'` (HomeController.php:72). */
const GUEST_REVIEWER = 'Guest'

/** Baris system_settings yang dibaca badge keramaian (HandleInertiaRequests.php:57). */
const GYM_TRAFFIC_KEY = 'gym_traffic'

/** Default SystemSetting::get() Laravel, sekaligus fallback klien di GymTrafficBadge.tsx:54. */
// Dianotasi KnownGymTrafficDto, bukan GymTrafficDto. Sejak GymTrafficDto dilebarkan jadi `string` demi
// paritas teks badge, anotasi lebar tidak menjaga apa pun: salah ketik ('Low Ocupancy') akan lolos compile
// lalu langsung menjadi TEKS badge untuk ketiga keadaan default. Union sempit tetap assignable ke `string`,
// jadi nilai ini tetap sah sebagai GymTrafficDto di mana pun ia dipakai.
const DEFAULT_GYM_TRAFFIC: KnownGymTrafficDto = 'Low Occupancy'

/**
 * P2021 — tabel tidak ada di database.
 *
 * Padanan `Schema::hasTable('info_banners')` / `Schema::hasTable('system_settings')`
 * (HandleInertiaRequests.php:52,56): Laravel memasang guard itu supaya deploy yang mendahului migrasi
 * tidak menjatuhkan SETIAP halaman publik — info banner dan badge gym hanya hiasan. Hanya kode itu yang
 * ditelan; error lain (koneksi putus, kredensial salah) tetap dilempar, kalau tidak gangguan database
 * akan menyamar jadi beranda yang baik-baik saja.
 *
 * Kodenya dibaca dari field terstruktur, bukan dari teks pesan — alasan lengkapnya di utils/prisma-errors.ts.
 */
function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'P2021'
}

/**
 * Kolom json `features` apa adanya, [] bila bukan array.
 *
 * Padanan `$p->features ?? []` (HomeController.php:41) di atas cast 'array': Laravel meneruskan hasil
 * json_decode tanpa memeriksa isinya, jadi isinya juga tidak divalidasi di sini — sama seperti
 * toApplicableDays() di public-facility-services.ts:96. Satu-satunya penyimpangan adalah json non-array
 * (skalar atau objek), yang jatuh ke [] alih-alih diteruskan; di Laravel bentuk itu lolos ke React lalu
 * mematikan `.map()` di SectionTwo, bukan perilaku yang layak ditiru.
 */
export function toFeatures(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

// ===== Prop global share (publik) =====

/**
 * Pesan info banner sebagai ARRAY STRING POLOS — padanan `InfoBanner::active()->ordered()->pluck('message')`
 * (HandleInertiaRequests.php:52-54).
 *
 * Bukan array objek: InfoBanner.tsx:13-17 merender elemennya apa adanya, objek akan tampil
 * "[object Object]". Karena itu `select: { message: true }` — tidak ada id yang bisa ikut terbawa.
 *
 * Urutan: scopeOrdered = `orderBy('sort_order')->orderBy('id')` (InfoBanner.php:22-25). Kunci kedua Laravel
 * berarti "urutan penyisipan" karena PK-nya auto-increment; di sini padanannya createdAt. `id` TIDAK dipakai
 * sebagai kunci ketiga: uuid v4 acak, jadi ia bukan urutan penyisipan melainkan urutan baru yang tidak
 * pernah ada di Laravel, dan createdAt sudah memport maksud kunci kedua itu sepenuhnya. Tanpa limit.
 */
export async function listAnnouncements(): Promise<AnnouncementDto[]> {
  try {
    const banners = await prismaClient.infoBanner.findMany({
      where: { isActive: true },
      select: { message: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    })

    return banners.map((banner) => banner.message)
  } catch (error) {
    if (!isMissingTable(error)) throw error
    logger.warn('Tabel info_banners belum ada; announcements dikembalikan kosong')
    return []
  }
}

/**
 * Status keramaian gym — padanan `SystemSetting::get('gym_traffic', 'Low Occupancy')`
 * (HandleInertiaRequests.php:56-58, SystemSetting.php:11-14).
 *
 * TIGA keadaan jatuh ke default, dan hanya tiga — persis yang di-default-kan Laravel juga: baris tidak ada,
 * kolom value null, dan tabelnya belum ada (`Schema::hasTable`).
 *
 * SELEBIHNYA NILAI KOLOM DITERUSKAN APA ADANYA, termasuk nilai di luar keempat pilihan yang ditegakkan
 * validasi `in:` jalur tulis admin (routes/web.php:620). Versi sebelumnya menjatuhkan nilai di luar union
 * itu ke default: warna badge memang tidak ikut berubah (GymTrafficBadge.tsx:20-44 punya cabang default =
 * warna Low), tapi TEKS badge jadi berbeda dari Laravel untuk baris yang sama. Karena itu GymTrafficDto
 * kini `string` dan unionnya hidup sebagai dokumentasi (KnownGymTrafficDto, shared/contracts.ts) — tipe
 * tidak boleh mengubah data.
 */
export async function getGymTraffic(): Promise<GymTrafficDto> {
  let value: string | null = null

  try {
    const row = await prismaClient.systemSetting.findUnique({ where: { key: GYM_TRAFFIC_KEY }, select: { value: true } })
    value = row?.value ?? null
  } catch (error) {
    if (!isMissingTable(error)) throw error
    logger.warn(`Tabel system_settings belum ada; gym traffic memakai default '${DEFAULT_GYM_TRAFFIC}'`)
  }

  return value ?? DEFAULT_GYM_TRAFFIC
}

// ===== Koleksi beranda =====

/**
 * Kartu paket membership — padanan HomeController.php:26-46 (->map() manual, BUKAN JsonResource).
 *
 * activeMembersCount adalah `withCount(['memberships as active_members_count' => status='active'])
 * (HomeController.php:27-29). Di sini itu `_count` BERFILTER: satu query untuk seluruh paket, bukan satu
 * COUNT per baris. Filternya wajib — `_count` polos akan menghitung membership expired dan cancelled juga,
 * dan angka "sudah bergabung" di SectionTwo diam-diam membesar tanpa satu pun error.
 *
 * Filter isActive, urut sortOrder ASC, TANPA limit. price dan features dikirim mentah (SectionTwo.tsx:486
 * yang memformat harga); features memakai fallback [] dan tidak pernah null.
 */
export async function listMembershipPlans(): Promise<MembershipPlanDto[]> {
  const plans = await prismaClient.membershipPlan.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      description: true,
      publicBadge: true,
      savingsLabel: true,
      ctaLabel: true,
      cardImageUrl: true,
      price: true,
      wargaPrice: true,
      durationMonths: true,
      features: true,
      isActive: true,
      sortOrder: true,
      _count: { select: { memberships: { where: { status: 'active' } } } }
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    publicBadge: plan.publicBadge,
    savingsLabel: plan.savingsLabel,
    ctaLabel: plan.ctaLabel,
    cardImageUrl: plan.cardImageUrl,
    price: plan.price,
    wargaPrice: plan.wargaPrice,
    durationMonths: plan.durationMonths,
    features: toFeatures(plan.features),
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    activeMembersCount: plan._count.memberships
  }))
}

/**
 * Slide carousel promo — padanan `PromoCarousel::active()->ordered()->get()` (HomeController.php:47-49)
 * yang dibentuk PromoCarouselResource.php:12-16.
 *
 * `alt` adalah kolom title yang memang nullable; `src` koleksi 'slide' singleFile (PromoCarousel.php:28-31)
 * dan '' bila kosong — ImageCarousel.tsx:19 yang membuang slide itu, bukan query ini. Tanpa limit.
 */
export async function listPromos(): Promise<PromoDto[]> {
  const promos = await prismaClient.promoCarousel.findMany({
    where: { isActive: true },
    select: { id: true, title: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  const slides = await listFor(
    'PromoCarousel',
    promos.map((promo) => promo.id),
    'slide'
  )

  return promos.map((promo) => ({
    id: promo.id,
    src: firstUrlFor(slides, promo.id, 'slide'),
    alt: promo.title
  }))
}

/**
 * Logo sponsor — padanan `SponsorLogo::active()->ordered()->get()` (HomeController.php:50-52) yang
 * dibentuk SponsorLogoResource.php:12-16.
 *
 * Field `link` yang ada di tipe FE (LogoMarquee.tsx:3-8) TIDAK pernah dikirim Laravel dan tidak ada di
 * SponsorDto — jangan ditambahkan. Koleksi 'logo' singleFile (SponsorLogo.php:27-30). Tanpa limit.
 */
export async function listSponsors(): Promise<SponsorDto[]> {
  const sponsors = await prismaClient.sponsorLogo.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  const logos = await listFor(
    'SponsorLogo',
    sponsors.map((sponsor) => sponsor.id),
    'logo'
  )

  return sponsors.map((sponsor) => ({
    id: sponsor.id,
    name: sponsor.name,
    img: firstUrlFor(logos, sponsor.id, 'logo')
  }))
}

/**
 * Kartu berita/artikel — padanan `News::published()->with('category')->latest('published_at')->take(7)`
 * (HomeController.php:53-55) yang dibentuk NewsResource.php:12-20.
 *
 * `limit` WAJIB dioper pemanggil dan tidak punya default. Beranda mengoper HOME_NEWS_LIMIT; fungsi yang
 * sama juga melayani GET /api/public/news, dan di Laravel `/news` tidak dibatasi 7 — default tersembunyi
 * di sini akan memotong halaman itu diam-diam.
 *
 * TANGGAL KOSONG DIREPLIKASI, BUKAN DIPERBAIKI. scopePublished hanya memeriksa status (News.php:48-51),
 * jadi baris published dengan publishedAt null tetap lolos dan Laravel mengirim '' untuk date
 * (`$this->published_at?->format('d.m.Y') ?? ''`). Guard `? :` di bawah wajib: formatDateDotID
 * mengembalikan '-' untuk input kosong, dan '-' akan tampil di kartu.
 *
 * URUTAN. `latest('published_at')` = ORDER BY published_at DESC, dipecah urutan penyisipan menaik saat
 * seri — lihat butir 4 di kepala berkas untuk alasan dan buktinya. Baris ber-publishedAt null jatuh ke
 * paling belakang (MySQL menaruh NULL terakhir pada DESC), sama seperti Laravel yang membaca database
 * yang sama.
 *
 * `content` (LongText) SENGAJA tidak diambil: tidak ada satu pun yang merendernya di beranda.
 */
export async function listNews(limit?: number): Promise<NewsDto[]> {
  const news = await prismaClient.news.findMany({
    where: { status: 'published' },
    select: {
      id: true,
      title: true,
      slug: true,
      excerpt: true,
      publishedAt: true,
      newsCategory: { select: { name: true } }
    },
    // Kunci kedua `createdAt: 'asc'` — arahnya MENAIK, dan itu bukan salah ketik. Laravel hanya menulis
    // `latest('published_at')`, tetapi pada nilai seri MySQL mengembalikan baris dalam urutan PK
    // auto-increment MENAIK, yaitu urutan penyisipan. Padanan urutan penyisipan di skema uuid adalah
    // `createdAt` menaik, bukan menurun. Diverifikasi langsung ke kedua database:
    //   Laravel  `ORDER BY published_at DESC`                    -> id 1 (Berita), id 2 (Artikel)
    //   Port     `ORDER BY publishedAt DESC, createdAt ASC`      -> Berita, Artikel   ← cocok
    //   Port     `ORDER BY publishedAt DESC, createdAt DESC`     -> Artikel, Berita   ← TERBALIK
    // Tanpa kunci kedua, filesort MySQL tidak stabil dan urutan seri jadi tak tentu. Ini bukan kasus
    // langka: prisma/seeders/cms.ts:15-16 menulis dua berita bertanggal '2026-02-26', satu 'berita' dan
    // satu 'artikel', dan NewsCard.tsx:5 memilih layoutOverride dari `category` — jadi yang tertukar
    // bukan cuma judul melainkan LAYOUT dua kartu teratas SectionFive.
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'asc' }],
    // limit undefined = TANPA batas: halaman /news Laravel memang mengambil seluruh berita terbit
    // (PublicNewsController::index, tanpa paginasi). Beranda tetap mengoper HOME_NEWS_LIMIT.
    take: limit
  })

  const thumbnails = await listFor(
    'News',
    news.map((item) => item.id),
    'thumbnail'
  )

  return news.map((item) => ({
    id: item.id,
    title: item.title,
    slug: item.slug,
    date: item.publishedAt ? formatDateDotID(item.publishedAt) : '',
    // `whenLoaded('category', ..., '')` — relasinya selalu dimuat di jalur ini, jadi yang tersisa hanya
    // berita tanpa kategori. Nilai name WAJIB persis 'Berita' atau 'Artikel' (NewsCard.tsx:5 mengetiknya
    // sebagai union dan memilih layoutOverride dari situ); itu urusan seed/CMS, bukan normalisasi di sini.
    category: item.newsCategory?.name ?? '',
    image: firstUrlFor(thumbnails, item.id, 'thumbnail'),
    description: item.excerpt
  }))
}

/**
 * Kartu reel — padanan `Reel::active()->latest()->take(8)` (HomeController.php:56-58) yang dibentuk
 * ReelResource.php:12-19.
 *
 * `latest()` tanpa argumen = ORDER BY created_at DESC; reels memang tidak punya kolom sort_order. Itu
 * SATU-SATUNYA kunci urut, tanpa tie-breaker — alasannya di butir 4 kepala berkas (take + uuid acak).
 * isActive selalu true karena sudah difilter scope — dikirim hanya demi paritas bentuk dengan ReelItem.
 *
 * `limit` dioper pemanggil tanpa default, sama seperti listNews: fungsi ini juga melayani
 * GET /api/public/reels.
 *
 * DUA KOLEKSI, SATU QUERY: listFor() dipanggil tanpa collectionName sehingga 'thumbnail' dan 'video'
 * (Reel.php:26-30, keduanya singleFile) terbawa bersama; memanggilnya dua kali akan menggandakan query
 * tanpa menambah apa pun.
 */
export async function listReels(limit: number): Promise<ReelDto[]> {
  const reels = await prismaClient.reel.findMany({
    where: { isActive: true },
    select: { id: true, title: true, isActive: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }],
    take: limit
  })

  const media = await listFor(
    'Reel',
    reels.map((reel) => reel.id)
  )

  return reels.map((reel) => ({
    id: reel.id,
    title: reel.title,
    // createdAt NOT NULL, jadi tidak ada cabang string kosong seperti di news.
    date: formatDateSlashSpaceID(reel.createdAt),
    thumbnail: firstUrlFor(media, reel.id, 'thumbnail'),
    videoUrl: firstUrlFor(media, reel.id, 'video'),
    isActive: reel.isActive
  }))
}

/**
 * Testimoni — padanan `Testimonial::active()->ordered()->with('media')->get()->map(...)`
 * (HomeController.php:62-69). Laravel sudah memakai camelCase di sini.
 *
 * SATU-SATUNYA TEMPAT MEDIA KOSONG JADI null. Testimonial::imageUrl()/logoUrl() (Testimonial.php:34-42)
 * memakai `?:`, jadi string kosong spatie jatuh ke null — karena itu `|| null` di bawah, bukan perubahan
 * pada firstUrlFor() yang dipakai koleksi lain.
 *
 * RANTAI FALLBACK BERKAS STATIS TIDAK DIPORT KE SINI. Testimonial.php:44-59 memetakan author_name
 * ('ub football club' | 'malang tennis academy' | 'brawijaya badminton club') ke assets/icons/*.avif dan
 * memeriksanya dengan file_exists(public_path). ubsc-api tidak bisa memeriksa public/ milik repo Next dan
 * tidak boleh menebak URL aset repo lain, jadi pemetaan itu hidup di ubsc-landing berdampingan dengan
 * SectionSeven (berkas .avif-nya memang sudah diimpor di SectionSeven.tsx:6-7). Semantik akhirnya tetap
 * sama: media -> aset statis -> null. Kalau landing lupa memasangnya, testimoni tanpa media kehilangan
 * gambar fallback-nya dibanding Laravel.
 *
 * Koleksi 'image' dan 'logo' (Testimonial.php:28-32) diambil dalam satu listFor(), sama seperti Reel.
 * Filter isActive, urut sortOrder ASC, tanpa limit.
 */
export async function listTestimonials(): Promise<TestimonialDto[]> {
  const testimonials = await prismaClient.testimonial.findMany({
    where: { isActive: true },
    select: { id: true, quote: true, authorName: true, authorRole: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  const media = await listFor(
    'Testimonial',
    testimonials.map((testimonial) => testimonial.id)
  )

  return testimonials.map((testimonial) => ({
    id: testimonial.id,
    image: firstUrlFor(media, testimonial.id, 'image') || null,
    quote: testimonial.quote,
    authorName: testimonial.authorName,
    authorRole: testimonial.authorRole,
    authorLogo: firstUrlFor(media, testimonial.id, 'logo') || null
  }))
}

/**
 * Ulasan publik — padanan `Review::approved()->latest()->take(10)->get()->map(...)`
 * (HomeController.php:70-75). `latest()` = ORDER BY created_at DESC — satu kunci urut, tanpa tie-breaker
 * (butir 4 kepala berkas). `limit` dioper pemanggil tanpa default; fungsi ini juga melayani
 * GET /api/public/reviews.
 *
 * userId, isApproved, dan createdAt SENGAJA tidak dikirim: Laravel tidak mengirimnya, dan reviewerName
 * di baris yang punya userId adalah nama yang dipilih sendiri oleh pengulas.
 *
 * CATATAN STATUS: di BERANDA prop ini mati — SectionSeven.tsx:50 mendeklarasikan `reviews` tapi tidak
 * pernah men-destructure-nya, jadi tidak ada satu piksel pun yang bergantung padanya. Fungsinya tetap
 * ditulis karena Laravel tetap mengirim prop-nya dan HomeDto meniru payload itu apa adanya; jangan
 * menghapusnya hanya karena beranda tidak membacanya.
 */
export async function listReviews(limit: number): Promise<ReviewDto[]> {
  const reviews = await prismaClient.review.findMany({
    where: { isApproved: true },
    select: { id: true, reviewerName: true, rating: true, text: true },
    orderBy: [{ createdAt: 'desc' }],
    take: limit
  })

  return reviews.map((review) => ({
    id: review.id,
    // `??`, BUKAN `||`: Laravel memakai `?? 'Guest'`, jadi nama berisi string kosong diteruskan apa adanya.
    reviewerName: review.reviewerName ?? GUEST_REVIEWER,
    // rating adalah Float di schema.prisma (bukan Decimal), jadi sudah number — tanpa Number()/toNumber().
    rating: review.rating,
    text: review.text
  }))
}
