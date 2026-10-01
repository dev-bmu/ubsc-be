import { Prisma } from '@prisma/client'
import type { FacilityDto, FacilityPriceDto } from '../../shared/contracts'
import { formatRupiahTight } from '../../shared/format'
import { prismaClient } from '../application/database'
import { dateOnlyToString } from '../utils/clock'
import { firstUrlFor, listFor } from './media-services'

// ============================================================================
// === Fasilitas publik — port FacilityResource pada jalur HomeController ===
// ============================================================================
// Padanan HomeController.php:59-61 (`Facility::active()->with('category','prices')->orderBy('sort_order')->get()`)
// yang dibentuk FacilityResource.php:12-38 dan FacilityPriceResource.php:12-25.
//
// TIGA hal yang mengubah TAMPILAN kalau dilanggar, bukan cuma tipe:
//
// 1. TANPA `units`. FacilityResource.php:26 memakai whenLoaded('units') sementara HomeController hanya
//    eager-load 'category' dan 'prices', jadi key-nya DIBUANG TOTAL (MissingValue) — bukan dikirim
//    sebagai array kosong. FacilityDto sengaja tidak punya field itu, jadi menambahkannya di sini
//    ditolak compiler. FACILITY_CARD_SELECT di bawah adalah pagar kedua: `select` yang menyebut kolom
//    satu per satu tidak bisa "kebetulan" ikut membawa relasi unit.
//
// 2. priceRange BUKAN formatRupiah. Laravel memakai `'Rp' . number_format($n, 0, ',', '.')`
//    (FacilityResource.php:50) — TANPA spasi setelah "Rp". formatRupiah menghasilkan "Rp 1.500.000"
//    dan tidak akan pernah sama karakter-per-karakter. Port-nya formatRupiahTight(); teks domainnya
//    (' / Jam', ' - ', 'Harga belum tersedia') dirakit di sini, bukan di shared/format.ts.
//
// 3. image = '' BILA MEDIA KOSONG, bukan null — semantik getFirstMediaUrl() spatie yang dipertahankan
//    firstUrlFor(). Media diambil BATCH lewat listFor(): satu query untuk seluruh fasilitas, bukan satu
//    query per kartu (prisma/schema.prisma:786-822).

/** Teks Laravel saat fasilitas belum punya satu pun baris harga (FacilityResource.php:44). */
const PRICE_RANGE_EMPTY = 'Harga belum tersedia'

/** Akhiran kedua cabang non-kosong (FacilityResource.php:52-53). Spasi sebelum '/' ikut dihitung. */
const PRICE_RANGE_SUFFIX = ' / Jam'

/** Pemisah min-max (FacilityResource.php:53): spasi, tanda hubung, spasi. */
const PRICE_RANGE_SEPARATOR = ' - '

/**
 * Kolom satu baris harga — persis daftar FacilityPriceResource, tidak lebih.
 *
 * `priceType` dan `sortOrder` ADA di schema.prisma tetapi TIDAK dikirim Laravel di jalur publik ini.
 * Menyebutkannya di sini akan menambah field ke JSON dan membuat bentuknya berbeda dari Laravel,
 * jadi keduanya sengaja tidak diambil.
 */
const FACILITY_PRICE_SELECT = {
  id: true,
  userCategory: true,
  label: true,
  price: true,
  durationMinutes: true,
  scheduleType: true,
  applicableDays: true,
  startsAt: true,
  endsAt: true,
  startsOn: true,
  endsOn: true,
  notes: true
} as const satisfies Prisma.FacilityPriceSelect

/**
 * Kolom kartu fasilitas beranda.
 *
 * `prices` SENGAJA tanpa orderBy dan tanpa where: Facility::prices() (Facility.php:58-61) adalah
 * hasMany polos, dan kolom facility_prices.sort_order TIDAK dipakai di jalur ini. Berbeda dari
 * FACILITY_WITH_PRICING di pricing-services.ts yang memang menambah `orderBy: createdAt` — di sana
 * urutan menentukan baris harga mana yang menang, di sini tidak menentukan apa pun: priceRange dihitung
 * dari min/max (kebal urutan) dan beranda sama sekali tidak merender array prices (HomePage.tsx:25-35).
 */
