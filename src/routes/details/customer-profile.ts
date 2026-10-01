import express from 'express'
import * as ctrl from '../../controller/customer-profile-controller'
import { denyStaffAccounts, requireVerifiedEmail } from '../../middleware/auth-middleware'
import { identityLimiter, memberPhotoLimiter, passwordLimiter } from '../../middleware/rate-limit-middleware'
import { singleFileUpload } from '../../middleware/upload-middleware'
import { MEMBER_PHOTO_TOO_LARGE_MESSAGE } from '../../services/member-photo-services'

// ===== Route profil akun customer sendiri (customer) — Fase 6 =====
// Prefix penuh /api/customer; customerAuthRequired sudah terpasang di level router (customer-api.ts).
//
//   GET    /api/customer/profile    auth                                  -> CustomerProfileDto
//   POST   /api/customer/profile    auth + verified + bukan staff         multipart (avatar opsional) -> CustomerProfileDto
//   PUT    /api/customer/password   auth                                  JSON { currentPassword, password, passwordConfirmation } -> { ok: true }
//   POST   /api/customer/identity   auth + verified + bukan staff + 5/mnt multipart (identityFile WAJIB) -> CustomerProfileDto
//   DELETE /api/customer/profile    auth + verified + bukan staff         JSON { password } -> { id }
//   POST   /api/customer/profile/resend-verification  auth + bukan staff  -> ResendVerificationDto
//
// ============================================================================
// === DARI MANA MIDDLEWARE PER BARIS ITU BERASAL ===
// ============================================================================
// Bukan selera, melainkan salinan grup middleware Laravel — dan ketiga barisnya memang BERBEDA grup:
//
//   routes/web.php:232  Route::middleware(['auth', 'verified', RedirectStaffFromPublic::class])
//                       -> PATCH /profile, POST /profile/identity (+ throttle:5,1), DELETE /profile
//                       'verified'                 -> requireVerifiedEmail
//                       RedirectStaffFromPublic    -> denyStaffAccounts
//
//   routes/auth.php:65  Route::middleware('auth') — TANPA 'verified', TANPA RedirectStaffFromPublic
//                       -> PUT password
//                       Karena itu PUT /password di bawah SENGAJA polos. Akun staff yang kebetulan
//                       juga login di situs publik memang boleh merotasi passwordnya lewat jalur ini
//                       di Laravel, dan menambahkan denyStaffAccounts di sini akan menolak sesuatu
//                       yang aslinya diterima. Padanan staff-nya tetap ada terpisah di
//                       PUT /api/admin/profile/password (Fase 8G).
//
//   GET /profile        TIDAK punya padanan route di Laravel: route GET /profile di sana hanya
//                       me-redirect, dan data profilnya sampai ke ProfileModal lewat prop Inertia
//                       `auth.user` (HandleInertiaRequests::share) yang tidak digerbangi 'verified'.
//                       Endpoint ini adalah port PROP itu, jadi ia hanya memakai denyStaffAccounts.
//                       Menambahkan requireVerifiedEmail akan membuat dashboard pengguna yang belum
//                       memverifikasi email gagal memuat profilnya sendiri — termasuk layar yang
//                       seharusnya memberitahunya untuk memverifikasi.
//
// URUTAN: tidak ada satu pun route ber-parameter di router ini, jadi tidak ada segmen yang bisa
// ditelan. Ketiga path ('/profile', '/password', '/identity') literal dan saling lepas.
//
// Urutan middleware pada baris unggah: pagar murah lebih dulu (akun, email, rate limit), baru multer
// yang menarik berkas ke memori — sama dengan customer-booking.ts.
//
// ============================================================================
// === BARIS MOUNT YANG WAJIB DITAMBAHKAN PARENT DI routes/customer-api.ts ===
// ============================================================================
// Impor:
//
//   import customerProfileRoutes from './details/customer-profile'
//
// Mount (SATU baris, prefix '/api/customer' — router ini memegang tiga path literal sekaligus):
//
//   customerRouter.use('/api/customer', customerProfileRoutes)
//
// BATASAN URUTAN:
//   1. WAJIB setelah `customerRouter.use('/api/customer', customerAuthRequired)`. Seluruh route di
//      sini mengandalkan requireUser(); tanpa auth yang sudah berjalan lebih dulu, setiap handler
//      membalas 401 dari requireUser() alih-alih dari middleware auth — pesan dan kode yang berbeda.
//   2. Bebas terhadap `/api/customer/booking` dan `/api/customer/payments`: '/profile', '/password',
//      dan '/identity' tidak beririsan dengan keduanya, dan request yang tidak cocok jatuh lewat
//      next() ke mount berikutnya. Tempat yang disarankan: tepat setelah handler GET /api/customer/me.
//   3. Router lain yang kelak di-mount pada '/api/customer' polos boleh berada di mana saja SELAMA ia
//      tidak mendaftarkan route ber-parameter di akar (mis. '/:something'), yang akan menelan ketiga
//      path literal ini bila terpasang lebih dulu.

