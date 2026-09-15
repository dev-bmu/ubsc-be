import express from 'express'
import * as bookingCtrl from '../../controller/booking-controller'
import * as paymentCtrl from '../../controller/payment-controller'
import { denyStaffAccounts, requireVerifiedEmail } from '../../middleware/auth-middleware'
import { bookingLimiter, proofUploadLimiter } from '../../middleware/rate-limit-middleware'
import { paymentProofUpload } from '../../middleware/upload-middleware'

// ===== Route booking pelanggan =====
// Prefix penuh (/api/customer/booking) dideklarasikan di customer-api.ts; customerAuthRequired sudah
// terpasang di level router. Path mengikuti docs/route-inventory.md.
//
//   GET  /api/customer/booking                              riwayat (halaman /riwayat-booking)
//   POST /api/customer/booking                              buat booking (12 langkah)
//   GET  /api/customer/booking/:bookingId/pembayaran        instruksi transfer
//   POST /api/customer/booking/:bookingId/pembayaran/bukti  unggah bukti (multipart, field `proof`, 10 MB)
//
// Urutan middleware unggah: pagar murah lebih dulu (akun, email, rate limit), baru multer yang menarik
// 10 MB ke memori.

const customerBookingRoutes = express.Router()

customerBookingRoutes.get('/', denyStaffAccounts, bookingCtrl.history)
customerBookingRoutes.post('/', denyStaffAccounts, bookingLimiter, bookingCtrl.store)
customerBookingRoutes.get('/:bookingId/pembayaran', denyStaffAccounts, requireVerifiedEmail, paymentCtrl.show)
customerBookingRoutes.post(
  '/:bookingId/pembayaran/bukti',
  denyStaffAccounts,
  requireVerifiedEmail,
  proofUploadLimiter,
  paymentProofUpload,
  paymentCtrl.uploadProof
)

export default customerBookingRoutes
