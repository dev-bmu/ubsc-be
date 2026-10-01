import { existsSync, unlinkSync } from 'fs'
import type {
  AdminPromoDto,
  AdminPromoIndexDto,
  AdminReelDto,
  AdminReelIndexDto,
  AdminReviewDto,
  AdminSponsorDto,
  AdminSponsorIndexDto,
  AdminTestimonialDto,
  AdminTestimonialIndexDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { now } from '../utils/clock'
import { logger } from '../utils/logger'
import { Validation } from '../validation/Validation'
import { CmsCardAdminValidation } from '../validation/cms-card-admin-validation'
import { timeAgoId } from './dashboard-services'
import { deleteForModel, firstUrlFor, listFor, MediaMap, MediaRow } from './media-services'
import { assertVideoAcceptable, deleteMediaCollection, storePublicMedia, storePublicVideo, unlinkMediaFiles } from './media-store-services'

// ============================================================================
// === Admin CMS kartu beranda — port 4 controller Laravel (Fase 8F) ===
// ============================================================================
// PromoCarouselController + SponsorLogoController + ReelController + TestimonialController (termasuk
// toggleApprove/destroyReview untuk Review). Keempatnya digerbangi `manage-cms` = cms.manage; gate-nya
// dicek di BARIS ROUTE (routes/details/admin-*.ts), tidak pernah di sini.
//
// LIMA hal yang mengubah perilaku kalau dilanggar:
//
// 1. ABSEN ≠ false/0. `'is_active' => $data['is_active'] ?? $existing->is_active` — field yang tidak
//    dikirim MEMPERTAHANKAN nilai lama; `false` yang dikirim tetap menulis false. Validasi sudah
//    mengembalikan undefined untuk yang absen (cms-card-admin-validation.ts), jadi di sini cukup `??`.
//    PENGECUALIAN: `title` promo memakai `$data['title'] ?? null` di KEDUA aksi, jadi absen MENGOSONGKAN.
//
// 2. REORDER 1-BASED DAN PARSIAL. `foreach ($ids as $index => $id) where('id',$id)->update(sort_order =
//    $index + 1)`. Baris yang tidak ada di daftar TIDAK disentuh, dan id yang tidak ada di database
//    diam-diam mengenai 0 baris — `where()->update()` Laravel tidak pernah 404. Padanannya updateMany,
//    bukan update (update melempar P2025). Daftar kosong = no-op yang berbalas 200.
//
// 3. KOLEKSI MEDIA SEMUANYA singleFile. PromoCarousel('slide'), SponsorLogo('logo'), Reel('thumbnail',
//    'video'), Testimonial('image','logo') — semuanya `->singleFile()` di registerMediaCollections().
//    Di spatie, singleFile berarti unggahan baru MENGGANTI yang lama (baris DB dan berkasnya). Di sini
//    itu eksplisit: deleteMediaCollection() lalu storePublicMedia/storePublicVideo(), dan berkas fisik
//    lama di-unlink SETELAH tulisan DB (kontrak media-store-services). Tanpa itu, satu koleksi
//    mengumpulkan baris dan firstUrlFor() tetap mengembalikan gambar LAMA selamanya.
//
// 4. DELETE OWNER HARUS MENGHAPUS MEDIANYA. relationMode="prisma" tidak punya cascade, dan spatie di
//    Laravel menghapus media saat model dihapus. deleteForModel() ikut di transaksi yang sama, berkas
//    fisiknya di-unlink setelah commit (R2).
//
// 5. URL MEDIA KOSONG JADI null DI SEMUA DTO HALAMAN INI. Keempat controller menulis
//    `getFirstMediaUrl(...) ?: null` (dan Testimonial::imageUrl()/logoUrl() memakai `?:` yang sama),
//    jadi '' dari firstUrlFor() dilewatkan `|| null` — berbeda dari cms-services.ts sisi publik yang
//    MEMPERTAHANKAN '' karena ImageCarousel.tsx bergantung padanya.
//
// Laravel membalas back()->with('success', ...); di sini tidak ada redirect, jadi setiap mutasi
// mengembalikan BARIS DALAM BENTUK TRANSFORM INDEX-nya (AdminPromoDto/AdminSponsorDto/AdminReelDto/
// AdminTestimonialDto/AdminReviewDto) supaya panel admin bisa menambal daftarnya tanpa GET ulang.
// destroy/reorder yang tidak punya baris untuk dikembalikan membalas { id } / { ids }, sama seperti 8A.

// ===== Berkas unggahan (bentuk minimum dari multer) =====

/** Berkas gambar dari multer memoryStorage — bentuk yang sama dengan Fase 8A. */
export interface UploadedImage {
  buffer: Buffer
  originalname: string
}

/**
 * Berkas video dari multer diskStorage. Tidak punya `buffer`: 50 MB tidak ditahan di memori, yang
 * dioper adalah PATH sementaranya (lihat storePublicVideo).
 */
export interface UploadedVideo {
  path: string
  originalname: string
}

/** req.files reel (.fields thumbnail+video). */
export interface ReelUploadFiles {
  thumbnail?: UploadedImage[]
  video?: UploadedVideo[]
}

/** req.files testimoni (.fields image+logo). */
export interface TestimonialUploadFiles {
  image?: UploadedImage[]
  logo?: UploadedImage[]
}

/**
 * Batas efektif video = 50 MB, dari `['nullable','mimes:mp4,webm','max:51200']` di ReelController.
 *
 * SENGAJA TIDAK memakai UPLOAD_LIMITS.VIDEO_REEL.maxBytes, yang bernilai 100 MB: angka itu berasal dari
 * Rewrite.md (pagar infrastruktur, dan catatan "TODO Fase 9: VIDEO_REEL pindah ke object storage" di
 * config/upload.ts), bukan dari aturan validasi Laravel. Memakainya akan menerima video 80 MB yang di
 * Laravel ditolak 422. Konstanta ini juga yang dipasang sebagai limits.fileSize multer di
 * routes/details/admin-reels.ts, supaya penolakan terjadi sebelum 100 MB terlanjur ditulis ke disk.
 */
export const REEL_VIDEO_MAX_BYTES = 50 * 1024 * 1024

/** Pesan 413 yang sama dengan jalur gambar CMS lain (upload-middleware.ts). */
const CMS_IMAGE_TOO_LARGE = 'Ukuran gambar maksimal 5 MB.'

/**
 * Buang berkas sementara multer yang tidak jadi dipakai — mis. video yang sudah tertulis ke
 * storage/private/tmp tapi validasi judul gagal lebih dulu, atau reel-nya tidak ditemukan (404).
 *
 * storePublicVideo() membersihkan miliknya sendiri; fungsi ini menutup jalur yang TIDAK PERNAH sampai
 * ke sana. Aman dipanggil dua kali (existsSync) dan tidak pernah melempar: kegagalan bersih-bersih
 * tidak boleh menutupi error asli yang sedang naik lewat blok finally.
 */
function discardTempUpload(path: string | undefined): void {
  if (!path) return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (error) {
    logger.warn(`Gagal menghapus berkas sementara ${path}: ${(error as Error).message}`)
  }
}

/** `max:5120` untuk gambar yang lolos limits.fileSize route reel (50 MB, dipakai bersama video). */
function assertImageWithinCmsLimit(image: UploadedImage | undefined, field: string): void {
  if (image && image.buffer.length > UPLOAD_LIMITS.CMS_IMAGE.maxBytes) {
    throw new ResponseError(413, CMS_IMAGE_TOO_LARGE, 'PAYLOAD_TOO_LARGE', { [field]: [CMS_IMAGE_TOO_LARGE] })
  }
}

// ============================================================================
// === Promo carousel ===
// ============================================================================

/** Urutan scopeOrdered + pemecah seri createdAt menaik — alasannya di kepala cms-services.ts butir 4. */
const ORDERED = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }]

