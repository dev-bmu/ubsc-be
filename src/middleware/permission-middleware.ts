import { Request, RequestHandler } from 'express'
import { INTERNAL_SERVICE_KEY } from '../config'
import { isAdministrator } from '../config/permissions'
import { ResponseError } from '../error/response-error'
import { UserRequest } from '../type/user-request'

// ===== Permission middleware =====
// Dideklarasikan PER BARIS ROUTE, tidak pernah di dalam controller.
// Administrator mem-bypass seluruh permission: matriks RBAC boleh mengosongkan
// role mana pun, tapi tidak boleh bisa mengunci diri sendiri keluar.
// Pesan penolakan sengaja seragam dan tidak menyebut kode permission — itu
// informasi internal, dan user hanya perlu tahu harus minta ke siapa.

const FORBIDDEN_MESSAGE = 'Akses belum diberikan oleh Administrator'

/** Panggilan internal service dan Administrator lewat tanpa dicek. */
function isBypassed(req: Request): boolean {
  const serviceKey = req.header('x-service-key')
  if (serviceKey && INTERNAL_SERVICE_KEY && serviceKey === INTERNAL_SERVICE_KEY) return true
  return isAdministrator((req as UserRequest).user?.role?.name)
}

export const requirePermission = (code: string): RequestHandler => {
  return (req, _res, next) => {
    if (isBypassed(req)) return next()

    const permissions = (req as UserRequest).permissions ?? []
    if (!permissions.includes(code)) return next(new ResponseError(403, FORBIDDEN_MESSAGE, 'FORBIDDEN'))

    next()
  }
}

/** anyOf: banyak route UBSC menerima beberapa permission alternatif. */
export const requireAnyPermission = (codes: string[]): RequestHandler => {
  return (req, _res, next) => {
    if (isBypassed(req)) return next()

    const permissions = (req as UserRequest).permissions ?? []
    if (!codes.some((code) => permissions.includes(code))) return next(new ResponseError(403, FORBIDDEN_MESSAGE, 'FORBIDDEN'))

    next()
  }
}
