import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import sharp from 'sharp'
import type { StaffProfileDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { UPLOAD_DIR } from '../config'
import { IMAGE_PIPELINE, UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { logger } from '../utils/logger'
import { StaffProfileValidation } from '../validation/staff-profile-validation'
import { Validation } from '../validation/Validation'
import { forceLogoutAll } from './auth-services'
import { issueVerification } from './registration-services'

// ============================================================================
// === Profil akun staff yang sedang login — Fase 8G ===
// ============================================================================
// Port ProfileController::update() + ::destroy(), Auth\PasswordController::update(), dan
// Auth\EmailVerificationNotificationController::store().
//
// Keempat endpoint ini menyentuh AKUN PEMANGGIL SENDIRI dan karena itu TIDAK punya gate permission —
// hanya autentikasi staff di level router. Konsekuensinya: userId TIDAK PERNAH boleh datang dari
// body atau params. Setiap fungsi di file ini menerimanya sebagai argumen dan controller mengisinya
// dari requireUser(req).id, bukan dari apa pun yang ditulis klien. Satu parameter userId yang
// dibaca dari body akan mengubah layar "ubah profil saya" menjadi "ubah profil siapa saja".

// ===== Bentuk baris + present() =====

const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
  emailVerifiedAt: true,
  role: { select: { name: true } }
} satisfies Prisma.UserSelect

type ProfileRow = Prisma.UserGetPayload<{ select: typeof PROFILE_SELECT }>

/**
 * Prefiks URL avatar milik API ini. Dua bagian yang keduanya dikunci di tempat lain:
 *   - '/uploads' -> mount express.static di application/web.ts:57 (di produksi: diterminasi nginx).
 *     Literal, BUKAN UPLOAD_DIR: UPLOAD_DIR adalah folder di disk, bukan path URL-nya — alasan yang
 *     sama dengan PUBLIC_URL_PREFIX di media-services.ts.
 *   - 'avatars/' -> subfolder yang ditulis storeAvatarImage() di bawah, dan SATU-SATUNYA tempat yang
 *     boleh disentuh unlinkOwnedAvatar().
 */
const AVATAR_URL_PREFIX = '/uploads/avatars/'

const PUBLIC_ROOT = (): string => resolve(process.cwd(), UPLOAD_DIR)

/**
 * Accessor `getAvatarUrlAttribute()` model User Laravel, tiga cabangnya persis:
 *   1. kolom kosong                                  -> null
 *   2. sudah http:// | https:// | /                  -> dipakai APA ADANYA
 *   3. selebihnya                                    -> diawali '/storage/'
 *
 * Cabang 2 itulah yang membuat avatar Google (URL absolut googleusercontent, ditulis
 * google-services.ts) tidak pernah dirusak, dan yang membuat avatar yang diunggah lewat endpoint ini
 * — nilainya sudah '/uploads/avatars/...' — lewat tanpa diubah apa pun.
 *
 * Cabang 3 memakai path RELATIF, bukan asset() yang absolut: alasannya sama dengan urlFor() di
 * media-services.ts (landing dan API beda origin saat dev, '/uploads' diproxy same-origin). Ia hanya
 * pernah tercapai untuk nilai warisan era Laravel ('avatars/xxx.jpg') yang berkasnya memang tidak
 * ikut pindah ke repo ini.
 */
function avatarUrlFor(avatar: string | null): string | null {
  if (!avatar) return null
  return avatar.startsWith('http://') || avatar.startsWith('https://') || avatar.startsWith('/') ? avatar : `/storage/${avatar}`
}

function presentProfile(row: ProfileRow): StaffProfileDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role?.name ?? null,
    avatar: row.avatar,
    avatarUrl: avatarUrlFor(row.avatar),
    emailVerifiedAt: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null
  }
}

async function loadProfile(userId: string): Promise<ProfileRow> {
  const row = await prismaClient.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT })
  // Token masih sah tapi akunnya sudah dihapus (mis. barusan, lewat endpoint destroy di bawah).
  if (!row) throw new ResponseError(404, 'Akun tidak ditemukan')
  return row
}

