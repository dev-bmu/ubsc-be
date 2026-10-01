import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/news-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'
import { singleFileUpload } from '../../middleware/upload-middleware'

// ===== Route CMS berita (staff) — Fase 8F =====
// Prefix penuh (/api/admin/news) dideklarasikan di private-api.ts.
//
//   GET    /api/admin/news              cms.manage   daftar penuh + kategori + info banner (AdminNewsIndexDto)
//   GET    /api/admin/news/create       cms.manage   form kosong (AdminNewsFormDto, article: null)
//   POST   /api/admin/news              cms.manage   multipart, `thumbnail` opsional -> 201 AdminNewsDto
//   GET    /api/admin/news/:id/edit     cms.manage   form terisi (AdminNewsFormDto)
//   PUT    /api/admin/news/:id          cms.manage   multipart, `thumbnail` opsional -> AdminNewsDto
//   DELETE /api/admin/news/:id          cms.manage   -> { id } (baris media + berkasnya ikut dihapus)
//
// `authorize('manage-cms')` Laravel = cms.manage, dan KEENAM aksinya memakai gate yang sama persis —
// jadi requirePermission tunggal, bukan requireAnyPermission.
//
// news.publish (= `publish-news`) SENGAJA TIDAK ADA di baris mana pun. Di Laravel gate itu dipanggil
// di tengah store()/update(), hanya saat status yang dikirim 'published' (dan, pada update, hanya bila
// barisnya belum terbit). Memasangnya di sini akan ikut memblokir penyimpanan DRAFT oleh staff
// ber-cms.manage — perilaku yang tidak ada di Laravel. Pengecekannya ada di news-admin-services.ts.
//
// URUTAN WAJIB: GET '/create' didaftarkan SEBELUM route ber-parameter. '/:id/edit' dan '/:id' punya
// kedalaman path berbeda sehingga tidak saling menelan, tapi urutan literal-sebelum-:param tetap
// dipertahankan supaya penambahan GET '/:id' kelak tidak diam-diam menelan 'create'.
//
// ============================================================================
// === Baris mount yang WAJIB ditambahkan parent ke src/routes/private-api.ts ===
// ============================================================================
// Import (urut alfabetis bersama import router lain):
//   import adminInfoBannerRoutes from './details/admin-info-banners'
//   import adminNewsRoutes from './details/admin-news'
//   import adminNewsCategoryRoutes from './details/admin-news-categories'
//   import adminSettingsRoutes from './details/admin-settings'
//
// Pemasangan:
//   privateRouter.use('/api/admin/news-categories', adminNewsCategoryRoutes)
//   privateRouter.use('/api/admin/news', adminNewsRoutes)
//   privateRouter.use('/api/admin/info-banners', adminInfoBannerRoutes)
//   privateRouter.use('/api/admin/settings', adminSettingsRoutes)
//
// URUTAN: router.use() Express 5 mencocokkan prefix pada BATAS SEGMEN, sehingga
// '/api/admin/news' TIDAK menelan '/api/admin/news-categories' ('-categories' bukan segmen baru) —
// berbeda dari pasangan /memberships/plans vs /memberships/:id yang memang satu segmen. Karena itu
// keempat baris di atas boleh dipasang dalam urutan mana pun. news-categories tetap ditulis lebih
// dulu sebagai asuransi murah bila suatu saat prefix-nya diubah menjadi '/api/admin/news/categories',
// yang SEKETIKA akan tertelan oleh router news bila urutannya terbalik.
//
// Tidak ada prefix lain di private-api.ts yang bertabrakan: '/api/admin/settings' belum dipakai
// (pengaturan rekening Fase 8D hidup di '/api/admin/payments/settings', satu segmen lebih dalam).

/**
 * `'thumbnail' => ['nullable','image','max:5120']`.
 *
 * Dirakit di sini dari factory singleFileUpload, bukan ditambahkan sebagai konstanta baru di
 * middleware/upload-middleware.ts: berkas itu di luar kepemilikan agen Fase 8F ini. CMS_IMAGE =
 * 5 MB, angka yang sama dengan max:5120 Laravel. Validasi ISI berkas (benar-benar gambar, format
 * jpeg/png/webp, batas dimensi) dilakukan storePublicMedia() lewat decoder sharp — padanan aturan
 * `image` Laravel, bukan pemeriksaan Content-Type yang ditulis klien.
 */
const newsThumbnailUpload = singleFileUpload('thumbnail', 'CMS_IMAGE', { tooLargeMessage: 'Ukuran gambar maksimal 5 MB.' })

const adminNewsRoutes = express.Router()

adminNewsRoutes.get('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.index)
adminNewsRoutes.get('/create', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.createForm)
adminNewsRoutes.post('/', newsThumbnailUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.store)
adminNewsRoutes.get('/:id/edit', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.editForm)
adminNewsRoutes.put('/:id', newsThumbnailUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.update)
adminNewsRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.destroy)

export default adminNewsRoutes
