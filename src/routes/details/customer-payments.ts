import express from 'express'
import * as ctrl from '../../controller/payment-controller'

// ===== Route berkas pembayaran pelanggan =====
// Prefix penuh (/api/customer/payments) dideklarasikan di customer-api.ts.
//
//   GET /api/customer/payments/:transactionId/bukti   stream bukti transfer, hanya pemiliknya
//
// Sengaja tanpa requireVerifiedEmail dan denyStaffAccounts — sama seperti Laravel, route ini hanya
// butuh login. Staff membaca bukti lewat /api/admin/payments/:transactionId/bukti.

const customerPaymentRoutes = express.Router()

customerPaymentRoutes.get('/:transactionId/bukti', ctrl.proofFile)

export default customerPaymentRoutes
