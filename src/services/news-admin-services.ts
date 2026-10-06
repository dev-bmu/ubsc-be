import { Prisma } from '@prisma/client'
import type {
  AdminNewsCategoryDto,
  AdminNewsDto,
  AdminNewsFormDto,
  AdminNewsIndexDto,
  InfoBannerDto,
  NewsAuthorDto,
  NewsContentImageDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { PERMISSIONS } from '../config/permissions'
import { ResponseError } from '../error/response-error'
import { FORBIDDEN_MESSAGE } from '../middleware/permission-middleware'
import { formatInstant, jakartaWallTimeToUtc, now } from '../utils/clock'
import { isUniqueViolation } from '../utils/prisma-errors'
import { htmlToText, sanitizeArticleHtml } from '../utils/sanitize-html'
import { NewsAdminValidation } from '../validation/news-admin-validation'
import { Validation } from '../validation/Validation'
import { newsSection } from './cms-services'
import { timeAgoId } from './dashboard-services'
import { deleteForModel, firstUrlFor, listFor, MediaMap, urlFor } from './media-services'
import { assertImageAcceptable, replaceSingleMedia, storePublicMedia, unlinkMediaFiles } from './media-store-services'

// ============================================================================
// === CMS berita + kategori + info banner + gym traffic (Fase 8F) ===
// ============================================================================
// Port Admin\NewsController (index/create/store/edit/update/destroy + validateArticle /
// resolvePublishedAt / transform), Admin\NewsCategoryController, Admin\InfoBannerController,
// InfoBanner::normalizeSortOrder()/scopeOrdered(), dan closure PUT admin/settings/gym-traffic
// (routes/web.php:618-622).
//
// Laravel menjawab redirect()/back(); di sini setiap aksi membalas DATA (lihat catatan per fungsi).
// Permission cms.manage dicek di baris route seperti biasa. SATU pengecualian ada di file ini —
// news.publish — karena di Laravel pun gate itu tidak di route melainkan di tengah aksi, bergantung
// pada isi request dan status baris yang sedang diubah. Lihat assertCan() + storeNews()/updateNews().

// ===== Berkas unggahan (bentuk minimum dari multer memoryStorage) =====
// Sama dengan UploadedFile di facility-services.ts; dideklarasikan ulang di sini supaya modul CMS
// tidak bergantung pada modul fasilitas hanya untuk dua properti.

export interface UploadedThumbnail {
  buffer: Buffer
  originalname: string
}

/** req.files dari newsMediaUpload (.fields thumbnail + ogImage). */
export interface NewsUploadFiles {
  thumbnail?: UploadedThumbnail[]
  ogImage?: UploadedThumbnail[]
}

/**
 * Permission efektif pemanggil, dibaca controller dari request.
 *
 * `bypass` menyalin isBypassed() di middleware/permission-middleware.ts: Administrator dan jalur
 * x-service-key lewat tanpa dicek. Tanpa field ini, Administrator akan ditolak menerbitkan berita
 * padahal requirePermission di baris route meloloskannya — persis "mengunci diri sendiri keluar"
 * yang dilarang middleware itu.
 */
export interface StaffGate {
  permissions: readonly string[]
  bypass: boolean
}

/**
 * Padanan imperatif `$this->authorize('publish-news')` di tengah aksi.
 *
 * Bentuk penolakannya HARUS sama dengan gate route: 403, kode FORBIDDEN, dan FORBIDDEN_MESSAGE yang
 * diimpor dari permission-middleware — bukan literal baru, supaya tidak ada satu permukaan yang
 * menolak dengan kalimat berbeda dari semua yang lain.
 */
function assertCan(gate: StaffGate, code: string): void {
  if (gate.bypass) return
  if (!gate.permissions.includes(code)) throw new ResponseError(403, FORBIDDEN_MESSAGE, 'FORBIDDEN')
}

function fieldError(field: string, message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { [field]: [message] })
}

// ===== Waktu: published_at =====
// R13 tetap berlaku: kolom disimpan UTC, jam dinding yang diketik staff selalu jam Jakarta.
// Laravel menyimpan wall-clock di zona aplikasi dan merendernya kembali apa adanya; padanannya di
// sini adalah WIB -> UTC saat menulis, UTC -> WIB saat membaca.

/**
 * 'YYYY-MM-DD[ T]HH:mm[:ss]' sebagai JAM DINDING WIB -> instan UTC.
 *
 * jakartaWallTimeToUtc() hanya menerima 'HH:mm', jadi detiknya ditambahkan setelahnya — bukan
 * disusun ulang dengan Date.UTC sendiri, supaya offset Jakarta tetap hidup di satu tempat
 * (utils/clock.ts). Bentuk nilainya sudah dijamin regex di news-admin-validation.ts.
 */
