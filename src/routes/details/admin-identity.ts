import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/identity-admin-controller'
import { requireAnyPermission, requirePermission } from '../../middleware/permission-middleware'
import { singleFileUpload } from '../../middleware/upload-middleware'
import { MEMBER_PHOTO_TOO_LARGE_MESSAGE } from '../../services/member-photo-services'

// ===== Route antrean verifikasi identitas (staff) =====
// Prefix penuh (/api/admin/identity) dideklarasikan di private-api.ts.
//
//   GET   /api/admin/identity                    antrean penuh (identityStatus != unverified), tanpa paginasi
//   PATCH /api/admin/identity/:userId/verify     body { status, identityCategory? } -> baris terbaru
//   GET   /api/admin/identity/:userId/document   stream dokumen identitas (privat, inline, no-store)
//   GET   /api/admin/identity/member-photos      antrean foto member (pending dulu), maks 200
//   PATCH /api/admin/identity/:userId/member-photo  body { status, photoUrl } -> baris terbaru
//   POST  /api/admin/identity/:userId/member-photo  multipart `photo`, diambil staff -> langsung approved
//
// `authorize('verify-identity')` Laravel = identity.verify, dan ketiga aksinya memakai gate yang sama
// persis — jadi requirePermission tunggal, bukan requireAnyPermission. GET '/' (literal) didaftarkan
// sebelum kedua route ber-parameter supaya urutan literal-sebelum-:param tetap terjaga.

const adminIdentityRoutes = express.Router()

adminIdentityRoutes.get('/', requirePermission(PERMISSIONS.IDENTITY_VERIFY), ctrl.index)
adminIdentityRoutes.patch('/:userId/verify', requirePermission(PERMISSIONS.IDENTITY_VERIFY), ctrl.verify)
adminIdentityRoutes.get('/:userId/document', requirePermission(PERMISSIONS.IDENTITY_VERIFY), ctrl.documentFile)

// Foto member (tahap B): antrean yang sama, tab baru — FO tidak perlu belajar layar lain.
adminIdentityRoutes.get('/member-photos', requirePermission(PERMISSIONS.IDENTITY_VERIFY), ctrl.memberPhotos)
adminIdentityRoutes.patch(
  '/:userId/member-photo',
  requireAnyPermission([PERMISSIONS.IDENTITY_VERIFY, PERMISSIONS.GYM_CHECKIN]),
  ctrl.decideMemberPhoto
)
// Foto diambil staff saat mendaftarkan member di meja (tahap C) — siapa pun yang boleh membuat membership.
adminIdentityRoutes.post(
  '/:userId/member-photo',
  requireAnyPermission([PERMISSIONS.IDENTITY_VERIFY, PERMISSIONS.MEMBERS_MANAGE, PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.GYM_CHECKIN]),
  singleFileUpload('photo', 'MEMBER_PHOTO', { tooLargeMessage: MEMBER_PHOTO_TOO_LARGE_MESSAGE }),
  ctrl.captureMemberPhoto
)

export default adminIdentityRoutes