interface PromoRow {
  id: string
  title: string | null
  isActive: boolean
  sortOrder: number
}

function mapPromo(promo: PromoRow, media: MediaMap): AdminPromoDto {
  return {
    id: promo.id,
    title: promo.title,
    isActive: promo.isActive,
    sortOrder: promo.sortOrder,
    slideUrl: firstUrlFor(media, promo.id, 'slide') || null
  }
}

async function loadPromo(id: string): Promise<AdminPromoDto> {
  const promo = await prismaClient.promoCarousel.findUnique({ where: { id }, select: { id: true, title: true, isActive: true, sortOrder: true } })
  if (!promo) throw new ResponseError(404, 'Slide tidak ditemukan.')
  return mapPromo(promo, await listFor('PromoCarousel', [id], 'slide'))
}

/** Ganti isi koleksi singleFile dengan satu gambar baru; tanpa berkas = tidak menyentuh apa pun. */
async function replacePromoSlide(promoId: string, slide: UploadedImage | undefined): Promise<void> {
  if (!slide) return
  const removed = await deleteMediaCollection('PromoCarousel', promoId, 'slide')
  await storePublicMedia({
    modelType: 'PromoCarousel',
    modelId: promoId,
    collectionName: 'slide',
    buffer: slide.buffer,
    originalName: slide.originalname,
    field: 'slide'
  })
  unlinkMediaFiles(removed)
}