function wibToUtc(value: string): Date {
  const [datePart, timePart] = value.trim().split(/[ T]/)
  const [hour = '00', minute = '00', second = '00'] = (timePart ?? '').split(':')
  return new Date(jakartaWallTimeToUtc(datePart, `${hour}:${minute}`).getTime() + Number(second) * 1_000)
}

/**
 * Padanan `Carbon::toDateTimeString()` -> 'YYYY-MM-DD HH:mm:ss', dirender di WIB.
 *
 * formatInstant() sudah merender Y-m-d H:i di jam Jakarta tapi tidak mengenal token detik, jadi
 * detiknya ditempel dari getUTCSeconds(): offset Asia/Jakarta adalah +07:00 bulat, sehingga detik
 * UTC dan detik WIB selalu sama. Menambah token 's' ke clock.ts akan menyentuh berkas milik fase
 * lain, jadi tidak dilakukan.
 */
function wibDateTimeString(instant: Date): string {
  return `${formatInstant(instant, 'Y-m-d H:i')}:${String(instant.getUTCSeconds()).padStart(2, '0')}`
}

/**
 * Padanan persis NewsController::resolvePublishedAt().
 *
 *   published -> nilai dari form ?? nilai lama ?? sekarang
 *   selain itu -> nilai lama APA ADANYA (draft/archived TIDAK menghapus tanggal terbit lama, dan
 *                juga tidak menerima tanggal baru dari form — ini bukan kelalaian Laravel, itu yang
 *                membuat artikel yang di-unpublish lalu diterbitkan lagi memakai tanggal aslinya)
 */
function resolvePublishedAt(status: string, posted: string | null | undefined, existing: Date | null): Date | null {
  if (status === 'published') {
    if (posted) return wibToUtc(posted)
    return existing ?? now()
  }
  return existing
}

// ===== Str::slug() =====

/**
 * Padanan `Str::slug($name)` untuk slug kategori.
 *
 * Disalin dari slugify() di media-store-services.ts (berkas itu READ-ONLY untuk agen ini) dan sama
 * persis dengan salinan di facility-services.ts:50 — pola yang sudah disepakati R9: NFKD, buang
 * diakritik, huruf kecil, non-alfanumerik jadi '-', pangkas '-' di ujung.
 */
const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// ===== Pemuat + transform berita =====

const NEWS_SELECT = {
  id: true,
  title: true,
  slug: true,
  excerpt: true,
  content: true,
  status: true,
  publishedAt: true,
  updatedAt: true,
  metaTitle: true,
  metaDescription: true,
  noindex: true,
  newsCategory: { select: { id: true, name: true, slug: true } },
  author: { select: { id: true, name: true, avatar: true } }
} as const satisfies Prisma.NewsSelect

type NewsRow = Prisma.NewsGetPayload<{ select: typeof NEWS_SELECT }>

/**
 * Blok `author` milik transform() Laravel, termasuk fallback defensifnya.
 *
 * `author_id` NOT NULL di skema Prisma dan relasinya wajib, jadi cabang "tanpa penulis" secara
 * praktis tidak pernah tercapai — ia tetap diport karena Laravel menulisnya dan AdminNewsDto
 * mendokumentasikannya. Laravel mengirim `id => $author?->id ?? 0` (PK int); id di sini uuid dan
 * kontraknya menetapkan '' sebagai padanan "tidak ada".
 *
 * avatar_url = '/storage/'.$avatar APA ADANYA. Kolom users.avatar memang ADA di skema
 * (prisma/schema.prisma model User) dan diisi jalur Google OAuth dengan URL absolut googleusercontent,
 * jadi hasil gabungannya bisa berupa '/storage/https://lh3...' — cacat yang sudah ada di Laravel dan
 * TIDAK diperbaiki di sini (1:1). Tidak ada mount '/storage' di ubsc-api; nilai ini hanya dipakai FE
 * sebagai petunjuk, dan avatar staff tidak dirender di halaman News.
 */
function toAuthor(author: NewsRow['author']): NewsAuthorDto {
  const avatar = author?.avatar ?? null
  return {
    id: author?.id ?? '',
    name: author?.name ?? 'Admin UBSC',
    avatar,
    avatarUrl: avatar ? `/storage/${avatar}` : null
  }
}

