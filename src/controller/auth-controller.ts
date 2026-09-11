import { Request, RequestHandler } from 'express'
import { forceLogoutAll, getActiveSessions, getRefreshCookieName, loginAuth, logoutAuth, refreshAuth, revokeSession } from '../services/auth-services'
import { ResponseError } from '../error/response-error'
import { UserRequest } from '../type/user-request'
import { TokenAudience } from '../utils/jwt'
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

// TODO Fase 1: register, verifyEmail, resendVerification, forgotPassword,
// resetPassword, googleRedirect, googleCallback — semuanya audience 'customer'
// saja. Akun staff dibuat lewat panel admin (Fase 8), tidak mendaftar sendiri.