/** GET /api/admin/promo — PromoCarouselController::index. Tanpa paginasi, tanpa filter isActive. */
export async function listAdminPromos(): Promise<AdminPromoIndexDto> {
  const promos = await prismaClient.promoCarousel.findMany({
    select: { id: true, title: true, isActive: true, sortOrder: true },
    orderBy: ORDERED
  })
  const media = await listFor(
    'PromoCarousel',
    promos.map((promo) => promo.id),
    'slide'
  )
  return { items: promos.map((promo) => mapPromo(promo, media)) }
}

/** POST /api/admin/promo — default `is_active` true, `sort_order` 0. */
export async function storePromo(body: unknown, slide: UploadedImage | undefined): Promise<AdminPromoDto> {
  const data = Validation.validate(CmsCardAdminValidation.PROMO, body)

  const promo = await prismaClient.promoCarousel.create({
    data: { title: data.title ?? null, isActive: data.isActive ?? true, sortOrder: data.sortOrder ?? 0 }
  })

  await replacePromoSlide(promo.id, slide)
  return loadPromo(promo.id)
}

/** PUT /api/admin/promo/:id — `title` absen MENGOSONGKAN; isActive/sortOrder absen mempertahankan. */
export async function updatePromo(id: string, body: unknown, slide: UploadedImage | undefined): Promise<AdminPromoDto> {
  const data = Validation.validate(CmsCardAdminValidation.PROMO, body)
  const existing = await prismaClient.promoCarousel.findUnique({ where: { id }, select: { isActive: true, sortOrder: true } })
  if (!existing) throw new ResponseError(404, 'Slide tidak ditemukan.')

  await prismaClient.promoCarousel.update({
    where: { id },
    data: { title: data.title ?? null, isActive: data.isActive ?? existing.isActive, sortOrder: data.sortOrder ?? existing.sortOrder }
  })

  await replacePromoSlide(id, slide)
  return loadPromo(id)
}

/** POST /api/admin/promo/reorder. */
export async function reorderPromos(body: unknown): Promise<{ ids: string[] }> {
  const { ids } = Validation.validate(CmsCardAdminValidation.REORDER, body)
  await prismaClient.$transaction(ids.map((id, index) => prismaClient.promoCarousel.updateMany({ where: { id }, data: { sortOrder: index + 1 } })))
  return { ids }
}