/**
 * Foto profil: field `avatar`, batas 2 MB = `max:2048` (KB) di ProfileUpdateRequest, sama persis
 * dengan UPLOAD_LIMITS.AVATAR.maxBytes. Berkasnya di-decode dan ditulis ULANG oleh sharp sebelum
 * menyentuh disk (storeAvatarImage() di staff-profile-services.ts, dipakai ulang lewat
 * updateStaffProfile()).
 */
const avatarUpload = singleFileUpload('avatar', 'AVATAR', { tooLargeMessage: 'Ukuran foto profil maksimal 2 MB.' })

/**
 * Dokumen identitas: field `identityFile`, batas 4 MB = `max:4096` (KB), sama dengan
 * UPLOAD_LIMITS.IDENTITY_DOC.maxBytes.
 *
 * Nama field camelCase mengikuti konvensi repo ini dan CustomerIdentityPayload; Laravel memakai
 * `identity_file`. ProfileModal.tsx di ubsc-landing MASIH mengirim nama snake_case — lihat catatan di
 * laporan fase ini.
 *
 * Tanpa fileFilter berdasarkan mimetype, sengaja: Content-Type bagian multipart ditulis klien.
 * Padanan `mimes:jpeg,jpg,png,webp,pdf` adalah storeIdentityDocument() di
 * services/customer-profile-services.ts, yang memeriksa ISI berkas (decoder sharp untuk gambar, magic
 * bytes `%PDF-` untuk PDF).
 */
const identityUpload = singleFileUpload('identityFile', 'IDENTITY_DOC', { tooLargeMessage: 'Ukuran dokumen maksimal 4 MB.' })

const customerProfileRoutes = express.Router()

customerProfileRoutes.get('/profile', denyStaffAccounts, ctrl.show)
customerProfileRoutes.post('/profile', denyStaffAccounts, requireVerifiedEmail, avatarUpload, ctrl.update)
customerProfileRoutes.delete('/profile', denyStaffAccounts, requireVerifiedEmail, ctrl.destroy)

customerProfileRoutes.put('/password', ctrl.updatePassword)

// Tanpa requireVerifiedEmail — justru untuk akun yang belum terverifikasi. Jeda + batas harian per akun
// ada di issueVerification(); passwordLimiter (per IP) sama dengan /api/auth/resend-verification.
customerProfileRoutes.post('/profile/resend-verification', denyStaffAccounts, passwordLimiter, ctrl.resendVerification)

customerProfileRoutes.post('/identity', denyStaffAccounts, requireVerifiedEmail, identityLimiter, identityUpload, ctrl.submitIdentity)

/**
 * Foto member (validasi wajah di meja gym): field `photo`, 10 MB seperti bukti transfer — sumbernya
 * kamera HP. Isi berkas diperiksa dan ditulis ulang oleh sharp di member-photo-services.ts.
 */
const memberPhotoUpload = singleFileUpload('photo', 'MEMBER_PHOTO', { tooLargeMessage: MEMBER_PHOTO_TOO_LARGE_MESSAGE })

customerProfileRoutes.post('/member-photo', denyStaffAccounts, requireVerifiedEmail, memberPhotoLimiter, memberPhotoUpload, ctrl.submitMemberPhoto)

export default customerProfileRoutes