const FACILITY_CARD_SELECT = {
  id: true,
  name: true,
  slug: true,
  location: true,
  venueType: true,
  bookingMode: true,
  capacity: true,
  classCode: true,
  rating: true,
  displayMetadata: true,
  facilityCategory: { select: { name: true } },
  prices: { select: FACILITY_PRICE_SELECT }
} as const satisfies Prisma.FacilitySelect

type FacilityCardRow = Prisma.FacilityGetPayload<{ select: typeof FACILITY_CARD_SELECT }>
type FacilityPriceRow = FacilityCardRow['prices'][number]

/**
 * Kolom json `applicable_days` apa adanya, null bila bukan array.
 *
 * Cast 'array' Laravel meneruskan hasil json_decode tanpa memeriksa isinya; cast yang sama dipakai
 * FacilityPriceResolver (pricing-services.ts:131), jadi bentuknya tidak divalidasi ulang di sini —
 * satu-satunya penyimpangan adalah json non-array (mis. objek), yang jatuh ke null alih-alih diteruskan.
 */
function toApplicableDays(value: Prisma.JsonValue): string[] | null {
  return Array.isArray(value) ? (value as string[]) : null
}

/** Kolom json `display_metadata`. Objek diteruskan apa adanya; null, skalar, dan array jadi null. */
function toDisplayMetadata(value: Prisma.JsonValue): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Satu baris harga — FacilityPriceResource.php:12-25.
 *
 * startsAt/endsAt: `substr($this->starts_at, 0, 5)` Laravel memotong "18:00:00" (kolom TIME) jadi "18:00".
 * Kolom di sini sudah VarChar(5), jadi slice(0, 5) adalah no-op — dipertahankan supaya baris yang terlanjur
 * masuk dengan detik tetap terpotong, dan supaya port-nya bisa dibaca sebaris dengan sumbernya. String
 * kosong ikut jatuh ke null, sama dengan `? :` PHP.
 *
 * startsOn/endsOn: kolom @db.Date, dibaca Prisma sebagai tengah malam UTC. dateOnlyToString() memakai
 * getUTC* sehingga tidak pernah bergeser sehari — jangan ganti dengan formatter berzona.
 */
function toPriceDto(price: FacilityPriceRow): FacilityPriceDto {
  return {
    id: price.id,
    userCategory: price.userCategory,
    label: price.label,
    price: price.price,
    durationMinutes: price.durationMinutes,
    // `??`, BUKAN `||`. FacilityPriceResource.php:18 meneruskan kolomnya apa adanya tanpa default sama
    // sekali; kolomnya NOT NULL dengan @default("regular") sehingga cabang kanan tidak pernah kepakai.
    // `||` akan menulis ulang string kosong menjadi 'regular' dan itu BUKAN yang dikirim Laravel.
    scheduleType: price.scheduleType ?? 'regular',
    applicableDays: toApplicableDays(price.applicableDays),
    startsAt: price.startsAt ? price.startsAt.slice(0, 5) : null,
    endsAt: price.endsAt ? price.endsAt.slice(0, 5) : null,
    startsOn: price.startsOn ? dateOnlyToString(price.startsOn) : null,
    endsOn: price.endsOn ? dateOnlyToString(price.endsOn) : null,
    notes: price.notes
  }
}

/**
 * String rentang harga siap tampil — port FacilityResource::computePriceRange() (FacilityResource.php:41-54).
 *
 * min/max diambil dari SELURUH baris harga fasilitas: lintas userCategory (warga_ub + umum) DAN lintas
 * scheduleType. Tidak ada filter apa pun, persis `$prices->pluck('price')->min()/max()`.
 *
 * SectionSix.tsx:18-24 menampilkan string ini apa adanya dan hanya punya fallback untuk prop yang hilang,
 * bukan untuk format yang meleset — satu spasi yang salah langsung terbaca di kartu.
 */