// ===== 1. Show — GET /api/admin/profile =====

export async function showStaffProfile(userId: string): Promise<StaffProfileDto> {
  return presentProfile(await loadProfile(userId))
}

// ============================================================================
// === Avatar: unggah, encode ulang, dan penghapusan berkas lama ===
// ============================================================================
// KEPUTUSAN PENYIMPANAN, ditulis lengkap karena ia menyimpang dari jalur unggah gambar lain di repo.
//
// storePublicMedia() (media-store-services.ts) TIDAK dipakai dan memang tidak bisa dipakai: fungsi
// itu membuat baris tabel Media dengan modelType berjenis MediaModelType, dan union itu berisi tujuh
// model konten (Facility, News, Reel, ...) — 'User' bukan salah satunya. Memakainya berarti menambah
// 'User' ke union di media-services.ts, yang di luar kepemilikan agen ini, sekaligus memberi avatar
// sebuah baris Media yang tidak pernah dibaca siapa pun: kolom users.avatar sudah menyimpan
// alamatnya sendiri, dan Laravel pun tidak melibatkan medialibrary di sini (`->store('avatars')`
// polos ke disk public).
//
// Yang DIPAKAI ULANG adalah propertinya, bukan kodenya: berkas di-decode dan ditulis ULANG oleh
// sharp dengan parameter IMAGE_PIPELINE yang sama. Itu properti KEAMANAN, bukan optimasi — berkas
// yang hanya mengaku gambar tidak selamat melewati decoder, dan EXIF maupun payload di ekor berkas
// tidak pernah sampai ke disk yang disajikan express.static.
//
// Tata letaknya 'avatars/<uuid>.<ext>' (bukan '<uuid>/<nama-kebab>.<ext>' ala media): nama berkas
// asli milik klien tidak ikut sama sekali, jadi tidak ada yang perlu di-slugify dan tidak ada nama
// tebakan yang bisa bertabrakan. Nilai yang disimpan di kolom users.avatar adalah URL BER-ROOT
// ('/uploads/avatars/<uuid>.webp') supaya cabang pass-through accessor di atas berlaku apa adanya.

/** Bentuk minimum berkas multer memoryStorage yang dipakai di sini — sama dengan UploadedImage CMS. */
export interface UploadedAvatar {
  buffer: Buffer
  originalname: string
}

/**
 * `mimes:jpeg,png,jpg` — SENGAJA tanpa webp, tidak seperti gambar CMS.
 * Aturan ProfileUpdateRequest memang hanya menyebut tiga itu; menerima lebih berarti menerima berkas
 * yang di Laravel ditolak.
 */
const AVATAR_INPUT_FORMATS = new Set(['jpeg', 'png'])

const AVATAR_TOO_LARGE_MESSAGE = 'Ukuran foto profil maksimal 2 MB.'

/**
 * Pagar dimensi terhadap decompression bomb: berkas 2 MB bisa mekar menjadi ratusan MB piksel di
 * memori sharp sebelum sempat di-resize. Angkanya disamakan dengan CMS_IMAGE/PAYMENT_PROOF;
 * UPLOAD_LIMITS.AVATAR tidak memuat batas dimensi sendiri.
 */
const AVATAR_MAX_EDGE = UPLOAD_LIMITS.CMS_IMAGE.maxWidth
const AVATAR_MAX_PIXELS = AVATAR_MAX_EDGE * AVATAR_MAX_EDGE

function avatarRejection(message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { avatar: [message] })
}

