import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import sharp from 'sharp'
import type { CustomerProfileDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { IMAGE_PIPELINE, UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { dateOnly, dateOnlyToString } from '../utils/clock'
import { logger } from '../utils/logger'
import { CustomerProfileValidation } from '../validation/customer-profile-validation'
import { customerNumber } from '../utils/money'
import { Validation } from '../validation/Validation'
import { putObject } from '../utils/storage'
import { deletePrivateFile } from './payment-proof-services'
import { deleteStaffAccount, showStaffProfile, updateStaffPassword, updateStaffProfile } from './staff-profile-services'
import type { UploadedAvatar } from './staff-profile-services'

// ============================================================================
// === Profil akun customer yang sedang login — Fase 6 ===
// ============================================================================
// Port ProfileController::update(), ::submitIdentity(), ::destroy(), dan
// Auth\PasswordController::update() untuk audience CUSTOMER.
//
// Kelima endpoint menyentuh AKUN PEMANGGIL SENDIRI dan karena itu tidak punya gate permission —
// hanya autentikasi customer di level router. Konsekuensinya sama dengan Fase 8G: userId TIDAK
// PERNAH boleh datang dari body atau params. Setiap fungsi menerimanya sebagai argumen dan
// controller mengisinya dari requireUser(req).id.
//
// ============================================================================
// === APA YANG DIPAKAI ULANG DARI FASE 8G, DAN KENAPA ===
// ============================================================================
// Fase 8G sudah membangun update/password/destroy untuk akun STAFF di staff-profile-services.ts.
// Nama fungsinya menyebut "Staff" karena layar itu yang melahirkannya, tetapi ISINYA tidak pernah
// melihat role: ketiganya adalah operasi AKUN, bukan operasi staff. Yang dipakai ulang di sini:
//
//   updateStaffProfile()  -> name + email + AVATAR. Seluruh keputusan avatar (encode ulang lewat
//                            sharp, tata letak 'avatars/<uuid>.<ext>' di mount uploads publik, nilai
//                            kolom yang sudah berupa URL ber-root, penghapusan berkas lama HANYA
//                            bila '/uploads/avatars/...', URL Google absolut tidak pernah disentuh)
//                            hidup di sana dan TIDAK diduplikasi di sini. Begitu pula
//                            `Rule::unique('users')->ignore()` dan `isDirty('email')` ->
//                            emailVerifiedAt = null.
//   updateStaffPassword() -> `current_password` + bcryptjs cost 10. Satu skema hashing untuk seluruh
//                            repo; endpoint ini tidak boleh melahirkan yang kedua.
//   deleteStaffAccount()  -> `current_password` + pagar integritas referensial + forceLogoutAll()
//                            kedua audience + unlink avatar. Lihat blok "Penghapusan akun" di bawah.
//   showStaffProfile()    -> accessor avatar_url (tiga cabang getAvatarUrlAttribute() Laravel).
//
// KONSEKUENSI YANG HARUS DISADARI: kalau suatu saat ada pemeriksaan khusus-staff yang MASUK ke
// keempat fungsi itu, jalur customer ini ikut berubah. Saran untuk parent: ekstrak keempatnya ke
// `account-profile-services.ts` yang netral audience dan biarkan kedua sisi mengimpor dari sana.
// Ekstraksi itu di luar kepemilikan berkas agen ini (staff-profile-services.ts tidak boleh disunting),
// jadi untuk sekarang jalurnya adalah impor langsung — bukan salinan.

// ===== Bentuk baris + present() =====

/**
 * Kolom yang HANYA ada di sisi customer. Bagian "inti akun" (id, name, email, avatar, avatarUrl,
 * emailVerifiedAt) sengaja TIDAK diambil di sini melainkan dari showStaffProfile(), supaya accessor
 * avatarUrl punya satu implementasi saja. Dua findUnique atas primary key yang sama itu murah dan
 * berjalan paralel; menduplikasi accessor-nya jauh lebih mahal saat salah satu berubah.
 */
const CUSTOMER_PROFILE_SELECT = {
  phoneNumber: true,
  birthPlace: true,
  birthDate: true,
  identityCategory: true,
  identityNumber: true,
  identityStatus: true,
  customerSequence: true,
  memberPhotoPath: true,
  memberPhotoStatus: true
} satisfies Prisma.UserSelect

async function presentCustomerProfile(userId: string): Promise<CustomerProfileDto> {
  const [core, row] = await Promise.all([
    showStaffProfile(userId),
    prismaClient.user.findUnique({ where: { id: userId }, select: CUSTOMER_PROFILE_SELECT })
  ])
  // showStaffProfile() sudah melempar 404 bila barisnya hilang; cek ini menutup balapan teoretis
  // antara kedua query (akun dihapus tepat di antaranya) sekaligus mempersempit tipe.
  if (!row) throw new ResponseError(404, 'Akun tidak ditemukan')

  return {
    id: core.id,
    name: core.name,
    email: core.email,
    phoneNumber: row.phoneNumber,
    birthPlace: row.birthPlace,
    // Kolom @db.Date -> 'YYYY-MM-DD' tanpa menyentuh TZ proses (R13, utils/clock.ts). Bentuk ini
    // langsung bisa dipasang ke <input type="date"> di ProfileModal.tsx.
    birthDate: row.birthDate ? dateOnlyToString(row.birthDate) : null,
    avatar: core.avatar,
    avatarUrl: core.avatarUrl,
    emailVerifiedAt: core.emailVerifiedAt,
    identityCategory: row.identityCategory,
    identityNumber: row.identityNumber,
    identityStatus: row.identityStatus,
    customerNumber: customerNumber(row.customerSequence),
    memberPhotoUrl: row.memberPhotoPath,
    memberPhotoStatus: row.memberPhotoStatus
  }
}

// ===== 1. Show — GET /api/customer/profile =====

/**
 * Tidak ada padanan langsung di Laravel: di sana route GET /profile hanya me-redirect, dan data
 * profil sampai ke ProfileModal lewat prop Inertia `auth.user` (HandleInertiaRequests::share).
 * Endpoint ini adalah port prop itu, bukan port route-nya — sebabnya ia tidak ikut digerbangi
 * middleware `verified` milik grup route profil (lihat routes/details/customer-profile.ts).
 */
export async function showCustomerProfile(userId: string): Promise<CustomerProfileDto> {
  return presentCustomerProfile(userId)
}

// ===== 2. Update — POST /api/customer/profile =====

/**
 * ProfileController::update() untuk customer.
 *
 * Dua langkah, dan urutannya disengaja:
 *
 *   1. updateStaffProfile() menulis name/email/avatar. Ia yang memegang cek keunikan email, jadi
 *      seluruh penolakan 422 terjadi SEBELUM satu kolom pun tersentuh.
 *   2. birthPlace/birthDate ditulis menyusul, hanya bila field-nya memang dikirim
 *      (`array_key_exists()` Laravel -> `!== undefined`).
 *
 * PENYIMPANGAN: Laravel melakukan SATU `$user->save()`; di sini ada dua UPDATE. Yang berubah hanya
 * jumlah pernyataan SQL dan `updatedAt` yang terbumikan dua kali — hasil akhir barisnya identik.
 * Menyatukannya berarti menyalin ulang seluruh pipeline avatar ke file ini, dan itu harga yang jauh
 * lebih mahal daripada satu UPDATE tambahan pada baris yang sama.
 *
 * Validasi dijalankan DUA KALI atas request yang sama (skema penuh di sini, subset name+email di
 * updateStaffProfile). Aturannya berasal dari satu FormRequest yang sama sehingga tidak mungkin
 * berbeda hasilnya; yang dipastikan urutan ini adalah pesan untuk birthDate/birthPlace tetap muncul
 * pada request yang name-nya juga bermasalah.
 */
export async function updateCustomerProfile(userId: string, request: unknown, avatar?: UploadedAvatar): Promise<CustomerProfileDto> {
  const v = Validation.validate(CustomerProfileValidation.PROFILE, request)

  await updateStaffProfile(userId, request, avatar)

  const data: Prisma.UserUpdateInput = {}
  if (v.birthPlace !== undefined) data.birthPlace = v.birthPlace
  if (v.birthDate !== undefined) data.birthDate = v.birthDate === null ? null : dateOnly(v.birthDate)

  if (Object.keys(data).length > 0) {
    await prismaClient.user.update({ where: { id: userId }, data })
  }

  return presentCustomerProfile(userId)
}

// ===== 3. Password — PUT /api/customer/password =====

/**
 * Auth\PasswordController::update() (routes/auth.php:65) — controller yang SAMA melayani kedua
 * audience di Laravel, jadi di sini ia benar-benar hanya diteruskan.
 *
 * Skema CustomerProfileValidation.PASSWORD sengaja tetap ditulis sebagai dokumentasi bentuk
 * CustomerPasswordPayload, tetapi yang MENEGAKKAN adalah updateStaffPassword() — satu tempat untuk
 * `current_password`, satu tempat untuk bcrypt cost 10.
 *
 * SESI LAIN TIDAK DICABUT, mengikuti Laravel: pemanggil baru saja membuktikan dirinya dengan
 * password lama, jadi tidak ada dugaan pembajakan yang membenarkan menendang perangkatnya yang lain.
 * (Bandingkan resetPasswordAuth(), yang memang mencabut semuanya.)
 */
export async function updateCustomerPassword(userId: string, request: unknown): Promise<{ ok: true }> {
  return updateStaffPassword(userId, request)
}

// ============================================================================
// === Dokumen identitas: PRIVAT, tidak pernah di uploads/ ===
// ============================================================================
// KTM / kartu pegawai / surat keterangan adalah dokumen ber-PII. Ia disimpan di area PRIVATE
// (storage/private lokal, bucket R2 privat di produksi — utils/storage.ts) dan
// dibaca kembali HANYA lewat GET /api/admin/identity/:userId/document (Fase 8E), yang digerbangi
// permission IDENTITY_VERIFY dan disajikan dengan `private, no-store`.
//
// BENTUK NILAI KOLOM — inilah kontrak antara fase ini dan 8E:
//   identityFilePath = 'identity/<userId>/<stem>.<ext>', key RELATIF di area private.
// identityDocumentFile() (identity-admin-services.ts) membacanya lewat readPrivateFile(); menulis di
// sini lewat putObject('private', ...). Keduanya melewati pagar key utils/storage.ts — nilai absolut
// atau yang memuat '..' ditolak, baik untuk menulis maupun membaca.
//
// Tata letaknya sengaja sama dengan Laravel (`->store('identity/'.$user->id, 'identity-documents')`,
// disk root storage/app/identity-documents). Yang berpindah hanya akar disknya; segmen relatifnya
// identik sehingga baris warisan era Laravel tetap ketemu setelah berkasnya disalin.
//
// EKSTENSI PENTING: identityMimeFor() di 8E memetakan Content-Type dari EKSTENSI berkas dan hanya
// mengenal .jpg/.jpeg/.png/.webp/.pdf — selebihnya jatuh ke application/octet-stream. Fungsi di bawah
// karena itu hanya pernah menulis .webp, .png, atau .pdf.

/** Bentuk minimum berkas multer memoryStorage yang dipakai di sini. */
export interface UploadedIdentityDocument {
  buffer: Buffer
  originalname: string
}

const IDENTITY_TOO_LARGE_MESSAGE = 'Ukuran dokumen maksimal 4 MB.'
const IDENTITY_UNSUPPORTED_MESSAGE = 'Dokumen harus JPG, PNG, WEBP, atau PDF.'

/** `mimes:jpeg,jpg,png,webp,pdf` untuk cabang GAMBAR; PDF ditangani terpisah (sharp tidak men-decode PDF). */
const IDENTITY_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp'])

/**
 * Pagar dimensi terhadap decompression bomb — UPLOAD_LIMITS.IDENTITY_DOC tidak memuat batas dimensi
 * sendiri, jadi angkanya disamakan dengan CMS_IMAGE/PAYMENT_PROOF (6000 x 6000).
 */
const IDENTITY_MAX_EDGE = UPLOAD_LIMITS.CMS_IMAGE.maxWidth
const IDENTITY_MAX_PIXELS = IDENTITY_MAX_EDGE * IDENTITY_MAX_EDGE

function identityRejection(message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { identityFile: [message] })
}

/** `%PDF-` — empat byte pertama berkas PDF yang sah, diperiksa pada ISI berkas. */
function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-'
}