function computePriceRange(prices: readonly FacilityPriceRow[]): string {
  if (prices.length === 0) return PRICE_RANGE_EMPTY

  const amounts = prices.map((price) => price.price)
  const min = Math.min(...amounts)
  const max = Math.max(...amounts)

  if (min === max) return `${formatRupiahTight(min)}${PRICE_RANGE_SUFFIX}`
  return `${formatRupiahTight(min)}${PRICE_RANGE_SEPARATOR}${formatRupiahTight(max)}${PRICE_RANGE_SUFFIX}`
}

/**
 * Kartu fasilitas beranda — padanan HomeController.php:59-61.
 *
 * URUTAN. Laravel hanya `orderBy('sort_order')` lalu jatuh ke urutan alami PK auto-increment. PK di sini
 * uuid (acak), jadi dua fasilitas ber-sortOrder sama bisa bertukar tempat antar request dan kartu di
 * SectionFour "berkedip". Dua tie-breaker createdAt+id ditambahkan dengan alasan yang sama persis dengan
 * media-services.ts:121 dan FACILITY_WITH_PRICING di pricing-services.ts. Untuk data yang sortOrder-nya
 * unik — kasus normal — urutannya identik dengan Laravel.
 *
 * MEDIA. Satu listFor() untuk seluruh fasilitas, bukan satu query per kartu. Koleksi 'hero' singleFile
 * (Facility.php:47-51), jadi firstUrlFor() adalah padanan penuh getFirstMediaUrl('hero') — termasuk
 * mengembalikan '' (bukan null) saat kosong.
 *
 * KATEGORI. `whenLoaded('category', fn () => $this->category->name, '')` — relasinya selalu dimuat di
 * jalur ini, jadi yang tersisa hanya '' untuk baris cacat. relationMode="prisma" menghapus foreign key,
 * jadi facilityCategoryId yang menunjuk baris terhapus memang mungkin, dan `?? ''` di bawah menangkapnya.
 * Nilai name WAJIB persis 'Lapangan & Arena' / 'Kelas & Kebugaran' (SectionFour.tsx:276,289,300) — itu
 * urusan seed/CMS, bukan normalisasi di sini.
 */
export async function listPublicFacilities(): Promise<FacilityDto[]> {
  const facilities = await prismaClient.facility.findMany({
    where: { isActive: true },
    select: FACILITY_CARD_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  const heroes = await listFor(
    'Facility',
    facilities.map((facility) => facility.id),
    'hero'
  )

  return facilities.map((facility) => ({
    id: facility.id,
    name: facility.name,
    slug: facility.slug,
    image: firstUrlFor(heroes, facility.id, 'hero'),
    category: facility.facilityCategory?.name ?? '',
    location: facility.location,
    venueType: facility.venueType,
    // `?? 'court'` dan `?? 1`: kolomnya NOT NULL dengan default di schema.prisma, jadi cabang kanan tidak
    // pernah kepakai. Ditulis supaya baris ini terbaca sebaris dengan FacilityResource.php:20-21 yang
    // memang memasang default — dan supaya kolomnya bisa dilonggarkan jadi nullable tanpa diam-diam
    // mengirim null ke kartu.
    bookingMode: facility.bookingMode ?? 'court',
    capacity: facility.capacity ?? 1,
    classCode: facility.classCode,
    // rating adalah Float di schema.prisma (bukan Decimal), jadi sudah number — tanpa .toNumber(),
    // tanpa Number(). Laravel men-cast decimal(2,1)-nya ke float di titik yang sama.
    rating: facility.rating,
    displayMetadata: toDisplayMetadata(facility.displayMetadata),
    prices: facility.prices.map(toPriceDto),
    priceRange: computePriceRange(facility.prices)
  }))
}
