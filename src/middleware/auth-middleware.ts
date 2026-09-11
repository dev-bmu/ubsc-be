import { RequestHandler } from 'express'
import { prismaClient } from '../application/database'
import { INTERNAL_SERVICE_KEY } from '../config'
import { ResponseError } from '../error/response-error'
import { UserRequest, UserWithRelations } from '../type/user-request'
import { TokenAudience, verifyAccessToken } from '../utils/jwt'
import { logger } from '../utils/logger'
import { getPermissionsByRole } from '../services/permission-services'

// ===== Auth middleware — factory per audience =====
// Satu implementasi dipakai dua kali. Perbedaan antar audience HANYA tiga hal:
//   1. secret JWT (dipilih di utils/jwt lewat argumen audience),
//   2. klaim `aud` yang diverifikasi,
//   3. apakah user wajib punya role staff.
// Selebihnya identik — termasuk cek isLocked dan pemuatan permission efektif.
//
// Error dikembalikan lewat next(new ResponseError(...)) supaya melewati
// errorMiddleware dan memakai envelope { success:false, error:{ code, ... } }.
// Jangan res.status().json({ error }) langsung seperti boilerplate: bentuk itu
// tidak lagi dikenali klien.

export function createAuthRequired(audience: TokenAudience): RequestHandler {
  return async (req, _res, next) => {
    const request = req as UserRequest

    // Jalur internal service-to-service (worker cron, script ops). Tidak ada
    // user yang dilampirkan — handler yang memakainya harus tahan user kosong.
    const serviceKey = req.header('x-service-key')
    if (serviceKey && INTERNAL_SERVICE_KEY && serviceKey === INTERNAL_SERVICE_KEY) {
      request.audience = audience
      return next()
    }

    const authHeader = req.header('authorization')
    if (!authHeader) return next(new ResponseError(401, 'Sesi tidak ditemukan. Silakan masuk kembali.', 'UNAUTHENTICATED'))

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer') return next(new ResponseError(401, 'Format Authorization tidak valid', 'UNAUTHENTICATED'))

    try {
      // Secret + klaim `aud` dipilih per audience: token customer gagal di sini
      // bila middleware ini dibuat untuk 'staff', dan sebaliknya.
      const payload = verifyAccessToken(parts[1], audience)

      const user = await prismaClient.user.findUnique({ where: { id: payload.userId }, include: { role: true } })
      if (!user) return next(new ResponseError(401, 'Akun tidak ditemukan', 'UNAUTHENTICATED'))
      if (user.isLocked) return next(new ResponseError(403, 'Akun terkunci. Hubungi administrator.', 'FORBIDDEN'))

      // Satu-satunya beda perilaku di luar cookie & secret: staff wajib punya role.
      if (audience === 'staff' && !user.role) return next(new ResponseError(403, 'Akun ini tidak punya akses ke panel staff', 'FORBIDDEN'))

      request.user = user as UserWithRelations
      request.permissions = user.role ? await getPermissionsByRole(user.role.name) : []
      request.audience = audience
      next()
    } catch (error) {
      logger.error(`Verifikasi access token gagal (audience=${audience}): ${(error as Error).message}`)
      next(new ResponseError(401, 'Sesi kedaluwarsa. Silakan masuk kembali.', 'UNAUTHENTICATED'))
    }
  }
}

export const customerAuthRequired = createAuthRequired('customer')
export const staffAuthRequired = createAuthRequired('staff')
