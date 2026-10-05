import { Prisma } from '@prisma/client'
import { prismaClient } from '../application/database'
import { logger } from '../utils/logger'

// ============================================================================
// === Media — padanan spatie/laravel-medialibrary ===
// ============================================================================
// Prisma tidak punya relasi polymorphic, jadi `Media` berdiri sendiri dengan modelType + modelId
// dan TANPA relasi (prisma/schema.prisma:786-822). Dua konsekuensinya diatur di file ini:
//
// 1. BATCH, BUKAN PER BARIS. Laravel menyembunyikan N+1 di balik `$model->getFirstMediaUrl()`:
//    tanpa `->with('media')` setiap baris beranda menembak satu query sendiri — 7 berita + 8 reel +
//    seluruh fasilitas + promo + sponsor dalam satu render. Di sini satu-satunya jalan baca adalah
//    listFor(), yang mengambil SEMUA id dalam satu findMany dan mengembalikan Map.
//
// 2. TIDAK ADA CASCADE DB. relationMode = "prisma" menghapus seluruh foreign key, jadi menghapus
//    owner TIDAK menghapus baris media-nya (R2). deleteForModel() wajib dipanggil di SETIAP jalur
//    delete owner — pesan larangan raw DELETE di eslint.config.mjs menyebut fungsi ini namanya.
//
// SEMANTIK STRING KOSONG. getFirstMediaUrl() spatie mengembalikan '' (bukan null) bila koleksi
// kosong, dan seluruh beranda bergantung pada itu: ImageCarousel.tsx:19 membuang slide yang src-nya
// falsy. firstUrlFor() dan urlFor() karena itu mengembalikan '' — TIDAK PERNAH null, TIDAK PERNAH
// undefined. Jangan "memperbaiki" ini menjadi null; yang berubah bukan tipe, tapi tampilannya.
//
// URL. Laravel menyusunnya dari disk 'public' (APP_URL + '/storage') dan aman ABSOLUT karena Laravel
// satu origin dengan halaman. Di arsitektur 3-repo, landing (:3000) dan API (:4020) BEDA ORIGIN saat
// dev, dan next.config.ts SENGAJA mem-proxy '/uploads' same-origin (rewrites) supaya cookie & aset
// selalu satu origin, di dev maupun produksi. Karena itu URL media
// harus RELATIF ('/uploads/media/<uuid>/<nama-kebab>') — URL absolut ke :4020 gagal dimuat <img> lintas
// origin dan mem-bypass proxy. Relatif bekerja di landing dan admin sekaligus.

/**
 * Prefiks URL berkas media. Terdiri dari dua bagian yang dikunci di tempat lain dan TIDAK boleh
 * diubah sepihak di sini:
 *   - '/uploads'  -> mount express.static di application/web.ts:57 (dijangkau lewat rewrite
 *                    next.config). Sengaja literal, bukan UPLOAD_DIR: UPLOAD_DIR adalah
 *                    folder di disk, bukan path URL-nya.
 *   - 'media/<uuid>/<fileName>' -> tata letak yang ditulis attachMedia() di
 *                    prisma/seeders/shared.ts:155, dan yang wajib diikuti pipeline unggah.
 */
const PUBLIC_URL_PREFIX = '/uploads'

type Db = Prisma.TransactionClient | typeof prismaClient

/**
 * Nilai sah kolom modelType — nama model Prisma, PascalCase, persis seperti yang ditulis seeder.
 * Dibuat union supaya salah ketik ('facility') gagal saat compile, bukan diam-diam mengembalikan
 * nol media dan section kosong tanpa satu pun error.
 */
export const MEDIA_MODEL_TYPES = ['Facility', 'FacilityUnit', 'News', 'PromoCarousel', 'SponsorLogo', 'Reel', 'Testimonial'] as const
export type MediaModelType = (typeof MEDIA_MODEL_TYPES)[number]

/**
 * Koleksi yang terdaftar di model Laravel (registerMediaCollections). Semuanya singleFile kecuali
 * 'gallery' milik Facility.
 */
export const MEDIA_COLLECTIONS = ['hero', 'gallery', 'thumbnail', 'video', 'slide', 'logo', 'image', 'unit_image'] as const
export type MediaCollection = (typeof MEDIA_COLLECTIONS)[number]