function encodeIdentityImage(buffer: Buffer, format: 'webp' | 'png'): Promise<Buffer> {
  const pipeline = sharp(buffer, { limitInputPixels: IDENTITY_MAX_PIXELS })
    .rotate()
    .resize({ width: IMAGE_PIPELINE.MAX_EDGE, height: IMAGE_PIPELINE.MAX_EDGE, fit: 'inside', withoutEnlargement: true })
  return format === 'webp' ? pipeline.webp({ quality: IMAGE_PIPELINE.WEBP_QUALITY }).toBuffer() : pipeline.png({ compressionLevel: 9 }).toBuffer()
}

/**
 * Simpan satu dokumen identitas. Mengembalikan path relatif yang masuk ke kolom identityFilePath.
 *
 * DUA CABANG, dan perbedaannya disengaja:
 *
 *   GAMBAR -> di-decode dan ditulis ULANG oleh sharp, parameter IMAGE_PIPELINE yang sama dengan
 *     bukti transfer dan avatar. Itu properti KEAMANAN, bukan optimasi: berkas yang hanya mengaku
 *     gambar tidak selamat melewati decoder, dan EXIF (termasuk koordinat GPS pada foto KTM yang
 *     diambil dengan ponsel) maupun payload di ekor berkas tidak pernah sampai disk. PENYIMPANGAN
 *     dari Laravel, yang menyimpan berkas mentah apa adanya. Resize ke sisi terpanjang 1600 px
 *     mengikuti preseden bukti transfer — dokumen yang sama-sama harus terbaca angkanya — dan masih
 *     jauh di atas kebutuhan membaca sebaris NIM.
 *
 *   PDF -> disimpan APA ADANYA, karena tidak ada decoder PDF di repo ini dan menambah satu hanya
 *     untuk menulis ulang berkas justru memperluas permukaan serangan. Yang diperiksa adalah magic
 *     bytes-nya, bukan Content-Type klien maupun ekstensi. Risiko sisanya (PDF berisi JavaScript)
 *     ditahan di sisi penyajian, bukan di sini: 8E mengirimkannya dengan `private, no-store` ke
 *     penampil PDF bawaan browser yang ter-sandbox, persis seperti Laravel. Catat ini bila kelak ada
 *     kebutuhan mem-flatten PDF menjadi gambar.
 *
 * `limits.fileSize` multer sudah menolak berkas kebesaran dengan 413 di baris route; pemeriksaan
 * ukuran di sini adalah pagar kedua untuk pemanggil yang tidak lewat middleware itu — pola yang sama
 * dengan storeAvatarImage() dan assertImageWithinCmsLimit().
 */
