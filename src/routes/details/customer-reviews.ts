import express from 'express'
import * as ctrl from '../../controller/customer-dashboard-controller'

// ===== Route ulasan pelanggan =====
// Prefix penuh (/api/customer/reviews) dideklarasikan di customer-api.ts.
//
//   GET  /api/customer/reviews/eligibility   canReview + existingReview (ReviewEligibilityDto)
//   POST /api/customer/reviews               simpan ulasan (updateOrCreate per user) -> MyReviewDto
//
// '/eligibility' literal didaftarkan SEBELUM POST '/' supaya tidak pernah tertelan; keduanya beda
// method sehingga sebenarnya tidak bisa bentrok, tapi urutannya dijaga agar konsisten dengan
// berkas route lain di repo ini.
//
// Gate keikutsertaan ("harus punya booking selesai") BUKAN di sini melainkan di service: pesannya
// spesifik dan ditentukan data, bukan oleh baris route.

const customerReviewRoutes = express.Router()

customerReviewRoutes.get('/eligibility', ctrl.reviewsEligibility)
customerReviewRoutes.post('/', ctrl.reviewsStore)

export default customerReviewRoutes