/**
 * Kolom yang dibaca jalur render. Kolom internal spatie tidak ada di schema, dan `customProperties`
 * sengaja tidak diambil: isinya jejak seeder, bukan data yang dirender.
 */
export const MEDIA_SELECT = {
  id: true,
  modelId: true,
  collectionName: true,
  uuid: true,
  name: true,
  fileName: true,
  mimeType: true,
  disk: true,
  size: true,
  orderColumn: true
} as const satisfies Prisma.MediaSelect

export type MediaRow = Prisma.MediaGetPayload<{ select: typeof MEDIA_SELECT }>

/** Hasil listFor(): modelId -> media miliknya, sudah terurut. Id tanpa media TIDAK punya entri. */
export type MediaMap = Map<string, MediaRow[]>

/**
 * Bentuk minimum yang dibutuhkan untuk menyusun path/URL. MediaRow memenuhinya secara struktural.
 *
 * TANPA `disk`: sejak urlFor() berhenti menyaring disk (lihat alasannya di sana), kolom itu tidak ikut
 * menentukan path maupun URL, jadi mewajibkannya di sini hanya memaksa pemanggil menyediakan data yang
 * tidak dibaca. Kolomnya sendiri tetap ada di MEDIA_SELECT/MediaRow — ia data baris, bukan bahan URL.
 */
export interface MediaFile {
  uuid: string | null
  fileName: string
}

/**
 * Semua media milik sekumpulan owner, dalam SATU query.
 *
 * `collectionName` opsional: tanpa argumen itu, seluruh koleksi owner ikut terbawa (dipakai halaman
 * yang butuh beberapa koleksi sekaligus, mis. Reel yang punya 'thumbnail' dan 'video' — dua koleksi
 * dalam satu query, bukan dua).
 *
 * Urutan: `orderColumn` ASC seperti `morphMany(...)->orderBy('order_column')` spatie. Dua tie-breaker
 * ditambahkan karena PK di sini uuid (acak) sementara Laravel jatuh ke urutan alami auto-increment —
 * alasan yang sama dengan FACILITY_WITH_PRICING di pricing-services.ts. Tanpa itu, dua media dengan
 * orderColumn sama bisa bertukar tempat antar request dan galeri "berkedip".
 */
