import express from 'express'
import * as ctrl from '../../controller/customer-dashboard-controller'

// ===== Route daftar transaksi pelanggan =====
// Prefix penuh (/api/customer/transactions) dideklarasikan di customer-api.ts.
//
//   GET /api/customer/transactions                          20 transaksi terbaru MILIK PEMANGGIL (CustomerTransactionIndexDto)
//   GET /api/customer/transactions/:transactionId/invoice   invoice/kuitansi siap cetak (InvoiceDto)
//
// Sengaja TANPA requireVerifiedEmail: di Laravel route ini satu-satunya di grup profil yang memakai
// ->withoutMiddleware('verified') (routes/web.php:308), karena modal riwayat pembayaran harus tetap
// terbuka bagi akun yang belum memverifikasi email — justru di situlah tagihan tertundanya terlihat.

const customerTransactionRoutes = express.Router()

customerTransactionRoutes.get('/', ctrl.transactions)
customerTransactionRoutes.get('/:transactionId/invoice', ctrl.transactionInvoice)

export default customerTransactionRoutes
