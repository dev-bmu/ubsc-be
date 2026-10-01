import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/cms-card-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'
import { singleFileUpload } from '../../middleware/upload-middleware'

// ===== Route promo carousel (staff) — Fase 8F =====
// Prefix penuh (/api/admin/promo) dideklarasikan di private-api.ts.
//
//   GET    /api/admin/promo             cms.manage   AdminPromoIndexDto (semua slide, urut sortOrder)
//   POST   /api/admin/promo             cms.manage   multipart `slide` -> AdminPromoDto (201)
//   POST   /api/admin/promo/reorder     cms.manage   { ids } -> { ids } (sortOrder = index + 1)
//   PUT    /api/admin/promo/:id         cms.manage   multipart `slide` -> AdminPromoDto
//   DELETE /api/admin/promo/:id         cms.manage   -> { id }
//
// `authorize('manage-cms')` Laravel = cms.manage, dan KELIMA aksinya memakai gate yang sama persis —
// jadi requirePermission tunggal, bukan requireAnyPermission. Permission per baris, tidak pernah di
// controller.
//
// URUTAN WAJIB: '/reorder' (literal) didaftarkan SEBELUM '/:id'. Keduanya POST vs PUT/DELETE sehingga
// tidak benar-benar bertabrakan hari ini, tapi urutannya tetap dijaga seperti admin-facilities.ts —
// menambah `PUT /reorder` atau `POST /:id` di masa depan akan langsung ditelan parameter kalau tidak.
//
// ============================================================================
// === BARIS MOUNT YANG HARUS DITAMBAHKAN PARENT DI routes/private-api.ts ===
// ============================================================================
// Import (urut alfabetis di blok import yang sudah ada):
//
//   import adminPromoRoutes from './details/admin-promo'
//   import adminReelRoutes from './details/admin-reels'
//   import adminReviewRoutes from './details/admin-reviews'
//   import adminSponsorRoutes from './details/admin-sponsors'
//   import adminTestimonialRoutes from './details/admin-testimonials'
//
// Mount (satu blok, setelah privateRouter.use('/api/admin/identity', adminIdentityRoutes)):
//
//   // CMS kartu beranda (promo / sponsor / reel / testimoni + review) — Fase 8F. Kelima prefix literal
//   // berbeda dan tidak saling menelan maupun bentrok dengan prefix lain; urutan literal-sebelum-:id
//   // dijaga di dalam tiap file details.
//   privateRouter.use('/api/admin/promo', adminPromoRoutes)
//   privateRouter.use('/api/admin/sponsors', adminSponsorRoutes)
//   privateRouter.use('/api/admin/reels', adminReelRoutes)
//   privateRouter.use('/api/admin/testimonials', adminTestimonialRoutes)
//   privateRouter.use('/api/admin/reviews', adminReviewRoutes)
//
// BATASAN URUTAN: TIDAK ADA di antara kelimanya — kelima prefiksnya literal dan saling lepas, jadi
// urutan relatifnya bebas. Yang WAJIB dijaga hanya bahwa tidak satu pun dari kelimanya didaftarkan di
// bawah sebuah prefix ber-parameter. Khususnya `/api/admin/reviews` adalah router TERSENDIRI dan bukan
// sub-path testimoni, meski Laravel menaruh kedua aksinya di TestimonialController yang sama — kalau
// suatu saat dipindah menjadi '/api/admin/testimonials/reviews', ia WAJIB berada di atas baris
// '/api/admin/testimonials' supaya 'reviews' tidak jatuh ke handler PUT/DELETE /:id sebagai id.

const CMS_IMAGE_TOO_LARGE = 'Ukuran gambar maksimal 5 MB.'

/** `['nullable','image','max:5120']` — batas 5 MB ditegakkan multer, ISI berkas oleh sharp di storePublicMedia. */
const promoSlideUpload = singleFileUpload('slide', 'CMS_IMAGE', { tooLargeMessage: CMS_IMAGE_TOO_LARGE })

const adminPromoRoutes = express.Router()

adminPromoRoutes.get('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.promoIndex)
adminPromoRoutes.post('/reorder', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.promoReorder)
adminPromoRoutes.post('/', promoSlideUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.promoStore)
adminPromoRoutes.put('/:id', promoSlideUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.promoUpdate)
adminPromoRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.promoDestroy)

export default adminPromoRoutes
