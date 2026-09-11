import express, { Router } from 'express'
import * as ctrl from '../../controller/auth-controller'
import { createAuthRequired } from '../../middleware/auth-middleware'
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

  routes.post('/login', ctrl.login(audience))
  routes.post('/refresh', ctrl.refresh(audience))
  routes.post('/logout', ctrl.logout(audience))
  routes.delete('/logout', ctrl.logout(audience))

  // Manajemen sesi multi-device — butuh access token audience yang sama.
  routes.get('/sessions', authRequired, ctrl.sessions(audience))
  routes.delete('/sessions/:id', authRequired, ctrl.revoke(audience))
  routes.delete('/sessions', authRequired, ctrl.forceLogout(audience))

  return routes
}

const authRoutes = express.Router()

authRoutes.use('/customer', createAudienceAuthRoutes('customer'))
authRoutes.use('/staff', createAudienceAuthRoutes('staff'))

// TODO Fase 1 (audience customer saja): POST /customer/register,
// GET /customer/verify-email/:token, POST /customer/resend-verification,
// POST /customer/forgot-password, POST /customer/reset-password,
// GET /customer/google, GET /customer/google/callback.

export default authRoutes
