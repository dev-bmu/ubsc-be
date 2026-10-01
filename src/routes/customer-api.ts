import express from 'express'
import { customerAuthRequired } from '../middleware/auth-middleware'
import { UserRequest } from '../type/user-request'
import { ok } from '../utils/respond'
import customerBookingRoutes from './details/customer-booking'
import customerMembershipRoutes from './details/customer-memberships'
import customerPaymentRoutes from './details/customer-payments'
import customerPendingPaymentRoutes from './details/customer-pending-payment'
import customerProfileRoutes from './details/customer-profile'
import customerReviewRoutes from './details/customer-reviews'
import customerTransactionRoutes from './details/customer-transactions'

// ===== Router customer (ubsportcenter.co.id) =====
// authRequired dipasang SEKALI di level router, bukan per baris route.
// Middleware-nya diikat ke prefix '/api/customer' dengan sengaja: web.ts
// memasang ketiga router tanpa prefix dan berurutan, jadi router.use() polos
// akan menghadang SETIAP request yang lolos dari publicRouter — termasuk
// /api/admin/* yang seharusnya ditangani privateRouter di bawahnya. Mengikat ke
// prefix membuat "sekali di level router" tetap berlaku tanpa menyandera
// audience lain.

export const customerRouter = express.Router()

customerRouter.use('/api/customer', customerAuthRequired)

// Profil + permission efektif user yang login. Dipakai app Next untuk hydrate
// sesi setelah refresh token.
customerRouter.get('/api/customer/me', (req, res) => {
  const { user, permissions } = req as UserRequest
  // Jangan balas objek Prisma mentah: hash password ikut terbawa.
  ok(res, {
    user: user ? { id: user.id, name: user.name, email: user.email, role: user.role?.name ?? null } : null,
    permissions: permissions ?? []
  })
})

// Profil, password, pengajuan identitas, hapus akun — Fase 6. Di-mount pada '/api/customer' polos
// karena path-nya tersebar ('/profile', '/password', '/identity'); ketiganya tidak beririsan dengan
// prefix di bawah dan request yang tidak cocok jatuh lewat next().
customerRouter.use('/api/customer', customerProfileRoutes)

// Booking (riwayat, buat, instruksi transfer, unggah bukti) — Fase 3.
customerRouter.use('/api/customer/booking', customerBookingRoutes)

// Berkas bukti transfer milik pelanggan — Fase 3.
customerRouter.use('/api/customer/payments', customerPaymentRoutes)

// Checkout membership lewat web (PRD tambahan 2026-09, tahap C).
customerRouter.use('/api/customer/memberships', customerMembershipRoutes)

// Daftar transaksi (modal riwayat pembayaran) + ulasan — Fase 6. Prefix literal berbeda, tidak saling
// menelan maupun bentrok dengan /me, /booking, /payments.
customerRouter.use('/api/customer/transactions', customerTransactionRoutes)
customerRouter.use('/api/customer/reviews', customerReviewRoutes)
customerRouter.use('/api/customer/pending-payment', customerPendingPaymentRoutes)
