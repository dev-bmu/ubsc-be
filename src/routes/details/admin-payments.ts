import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/payment-verification-controller'
import { requireAnyPermission, requirePermission } from '../../middleware/permission-middleware'

// ===== Route verifikasi pembayaran (staff) =====
// Prefix penuh (/api/admin/payments) dideklarasikan di private-api.ts.
//
//   GET  /api/admin/payments?tab=awaiting|rejected|paid  antrean verifikasi (maks 100, metode manual) — Fase 8D
//   POST /api/admin/payments/settings                    rekening tujuan + durasi hold — Fase 8D
//   POST /api/admin/payments/:transactionId/approve
//   POST /api/admin/payments/:transactionId/reject       body { reason }
//   GET  /api/admin/payments/:transactionId/bukti        stream bukti transfer
//   GET  /api/admin/payments/:transactionId/invoice      invoice/kuitansi siap cetak (InvoiceDto) — meja depan
//
// `manage-bookings` ATAU `manage-payment-links` Laravel = bookings.manage | payments.manage.
// Pengaturan HANYA `manage-payment-links` (authorizeAny(['manage-payment-links'])) = payments.manage.
// POST /settings tidak bentrok dengan /:transactionId/* karena kedalaman path-nya berbeda; tetap
// didaftarkan di atas route ber-parameter supaya urutannya literal-sebelum-:param.

const PAYMENT_VERIFIERS = [PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.PAYMENTS_MANAGE]

const adminPaymentRoutes = express.Router()

adminPaymentRoutes.get('/', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.index)
adminPaymentRoutes.post('/settings', requirePermission(PERMISSIONS.PAYMENTS_MANAGE), ctrl.updateSettings)
adminPaymentRoutes.post('/:transactionId/approve', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.approve)
adminPaymentRoutes.post('/:transactionId/reject', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.reject)
adminPaymentRoutes.get('/:transactionId/bukti', requireAnyPermission(PAYMENT_VERIFIERS), ctrl.proofFile)
// Hanya-baca: siapa pun yang boleh melihat reservasi atau membership boleh mencetak invoice-nya.
adminPaymentRoutes.get(
  '/:transactionId/invoice',
  requireAnyPermission([
    ...PAYMENT_VERIFIERS,
    PERMISSIONS.BOOKINGS_READ,
    PERMISSIONS.MEMBERS_READ,
    PERMISSIONS.MEMBERS_MANAGE,
    PERMISSIONS.REPORTS_READ
  ]),
  ctrl.invoice
)

export default adminPaymentRoutes