/** Padanan NewsController::transform(). `at` dioper supaya satu daftar memakai satu "sekarang". */
function toAdminNews(row: NewsRow, thumbnails: MediaMap, ogImages: MediaMap, at: Date): AdminNewsDto {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    content: row.content,
    status: row.status,
    publishedAt: row.publishedAt ? wibDateTimeString(row.publishedAt) : null,
    // `$n->updated_at->diffForHumans()` dengan APP_LOCALE=id. timeAgoId diimpor dari
    // dashboard-services.ts (Fase 8E sudah mengekspornya) — satu implementasi, bukan dua salinan.
    updatedAt: timeAgoId(row.updatedAt, at),
    category: row.newsCategory ? { id: row.newsCategory.id, name: row.newsCategory.name, slug: row.newsCategory.slug } : null,
    author: toAuthor(row.author),
    // `getFirstMediaUrl('thumbnail') ?: null` — '' spatie dijatuhkan ke null, sama seperti
    // Testimonial::imageUrl() di cms-services.ts.
    thumbnail: firstUrlFor(thumbnails, row.id, 'thumbnail') || null,
    // SEO (PRD §7.7) — null = landing memakai fallback (judul / excerpt / thumbnail).
    section: newsSection(row.newsCategory?.slug),
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    ogImage: firstUrlFor(ogImages, row.id, 'og_image') || null,
    noindex: row.noindex
  }
}

/** Thumbnail + OG image sekumpulan artikel — dua koleksi, tanpa ikut menarik gambar isi ('content'). */
async function articleImages(ids: string[]): Promise<[MediaMap, MediaMap]> {
  return Promise.all([listFor('News', ids, 'thumbnail'), listFor('News', ids, 'og_image')])
}

/** Muat ulang satu artikel dalam bentuk DTO index (dipakai balasan store/update dan form edit). */
async function loadAdminNews(id: string): Promise<AdminNewsDto> {
  const row = await prismaClient.news.findUnique({ where: { id }, select: NEWS_SELECT })
  if (!row) throw new ResponseError(404, 'Artikel tidak ditemukan.')

  const [thumbnails, ogImages] = await articleImages([id])
  return toAdminNews(row, thumbnails, ogImages, now())
}

// ===== Info banner: normalizeSortOrder + scopeOrdered =====

type Db = Prisma.TransactionClient | typeof prismaClient

/**
 * Kunci urut scopeOrdered() Laravel: `orderBy('sort_order')->orderBy('id')`.
 *
 * PENYIMPANGAN YANG DISENGAJA: kunci kedua di sini `createdAt`, bukan `id`. PK Laravel auto-increment
 * sehingga `orderBy('id')` berarti "urutan penyisipan"; PK di skema ini uuid v4 yang ACAK, jadi
 * mengurutkannya secara leksikografis bukan meniru Laravel melainkan mengarang urutan yang tidak
 * pernah ada. `createdAt` menaik adalah padanan urutan penyisipan — alasan yang sama, dan kata demi
 * kata pembahasannya, ada di butir 4 kepala cms-services.ts (listAnnouncements memakai kunci ini
 * juga, sehingga urutan banner publik dan admin tidak pernah berbeda).
 */
const BANNER_ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] as const satisfies Prisma.InfoBannerOrderByWithRelationInput[]

const BANNER_SELECT = { id: true, message: true, isActive: true, sortOrder: true } as const satisfies Prisma.InfoBannerSelect

/**
 * Padanan `InfoBanner::normalizeSortOrder()` — nomor ulang SELURUH banner menjadi 1..n menurut
 * (sortOrder, createdAt).
 *
 * HANYA BARIS YANG BERUBAH YANG DITULIS, dan itu juga yang dilakukan Laravel: `updateQuietly()`
 * memanggil fill()+saveQuietly(), dan save() tidak mengeluarkan UPDATE apa pun bila modelnya tidak
 * dirty. Menulis semua baris tanpa syarat akan menaikkan updated_at seluruh tabel setiap kali
 * halaman News dibuka.
 */
async function normalizeBannerSortOrder(db: Db): Promise<void> {
  const banners = await db.infoBanner.findMany({ select: { id: true, sortOrder: true }, orderBy: BANNER_ORDER })

  for (const [index, banner] of banners.entries()) {
    const target = index + 1
    if (banner.sortOrder === target) continue
    await db.infoBanner.update({ where: { id: banner.id }, data: { sortOrder: target } })
  }
}

/** `InfoBanner::ordered()->get(['id','message','is_active','sort_order'])`. */
async function orderedBanners(db: Db): Promise<InfoBannerDto[]> {
  return db.infoBanner.findMany({ select: BANNER_SELECT, orderBy: BANNER_ORDER })
}