async function storeIdentityDocument(userId: string, buffer: Buffer): Promise<string> {
  if (buffer.length > UPLOAD_LIMITS.IDENTITY_DOC.maxBytes) {
    throw new ResponseError(413, IDENTITY_TOO_LARGE_MESSAGE, 'PAYLOAD_TOO_LARGE', { identityFile: [IDENTITY_TOO_LARGE_MESSAGE] })
  }

  let chosen: { data: Buffer; ext: 'webp' | 'png' | 'pdf' }

  if (looksLikePdf(buffer)) {
    chosen = { data: buffer, ext: 'pdf' }
  } else {
    const meta = await sharp(buffer, { limitInputPixels: IDENTITY_MAX_PIXELS })
      .metadata()
      .catch(() => null)

    if (!meta || !meta.format || !IDENTITY_IMAGE_FORMATS.has(meta.format)) throw identityRejection(IDENTITY_UNSUPPORTED_MESSAGE)
    if ((meta.width ?? 0) > IDENTITY_MAX_EDGE || (meta.height ?? 0) > IDENTITY_MAX_EDGE) {
      throw identityRejection(`Resolusi dokumen terlalu besar. Maksimal ${IDENTITY_MAX_EDGE} x ${IDENTITY_MAX_EDGE} piksel.`)
    }

    const webp = await encodeIdentityImage(buffer, 'webp')
    chosen = { data: webp, ext: 'webp' }
    if (webp.length >= buffer.length) {
      const png = await encodeIdentityImage(buffer, 'png')
      if (png.length < webp.length) chosen = { data: png, ext: 'png' }
    }
  }

  // Nama berkas asli milik klien TIDAK ikut sama sekali — tidak ada yang perlu di-slugify dan tidak
  // ada nama tebakan yang bisa bertabrakan. Sama dengan storePaymentProof().
  const relativePath = `identity/${userId}/${randomBytes(18).toString('base64url')}.${chosen.ext}`
  const mimeType = chosen.ext === 'pdf' ? 'application/pdf' : chosen.ext === 'png' ? 'image/png' : 'image/webp'
  await putObject('private', relativePath, chosen.data, mimeType)

  logger.info(`Dokumen identitas disimpan: ${relativePath} (${buffer.length} -> ${chosen.data.length} byte)`)
  return relativePath
}

