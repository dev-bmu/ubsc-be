import { RequestHandler } from 'express'
import { identityDocumentFile, listIdentityQueue, verifyIdentity } from '../services/identity-admin-services'
import {
  captureMemberPhoto as capturePhoto,
  decideMemberPhoto as decidePhoto,
  listMemberPhotoQueue,
  UploadedMemberPhoto
} from '../services/member-photo-services'
import { ok } from '../utils/respond'
import { sendProofFile } from './payment-controller'

// ===== Controller antrean verifikasi identitas (Fase 8E) =====
// Tipis: baca params/body, panggil service, balas ok(). Permission dicek di baris route
// (requirePermission di details/admin-identity.ts), tidak pernah di sini.

export const index: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await listIdentityQueue())
  } catch (error) {
    next(error)
  }
}

export const memberPhotos: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await listMemberPhotoQueue())
  } catch (error) {
    next(error)
  }
}

export const decideMemberPhoto: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await decidePhoto(String(req.params.userId), req.body))
  } catch (error) {
    next(error)
  }
}

export const captureMemberPhoto: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await capturePhoto(String(req.params.userId), req.file as UploadedMemberPhoto | undefined))
  } catch (error) {
    next(error)
  }
}

export const verify: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await verifyIdentity(String(req.params.userId), req.body))
  } catch (error) {
    next(error)
  }
}

/**
 * Berkas identitas memakai sendProofFile yang sama dengan bukti transfer: `inline`, `private, no-store`.
 * Access token hidup di memori JS, jadi FE mengambilnya lewat axios sebagai blob lalu merender
 * URL.createObjectURL-nya — bukan <img src> langsung.
 */
export const documentFile: RequestHandler = async (req, res, next) => {
  try {
    sendProofFile(res, next, await identityDocumentFile(String(req.params.userId)))
  } catch (error) {
    next(error)
  }
}