/**
 * Keempat aksi InfoBannerController membungkus mutasinya dalam DB::transaction dan menutupnya dengan
 * normalizeSortOrder(). Pola itu dipakai ulang di sini supaya tidak ada aksi yang lupa menormalkan.
 *
 * BALASANNYA SELURUH DAFTAR, bukan satu baris. Normalisasi menyentuh SEMUA banner (satu insert di
 * tengah menggeser nomor semua yang di bawahnya), jadi membalas satu baris saja akan membuat panel
 * menampilkan nomor urut yang sudah basi untuk baris lain. Ini pilihan sadar dan berbeda dari
 * konvensi `{ id }` milik destroy di fase lain.
 */
async function mutateBanners(mutate: (tx: Prisma.TransactionClient) => Promise<void>): Promise<InfoBannerDto[]> {
  return prismaClient.$transaction(async (tx) => {
    await mutate(tx)
    await normalizeBannerSortOrder(tx)
    return orderedBanners(tx)
  }, TX_OPTIONS)
}

// ============================================================================
// === Berita ===
// ============================================================================

/**
 * GET /api/admin/news — padanan NewsController::index().
 *
 * Tiga koleksi dalam satu payload karena Laravel merender ketiganya di satu halaman Inertia.
 *
 * news: `latest('updated_at')` tanpa paginasi — seluruh baris, persis Laravel (panel memfilter di
 * sisi klien). Kunci kedua createdAt DESC adalah TAMBAHAN deterministik, sama seperti
 * listIdentityQueue() di identity-admin-services.ts: Laravel hanya memberi satu kunci sehingga dua
 * baris ber-updated_at identik (hasil seed/migrasi) keluar dalam urutan yang tidak ditentukan.
 *
 * media diambil SATU BATCH lewat listFor() — `->with('media')` Laravel, bukan satu query per baris.
 *
 * categories: `withCount('news')->orderBy('name')`.
 *
 * infoBanners: normalizeSortOrder() DULU, baru ordered(). Urutannya wajib begitu; kalau dibalik,
 * halaman menampilkan nomor urut sebelum dinormalkan. Normalisasi di jalur GET ini SENGAJA tidak
 * dibungkus transaksi — Laravel pun memanggilnya telanjang di index(), dan hanya keempat aksi
 * InfoBannerController yang transaksional.
 */
export async function listAdminNews(): Promise<AdminNewsIndexDto> {
  const at = now()

  const rows = await prismaClient.news.findMany({ select: NEWS_SELECT, orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }] })
  const [thumbnails, ogImages] = await articleImages(rows.map((row) => row.id))

  const categories = await prismaClient.newsCategory.findMany({
    select: { id: true, name: true, slug: true, _count: { select: { news: true } } },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }]
  })

  await normalizeBannerSortOrder(prismaClient)

  return {
    news: rows.map((row) => toAdminNews(row, thumbnails, ogImages, at)),
    categories: categories.map((category): AdminNewsCategoryDto => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      newsCount: category._count.news
    })),
    infoBanners: await orderedBanners(prismaClient)
  }
}

/** Daftar kategori untuk dropdown form — `NewsCategory::orderBy('name')->get(['id','name'])`. */
async function formCategories(): Promise<AdminNewsFormDto['categories']> {
  return prismaClient.newsCategory.findMany({ select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { createdAt: 'asc' }] })
}

/** GET /api/admin/news/create — padanan NewsController::create(), `article` selalu null. */
export async function newsCreateForm(): Promise<AdminNewsFormDto> {
  return { article: null, categories: await formCategories() }
}

/** GET /api/admin/news/:id/edit — padanan NewsController::edit(); 404 = route-model binding Laravel. */
export async function newsEditForm(id: string): Promise<AdminNewsFormDto> {
  const [article, categories] = await Promise.all([loadAdminNews(id), formCategories()])
  return { article, categories }
}

/** `exists:news_categories,id` — dilewati bila null (aturannya `nullable`). */
async function assertCategoryExists(newsCategoryId: string | null | undefined): Promise<void> {
  if (!newsCategoryId) return
  const category = await prismaClient.newsCategory.findUnique({ where: { id: newsCategoryId }, select: { id: true } })
  if (!category) throw fieldError('newsCategoryId', 'Kategori tidak ditemukan.')
}

/**
 * `Rule::unique('news','slug')->ignore($excludeId)`.
 *
 * Dicek eksplisit supaya pesannya menempel ke field `slug` dengan 422 seperti Laravel. Indeks unik di
 * database tetap menjadi penentu terakhir (dua request bersamaan bisa lolos cek ini) — P2002 ditangkap
 * rethrowSlugConflict() dan diubah menjadi 422 yang sama, pola identik dengan facility-services.ts.
 */
async function assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
  const clash = await prismaClient.news.findFirst({
    where: excludeId ? { slug, id: { not: excludeId } } : { slug },
    select: { id: true }
  })
  if (clash) throw fieldError('slug', 'Slug sudah dipakai.')
}