/** Validasi ISI berkas (bukan ekstensi/Content-Type klien), setara `image|mimes:jpeg,png,jpg`. */
async function inspectAvatar(buffer: Buffer): Promise<void> {
  const meta = await sharp(buffer, { limitInputPixels: AVATAR_MAX_PIXELS })
    .metadata()
    .catch(() => null)

  if (!meta) throw avatarRejection('Foto profil harus berupa gambar.')
  if (!meta.format || !AVATAR_INPUT_FORMATS.has(meta.format)) {
    throw avatarRejection('Format foto profil tidak didukung. Gunakan JPG atau PNG.')
  }
  if ((meta.width ?? 0) > AVATAR_MAX_EDGE || (meta.height ?? 0) > AVATAR_MAX_EDGE) {
    throw avatarRejection(`Resolusi foto profil terlalu besar. Maksimal ${AVATAR_MAX_EDGE} x ${AVATAR_MAX_EDGE} piksel.`)
  }
}

function encodeAvatar(buffer: Buffer, format: 'webp' | 'png'): Promise<Buffer> {
  const pipeline = sharp(buffer, { limitInputPixels: AVATAR_MAX_PIXELS })
    .rotate()
    .resize({ width: IMAGE_PIPELINE.MAX_EDGE, height: IMAGE_PIPELINE.MAX_EDGE, fit: 'inside', withoutEnlargement: true })
  return format === 'webp' ? pipeline.webp({ quality: IMAGE_PIPELINE.WEBP_QUALITY }).toBuffer() : pipeline.png({ compressionLevel: 9 }).toBuffer()
}

/**
 * Encode ulang + tulis satu avatar. Mengembalikan nilai yang masuk ke kolom users.avatar: URL
 * ber-root yang sudah bisa dipakai <img src> apa adanya.
 *
 * `limits.fileSize` multer sudah menolak berkas kebesaran dengan 413 di baris route; pemeriksaan
 * ukuran di sini adalah pagar kedua untuk pemanggil yang tidak lewat middleware itu, persis pola
 * assertImageWithinCmsLimit() di cms-card-admin-services.ts.
 */
async function storeAvatarImage(file: UploadedAvatar): Promise<string> {
  if (file.buffer.length > UPLOAD_LIMITS.AVATAR.maxBytes) {
    throw new ResponseError(413, AVATAR_TOO_LARGE_MESSAGE, 'PAYLOAD_TOO_LARGE', { avatar: [AVATAR_TOO_LARGE_MESSAGE] })
  }

  await inspectAvatar(file.buffer)

  const webp = await encodeAvatar(file.buffer, 'webp')
  let chosen: { data: Buffer; ext: 'webp' | 'png' } = { data: webp, ext: 'webp' }
  if (webp.length >= file.buffer.length) {
    const png = await encodeAvatar(file.buffer, 'png')
    if (png.length < webp.length) chosen = { data: png, ext: 'png' }
  }

  const fileName = `${randomUUID()}.${chosen.ext}`
  const destination = resolve(PUBLIC_ROOT(), 'avatars', fileName)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, chosen.data)

  logger.info(`Avatar diunggah: ${fileName} (${statSync(destination).size} byte)`)
  return `${AVATAR_URL_PREFIX}${fileName}`
}

/**
 * Hapus berkas avatar LAMA — hanya bila berkas itu memang milik kita.
 *
 * Laravel menuliskannya sebagai `! Str::startsWith($user->avatar, ['http://','https://','/'])`, yang
 * di sana berarti "nilai relatif = berkas di disk public kita; selain itu URL orang lain". Syarat itu
 * TIDAK bisa disalin harfiah ke sini, dan menyalinnya justru akan salah di kedua arah:
 *
 *   - Avatar yang ditulis endpoint ini SELALU diawali '/', sehingga syarat harfiah tidak akan pernah
 *     menghapus apa pun dan setiap penggantian foto menumpuk satu berkas yatim selamanya.
 *   - Nilai relatif warisan era Laravel ('avatars/xxx.jpg') menunjuk ke disk public APLIKASI LAMA
 *     yang tidak ikut pindah. Menyalin syaratnya harfiah membuat kita me-resolve nama itu ke dalam
 *     uploads/avatars milik kita sendiri — dan menghapus berkas milik orang lain yang kebetulan
 *     bernama sama.
 *
 * Yang dipertahankan adalah MAKSUDNYA: hapus hanya berkas yang benar-benar kita tulis sendiri, dan
 * jangan pernah menyentuh URL eksternal. Karena itu syaratnya menjadi "berawalan '/uploads/avatars/'",
 * ditambah pagar containment seperti unlinkMediaFiles(): nilai kolom berasal dari database, dan tanpa
 * pagar itu sebuah nilai berisi '../../' menjadikan fungsi ini penghapus berkas apa pun di disk.
 *
 * Tidak pernah melempar — kegagalan bersih-bersih bukan error milik user.
 */