// ===== 4. Submit identity — POST /api/customer/identity =====

const ALREADY_VERIFIED_MESSAGE = 'Identitas Anda sudah terverifikasi.'
const STILL_PENDING_MESSAGE = 'Pengajuan sebelumnya masih menunggu review admin.'
const DOCUMENT_REQUIRED_MESSAGE = 'Unggah foto KTM / kartu pegawai / surat keterangan.'

/**
 * ProfileController::submitIdentity(), langkah demi langkah.
 *
 * URUTANNYA DIPERTAHANKAN: kedua penolakan status diperiksa SEBELUM validasi input, sehingga
 * pengguna yang identitasnya sudah terverifikasi selalu menerima pesan yang sama apa pun isi
 * formulirnya. Keduanya memakai kunci field `identityNumber` — persis ValidationException::withMessages
 * Laravel — supaya applyEnvelopeErrors() di ProfileModal.tsx memasangnya di bawah input nomor.
 *
 * DUA CABANG, bukan satu: prompt fase ini hanya menyebut 'verified', tetapi sumbernya juga menolak
 * 'pending' dengan pesan yang berbeda. Membuang cabang 'pending' akan mengizinkan pengajuan berulang
 * menimpa dokumen yang sedang diantre staff.
 *
 * SATU PERBEDAAN URUTAN YANG TIDAK BISA DIHINDARI: multer berjalan sebagai middleware, jadi berkas
 * yang melewati 4 MB dijawab 413 SEBELUM pemeriksaan status sempat berjalan. Laravel memeriksa status
 * lebih dulu karena berkasnya sudah terlanjur ada di tmp PHP. Yang berbeda hanya pesan yang diterima
 * pengguna 'verified' yang mengunggah berkas kebesaran.
 *
 * Berhasil -> identity_status = 'pending' (BUKAN 'verified'): tidak ada satu pun harga yang berubah
 * sampai staff memutuskan di antrean 8E.
 */