/** DELETE /api/admin/promo/:id — slide + baris media + berkasnya. */
export async function destroyPromo(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.promoCarousel.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Slide tidak ditemukan.')

  const removed: MediaRow[] = []
  await prismaClient.$transaction(async (tx) => {
    await tx.promoCarousel.delete({ where: { id } })
    removed.push(...(await deleteForModel('PromoCarousel', id, tx)))
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

// ============================================================================
// === Sponsor logo ===
// ============================================================================

interface SponsorRow {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
}

function mapSponsor(sponsor: SponsorRow, media: MediaMap): AdminSponsorDto {
  return {
    id: sponsor.id,
    name: sponsor.name,
    isActive: sponsor.isActive,
    sortOrder: sponsor.sortOrder,
    logoUrl: firstUrlFor(media, sponsor.id, 'logo') || null
  }
}

async function loadSponsor(id: string): Promise<AdminSponsorDto> {
  const sponsor = await prismaClient.sponsorLogo.findUnique({ where: { id }, select: { id: true, name: true, isActive: true, sortOrder: true } })
  if (!sponsor) throw new ResponseError(404, 'Sponsor tidak ditemukan.')
  return mapSponsor(sponsor, await listFor('SponsorLogo', [id], 'logo'))
}

async function replaceSponsorLogo(sponsorId: string, logo: UploadedImage | undefined): Promise<void> {
  if (!logo) return
  const removed = await deleteMediaCollection('SponsorLogo', sponsorId, 'logo')
  await storePublicMedia({
    modelType: 'SponsorLogo',
    modelId: sponsorId,
    collectionName: 'logo',
    buffer: logo.buffer,
    originalName: logo.originalname,
    field: 'logo'
  })
  unlinkMediaFiles(removed)
}

/** GET /api/admin/sponsors — SponsorLogoController::index. */
export async function listAdminSponsors(): Promise<AdminSponsorIndexDto> {
  const sponsors = await prismaClient.sponsorLogo.findMany({
    select: { id: true, name: true, isActive: true, sortOrder: true },
    orderBy: ORDERED
  })
  const media = await listFor(
    'SponsorLogo',
    sponsors.map((sponsor) => sponsor.id),
    'logo'
  )
  return { items: sponsors.map((sponsor) => mapSponsor(sponsor, media)) }
}

/** POST /api/admin/sponsors — `name` WAJIB (beda dari promo yang judulnya nullable). */
export async function storeSponsor(body: unknown, logo: UploadedImage | undefined): Promise<AdminSponsorDto> {
  const data = Validation.validate(CmsCardAdminValidation.SPONSOR, body)

  const sponsor = await prismaClient.sponsorLogo.create({
    data: { name: data.name, isActive: data.isActive ?? true, sortOrder: data.sortOrder ?? 0 }
  })

  await replaceSponsorLogo(sponsor.id, logo)
  return loadSponsor(sponsor.id)
}

/** PUT /api/admin/sponsors/:id. */
export async function updateSponsor(id: string, body: unknown, logo: UploadedImage | undefined): Promise<AdminSponsorDto> {
  const data = Validation.validate(CmsCardAdminValidation.SPONSOR, body)
  const existing = await prismaClient.sponsorLogo.findUnique({ where: { id }, select: { isActive: true, sortOrder: true } })
  if (!existing) throw new ResponseError(404, 'Sponsor tidak ditemukan.')

  await prismaClient.sponsorLogo.update({
    where: { id },
    data: { name: data.name, isActive: data.isActive ?? existing.isActive, sortOrder: data.sortOrder ?? existing.sortOrder }
  })

  await replaceSponsorLogo(id, logo)
  return loadSponsor(id)
}

/** POST /api/admin/sponsors/reorder. */
export async function reorderSponsors(body: unknown): Promise<{ ids: string[] }> {
  const { ids } = Validation.validate(CmsCardAdminValidation.REORDER, body)
  await prismaClient.$transaction(ids.map((id, index) => prismaClient.sponsorLogo.updateMany({ where: { id }, data: { sortOrder: index + 1 } })))
  return { ids }
}

/** DELETE /api/admin/sponsors/:id. */
export async function destroySponsor(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.sponsorLogo.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Sponsor tidak ditemukan.')

  const removed: MediaRow[] = []
  await prismaClient.$transaction(async (tx) => {
    await tx.sponsorLogo.delete({ where: { id } })
    removed.push(...(await deleteForModel('SponsorLogo', id, tx)))
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

// ============================================================================
// === Reel (thumbnail gambar + video) ===
// ============================================================================

interface ReelRow {
  id: string
  title: string
  isActive: boolean
}

function mapReel(reel: ReelRow, media: MediaMap): AdminReelDto {
  return {
    id: reel.id,
    title: reel.title,
    isActive: reel.isActive,
    thumbnailUrl: firstUrlFor(media, reel.id, 'thumbnail') || null,
    videoUrl: firstUrlFor(media, reel.id, 'video') || null
  }
}

async function loadReel(id: string): Promise<AdminReelDto> {
  const reel = await prismaClient.reel.findUnique({ where: { id }, select: { id: true, title: true, isActive: true } })
  if (!reel) throw new ResponseError(404, 'Reel tidak ditemukan.')
  // DUA koleksi, SATU query: listFor() tanpa collectionName (sama seperti listReels publik).
  return mapReel(reel, await listFor('Reel', [id]))
}

/**
 * Lampirkan thumbnail dan/atau video, masing-masing MENGGANTI koleksi singleFile-nya. Urutannya sama
 * dengan ReelController: thumbnail dulu, baru video.
 */
async function attachReelMedia(reelId: string, files: ReelUploadFiles): Promise<void> {
  const thumbnail = files.thumbnail?.[0]
  const video = files.video?.[0]
  const removed: MediaRow[] = []

  try {
    if (thumbnail) {
      removed.push(...(await deleteMediaCollection('Reel', reelId, 'thumbnail')))
      await storePublicMedia({
        modelType: 'Reel',
        modelId: reelId,
        collectionName: 'thumbnail',
        buffer: thumbnail.buffer,
        originalName: thumbnail.originalname,
        field: 'thumbnail'
      })
    }

    if (video) {
      removed.push(...(await deleteMediaCollection('Reel', reelId, 'video')))
      await storePublicVideo({
        modelType: 'Reel',
        modelId: reelId,
        collectionName: 'video',
        tempPath: video.path,
        originalName: video.originalname,
        field: 'video',
        maxBytes: REEL_VIDEO_MAX_BYTES
      })
    }
  } finally {
    // Berkas lama dibuang walau langkah berikutnya gagal: baris DB-nya SUDAH terhapus di atas, jadi
    // membiarkan berkasnya hanya menumpuk sampah yang tidak lagi dirujuk siapa pun.
    unlinkMediaFiles(removed)
  }
}

/**
 * GET /api/admin/reels — ReelController::index, `latest()` = createdAt DESC.
 *
 * Reels TIDAK punya kolom sort_order, jadi tidak ada reorder untuk domain ini dan tidak ada kunci urut
 * kedua yang bisa menolong saat createdAt seri (catatan penutup butir 4 di cms-services.ts).
 */
export async function listAdminReels(): Promise<AdminReelIndexDto> {
  const reels = await prismaClient.reel.findMany({
    select: { id: true, title: true, isActive: true },
    orderBy: [{ createdAt: 'desc' }]
  })
  const media = await listFor(
    'Reel',
    reels.map((reel) => reel.id)
  )
  return { items: reels.map((reel) => mapReel(reel, media)) }
}

/** POST /api/admin/reels — multipart `thumbnail` (gambar) + `video`. */
export async function storeReel(body: unknown, files: ReelUploadFiles): Promise<AdminReelDto> {
  const video = files.video?.[0]
  try {
    const data = Validation.validate(CmsCardAdminValidation.REEL, body)
    assertImageWithinCmsLimit(files.thumbnail?.[0], 'thumbnail')
    // Semua pemeriksaan berkas SEBELUM baris dibuat — di Laravel validasi selesai sebelum Reel::create().
    if (video) assertVideoAcceptable(video.path, REEL_VIDEO_MAX_BYTES, 'video')

    const reel = await prismaClient.reel.create({ data: { title: data.title, isActive: data.isActive ?? true } })

    await attachReelMedia(reel.id, files)
    return await loadReel(reel.id)
  } finally {
    // Jalur yang tidak pernah sampai ke storePublicVideo (validasi gagal, thumbnail kebesaran, create
    // gagal) tetap meninggalkan berkas sementara 50 MB di disk kalau tidak dibuang di sini.
    discardTempUpload(video?.path)
  }
}

/** PUT /api/admin/reels/:id. */
export async function updateReel(id: string, body: unknown, files: ReelUploadFiles): Promise<AdminReelDto> {
  const video = files.video?.[0]
  try {
    const data = Validation.validate(CmsCardAdminValidation.REEL, body)
    assertImageWithinCmsLimit(files.thumbnail?.[0], 'thumbnail')
    // Sama seperti storeReel: video buruk tidak boleh sempat mengubah baris atau mengganti thumbnail.
    if (video) assertVideoAcceptable(video.path, REEL_VIDEO_MAX_BYTES, 'video')

    const existing = await prismaClient.reel.findUnique({ where: { id }, select: { isActive: true } })
    if (!existing) throw new ResponseError(404, 'Reel tidak ditemukan.')

    await prismaClient.reel.update({ where: { id }, data: { title: data.title, isActive: data.isActive ?? existing.isActive } })

    await attachReelMedia(id, files)
    return await loadReel(id)
  } finally {
    discardTempUpload(video?.path)
  }
}

/** DELETE /api/admin/reels/:id — thumbnail DAN video ikut terhapus (deleteForModel: semua koleksi). */
export async function destroyReel(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.reel.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Reel tidak ditemukan.')

  const removed: MediaRow[] = []
  await prismaClient.$transaction(async (tx) => {
    await tx.reel.delete({ where: { id } })
    removed.push(...(await deleteForModel('Reel', id, tx)))
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

// ============================================================================
// === Testimoni + Review ===
// ============================================================================

interface TestimonialRow {
  id: string
  authorName: string
  authorRole: string
  quote: string
  isActive: boolean
  sortOrder: number
}

/**
 * Port `$t->imageUrl()` / `$t->logoUrl()` (Testimonial.php:34-42) — keduanya `getFirstMediaUrl(...) ?: null`.
 *
 * RANTAI FALLBACK BERKAS STATIS TIDAK DIPORT, sama persis dengan keputusan di listTestimonials()
 * (cms-services.ts): Testimonial::fallbackImageUrl() memetakan author_name ke assets/icons/*.avif dan
 * memeriksanya dengan file_exists(public_path), dan ubsc-api tidak bisa memeriksa public/ milik repo
 * Next. Di panel admin konsekuensinya justru lebih benar: kolom gambar memperlihatkan media yang
 * BENAR-BENAR terunggah, bukan aset statis yang tidak bisa dihapus lewat CMS.
 */
function mapTestimonial(testimonial: TestimonialRow, media: MediaMap): AdminTestimonialDto {
  return {
    id: testimonial.id,
    authorName: testimonial.authorName,
    authorRole: testimonial.authorRole,
    quote: testimonial.quote,
    isActive: testimonial.isActive,
    sortOrder: testimonial.sortOrder,
    imageUrl: firstUrlFor(media, testimonial.id, 'image') || null,
    logoUrl: firstUrlFor(media, testimonial.id, 'logo') || null
  }
}

const TESTIMONIAL_SELECT = {
  id: true,
  authorName: true,
  authorRole: true,
  quote: true,
  isActive: true,
  sortOrder: true
} as const

async function loadTestimonial(id: string): Promise<AdminTestimonialDto> {
  const testimonial = await prismaClient.testimonial.findUnique({ where: { id }, select: TESTIMONIAL_SELECT })
  if (!testimonial) throw new ResponseError(404, 'Testimoni tidak ditemukan.')
  return mapTestimonial(testimonial, await listFor('Testimonial', [id]))
}

/** 'image' lalu 'logo', masing-masing mengganti koleksi singleFile-nya — urutan TestimonialController. */
async function attachTestimonialMedia(testimonialId: string, files: TestimonialUploadFiles): Promise<void> {
  const removed: MediaRow[] = []

  try {
    for (const collection of ['image', 'logo'] as const) {
      const file = files[collection]?.[0]
      if (!file) continue
      removed.push(...(await deleteMediaCollection('Testimonial', testimonialId, collection)))
      await storePublicMedia({
        modelType: 'Testimonial',
        modelId: testimonialId,
        collectionName: collection,
        buffer: file.buffer,
        originalName: file.originalname,
        field: collection
      })
    }
  } finally {
    unlinkMediaFiles(removed)
  }
}

/**
 * Port map() Review di TestimonialController::index.
 *
 * `reviewer_name ?? user?->name ?? 'Guest'` memakai `??`, BUKAN `||`: nama berisi string kosong
 * diteruskan apa adanya (sama seperti listReviews publik).
 *
 * `created_at->diffForHumans()` diport dengan timeAgoId() yang DIIMPOR dari dashboard-services —
 * bukan disalin ulang. Dibandingkan terhadap satu `now()` yang sama untuk seluruh daftar supaya dua
 * review yang tercatat di detik yang sama tidak berbeda label hanya karena jam berjalan saat map().
 */
function mapReview(
  review: {
    id: string
    reviewerName: string | null
    rating: number
    text: string
    isApproved: boolean
    createdAt: Date
    user: { name: string } | null
  },
  at: Date
): AdminReviewDto {
  return {
    id: review.id,
    reviewerName: review.reviewerName ?? review.user?.name ?? 'Guest',
    // rating adalah Float di schema.prisma, jadi sudah number.
    rating: review.rating,
    text: review.text,
    isApproved: review.isApproved,
    createdAt: timeAgoId(review.createdAt, at)
  }
}

const REVIEW_SELECT = {
  id: true,
  reviewerName: true,
  rating: true,
  text: true,
  isApproved: true,
  createdAt: true,
  user: { select: { name: true } }
} as const

/**
 * GET /api/admin/testimonials — TestimonialController::index mengirim DUA koleksi dalam satu render:
 * testimoni kurasi (orderBy sort_order) dan review masuk dari customer (`latest()` = createdAt DESC,
 * dengan relasi user). Tidak ada filter is_active/is_approved di kedua daftar — panel ini justru yang
 * memutuskan keduanya.
 */
export async function listAdminTestimonials(): Promise<AdminTestimonialIndexDto> {
  const [testimonials, reviews] = await Promise.all([
    prismaClient.testimonial.findMany({ select: TESTIMONIAL_SELECT, orderBy: ORDERED }),
    prismaClient.review.findMany({ select: REVIEW_SELECT, orderBy: [{ createdAt: 'desc' }] })
  ])

  const media = await listFor(
    'Testimonial',
    testimonials.map((testimonial) => testimonial.id)
  )
  const at = now()

  return {
    testimonials: testimonials.map((testimonial) => mapTestimonial(testimonial, media)),
    reviews: reviews.map((review) => mapReview(review, at))
  }
}

/** POST /api/admin/testimonials — multipart `image` + `logo`. */
export async function storeTestimonial(body: unknown, files: TestimonialUploadFiles): Promise<AdminTestimonialDto> {
  const data = Validation.validate(CmsCardAdminValidation.TESTIMONIAL, body)

  const testimonial = await prismaClient.testimonial.create({
    data: {
      authorName: data.authorName,
      authorRole: data.authorRole,
      quote: data.quote,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0
    }
  })

  await attachTestimonialMedia(testimonial.id, files)
  return loadTestimonial(testimonial.id)
}

/** PUT /api/admin/testimonials/:id. */
export async function updateTestimonial(id: string, body: unknown, files: TestimonialUploadFiles): Promise<AdminTestimonialDto> {
  const data = Validation.validate(CmsCardAdminValidation.TESTIMONIAL, body)
  const existing = await prismaClient.testimonial.findUnique({ where: { id }, select: { isActive: true, sortOrder: true } })
  if (!existing) throw new ResponseError(404, 'Testimoni tidak ditemukan.')

  await prismaClient.testimonial.update({
    where: { id },
    data: {
      authorName: data.authorName,
      authorRole: data.authorRole,
      quote: data.quote,
      isActive: data.isActive ?? existing.isActive,
      sortOrder: data.sortOrder ?? existing.sortOrder
    }
  })

  await attachTestimonialMedia(id, files)
  return loadTestimonial(id)
}

/** POST /api/admin/testimonials/reorder. */
export async function reorderTestimonials(body: unknown): Promise<{ ids: string[] }> {
  const { ids } = Validation.validate(CmsCardAdminValidation.REORDER, body)
  await prismaClient.$transaction(ids.map((id, index) => prismaClient.testimonial.updateMany({ where: { id }, data: { sortOrder: index + 1 } })))
  return { ids }
}

/** DELETE /api/admin/testimonials/:id — koleksi 'image' dan 'logo' ikut terhapus. */
export async function destroyTestimonial(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.testimonial.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Testimoni tidak ditemukan.')

  const removed: MediaRow[] = []
  await prismaClient.$transaction(async (tx) => {
    await tx.testimonial.delete({ where: { id } })
    removed.push(...(await deleteForModel('Testimonial', id, tx)))
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

/**
 * POST /api/admin/reviews/:id/toggle-approve — TestimonialController::toggleApprove.
 *
 * MEMBALIK boolean-nya (bukan menerima nilai dari body), lalu mengembalikan barisnya. Laravel memilih
 * teks flash dari hasil akhirnya ('Review disetujui.' / 'Review ditolak.'); di sini `isApproved` pada
 * DTO-lah yang memberi tahu FE teks mana yang harus ditampilkan.
 */
export async function toggleReviewApproval(id: string): Promise<AdminReviewDto> {
  const existing = await prismaClient.review.findUnique({ where: { id }, select: { isApproved: true } })
  if (!existing) throw new ResponseError(404, 'Review tidak ditemukan.')

  const review = await prismaClient.review.update({ where: { id }, data: { isApproved: !existing.isApproved }, select: REVIEW_SELECT })
  return mapReview(review, now())
}

/** DELETE /api/admin/reviews/:id — Review tidak punya media, jadi tidak ada deleteForModel di sini. */
export async function destroyReview(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.review.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Review tidak ditemukan.')

  await prismaClient.review.delete({ where: { id } })
  return { id }
}
