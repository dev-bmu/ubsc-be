import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/cms-card-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'
import { fieldsFileUpload } from '../../middleware/upload-middleware'

// ===== Route testimoni (staff) — Fase 8F =====
// Prefix penuh (/api/admin/testimonials) dideklarasikan di private-api.ts (baris mount lengkapnya
// didokumentasikan di details/admin-promo.ts).
//
//   GET    /api/admin/testimonials           cms.manage   AdminTestimonialIndexDto (testimoni + review)
//   POST   /api/admin/testimonials           cms.manage   multipart `image` + `logo` -> AdminTestimonialDto (201)
//   POST   /api/admin/testimonials/reorder   cms.manage   { ids } -> { ids } (sortOrder = index + 1)
//   PUT    /api/admin/testimonials/:id       cms.manage   multipart `image` + `logo` -> AdminTestimonialDto
//   DELETE /api/admin/testimonials/:id       cms.manage   -> { id }
//
// GET '/' mengembalikan DUA daftar sekaligus (testimonials + reviews) karena
// TestimonialController::index memang merender satu halaman berisi keduanya. Aksi tulis untuk review
// hidup di router tersendiri (details/admin-reviews.ts), bukan di bawah prefix ini.
//
// DUA field berkas dalam satu submit, keduanya `['nullable','image','max:5120']` dan masing-masing
// koleksi singleFile — jadi .fields(), bukan dua .single() berurutan (badan multipart hanya bisa
// diurai sekali).
//
// URUTAN WAJIB: '/reorder' (literal) SEBELUM '/:id' — alasannya sama dengan admin-promo.ts.

/** `image` + `logo`, masing-masing maksimal satu berkas, 5 MB, memoryStorage. */
const testimonialMediaUpload = fieldsFileUpload(
  [
    { name: 'image', maxCount: 1 },
    { name: 'logo', maxCount: 1 }
  ],
  'CMS_IMAGE',
  { tooLargeMessage: 'Ukuran gambar maksimal 5 MB.' }
)

const adminTestimonialRoutes = express.Router()

adminTestimonialRoutes.get('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.testimonialIndex)
adminTestimonialRoutes.post('/reorder', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.testimonialReorder)
adminTestimonialRoutes.post('/', testimonialMediaUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.testimonialStore)
adminTestimonialRoutes.put('/:id', testimonialMediaUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.testimonialUpdate)
adminTestimonialRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.testimonialDestroy)

export default adminTestimonialRoutes
