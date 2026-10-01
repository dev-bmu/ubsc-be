import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/news-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route kategori berita (staff) — Fase 8F =====
// Prefix penuh (/api/admin/news-categories) dideklarasikan di private-api.ts; baris mount-nya
// ditulis lengkap di kepala details/admin-news.ts.
//
//   POST   /api/admin/news-categories        cms.manage   -> 201 AdminNewsCategoryDto
//   PUT    /api/admin/news-categories/:id    cms.manage   -> AdminNewsCategoryDto
//   DELETE /api/admin/news-categories/:id    cms.manage   -> { id }
//
// MUTASI SAJA, tanpa GET: Laravel merender daftar kategorinya di dalam admin.news.index, jadi
// pembacaannya ikut GET /api/admin/news (field `categories`). Ketiga aksi memakai gate yang sama
// (`authorize('manage-cms')` = cms.manage).
//
// DELETE melepas dulu artikel yang memakainya (news_category_id = null) baru menghapus barisnya —
// Laravel menulis kedua langkah itu eksplisit dan di sini langkah pertama WAJIB, karena
// relationMode="prisma" tidak punya foreign key ON DELETE SET NULL. Lihat destroyNewsCategory().
//
// Tidak ada route literal di router ini, jadi tidak ada urutan literal-sebelum-:param yang perlu
// dijaga; POST '/' ditulis lebih dulu semata demi bentuk yang sama dengan router lain.

const adminNewsCategoryRoutes = express.Router()

adminNewsCategoryRoutes.post('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.categoryStore)
adminNewsCategoryRoutes.put('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.categoryUpdate)
adminNewsCategoryRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.categoryDestroy)

export default adminNewsCategoryRoutes
