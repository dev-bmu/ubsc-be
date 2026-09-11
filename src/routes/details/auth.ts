import express, { Router } from 'express'
import * as ctrl from '../../controller/auth-controller'
import { createAuthRequired } from '../../middleware/auth-middleware'
import { loginLimiter, passwordLimiter, registerLimiter } from '../../middleware/rate-limit-middleware'
import { TokenAudience } from '../../utils/jwt'

// ===== Route auth =====
// Prefix penuh (/api/auth) dideklarasikan di public-api.ts; di sini path-nya
// relatif polos. Audience eksplisit di URL, bukan ditebak dari header Origin:
// panggilan server-to-server tidak mengirim Origin, dan menebak salah berarti
// menandatangani token dengan secret yang keliru.
//
//   POST   /api/auth/customer/login      POST   /api/auth/staff/login
//   POST   /api/auth/customer/refresh    POST   /api/auth/staff/refresh
//   POST   /api/auth/customer/logout     POST   /api/auth/staff/logout
//   GET    /api/auth/customer/sessions   GET    /api/auth/staff/sessions
//
// Cookie refresh ber-Path=/api/auth sehingga terkirim ke kedua sub-jalur; yang
// memisahkan sesi keduanya adalah nama cookie, secret, dan kolom audience.

function createAudienceAuthRoutes(audience: TokenAudience): Router {
  const routes = express.Router()
  const authRequired = createAuthRequired(audience)

  // Rate limit per baris route, sama seperti permission: terbaca di tempat
  // route-nya didaftarkan, bukan tersembunyi di dalam controller.
  routes.post('/login', loginLimiter, ctrl.login(audience))
  // refresh dan logout TIDAK dibatasi: keduanya dipanggil otomatis oleh
  // interceptor axios saat access token kedaluwarsa. Membatasinya berarti
  // membuat pengguna aktif di beberapa tab terlempar keluar sendiri.
  routes.post('/refresh', ctrl.refresh(audience))
  routes.post('/logout', ctrl.logout(audience))
  routes.delete('/logout', ctrl.logout(audience))

  // Manajemen sesi multi-device — butuh access token audience yang sama.
  routes.get('/sessions', authRequired, ctrl.sessions(audience))
  routes.delete('/sessions/:id', authRequired, ctrl.revoke(audience))
  routes.delete('/sessions', authRequired, ctrl.forceLogout(audience))

  return routes
}

/**
 * Pendaftaran mandiri dan pemulihan akun — CUSTOMER SAJA.
 *
 * Tidak ada padanannya di sisi staff, dan itu disengaja: akun staff dibuat
 * administrator lewat panel (Fase 8). Membuka /staff/register berarti siapa pun
 * di internet bisa membuat akun di origin panel; membuka /staff/forgot-password
 * berarti alamat email staff bisa dienumerasi lewat beda waktu respons.
 * Staff yang lupa password dipulihkan administrator.
 */
function createCustomerSelfServiceRoutes(): Router {
  const routes = express.Router()

  routes.post('/register', registerLimiter, ctrl.register)

  // Token dikirim lewat BODY, bukan path. Token di URL ikut tercatat di log
  // akses nginx, riwayat browser, dan header Referer ke pihak ketiga.
  routes.post('/verify-email', passwordLimiter, ctrl.verifyEmail)
  routes.post('/resend-verification', passwordLimiter, ctrl.resendVerification)

  routes.post('/forgot-password', passwordLimiter, ctrl.forgotPassword)
  routes.post('/reset-password', passwordLimiter, ctrl.resetPassword)

  // Dua route ini navigasi browser sungguhan (302), bukan pemanggilan fetch —
  // balasannya redirect, bukan envelope JSON.
  routes.get('/google', ctrl.googleStart)
  routes.get('/google/callback', ctrl.googleFinish)

  return routes
}

const authRoutes = express.Router()

const customerRoutes = createAudienceAuthRoutes('customer')
customerRoutes.use(createCustomerSelfServiceRoutes())

authRoutes.use('/customer', customerRoutes)
authRoutes.use('/staff', createAudienceAuthRoutes('staff'))

export default authRoutes