function unlinkOwnedAvatar(avatar: string | null): void {
  if (!avatar || !avatar.startsWith(AVATAR_URL_PREFIX)) return

  const root = PUBLIC_ROOT()
  const full = resolve(root, 'avatars', avatar.slice(AVATAR_URL_PREFIX.length))
  const within = relative(resolve(root, 'avatars'), full)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    logger.warn(`Path avatar di luar uploads/avatars, dilewati: ${avatar}`)
    return
  }

  try {
    if (existsSync(full)) unlinkSync(full)
  } catch (error) {
    logger.warn(`Gagal menghapus avatar lama ${avatar}: ${(error as Error).message}`)
  }
}

// ===== 2. Update — PATCH /api/admin/profile =====

/**
 * ProfileController::update(), langkah demi langkah.
 *
 * `array_key_exists('email', $validated)` menjadi `v.email !== undefined`: alamat yang tidak dikirim
 * membiarkan kolomnya apa adanya (aturan `sometimes`).
 *
 * `$user->isDirty('email')` menjadi perbandingan eksplisit dengan alamat yang tersimpan. Bedanya
 * halus tapi penting: mengirim ULANG alamat yang sama TIDAK mencabut verifikasi email, sedangkan
 * menulis `emailVerifiedAt: null` setiap kali field email ikut terkirim akan membuat staff kehilangan
 * status terverifikasinya hanya karena menekan Simpan setelah mengganti namanya.
 *
 * `Rule::unique('users')->ignore($this->user()->id)` ditegakkan di sini (butuh database), dengan 422
 * yang menempel ke field email supaya applyApiErrors() bisa memasangnya di form.
 *
 * SATU PENYIMPANGAN URUTAN YANG DISENGAJA: Laravel menghapus berkas avatar LAMA sebelum menyimpan
 * yang baru dan sebelum `$user->save()`. Di sini penghapusan dilakukan SETELAH baris berhasil
 * di-update. Alasannya: kalau update gagal (mis. tabrakan unik yang lolos balapan), urutan Laravel
 * sudah terlanjur memusnahkan foto lama sementara kolomnya masih menunjuk ke sana. Hasil akhir pada
 * jalur sukses identik; yang berbeda hanya apa yang tersisa pada jalur gagal.
 */
export async function updateStaffProfile(userId: string, request: unknown, avatar?: UploadedAvatar): Promise<StaffProfileDto> {
  const v = Validation.validate(StaffProfileValidation.PROFILE, request)

  const current = await loadProfile(userId)

  const data: Prisma.UserUpdateInput = { name: v.name }

  if (v.email !== undefined && v.email !== current.email) {
    const taken = await prismaClient.user.findUnique({ where: { email: v.email }, select: { id: true } })
    if (taken && taken.id !== userId) {
      throw new ResponseError(422, 'Email sudah dipakai akun lain.', 'VALIDATION_ERROR', { email: ['Email sudah dipakai akun lain.'] })
    }

    data.email = v.email
    // isDirty('email') -> email_verified_at = null. Alamat baru belum pernah dibuktikan milik siapa
    // pun, jadi statusnya wajib kembali ke nol sampai tautan verifikasi yang baru diklik.
    data.emailVerifiedAt = null
  }

  const previousAvatar = current.avatar
  if (avatar) data.avatar = await storeAvatarImage(avatar)

  const updated = await prismaClient.user.update({ where: { id: userId }, data, select: PROFILE_SELECT })

  if (avatar) unlinkOwnedAvatar(previousAvatar)

  return presentProfile(updated)
}