function rethrowSlugConflict(error: unknown): never {
  if (isUniqueViolation(error, 'slug')) throw fieldError('slug', 'Slug sudah dipakai.')
  throw error
}

/**
 * `$article->addMediaFromRequest('thumbnail')->toMediaCollection('thumbnail')`, ditambah OG image (PRD §7.7).
 *
 * Kedua koleksi singleFile: berkas baru MENGGANTI yang lama, dengan urutan simpan-dulu-baru-hapus
 * (alasannya di replaceSingleMedia). Tanpa berkas baru, thumbnail lama bertahan — `if ($request->hasFile())`
 * Laravel, dan form berita memang tidak punya tombol "hapus thumbnail". OG image punya: `removeOgImage`.
 */
async function attachArticleMedia(newsId: string, files: NewsUploadFiles, removeOgImage: boolean): Promise<void> {
  await replaceSingleMedia({ modelType: 'News', modelId: newsId, collectionName: 'thumbnail', field: 'thumbnail' }, files.thumbnail?.[0])
  await replaceSingleMedia({ modelType: 'News', modelId: newsId, collectionName: 'og_image', field: 'ogImage' }, files.ogImage?.[0], removeOgImage)
}

/**
 * Periksa isi berkas SEBELUM tulis DB: gambar yang ditolak sharp setelah artikel tersimpan berarti klien
 * menerima 422 padahal artikelnya sudah ada (dan revalidasi landing terlewat).
 */
async function assertArticleImages(files: NewsUploadFiles): Promise<void> {
  if (files.thumbnail?.[0]) await assertImageAcceptable(files.thumbnail[0].buffer, 'thumbnail')
  if (files.ogImage?.[0]) await assertImageAcceptable(files.ogImage[0].buffer, 'ogImage')
}

// ===== Isi artikel (HTML editor) =====

/**
 * Pemilik sementara gambar isi: editor mengunggah gambar SEBELUM artikelnya tersimpan (bahkan sebelum
 * ada id saat membuat artikel baru), jadi barisnya lahir dengan modelId ini lalu diklaim saat simpan.
 */
const UNATTACHED = 'unattached'

/** Sanitasi isi; yang tersisa tanpa teks dan tanpa gambar (mis. '<p></p>' editor kosong) ditolak. */
function cleanContent(html: string): string {
  const content = sanitizeArticleHtml(html)
  if (!htmlToText(content) && !content.includes('<img')) throw fieldError('content', 'Isi artikel wajib diisi.')
  return content
}

/**
 * Tautkan gambar isi yang masih 'unattached' ke artikel yang isinya merujuknya (URL memuat media/<uuid>/).
 * Gambar yang sudah milik artikel lain tidak dipindah di sini; destroyNews() memindahkannya ke artikel lain
 * yang masih merujuknya sebelum menghapus koleksi artikel pemiliknya.
 *
 * ponytail: unggahan editor yang tidak pernah ikut tersimpan (form dibatalkan, gambar dihapus sebelum
 * simpan) tetap 'unattached' selamanya — baris + berkasnya tidak disapu. Tambah sapuan berkala
 * (modelId 'unattached' & createdAt > 1 hari) bila menumpuk.
 */