export async function submitCustomerIdentity(
  userId: string,
  request: unknown,
  file: UploadedIdentityDocument | undefined
): Promise<CustomerProfileDto> {
  const current = await prismaClient.user.findUnique({
    where: { id: userId },
    select: { identityStatus: true, identityFilePath: true }
  })
  if (!current) throw new ResponseError(404, 'Akun tidak ditemukan')

  if (current.identityStatus === 'verified') {
    throw new ResponseError(422, ALREADY_VERIFIED_MESSAGE, 'VALIDATION_ERROR', { identityNumber: [ALREADY_VERIFIED_MESSAGE] })
  }
  if (current.identityStatus === 'pending') {
    throw new ResponseError(422, STILL_PENDING_MESSAGE, 'VALIDATION_ERROR', { identityNumber: [STILL_PENDING_MESSAGE] })
  }

  const v = Validation.validate(CustomerProfileValidation.IDENTITY, request)

  // `required` pada berkas: multer tidak mengisi req.file bila bagiannya tidak ada.
  if (!file) throw identityRejection(DOCUMENT_REQUIRED_MESSAGE)

  const previous = current.identityFilePath
  const path = await storeIdentityDocument(userId, file.buffer)

  await prismaClient.user.update({
    where: { id: userId },
    data: {
      identityCategory: v.identityCategory,
      identityNumber: v.identityNumber,
      identityFilePath: path,
      identityStatus: 'pending'
    }
  })

  // Sama seperti Laravel: berkas lama dibuang HANYA setelah baris menunjuk ke yang baru, dan hanya
  // bila memang berbeda. deletePrivateFile() tidak pernah melempar dan melewati pagar key
  // utils/storage.ts, jadi nilai kolom yang aneh berhenti di situ, bukan menghapus berkas lain.
  if (previous && previous !== path) deletePrivateFile(previous)

  logger.info(`Pengajuan identitas diterima: user=${userId} status=pending`)
  return presentCustomerProfile(userId)
}

// ===== 5. Destroy — DELETE /api/customer/profile =====