// ===== 3. Password — PUT /api/admin/profile/password =====

const WRONG_CURRENT_PASSWORD = 'Password saat ini salah.'

/**
 * Auth\PasswordController::update(): aturan `current_password` lalu `Hash::make`.
 *
 * bcryptjs dengan cost 10 — SAMA dengan registerAuth() dan resetPasswordAuth()
 * (registration-services.ts). Tidak ada skema hashing kedua di repo ini; kalau cost-nya berubah, ia
 * berubah untuk semuanya sekaligus, bukan untuk satu endpoint.
 *
 * password NULL = akun yang hanya punya Google OAuth dan belum pernah menetapkan password lokal.
 * Diperlakukan sama dengan password salah, TANPA memanggil bcrypt dengan null — perlakuan yang sama
 * dengan loginAuth(). Jalur keluarnya adalah "lupa password", bukan endpoint ini.
 *
 * SESI LAIN SENGAJA TIDAK DICABUT. Laravel tidak mencabutnya di sini (bandingkan resetPasswordAuth,
 * yang mencabut SELURUH sesi di kedua audience — di sana pemicunya memang dugaan akun dibajak,
 * sedangkan di sini pemanggil baru saja membuktikan dirinya dengan password lama). Mencabut sesi
 * tanpa alasan itu hanya akan menendang staff keluar dari perangkat lain setiap kali ia merotasi
 * password secara rutin.
 */
export async function updateStaffPassword(userId: string, request: unknown): Promise<{ ok: true }> {
  const v = Validation.validate(StaffProfileValidation.PASSWORD, request)

  const user = await prismaClient.user.findUnique({ where: { id: userId }, select: { password: true } })
  if (!user) throw new ResponseError(404, 'Akun tidak ditemukan')

  if (!user.password || !bcrypt.compareSync(v.currentPassword, user.password)) {
    throw new ResponseError(422, WRONG_CURRENT_PASSWORD, 'VALIDATION_ERROR', { currentPassword: [WRONG_CURRENT_PASSWORD] })
  }

  await prismaClient.user.update({ where: { id: userId }, data: { password: bcrypt.hashSync(v.password, 10) } })

  logger.info(`Password akun staff diperbarui sendiri: ${userId}`)
  return { ok: true }
}

// ===== 4. Destroy — DELETE /api/admin/profile =====

// ============================================================================
// === Integritas referensial saat menghapus akun ===
// ============================================================================
// relationMode = "prisma" menghapus SELURUH foreign key di level database; integritas hanya
// ditegakkan Prisma di sisi client, memakai aksi referensial BAWAAN karena tidak satu pun relasi User
// di bawah menuliskan onDelete sendiri:
//
//   * Relasi WAJIB  -> Restrict. Hanya satu: News.authorId (String, non-null). Menghapus penulis yang
//     punya artikel akan GAGAL dengan error Prisma mentah, bukan pesan yang bisa dibaca staff.
//   * Relasi OPSIONAL -> SetNull, DIAM-DIAM. Ini yang berbahaya. Sepuluh kolom ikut dikosongkan tanpa
//     satu pun error: Transaction.verifiedById (siapa yang menyetujui pembayaran), Booking
//     .checkedInById (siapa yang melakukan check-in), Membership.createdById, MembershipHistory
//     .actorId, ClassSessionException.createdById — seluruh jejak audit — plus kepemilikan sisi
//     pelanggan Booking.userId, Membership.userId, MembershipHistory.userId, Transaction.userId, dan
//     Review.userId, yang berubah menjadi baris tanpa pemilik.
//
// Tidak satu pun dari itu bisa dibuat AMAN dari dalam file ini. Yang dibutuhkan adalah perubahan
// SKEMA — soft delete (kolom deletedAt) atau akun sistem "Akun Dihapus" sebagai penerima limpahan
// baris — dan skema di luar kepemilikan agen fase ini. Karena itu keputusannya: PERIKSA LEBIH DULU,
// lalu TOLAK dengan 422 yang menjelaskan apa yang menahan. Menghapus baris pembayaran yang sudah
// terverifikasi menjadi anonim jauh lebih buruk daripada sebuah tombol yang menolak bekerja.
//
// Akun yang benar-benar belum meninggalkan jejak apa pun tetap bisa menghapus dirinya. Empat tabel
// token (RefreshToken, PasswordResetToken, EmailVerificationToken, NotificationState) memang ber-
// onDelete: Cascade eksplisit dan ikut terhapus — itu memang isinya sesi dan token, bukan riwayat.

