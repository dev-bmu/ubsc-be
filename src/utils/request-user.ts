import { Request } from 'express'
import { ResponseError } from '../error/response-error'
import { UserRequest, UserWithRelations } from '../type/user-request'

// ===== User pada request =====

/**
 * User yang dilampirkan auth middleware. Jalur x-service-key lolos TANPA user, jadi endpoint yang
 * bertindak atas nama seseorang (booking, verifikasi pembayaran) wajib menolaknya di sini.
 */
export function requireUser(req: Request): UserWithRelations {
  const user = (req as UserRequest).user
  if (!user) throw new ResponseError(401, 'Sesi tidak ditemukan. Silakan masuk kembali.', 'UNAUTHENTICATED')
  return user
}