export async function listFor(modelType: MediaModelType, modelIds: readonly string[], collectionName?: MediaCollection): Promise<MediaMap> {
  const map: MediaMap = new Map()

  // Daftar id kosong = tidak ada yang perlu ditanyakan. `in: []` tetap menjadi satu round-trip ke
  // database untuk hasil yang sudah pasti kosong.
  const ids = [...new Set(modelIds)]
  if (ids.length === 0) return map

  const where: Prisma.MediaWhereInput = { modelType, modelId: { in: ids } }
  if (collectionName) where.collectionName = collectionName

  const rows = await prismaClient.media.findMany({
    where,
    select: MEDIA_SELECT,
    orderBy: [{ orderColumn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  for (const row of rows) {
    const bucket = map.get(row.modelId)
    if (bucket) bucket.push(row)
    else map.set(row.modelId, [row])
  }

  return map
}

/**
 * Path berkas relatif terhadap UPLOAD_DIR: 'media/<uuid>/<nama-kebab>'.
 *
 * Satu-satunya tempat tata letak itu ditulis di sisi API. Pemanggil yang perlu menyentuh berkasnya
 * di disk (mis. membersihkan berkas setelah deleteForModel) memakai fungsi ini, bukan menyusun
 * ulang stringnya sendiri.
 *
 * '' bila baris tidak punya uuid: berkasnya memang tidak pernah ditulis di bawah nama itu, jadi
 * tidak ada path yang bisa dikembalikan.
 */
export function storagePathFor(media: MediaFile): string {
  if (!media.uuid || !media.fileName) return ''
  return `media/${media.uuid}/${media.fileName}`
}

/**
 * URL publik absolut sebuah media — padanan `$media->getUrl()`.
 *
 * DIBANGUN UNTUK MEDIA APA PUN YANG PUNYA uuid + fileName, TANPA MEMANDANG DISK. `getFirstMediaUrl()`
 * spatie tidak memfilter disk sama sekali; ia menyusun URL dari baris itu dan mengembalikannya. Versi
 * sebelumnya menyaring `disk !== 'public'` dan mengembalikan '' — dan '' bukan nilai netral di sini:
 * ImageCarousel.tsx:19 MEMBUANG slide yang src-nya falsy, jadi satu baris berdisk lain menghilangkan satu
 * slide yang di Laravel tetap ada. Filter itu juga menulis logger.warn per-media per-request di jalur yang
 * dilalui SETIAP cache-miss beranda, tanpa dedup dan tanpa rate limit.
 *
 * KEKHAWATIRAN ASLINYA TETAP SAH DAN TETAP TERTANGANI, hanya bukan dengan mengubah bentuk data: mount
 * publik HANYA melayani uploads/ (application/web.ts:57) dan storage/private tidak pernah di-mount, jadi
 * URL ke media berdisk lain menghasilkan 404 — persis seperti di Laravel, di mana disk non-public juga
 * tidak punya route publik. Kalau nama berkas di dalam URL itu sendiri tidak boleh muncul, tempat
 * memperbaikinya adalah jalur tulis yang menaruh dokumen non-publik di koleksi yang dirender, bukan
 * formatter URL ini.
 *
 * '' HANYA untuk baris tanpa uuid/fileName: cacat data, berkasnya memang tidak pernah ditulis di bawah
 * nama itu. Kasus itu tetap dicatat log karena '' membuat gambar hilang dari halaman secara diam-diam dan
 * baris log inilah satu-satunya jejaknya.
 *
 * encodeURI, bukan encodeURIComponent: pemisah '/' harus tetap pemisah. Nama berkas seharusnya
 * sudah kebab-case (R9), ini pagar untuk baris yang terlanjur masuk dengan spasi.
 */
export function urlFor(media: MediaFile): string {
  const path = storagePathFor(media)
  if (!path) {
    logger.warn(`Media tanpa uuid/fileName, URL tidak dibuat: ${media.fileName}`)
    return ''
  }

  // Relatif (tanpa origin) — lihat catatan URL di kepala berkas: same-origin lewat proxy/nginx.
  return `${PUBLIC_URL_PREFIX}/${encodeURI(path)}`
}

/**
 * URL media PERTAMA sebuah owner di satu koleksi — padanan persis `getFirstMediaUrl($collection)`,
 * termasuk nilai baliknya saat kosong: STRING KOSONG, bukan null.
 *
 * Kolom pemanggil yang memang null di Laravel (testimonials.image, testimonials.authorLogo) diurus
 * di pemanggilnya dengan `firstUrlFor(...) || null`, bukan dengan mengubah fungsi ini.
 */
export function firstUrlFor(map: MediaMap, modelId: string, collectionName: MediaCollection): string {
  const first = map.get(modelId)?.find((media) => media.collectionName === collectionName)
  return first ? urlFor(first) : ''
}

/**
 * Hapus SELURUH baris media milik satu owner. Wajib dipanggil di setiap jalur delete owner (R2):
 * tanpa foreign key, menghapus Facility/News/Reel meninggalkan baris media yatim yang tidak ditolak
 * siapa pun dan baru terlihat berbulan-bulan kemudian lewat scripts/check-orphans.ts.
 *
 * `db` menerima TransactionClient supaya penghapusan ikut transaksi yang sama dengan owner-nya —
 * kalau tidak, media bisa hilang padahal delete owner-nya batal.
 *
 * Mengembalikan baris yang dihapus, bukan jumlahnya: berkas fisik di uploads/ SENGAJA tidak
 * disentuh di sini. Penghapusan berkas tidak bisa di-rollback, jadi ia milik pemanggil dan
 * dilakukan SETELAH commit, dengan storagePathFor() atas baris-baris ini.
 */
export async function deleteForModel(modelType: MediaModelType, modelId: string, db: Db = prismaClient): Promise<MediaRow[]> {
  const rows = await db.media.findMany({ where: { modelType, modelId }, select: MEDIA_SELECT })
  if (rows.length === 0) return []

  await db.media.deleteMany({ where: { modelType, modelId } })
  logger.info(`Media dihapus: ${modelType} ${modelId} (${rows.length} baris)`)

  return rows
}