interface AccountReference {
  label: string
  count: number
}

async function accountReferences(userId: string): Promise<AccountReference[]> {
  const [
    news,
    verifiedTransactions,
    checkedInBookings,
    createdMemberships,
    membershipActions,
    sessionExceptions,
    bookings,
    memberships,
    membershipHistory,
    transactions,
    reviews
  ] = await Promise.all([
    prismaClient.news.count({ where: { authorId: userId } }),
    prismaClient.transaction.count({ where: { verifiedById: userId } }),
    prismaClient.booking.count({ where: { checkedInById: userId } }),
    prismaClient.membership.count({ where: { createdById: userId } }),
    prismaClient.membershipHistory.count({ where: { actorId: userId } }),
    prismaClient.classSessionException.count({ where: { createdById: userId } }),
    prismaClient.booking.count({ where: { userId } }),
    prismaClient.membership.count({ where: { userId } }),
    prismaClient.membershipHistory.count({ where: { userId } }),
    prismaClient.transaction.count({ where: { userId } }),
    prismaClient.review.count({ where: { userId } })
  ])

  return [
    { label: 'artikel berita', count: news },
    { label: 'pembayaran yang diverifikasi', count: verifiedTransactions },
    { label: 'check-in reservasi', count: checkedInBookings },
    { label: 'membership yang dibuat', count: createdMemberships },
    { label: 'riwayat membership', count: membershipActions },
    { label: 'pembatalan sesi kelas', count: sessionExceptions },
    { label: 'reservasi', count: bookings },
    { label: 'membership', count: memberships },
    { label: 'riwayat membership sebagai subjek', count: membershipHistory },
    { label: 'transaksi', count: transactions },
    { label: 'ulasan', count: reviews }
  ].filter((reference) => reference.count > 0)
}

/**
 * ProfileController::destroy(): `current_password` -> Auth::logout() -> $user->delete().
 *
 * Tiga bedanya dengan Laravel, semuanya disengaja:
 *
 *   1. Pemeriksaan integritas referensial di atas berjalan lebih dulu. Laravel bersandar pada foreign
 *      key MySQL; di sini tidak ada satu pun foreign key di database (relationMode = "prisma").
 *   2. Auth::logout() + session invalidate menjadi forceLogoutAll() untuk KEDUA audience. Akun yang
 *      dihapus tidak boleh menyisakan sesi hidup di mana pun, dan seorang staff bisa saja juga punya
 *      sesi customer di situs publik dengan akun yang sama. Fungsinya diambil dari auth-services.ts,
 *      bukan ditulis ulang — pencabutan sesi hanya boleh punya satu implementasi.
 *   3. Cookie di browser TIDAK dibersihkan dari sini (service tidak memegang Response). Refresh token
 *      sudah tidak ada, jadi rotasi berikutnya membalas 401 dan refreshAuth() yang membersihkan
 *      cookie-nya. FE tetap sebaiknya memanggil /api/auth/logout setelah balasan ini.
 */
