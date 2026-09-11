import { Request, RequestHandler } from 'express'
import { forceLogoutAll, getActiveSessions, getRefreshCookieName, loginAuth, logoutAuth, refreshAuth, revokeSession } from '../services/auth-services'
import { forgotPasswordAuth, registerAuth, resendVerificationAuth, resetPasswordAuth, verifyEmailAuth } from '../services/registration-services'
import { googleCallback, googleRedirect, STATE_COOKIE } from '../services/google-services'
import { LANDING_URL } from '../config'
import { ResponseError } from '../error/response-error'
import { UserRequest } from '../type/user-request'
import { TokenAudience } from '../utils/jwt'
import { logger } from '../utils/logger'
import { ok } from '../utils/respond'

// ===== Controller auth =====
// Tiap handler adalah factory beraudience: routes/details/auth.ts memasangnya
// dua kali, sekali untuk /api/auth/customer/* dan sekali untuk
// /api/auth/staff/*. Audience tidak pernah ditebak dari header Origin —
// panggilan server-to-server tidak mengirimkannya.
//
// Controller tetap tipis: panggil service, balas lewat ok(), lempar sisanya ke
// next() supaya errorMiddleware yang menyusun envelope error.

const clientIp = (req: Request): string | null =>
  (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || null

const readRefreshCookie = (req: Request, audience: TokenAudience): string | undefined =>
  (req.cookies as Record<string, string | undefined>)[getRefreshCookieName(audience)]

/** Jalur x-service-key tidak melampirkan user; endpoint sesi memang butuh user. */
const currentUserId = (req: Request): string => {
  const user = (req as UserRequest).user
  if (!user) throw new ResponseError(401, 'Sesi tidak ditemukan. Silakan masuk kembali.', 'UNAUTHENTICATED')
  return user.id
}

export const login =
  (audience: TokenAudience): RequestHandler =>
  async (req, res, next) => {
    try {
      ok(res, await loginAuth(req.body, audience, clientIp(req), req.headers['user-agent'] ?? null, res))
    } catch (error) {
      next(error)
    }
  }

export const refresh =
  (audience: TokenAudience): RequestHandler =>
  async (req, res, next) => {
    try {
      ok(res, await refreshAuth(readRefreshCookie(req, audience), audience, clientIp(req), res))
    } catch (error) {
      next(error)
    }
  }

export const logout =
  (audience: TokenAudience): RequestHandler =>
  async (req, res, next) => {
    try {
      ok(res, await logoutAuth(readRefreshCookie(req, audience), audience, res))
    } catch (error) {
      next(error)
    }
  }

export const sessions =
  (audience: TokenAudience): RequestHandler =>
  async (req, res, next) => {
    try {
      ok(res, await getActiveSessions(currentUserId(req), audience))
    } catch (error) {
      next(error)
    }
  }

export const revoke =
  (audience: TokenAudience): RequestHandler =>
  async (req, res, next) => {
    try {
      ok(res, await revokeSession(currentUserId(req), String(req.params.id), audience))
    } catch (error) {
      next(error)
    }
  }

export const forceLogout =
  (audience: TokenAudience): RequestHandler =>
  async (req, res, next) => {
    try {
      ok(res, await forceLogoutAll(currentUserId(req), audience))
    } catch (error) {
      next(error)
    }
  }

// ===== Pendaftaran & pemulihan akun (audience customer saja) =====
// Akun staff dibuat lewat panel admin (Fase 8), tidak pernah mendaftar sendiri
// — karena itu handler di bawah ini BUKAN factory beraudience.

export const register: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await registerAuth(req.body, clientIp(req), req.headers['user-agent'] ?? null, res), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const verifyEmail: RequestHandler = async (req, res, next) => {
  try {
    // Token diterima lewat body, bukan path: token di URL ikut tercatat di log
    // akses nginx, riwayat browser, dan header Referer ke pihak ketiga.
    // Halaman /verifikasi-email di landing membaca ?token= lalu mem-POST-nya.
    ok(res, await verifyEmailAuth(req.body))
  } catch (error) {
    next(error)
  }
}

export const resendVerification: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await resendVerificationAuth(req.body))
  } catch (error) {
    next(error)
  }
}

export const forgotPassword: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await forgotPasswordAuth(req.body))
  } catch (error) {
    next(error)
  }
}

export const resetPassword: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await resetPasswordAuth(req.body))
  } catch (error) {
    next(error)
  }
}

// ===== Google OAuth =====

export const googleStart: RequestHandler = async (req, res, next) => {
  try {
    // 302 ke Google, bukan envelope JSON: ini navigasi browser sungguhan.
    res.redirect(googleRedirect(res))
  } catch (error) {
    next(error)
  }
}

// next tidak dipakai: kegagalan di sini ditangani sendiri sebagai redirect,
// tidak diteruskan ke errorMiddleware yang akan membalas JSON.
export const googleFinish: RequestHandler = async (req, res, _next) => {
  try {
    const state = (req.cookies as Record<string, string | undefined>)[STATE_COOKIE]
    await googleCallback(req.query as { code?: string; state?: string; error?: string }, state, clientIp(req), req.headers['user-agent'] ?? null, res)

    // Sesi sudah terpasang di cookie. Balikkan browser ke landing — access
    // token tidak bisa dititipkan lewat URL (ia akan tercatat di log akses dan
    // riwayat browser), jadi landing memanggil /auth/customer/refresh untuk
    // mengambilnya dari cookie yang baru saja dipasang.
    res.redirect(`${LANDING_URL}/?auth=google-success`)
  } catch (error) {
    // Kegagalan OAuth juga navigasi browser, bukan pemanggilan fetch — user
    // tidak boleh mendarat di halaman JSON. Kirim kodenya lewat query supaya
    // landing memunculkan FlashToast yang sesuai.
    const code = error instanceof ResponseError ? error.code : 'INTERNAL_ERROR'
    logger.warn(`Google OAuth gagal: ${(error as Error).message}`)
    res.redirect(`${LANDING_URL}/?auth=google-error&code=${encodeURIComponent(code)}`)
  }
}
