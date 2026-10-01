import { Request, RequestHandler } from 'express'
import { isBypassed } from '../middleware/permission-middleware'
import * as service from '../services/settings-admin-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller pengaturan sistem: Role & Access + Pengguna Internal (Fase 8G) =====
// Tipis: baca params/body, rakit actor, panggil service, balas ok(). Permission rbac.manage /
// users.manage dicek di baris route (details/admin-settings-roles.ts, details/admin-settings-users.ts),
// tidak pernah di sini.

/**
 * Pemanggil untuk gate IMPERATIF "hanya Administrator" yang dibawa RoleController/UserController.
 *
 * `bypass` memakai isBypassed() milik permission-middleware — bukan salinan `role === 'Administrator'`
 * — supaya jalur bypass Administrator / x-service-key tidak pernah bercabang. requireUser() lebih dulu
 * menolak request tanpa user (401), sehingga id di bawah selalu nyata.
 */
function actorOf(req: Request): service.SettingsActor {
  const user = requireUser(req)
  return { id: user.id, roleName: user.role?.name ?? null, bypass: isBypassed(req) }
}

// ===== Role & Access =====

export const rolesIndex: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.listRoles(actorOf(req)))
  } catch (error) {
    next(error)
  }
}

/** :name adalah NAMA role ('Staff Front Office'); Express sudah men-decode %20 di params. */
export const rolesUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateRolePermissions(actorOf(req), String(req.params.name), req.body))
  } catch (error) {
    next(error)
  }
}

// ===== Pengguna internal =====

export const usersIndex: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.listStaffUsers(actorOf(req)))
  } catch (error) {
    next(error)
  }
}

export const usersStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.createStaffUser(actorOf(req), req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const usersUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateStaffUser(actorOf(req), String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

/** Laravel membalas back(); di sini { id } supaya panel bisa mencabut satu baris tanpa memuat ulang. */
export const usersDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.deleteStaffUser(actorOf(req), String(req.params.id)))
  } catch (error) {
    next(error)
  }
}
