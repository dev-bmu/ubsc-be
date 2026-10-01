import { RequestHandler } from 'express'
import * as service from '../services/staff-profile-services'
import { UploadedAvatar } from '../services/staff-profile-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller profil akun staff sendiri (Fase 8G) =====
// Tipis: baca body/file/user, panggil service, balas ok().
//
// TIDAK ADA requirePermission di baris route mana pun untuk kelima endpoint ini, dan itu disengaja:
// di Laravel keempat aksi yang diport (ProfileController::update/destroy, PasswordController::update,
// EmailVerificationNotificationController::store) berada di routes/auth.php + routes/web.php di
// dalam grup `auth`, bukan di dalam grup admin yang ber-`can:`. Yang berlaku hanya autentikasi staff
// di level router privat.
//
// Justru karena tidak ada gate permission, identitas subjeknya harus mutlak: SETIAP handler memakai
// requireUser(req).id dan tidak satu pun membaca id dari params atau body. requireUser() sekaligus
// menolak jalur internal x-service-key yang lolos autentikasi tanpa membawa user (401) — jalur itu
// tidak punya "akun sendiri" untuk diubah.

/** req.file dari avatarUpload (.single('avatar')) — dicast ke bentuk minimum yang dipakai service. */
const avatar = (file: unknown): UploadedAvatar | undefined => file as UploadedAvatar | undefined

export const show: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.showStaffProfile(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateStaffProfile(requireUser(req).id, req.body, avatar(req.file)))
  } catch (error) {
    next(error)
  }
}

export const updatePassword: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateStaffPassword(requireUser(req).id, req.body))
  } catch (error) {
    next(error)
  }
}

export const destroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.deleteStaffAccount(requireUser(req).id, req.body))
  } catch (error) {
    next(error)
  }
}

export const sendVerificationEmail: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.resendStaffVerificationEmail(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}
