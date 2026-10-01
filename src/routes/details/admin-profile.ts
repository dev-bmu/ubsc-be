import express from 'express'
import * as ctrl from '../../controller/staff-profile-controller'
import { singleFileUpload } from '../../middleware/upload-middleware'

// ===== Route profil akun staff sendiri (staff) — Fase 8G =====
// Berkas ini mengekspor DUA router, karena Laravel menaruh kelima aksinya di dua prefix berbeda dan
// menggabungkannya di sini hanya akan memaksa salah satu URL menyimpang dari aslinya.
//
//   adminProfileRoutes — prefix penuh /api/admin/profile:
//     GET    /api/admin/profile             auth saja   -> StaffProfileDto
//     PATCH  /api/admin/profile             auth saja   multipart (avatar opsional) -> StaffProfileDto
//     PUT    /api/admin/profile/password    auth saja   body { currentPassword, password, passwordConfirmation } -> { ok: true }
//     DELETE /api/admin/profile             auth saja   body { password } -> { id }
//
//   adminEmailRoutes — prefix penuh /api/admin/email:
//     POST   /api/admin/email/verification-notification   auth saja   -> { sent: boolean }
//
// TANPA requirePermission DI SATU BARIS PUN, dan itu bukan kelalaian. Keempat aksi Laravel yang
// diport (ProfileController::update/destroy, Auth\PasswordController::update,
// Auth\EmailVerificationNotificationController::store) hidup di grup middleware `auth` pada
// routes/web.php dan routes/auth.php — BUKAN di grup admin yang ber-`can:`. Subjeknya adalah akun
// pemanggil sendiri, jadi permission yang bisa dicabut Administrator tidak punya tempat di sini:
// mencabutnya hanya akan membuat seorang staff tidak bisa mengganti password-nya sendiri.
// Autentikasi staff sudah dipasang sekali di level router privat (privateRouter.use('/api/admin',
// staffAuthRequired)); identitas subjeknya dikunci controller lewat requireUser(req).id.
//
// URUTAN: '/password' (literal) didaftarkan SEBELUM route apa pun yang ber-parameter. Saat ini tidak
// ada satu pun route ber-parameter di kedua router ini — GET/PATCH/DELETE semuanya '/' — jadi tidak
// ada yang bisa menelan segmen itu. Baris ini tetap ditulis sebagai kontrak untuk penambahan
// berikutnya.
//
// ============================================================================
// === BARIS MOUNT YANG WAJIB DITAMBAHKAN PARENT DI routes/private-api.ts ===
// ============================================================================
// Impor:
//
//   import adminProfileRoutes, { adminEmailRoutes } from './details/admin-profile'
//
// Mount (keduanya prefix literal yang saling lepas dari seluruh prefix lain — tidak ada batasan
// urutan terhadap prefix mana pun, termasuk /api/admin/me dan /api/admin/settings*):
//
//   privateRouter.use('/api/admin/profile', adminProfileRoutes)
//   privateRouter.use('/api/admin/email', adminEmailRoutes)

/**
 * Foto profil: field `avatar`, batas 2 MB = `max:2048` (KB) di ProfileUpdateRequest, yang kebetulan
 * sama persis dengan UPLOAD_LIMITS.AVATAR.maxBytes. memoryStorage seperti seluruh unggahan gambar di
 * repo ini — berkasnya di-decode dan ditulis ULANG oleh sharp sebelum menyentuh disk.
 *
 * Tanpa fileFilter berdasarkan mimetype, sengaja: Content-Type bagian multipart ditulis klien dan
 * bisa apa saja. Padanan `image|mimes:jpeg,png,jpg` adalah inspectAvatar() di
 * services/staff-profile-services.ts, yang memeriksa ISI berkas.
 */
const avatarUpload = singleFileUpload('avatar', 'AVATAR', { tooLargeMessage: 'Ukuran foto profil maksimal 2 MB.' })

const adminProfileRoutes = express.Router()

adminProfileRoutes.get('/', ctrl.show)
adminProfileRoutes.put('/password', ctrl.updatePassword)
adminProfileRoutes.patch('/', avatarUpload, ctrl.update)
adminProfileRoutes.delete('/', ctrl.destroy)

export const adminEmailRoutes = express.Router()

adminEmailRoutes.post('/verification-notification', ctrl.sendVerificationEmail)

export default adminProfileRoutes
