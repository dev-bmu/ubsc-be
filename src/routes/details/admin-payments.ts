import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/payment-verification-controller'
import { requireAnyPermission } from '../../middleware/permission-middleware'

// ===== Route verifikasi pembayaran (staff) =====
// Prefix penuh (/api/admin/payments) dideklarasikan di private-api.ts.
//
//   POST /api/admin/payments/:transactionId/approve
//   POST /api/admin/payments/:transactionId/reject    body { reason }
//   GET  /api/admin/payments/:transactionId/bukti     stream bukti transfer
//
// `manage-bookings` ATAU `manage-payment-links` Laravel = bookings.manage | payments.manage.
// Antrean verifikasi (index) dan pengaturan rekening menyusul di Fase 8; POST /settings tidak bentrok
// dengan /:transactionId/* karena kedalaman path-nya berbeda.

const PAYMENT_VERIFIERS = [PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.PAYMENTS_MANAGE]

const adminPaymentRoutes = express.Router()

adminPaymentRoutes.post('/:transactionId/approve', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.approve)
adminPaymentRoutes.post('/:transactionId/reject', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.reject)
adminPaymentRoutes.get('/:transactionId/bukti', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.proofFile)

export default adminPaymentRoutes