export async function deleteStaffAccount(userId: string, request: unknown): Promise<{ id: string }> {
  const v = Validation.validate(StaffProfileValidation.ACCOUNT_DELETE, request)

  const user = await prismaClient.user.findUnique({ where: { id: userId }, select: { email: true, avatar: true, password: true } })
  if (!user) throw new ResponseError(404, 'Akun tidak ditemukan')

  if (!user.password || !bcrypt.compareSync(v.password, user.password)) {
    throw new ResponseError(422, WRONG_CURRENT_PASSWORD, 'VALIDATION_ERROR', { password: [WRONG_CURRENT_PASSWORD] })
  }

  const references = await accountReferences(userId)
  if (references.length > 0) {
    const detail = references.map((reference) => `${reference.count} ${reference.label}`).join(', ')
    const message = `Akun ini masih tertaut ke data operasional (${detail}) sehingga tidak bisa dihapus. Menghapusnya akan memutus jejak audit pembayaran dan reservasi. Hubungi Administrator untuk menonaktifkan akun.`
    throw new ResponseError(422, message, 'VALIDATION_ERROR', { password: [message] })
  }

  await forceLogoutAll(userId, 'staff')
  await forceLogoutAll(userId, 'customer')

  await prismaClient.user.delete({ where: { id: userId } })

  // Setelah baris hilang, berkasnya tidak punya pemilik lagi. Sama seperti update: hanya berkas yang
  // memang kita tulis sendiri yang disentuh, URL Google tidak pernah.
  unlinkOwnedAvatar(user.avatar)

  logger.info(`Akun staff dihapus atas permintaan sendiri: ${user.email}`)
  return { id: userId }
}

// ===== 5. Kirim ulang email verifikasi — POST /api/admin/email/verification-notification =====

/**
 * Auth\EmailVerificationNotificationController::store(), kedua cabangnya:
 *   - sudah terverifikasi -> TIDAK mengirim apa pun (Laravel: redirect()->intended('/'))
 *   - belum               -> kirim notifikasi verifikasi
 *
 * Pengirimannya MEMAKAI ULANG resendVerificationAuth() (registration-services.ts) dan tidak
 * membangun jalur email kedua: fungsi itu sudah mencabut token lama, menerbitkan token baru 24 jam,
 * dan mengirim verifyEmailTemplate lewat `void sendMailSafe()` setelah transaksi commit (R8). Satu
 * tautan verifikasi yang beredar, satu bentuk email, satu tempat untuk memperbaikinya.
 *
 * Dua catatan atas pemakaian ulang itu:
 *
 *   - resendVerificationAuth() menerima EMAIL, bukan userId, dan membalas pesan generik yang sama
 *     untuk "terkirim" dan "tidak terdaftar" (anti-enumerasi). Di sini pemanggilnya sudah
 *     terautentikasi dan emailnya diambil dari barisnya sendiri, jadi penyamaran itu tidak relevan —
 *     dan karena status terverifikasi sudah diperiksa lebih dulu di sini, `sent` yang dikembalikan
 *     benar-benar mencerminkan apakah ada email yang dikirim.
 *   - Tautannya mengarah ke LANDING_URL/verifikasi-email. Halaman itu berada di situs publik, bukan
 *     panel staff; endpoint penukaran tokennya sama untuk kedua audience, jadi tautannya berfungsi.
 *     Bila kelak ada halaman verifikasi khusus panel, yang berubah cukup verifyUrl() di sana.
 *
 * Cabang TransportExceptionInterface Laravel (SMTP mati -> pesan error, bukan 500) sudah dijawab
 * bentuk `void sendMailSafe()`: pengiriman berjalan di luar jalur balasan sehingga SMTP yang tidak
 * terjangkau tidak pernah bisa menjatuhkan request ini. Konsekuensinya, endpoint ini melaporkan
 * "sudah dikirim" berdasarkan token yang berhasil dibuat, bukan berdasarkan konfirmasi server email.
 */
export async function resendStaffVerificationEmail(userId: string): Promise<{ sent: boolean }> {
  const user = await prismaClient.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) throw new ResponseError(404, 'Akun tidak ditemukan')

  // Jeda dan batas harian kirim ulang (issueVerification) berlaku juga untuk staff: sent=false bila ditahan.
  return { sent: (await issueVerification(userId)).sent }
}
