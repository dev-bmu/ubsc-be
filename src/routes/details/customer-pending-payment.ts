import express from 'express'
import * as ctrl from '../../controller/pending-payment-controller'

// ===== Route transfer tertunda (customer) =====
// Prefix penuh (/api/customer/pending-payment) dideklarasikan di customer-api.ts.
//
//   GET /api/customer/pending-payment   PendingPaymentDto | null
//
// Tanpa requireVerifiedEmail: di Laravel ini prop Inertia yang ikut di setiap response untuk customer
// mana pun yang login (HandleInertiaRequests::share), bukan route ber-middleware 'verified'. Justru
// akun yang belum verifikasi paling perlu melihat tagihan tertundanya.

const customerPendingPaymentRoutes = express.Router()

customerPendingPaymentRoutes.get('/', ctrl.pendingPayment)

export default customerPendingPaymentRoutes
