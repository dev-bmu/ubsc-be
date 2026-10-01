import { RequestHandler } from 'express'
import * as service from '../services/customer-profile-services'
import { UploadedIdentityDocument } from '../services/customer-profile-services'
import { submitMemberPhoto as submitPhoto, UploadedMemberPhoto } from '../services/member-photo-services'
import { issueVerification } from '../services/registration-services'
import { UploadedAvatar } from '../services/staff-profile-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller profil akun customer sendiri (Fase 6) =====
// Tipis: baca body/file/user, panggil service, balas ok().
//
// TIDAK ADA gate permission di satu baris route pun, dan itu disengaja: di Laravel keempat aksi yang
// diport (ProfileController::update/submitIdentity/destroy, Auth\PasswordController::update) berada
// di grup middleware `auth` pada routes/web.php + routes/auth.php, bukan di grup admin yang ber-`can:`.
// Subjeknya adalah akun pemanggil sendiri.
//
// Justru karena tidak ada gate itu, identitas subjeknya harus mutlak: SETIAP handler memakai
// requireUser(req).id dan tidak satu pun membaca id dari params atau body. requireUser() sekaligus
// menolak jalur internal x-service-key yang lolos autentikasi tanpa membawa user (401) — jalur itu
// tidak punya "akun sendiri" untuk diubah.

/** req.file dari avatarUpload (.single('avatar')) — dicast ke bentuk minimum yang dipakai service. */
const avatar = (file: unknown): UploadedAvatar | undefined => file as UploadedAvatar | undefined

/** req.file dari identityUpload (.single('identityFile')). */
const identityDocument = (file: unknown): UploadedIdentityDocument | undefined => file as UploadedIdentityDocument | undefined

export const show: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.showCustomerProfile(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateCustomerProfile(requireUser(req).id, req.body, avatar(req.file)))
  } catch (error) {
    next(error)
  }
}

export const updatePassword: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateCustomerPassword(requireUser(req).id, req.body))
  } catch (error) {
    next(error)
  }
}

export const submitIdentity: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.submitCustomerIdentity(requireUser(req).id, req.body, identityDocument(req.file)))
  } catch (error) {
    next(error)
  }
}

export const submitMemberPhoto: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await submitPhoto(requireUser(req).id, req.file as UploadedMemberPhoto | undefined))
  } catch (error) {
    next(error)
  }
}

export const destroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.deleteCustomerAccount(requireUser(req).id, req.body))
  } catch (error) {
    next(error)
  }
}

/** POST /api/customer/profile/resend-verification — kirim ulang email verifikasi, dibatasi per akun. */
export const resendVerification: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await issueVerification(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}
