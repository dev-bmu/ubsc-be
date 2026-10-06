import { Request, RequestHandler } from 'express'
import { isBypassed } from '../middleware/permission-middleware'
import * as service from '../services/news-admin-services'
import { NewsUploadFiles, StaffGate, UploadedThumbnail } from '../services/news-admin-services'
import * as pageSeo from '../services/page-seo-services'
import { UserRequest } from '../type/user-request'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller CMS berita + kategori + info banner + gym traffic (Fase 8F) =====
// Tipis: baca params/body/file/user, panggil service, balas ok(). Permission cms.manage dicek di
// baris route (requirePermission di details/admin-news*.ts, admin-info-banners.ts, admin-settings.ts),
// tidak pernah di sini.
//
// SATU PENGECUALIAN, dan ia memang bukan gerbang route: news.publish. Di Laravel
// `$this->authorize('publish-news')` dipanggil DI TENGAH store()/update(), setelah validasi, dan hanya
// untuk status 'published' (store) atau perpindahan menuju 'published' (update). Gerbang seperti itu
// tidak bisa dipasang di baris route tanpa ikut memblokir penyimpanan draft. Karena itu controller
// hanya MENGUMPULKAN permission efektif dari request lalu mengopernya; keputusannya ada di service.

/**
 * Permission efektif + status bypass. `bypass` memakai isBypassed() milik permission-middleware
 * (Administrator + jalur internal x-service-key) — SATU sumber kebenaran, jangan disalin ulang di
 * sini: bypass yang bercabang berarti Administrator bisa ditolak di satu permukaan saja.
 */
const publishGate = (req: Request): StaffGate => ({
  permissions: (req as UserRequest).permissions ?? [],
  bypass: isBypassed(req)
})

/** req.file (.single) — dicast ke bentuk minimum yang dipakai service. */
const singleImage = (file: unknown): UploadedThumbnail | undefined => file as UploadedThumbnail | undefined

/** req.files dari newsMediaUpload (.fields thumbnail + ogImage). */
const newsFiles = (files: unknown): NewsUploadFiles => (files ?? {}) as NewsUploadFiles

// ===== Berita =====

export const index: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminNews())
  } catch (error) {
    next(error)
  }
}

export const createForm: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.newsCreateForm())
  } catch (error) {
    next(error)
  }
}

export const editForm: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.newsEditForm(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

/** `author_id => Auth::id()`. requireUser menolak jalur x-service-key yang tidak membawa user (401). */
export const store: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeNews(req.body, newsFiles(req.files), requireUser(req).id, publishGate(req)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateNews(String(req.params.id), req.body, newsFiles(req.files), publishGate(req)))
  } catch (error) {
    next(error)
  }
}

export const destroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyNews(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

/** Gambar yang disisipkan editor ke isi artikel — field `image`. */
export const contentImageStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeContentImage(singleImage(req.file)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

// ===== Kategori berita =====

export const categoryStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeNewsCategory(req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const categoryUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateNewsCategory(String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

export const categoryDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyNewsCategory(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Info banner =====
// Keempatnya membalas SELURUH daftar banner yang sudah dinormalkan (InfoBannerDto[]), bukan satu
// baris: normalizeSortOrder() menyentuh semua baris, jadi satu baris saja akan membuat panel
// menampilkan nomor urut basi untuk yang lain. Alasan lengkapnya di mutateBanners().

export const bannerStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeInfoBanner(req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const bannerUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateInfoBanner(String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

export const bannerReorder: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.reorderInfoBanners(req.body))
  } catch (error) {
    next(error)
  }
}

export const bannerDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyInfoBanner(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== System setting =====

export const gymTrafficUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateGymTraffic(req.body))
  } catch (error) {
    next(error)
  }
}

// ===== SEO halaman statis landing (PRD §7.7) =====

export const seoPageIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await pageSeo.listAdminPageSeo())
  } catch (error) {
    next(error)
  }
}

export const seoPageUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await pageSeo.updatePageSeo(String(req.params.key), req.body, singleImage(req.file)))
  } catch (error) {
    next(error)
  }
}