// ============================================================================
// === Penghapusan akun: integritas referensial ===
// ============================================================================
// Analisis dan pagarnya SAMA PERSIS dengan Fase 8G, dan memang harus sama — yang ditimbang adalah
// relasi pada tabel users, bukan audience pemanggilnya. Ringkasnya (uraian lengkap ada di
// staff-profile-services.ts): relationMode = "prisma" menghapus SELURUH foreign key di level
// database, sehingga tidak ada satu pun aksi referensial yang ditegakkan MariaDB.
//
//   * News.authorId (WAJIB)  -> Restrict. Gagal dengan error Prisma mentah.
//   * Sepuluh relasi OPSIONAL -> SetNull, DIAM-DIAM. Untuk seorang CUSTOMER yang relevan adalah
//     Booking.userId, Transaction.userId, Review.userId, Membership.userId, dan
//     MembershipHistory.userId: seluruhnya menjadi baris tanpa pemilik. Reservasi yang pernah dibayar
//     berubah menjadi reservasi tanpa pemesan, transaksi terverifikasi menjadi uang masuk tanpa
//     penyetor, dan ulasan yang sudah tampil di beranda kehilangan penulisnya tanpa satu pun error.
//
// Tidak satu pun bisa dibuat aman dari dalam file ini: yang dibutuhkan adalah perubahan SKEMA (kolom
// deletedAt untuk soft delete, atau akun sistem "Akun Dihapus" sebagai penerima limpahan), dan skema
// di luar kepemilikan agen fase ini. Karena itu keputusannya sama: PERIKSA LEBIH DULU, lalu TOLAK
// dengan 422 yang menyebut apa yang menahan.
//
// KONSEKUENSI PRAKTIS YANG HARUS DISAMPAIKAN KE PRODUK: seorang customer yang pernah memesan satu
// lapangan, membayar sekali, atau menulis satu ulasan TIDAK akan pernah bisa menghapus akunnya lewat
// endpoint ini — ia selalu menerima 422. Yang benar-benar terhapus hanyalah akun yang belum
// meninggalkan jejak apa pun (mis. baru mendaftar lalu berubah pikiran). Itu disengaja dan jauh lebih
// baik daripada menganonimkan riwayat pembayaran; jalur untuk sisanya adalah penonaktifan akun oleh
// Administrator, yang butuh kolom baru di skema.
//
// Empat tabel token (RefreshToken, PasswordResetToken, EmailVerificationToken, NotificationState)
// ber-onDelete: Cascade eksplisit dan ikut terhapus — itu memang sesi dan token, bukan riwayat.

/**
 * ProfileController::destroy() untuk customer.
 *
 * Seluruh pekerjaannya dikerjakan deleteStaffAccount() — `current_password`, pagar integritas di
 * atas, forceLogoutAll() untuk KEDUA audience, penghapusan baris, dan unlink avatar yang memang milik
 * kita. Membuat versi keduanya di sini berarti dua pagar integritas yang bisa berbeda isinya, dan itu
 * persis jenis duplikasi yang paling mahal saat skemanya bertambah.
 *
 * SATU TAMBAHAN yang khusus customer: dokumen identitas. Laravel tidak membersihkannya (berkasnya
 * yatim di disk identity-documents selamanya) dan akun staff tidak pernah punya satu pun, jadi
 * deleteStaffAccount() tidak mengenalnya. Di sini ia PII yang tidak punya alasan untuk tetap ada
 * setelah pemiliknya hilang, jadi path-nya dibaca sebelum baris terhapus lalu berkasnya dibuang
 * setelahnya. PENYIMPANGAN dari Laravel yang disengaja.
 *
 * Cookie di browser TIDAK dibersihkan dari sini (service tidak memegang Response). Refresh token
 * sudah tidak ada, jadi rotasi berikutnya membalas 401. FE tetap sebaiknya memanggil
 * /api/auth/logout setelah balasan ini.
 */
export async function deleteCustomerAccount(userId: string, request: unknown): Promise<{ id: string }> {
  // Dibaca SEBELUM barisnya hilang; validasi password dan pagar integritas berjalan di dalam
  // deleteStaffAccount(), jadi pembacaan ini tidak pernah membocorkan apa pun ke pemanggil yang gagal.
  const current = await prismaClient.user.findUnique({ where: { id: userId }, select: { identityFilePath: true } })

  const result = await deleteStaffAccount(userId, request)

  if (current?.identityFilePath) deletePrivateFile(current.identityFilePath)

  logger.info(`Akun customer dihapus atas permintaan sendiri: ${userId}`)
  return result
}
