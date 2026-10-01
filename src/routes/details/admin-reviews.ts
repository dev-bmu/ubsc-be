import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/cms-card-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route review customer (staff) — Fase 8F =====
// Prefix penuh (/api/admin/reviews) dideklarasikan di private-api.ts (baris mount lengkapnya
// didokumentasikan di details/admin-promo.ts).
//
//   POST   /api/admin/reviews/:id/toggle-approve   cms.manage   balik isApproved -> AdminReviewDto
//   DELETE /api/admin/reviews/:id                  cms.manage   -> { id }
//
// Kedua aksinya milik TestimonialController Laravel (toggleApprove + destroyReview) dan memakai gate
// `manage-cms` yang sama, tapi menyentuh model Review — bukan Testimonial. Router tersendiri supaya
// ':id' di sini tidak pernah dibaca sebagai id testimoni.
//
// DAFTAR review-nya sendiri TIDAK ada di sini: Laravel mengirimnya sebagai bagian dari
// TestimonialController::index, jadi pembacanya adalah GET /api/admin/testimonials.
//
// toggle-approve memakai POST, bukan PATCH: Laravel mendaftarkannya sebagai POST dan aksinya bukan
// "kirim nilai baru" melainkan "balik nilainya" (tidak idempoten).
//
// URUTAN: '/:id/toggle-approve' lebih dalam satu segmen dari '/:id', jadi keduanya tidak bisa saling
// menelan; tidak ada segmen literal di router ini yang perlu didahulukan.

const adminReviewRoutes = express.Router()

adminReviewRoutes.post('/:id/toggle-approve', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.reviewToggleApprove)
adminReviewRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.reviewDestroy)

export default adminReviewRoutes
