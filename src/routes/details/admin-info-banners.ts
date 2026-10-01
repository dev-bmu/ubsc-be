import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/news-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route info banner (staff) — Fase 8F =====
// Prefix penuh (/api/admin/info-banners) dideklarasikan di private-api.ts; baris mount-nya ditulis
// lengkap di kepala details/admin-news.ts.
//
//   POST   /api/admin/info-banners            cms.manage   -> 201 InfoBannerDto[]
//   POST   /api/admin/info-banners/reorder    cms.manage   body { ids } -> InfoBannerDto[]
//   PUT    /api/admin/info-banners/:id        cms.manage   -> InfoBannerDto[]
//   DELETE /api/admin/info-banners/:id        cms.manage   -> InfoBannerDto[]
//
// MUTASI SAJA, tanpa GET — Laravel menyebutnya sendiri di routes/web.php:625 ("mutation-only; index
// rendered inside admin.news.index"), jadi pembacaannya ikut GET /api/admin/news (field `infoBanners`).
// Keempat aksi memakai gate yang sama (`authorize('manage-cms')` = cms.manage).
//
// KEEMPATNYA MEMBALAS SELURUH DAFTAR, bukan satu baris. Setiap aksi ditutup normalizeSortOrder() yang
// menomori ULANG semua banner 1..n, sehingga satu baris saja akan membuat panel memegang nomor urut
// basi untuk baris lain. Ini berbeda dari konvensi `{ id }` milik destroy di fase lain, dan disengaja.
//
// URUTAN WAJIB: POST '/reorder' SEBELUM route ber-parameter. Saat ini tidak ada POST '/:id' sehingga
// belum bisa tertelan, tapi urutannya dipertahankan seperti '/reorder' milik facilities.

const adminInfoBannerRoutes = express.Router()

adminInfoBannerRoutes.post('/reorder', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.bannerReorder)
adminInfoBannerRoutes.post('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.bannerStore)
adminInfoBannerRoutes.put('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.bannerUpdate)
adminInfoBannerRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.bannerDestroy)

export default adminInfoBannerRoutes
