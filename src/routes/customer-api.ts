import express from 'express'
import { customerAuthRequired } from '../middleware/auth-middleware'
import { UserRequest } from '../type/user-request'
import { ok } from '../utils/respond'
import customerBookingRoutes from './details/customer-booking'
import customerPaymentRoutes from './details/customer-payments'

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

// Booking (riwayat, buat, instruksi transfer, unggah bukti) — Fase 3.
customerRouter.use('/api/customer/booking', customerBookingRoutes)

// Berkas bukti transfer milik pelanggan — Fase 3.
customerRouter.use('/api/customer/payments', customerPaymentRoutes)

// TODO Fase 6: /api/customer/transactions (JSON dashboard), /api/customer/profile,
// /api/customer/profile/identity (unggah dokumen + status verifikasi),
// /api/customer/reviews, /api/customer/memberships.
