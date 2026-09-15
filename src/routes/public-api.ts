import express from 'express'
import authRoutes from './details/auth'
import metaRoutes from './details/meta'
import healthRoutes from './details/health'
import publicBookingRoutes from './details/public-booking'

// ===== Router publik — tanpa auth =====
// Prefix penuh dideklarasikan di titik mount ini; file detail memakai path
// relatif polos.

export const publicRouter = express.Router()

// Login/refresh/logout dua audience. Lihat details/auth.ts untuk sub-jalur
// /customer dan /staff.
publicRouter.use('/api/auth', authRoutes)

// Metadata kontrak antar repo (contract-hash) — milik modul meta.
publicRouter.use('/api/meta', metaRoutes)

// Health check untuk UptimeRobot, PM2, dan nginx.
publicRouter.use('/api/health', healthRoutes)

// Ketersediaan slot lapangan dan kalender kelas (Fase 3). Satu-satunya data
// publik yang TIDAK boleh di-cache bersama: jawabannya bergantung pemanggil.
publicRouter.use('/api/public/booking', publicBookingRoutes)

// TODO Fase 5: sisa data landing masuk di sini sebagai /api/public/* —
// facilities, pricing, news, branches, testimonials, reels, promo carousel,
// sponsor logo, info banner, system settings. Semuanya baca saja dan aman
// di-cache; POST booking justru ada di customer-api karena butuh user login.
