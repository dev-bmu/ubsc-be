import express from 'express'
import { customerAuthRequired } from '../middleware/auth-middleware'
import { UserRequest } from '../type/user-request'
import { ok } from '../utils/respond'

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

// TODO Fase 6: area customer — /api/customer/bookings (riwayat + detail),
// /api/customer/bookings/:id/payment (buka transfer, unggah bukti 10 MB),
// /api/customer/identity (unggah dokumen + status verifikasi),
// /api/customer/reviews, /api/customer/profile, /api/customer/memberships.
// POST /api/customer/booking (12 langkah, Fase 3) juga masuk di sini.
