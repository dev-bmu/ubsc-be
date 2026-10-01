import express from 'express'
import * as gymCtrl from '../../controller/gym-controller'
import * as ctrl from '../../controller/membership-checkout-controller'
import { denyStaffAccounts, requireVerifiedEmail } from '../../middleware/auth-middleware'
import { bookingLimiter, proofUploadLimiter } from '../../middleware/rate-limit-middleware'
import { paymentProofUpload } from '../../middleware/upload-middleware'

// ===== Route checkout membership lewat web (tahap C) =====
// Prefix penuh (/api/customer/memberships) dideklarasikan di customer-api.ts.
//
//   GET  /api/customer/memberships/card                          kartu member (tahap D)
//   GET  /api/customer/memberships/checkout/:planId              pratinjau harga, biaya, tanggal mulai, foto
//   POST /api/customer/memberships                                body { membershipPlanId } -> { membershipId }
//   GET  /api/customer/memberships/:membershipId/pembayaran       instruksi transfer + status
//   POST /api/customer/memberships/:membershipId/pembayaran/bukti multipart, field `proof`
//
// Pratinjau sengaja tanpa requireVerifiedEmail: halamannya sendiri yang menampilkan gerbang verifikasi.
// bookingLimiter dipakai bersama booking: keduanya "membeli sesuatu", dan jatahnya longgar.

const customerMembershipRoutes = express.Router()

customerMembershipRoutes.get('/card', denyStaffAccounts, gymCtrl.card)
customerMembershipRoutes.get('/checkout/:planId', denyStaffAccounts, ctrl.preview)
customerMembershipRoutes.post('/', denyStaffAccounts, requireVerifiedEmail, bookingLimiter, ctrl.store)
customerMembershipRoutes.get('/:membershipId/pembayaran', denyStaffAccounts, requireVerifiedEmail, ctrl.payment)
customerMembershipRoutes.post(
  '/:membershipId/pembayaran/bukti',
  denyStaffAccounts,
  requireVerifiedEmail,
  proofUploadLimiter,
  paymentProofUpload,
  ctrl.uploadProof
)

export default customerMembershipRoutes