async function claimContentImages(newsId: string, content: string): Promise<void> {
  const uuids = [...new Set(Array.from(content.matchAll(/media\/([0-9a-f-]{36})\//gi), (match) => match[1].toLowerCase()))]
  if (uuids.length === 0) return
  await prismaClient.media.updateMany({
    where: { modelType: 'News', collectionName: 'content', modelId: UNATTACHED, uuid: { in: uuids } },
    data: { modelId: newsId }
  })
}

/** POST /api/admin/news/content-images — field `image`. Dibalas URL publik untuk disisipkan editor. */
export async function storeContentImage(file: UploadedThumbnail | undefined): Promise<NewsContentImageDto> {
  if (!file) throw fieldError('image', 'Pilih gambar terlebih dahulu.')
  const row = await storePublicMedia({
    modelType: 'News',
    modelId: UNATTACHED,
    collectionName: 'content',
    buffer: file.buffer,
    originalName: file.originalname,
    field: 'image'
  })
  return { url: urlFor(row) }
}

/**
 * POST /api/admin/news — padanan NewsController::store().
 *
 * GERBANG TERBIT. `$this->authorize('publish-news')` dipanggil SETELAH validasi dan HANYA bila status
 * yang dikirim 'published'. Jadi staff ber-cms.manage tanpa news.publish tetap boleh menyimpan draft;
 * yang ditolak hanya percobaan menerbitkan. Gerbang di baris route tetap cms.manage saja — meletakkan
 * news.publish di sana akan memblokir penyimpanan draft, perilaku yang tidak ada di Laravel.
 *
 * `author_id` = Auth::id() (dioper controller lewat requireUser). Isi berkas thumbnail/ogImage diperiksa
 * SEBELUM baris dibuat (assertArticleImages), jadi gambar yang ditolak = 422 tanpa artikel tersimpan; media
 * baru dilampirkan SETELAH barisnya ada, sama seperti Laravel.
 *
 * Laravel redirect ke admin.news.index; di sini dibalas ARTIKELNYA dalam bentuk AdminNewsDto — bentuk
 * transform() yang sama dengan index, sehingga panel bisa menyisipkan satu baris tanpa memuat ulang
 * seluruh daftar.
 */
export async function storeNews(request: unknown, files: NewsUploadFiles, authorId: string, gate: StaffGate): Promise<AdminNewsDto> {
  const data = Validation.validate(NewsAdminValidation.ARTICLE, request)
  const content = cleanContent(data.content)
  await assertArticleImages(files)
  if (data.status === 'published') assertCan(gate, PERMISSIONS.NEWS_PUBLISH)

  await assertCategoryExists(data.newsCategoryId)
  await assertSlugAvailable(data.slug)

  const article = await prismaClient.news
    .create({
      data: {
        newsCategoryId: data.newsCategoryId ?? null,
        authorId,
        title: data.title,
        slug: data.slug,
        excerpt: data.excerpt ?? null,
        content,
        status: data.status,
        publishedAt: resolvePublishedAt(data.status, data.publishedAt, null),
        metaTitle: data.metaTitle,
        metaDescription: data.metaDescription,
        noindex: data.noindex
      },
      select: { id: true }
    })
    .catch(rethrowSlugConflict)

  await claimContentImages(article.id, content)
  await attachArticleMedia(article.id, files, data.removeOgImage ?? false)
  return loadAdminNews(article.id)
}

/**
 * PUT /api/admin/news/:id — padanan NewsController::update().
 *
 * GERBANG TERBIT, VERSI BERSYARAT GANDA: `$data['status'] === 'published' && $news->status !==
 * 'published'`. Artinya artikel yang SUDAH terbit boleh disunting siapa pun ber-cms.manage; yang butuh
 * news.publish hanya PERPINDAHAN dari draft/archived ke published. Dua syarat itu, bukan satu.
 *
 * `author_id` TIDAK ikut diubah — Laravel tidak menyertakannya di array update(), jadi penulis asli
 * tetap tercatat meski yang menyunting orang lain.
 *
 * Field SEO yang ABSEN (undefined) tidak diubah; yang dikirim kosong menjadi null (= pakai fallback).
 */
export async function updateNews(id: string, request: unknown, files: NewsUploadFiles, gate: StaffGate): Promise<AdminNewsDto> {
  const data = Validation.validate(NewsAdminValidation.ARTICLE, request)
  const content = cleanContent(data.content)
  await assertArticleImages(files)

  const existing = await prismaClient.news.findUnique({ where: { id }, select: { id: true, status: true, publishedAt: true } })
  if (!existing) throw new ResponseError(404, 'Artikel tidak ditemukan.')

  if (data.status === 'published' && existing.status !== 'published') assertCan(gate, PERMISSIONS.NEWS_PUBLISH)

  await assertCategoryExists(data.newsCategoryId)
  await assertSlugAvailable(data.slug, id)

  await prismaClient.news
    .update({
      where: { id },
      data: {
        newsCategoryId: data.newsCategoryId ?? null,
        title: data.title,
        slug: data.slug,
        excerpt: data.excerpt ?? null,
        content,
        status: data.status,
        publishedAt: resolvePublishedAt(data.status, data.publishedAt, existing.publishedAt),
        metaTitle: data.metaTitle,
        metaDescription: data.metaDescription,
        noindex: data.noindex
      },
      select: { id: true }
    })
    .catch(rethrowSlugConflict)

  await claimContentImages(id, content)
  await attachArticleMedia(id, files, data.removeOgImage ?? false)
  return loadAdminNews(id)
}

/**
 * DELETE /api/admin/news/:id — padanan NewsController::destroy().
 *
 * `$news->delete()` di Laravel ikut menghapus media beserta berkasnya (InteractsWithMedia memasang
 * listener `deleting`). Di sini itu harus eksplisit: relationMode="prisma" tidak punya cascade dan
 * Media tidak punya relasi, jadi deleteForModel() dipanggil DALAM transaksi yang sama (R2) sedangkan
 * berkas fisiknya baru dibuang SETELAH commit — penghapusan berkas tidak bisa di-rollback.
 * deleteForModel() tidak memfilter koleksi: thumbnail, og_image, dan gambar isi ('content') ikut terhapus —
 * KECUALI gambar isi yang masih dirujuk artikel lain (disalin-tempel antar-artikel): barisnya dipindah ke
 * artikel itu lebih dulu, sehingga deleteForModel() tidak mengembalikannya dan berkasnya tidak dibuang.
 */
export async function destroyNews(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.news.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Artikel tidak ditemukan.')

  const removed = await prismaClient.$transaction(async (tx) => {
    await tx.news.delete({ where: { id } })
    const images = await tx.media.findMany({ where: { modelType: 'News', modelId: id, collectionName: 'content' }, select: { id: true, uuid: true } })
    for (const image of images) {
      const other = await tx.news.findFirst({ where: { content: { contains: `media/${image.uuid}/` } }, select: { id: true } })
      if (other) await tx.media.update({ where: { id: image.id }, data: { modelId: other.id } })
    }
    return deleteForModel('News', id, tx)
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

// ============================================================================
// === Kategori berita ===
// ============================================================================

/** Satu kategori + jumlah artikelnya, bentuk yang sama dengan panel kategori di index. */
async function loadAdminNewsCategory(id: string): Promise<AdminNewsCategoryDto> {
  const category = await prismaClient.newsCategory.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, _count: { select: { news: true } } }
  })
  if (!category) throw new ResponseError(404, 'Kategori tidak ditemukan.')

  return { id: category.id, name: category.name, slug: category.slug, newsCount: category._count.news }
}

function rethrowCategorySlugConflict(error: unknown): never {
  if (isUniqueViolation(error, 'slug')) throw fieldError('name', 'Nama kategori sudah dipakai.')
  throw error
}

/**
 * POST /api/admin/news-categories — `NewsCategory::create(['name'=>..., 'slug'=>Str::slug($name)])`.
 *
 * news_categories.slug UNIK di skema, sementara Laravel tidak memvalidasinya: di sana dua kategori
 * bernama sama menabrak indeks unik dan melempar QueryException 500. Di sini P2002 diubah menjadi 422
 * yang menempel ke field `name` — satu-satunya perbedaan adalah kode status dan pesannya bisa dibaca,
 * data yang tersimpan tetap sama (tidak ada yang tersimpan).
 */
export async function storeNewsCategory(request: unknown): Promise<AdminNewsCategoryDto> {
  const data = Validation.validate(NewsAdminValidation.CATEGORY, request)

  const category = await prismaClient.newsCategory
    .create({ data: { name: data.name, slug: slugify(data.name) }, select: { id: true } })
    .catch(rethrowCategorySlugConflict)

  return loadAdminNewsCategory(category.id)
}

/** PUT /api/admin/news-categories/:id — name + slug ikut diturunkan ulang dari name. */
export async function updateNewsCategory(id: string, request: unknown): Promise<AdminNewsCategoryDto> {
  const data = Validation.validate(NewsAdminValidation.CATEGORY, request)

  const existing = await prismaClient.newsCategory.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Kategori tidak ditemukan.')

  await prismaClient.newsCategory
    .update({ where: { id }, data: { name: data.name, slug: slugify(data.name) }, select: { id: true } })
    .catch(rethrowCategorySlugConflict)

  return loadAdminNewsCategory(id)
}

/**
 * DELETE /api/admin/news-categories/:id — padanan destroy().
 *
 * `$newsCategory->news()->update(['news_category_id' => null])` DULU, baru delete(). Laravel menulis
 * kedua baris itu sendiri dan tidak mengandalkan FK ON DELETE SET NULL; di sini langkah itu wajib
 * karena relationMode="prisma" tidak punya foreign key sama sekali — tanpa langkah ini, artikel yang
 * kategorinya dihapus menyimpan id yatim dan `newsCategory` pada pemuatan berikutnya diam-diam null
 * DENGAN kolom yang masih terisi.
 *
 * Dibungkus transaksi (Laravel tidak) supaya kategori tidak pernah terhapus sementara artikelnya
 * gagal dilepas. Tidak ada perbedaan hasil pada jalur sukses.
 */
export async function destroyNewsCategory(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.newsCategory.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Kategori tidak ditemukan.')

  await prismaClient.$transaction(async (tx) => {
    await tx.news.updateMany({ where: { newsCategoryId: id }, data: { newsCategoryId: null } })
    await tx.newsCategory.delete({ where: { id } })
  }, TX_OPTIONS)

  return { id }
}

// ============================================================================
// === Info banner ===
// ============================================================================

/**
 * POST /api/admin/info-banners — padanan InfoBannerController::store().
 *
 * `is_active` absen -> true (`$data['is_active'] ?? true`).
 * `sort_order` > 0 -> dipakai apa adanya; selain itu (absen, 0) -> `InfoBanner::max('sort_order') + 1`.
 * PHP menghitung `null + 1` sebagai 1, jadi tabel kosong menghasilkan 1 — `(max ?? 0) + 1` di bawah.
 * Nomor itu tetap hanya sementara: normalizeSortOrder() di akhir transaksi merapikannya jadi 1..n.
 */
export async function storeInfoBanner(request: unknown): Promise<InfoBannerDto[]> {
  const data = Validation.validate(NewsAdminValidation.INFO_BANNER, request)

  return mutateBanners(async (tx) => {
    const max = await tx.infoBanner.aggregate({ _max: { sortOrder: true } })
    const sortOrder = data.sortOrder !== undefined && data.sortOrder > 0 ? data.sortOrder : (max._max.sortOrder ?? 0) + 1

    await tx.infoBanner.create({ data: { message: data.message, isActive: data.isActive ?? true, sortOrder }, select: { id: true } })
  })
}

/**
 * PUT /api/admin/info-banners/:id — padanan update().
 *
 * Field yang absen MEMPERTAHANKAN nilai lama (`?? $infoBanner->is_active` / `?? $infoBanner->sort_order`),
 * bukan jatuh ke default kolom.
 */
export async function updateInfoBanner(id: string, request: unknown): Promise<InfoBannerDto[]> {
  const data = Validation.validate(NewsAdminValidation.INFO_BANNER, request)

  const existing = await prismaClient.infoBanner.findUnique({ where: { id }, select: { id: true, isActive: true, sortOrder: true } })
  if (!existing) throw new ResponseError(404, 'Banner tidak ditemukan.')

  return mutateBanners(async (tx) => {
    await tx.infoBanner.update({
      where: { id },
      data: {
        message: data.message,
        isActive: data.isActive ?? existing.isActive,
        sortOrder: data.sortOrder ?? existing.sortOrder
      },
      select: { id: true }
    })
  })
}

/**
 * POST /api/admin/info-banners/reorder — padanan reorder().
 *
 * sortOrder = index + 1 menurut urutan `ids` yang dikirim, lalu dinormalkan. updateMany dipakai,
 * bukan update, supaya id yang sudah tidak ada DILEWATI tanpa error — `where('id',$id)->update()`
 * Laravel juga tidak mengeluh untuk 0 baris. Id yang tidak ikut dikirim tetap di tabel dan
 * normalizeSortOrder() menempatkannya setelah yang dikirim (nomor lamanya lebih besar) atau sesuai
 * nomor lamanya bila lebih kecil — perilaku Laravel apa adanya, bukan aturan tambahan.
 */
export async function reorderInfoBanners(request: unknown): Promise<InfoBannerDto[]> {
  const { ids } = Validation.validate(NewsAdminValidation.REORDER, request)

  return mutateBanners(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.infoBanner.updateMany({ where: { id }, data: { sortOrder: index + 1 } })
    }
  })
}

/** DELETE /api/admin/info-banners/:id — hapus lalu normalkan, keduanya dalam satu transaksi. */
export async function destroyInfoBanner(id: string): Promise<InfoBannerDto[]> {
  const existing = await prismaClient.infoBanner.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Banner tidak ditemukan.')

  return mutateBanners(async (tx) => {
    await tx.infoBanner.delete({ where: { id } })
  })
}

// ============================================================================
// === System setting: gym traffic ===
// ============================================================================

/** Baris system_settings yang dibaca badge keramaian — kunci yang sama dengan getGymTraffic(). */
const GYM_TRAFFIC_KEY = 'gym_traffic'

/**
 * PUT /api/admin/settings/gym-traffic — padanan closure routes/web.php:618-622 +
 * `SystemSetting::set()` (updateOrCreate).
 *
 * Laravel membalas back(); di sini dibalas `{ value }`, satu-satunya data yang berubah. Tidak ada DTO
 * khusus di shared/contracts.ts untuk balasan ini (hanya GymTrafficPayload untuk badan request), jadi
 * bentuk baliknya sengaja dibuat identik dengan payload-nya — FE bisa memakai tipe yang sama.
 */
export async function updateGymTraffic(request: unknown): Promise<{ value: string }> {
  const data = Validation.validate(NewsAdminValidation.GYM_TRAFFIC, request)

  await prismaClient.systemSetting.upsert({
    where: { key: GYM_TRAFFIC_KEY },
    update: { value: data.value },
    create: { key: GYM_TRAFFIC_KEY, value: data.value },
    select: { id: true }
  })

  return { value: data.value }
}
