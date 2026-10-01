import express from 'express'
import authRoutes from './details/auth'
import metaRoutes from './details/meta'
import healthRoutes from './details/health'
import publicBookingRoutes from './details/public-booking'
import publicBookingDataRoutes from './details/public-booking-data'
import publicHomeRoutes from './details/public-home'

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
// Data statis halaman /booking (fasilitas + ulasan disetujui) — Fase 6. WAJIB di atas router
// /slots + /month: keduanya berbagi prefix '/api/public/booking', dan router ini yang membawa
// path literal '/facilities' + '/reviews'. Aturan cache & auth keduanya berlawanan — alasannya
// ditulis lengkap di kepala details/public-booking-data.ts.
publicRouter.use('/api/public/booking', publicBookingDataRoutes)
publicRouter.use('/api/public/booking', publicBookingRoutes)

// Data beranda dan koleksi CMS publik (Fase 4a): /home plus sepuluh endpoint
// granular — membership-plans, promos, sponsors, news, reels, facilities,
// testimonials, reviews, announcements, gym-traffic. Semuanya baca saja, sama
// untuk setiap pengunjung, dan boleh di-cache bersama (Cache-Control dipasang
// home-controller.ts). Daftar path lengkapnya ada di details/public-home.ts.
//
// DI BAWAH /booking, dan urutannya penting: router ini memakai prefix
// '/api/public' polos, jadi kalau dipasang lebih dulu ia akan mendahului
// '/api/public/booking'. Express mencocokkan mount secara berurutan.
publicRouter.use('/api/public', publicHomeRoutes)

// TODO Fase 5: sisa data landing masuk di sini sebagai /api/public/* — unit
// fasilitas dan resolver harga untuk halaman fasilitas & pricing (FacilityDto
// beranda sengaja TIDAK membawa `units`), lalu branches. Semuanya baca saja dan
// aman di-cache; POST booking justru ada di customer-api karena butuh user login.
//
// TODO Fase 4b: /api/customer/pending-payment (PendingPaymentDto) — per-user,
// jadi tempatnya customer-api dan JANGAN ikut ter-cache bersama HomeDto.
