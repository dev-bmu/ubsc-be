import { Response } from 'express'
import bcrypt from 'bcryptjs'
import type { ResendVerificationDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { LANDING_URL } from '../config'
import { ResponseError } from '../error/response-error'
import { createRefreshToken, hashToken } from '../utils/token'
import { logger } from '../utils/logger'
import { sendMailSafe } from '../utils/mailer'
import { resetPasswordTemplate, verifyEmailTemplate } from '../utils/mail-templates'
import { Validation } from '../validation/Validation'
import { AuthValidation } from '../validation/auth-validation'
import { issueCustomerSession } from './auth-services'

// ============================================================================
// === PENDAFTARAN, VERIFIKASI EMAIL, RESET PASSWORD (audience customer) ===
// ============================================================================
// Tidak satu pun dari ini ada di boilerplate STARTER-BMU — jawabannya untuk
// "lupa password" di sana hanya dialog statis "silakan menghubungi
// administrator BMU". Semuanya dibangun baru mengikuti gaya boilerplate, dan
// memakai ulang bahan yang memang sudah ada: utils/token.ts
// (createRefreshToken 64-byte hex + hashToken sha256) dan bentuk tabel
// RefreshToken — persis pola "simpan hash saja, beri expiry, sekali pakai"
// yang dibutuhkan token reset password.
//
// Dua aturan keamanan yang berlaku di seluruh file ini:
//
//  1. JANGAN membocorkan email mana yang terdaftar. forgot-password dan
//     resend-verification SELALU membalas sukses, apa pun hasilnya. Endpoint
//     yang membalas "email tidak ditemukan" adalah alat enumerasi akun gratis.
//  2. Email dikirim SETELAH transaksi commit dan DI LUAR $transaction, lewat
//     `void sendMailSafe()` (R8). Kegagalan SMTP tidak boleh muncul sebagai 500
//     setelah akunnya benar-benar dibuat.

/** Token verifikasi email berlaku 24 jam. */
const VERIFY_TOKEN_TTL_HOURS = 24

/** Token reset password berlaku 60 menit — lebih pendek, dampaknya lebih besar. */
const RESET_TOKEN_TTL_MINUTES = 60

function verifyUrl(token: string): string {
  return `${LANDING_URL}/verifikasi-email?token=${token}`
}

function resetUrl(token: string): string {
  return `${LANDING_URL}/reset-password?token=${token}`
}

// ---------------------------------------------------------------------------
// 1. REGISTER
// ---------------------------------------------------------------------------

export const registerAuth = async (request: unknown, ipAddress: string | null, userAgent: string | null, res: Response) => {
  const validated = Validation.validate(AuthValidation.REGISTER, request)

  const existing = await prismaClient.user.findUnique({ where: { email: validated.email }, select: { id: true } })
  if (existing) {
    // Di sini membocorkan keberadaan email TIDAK bisa dihindari — form memang
    // harus memberi tahu bahwa email sudah dipakai. Yang penting pesannya
    // menempel ke field email supaya applyApiErrors() bisa memasangnya.
    throw new ResponseError(409, 'Email sudah terdaftar', 'CONFLICT', { email: ['Email sudah terdaftar'] })
  }

  const passwordHash = bcrypt.hashSync(validated.password, 10)
  const tokenPlain = createRefreshToken()

  // Akun dan token verifikasi dibuat dalam satu transaksi: akun tanpa token
  // berarti user yang tidak pernah bisa memverifikasi dirinya sendiri.
  const user = await prismaClient.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: validated.name,
        email: validated.email,
        password: passwordHash,
        phoneNumber: validated.phoneNumber ?? null
      },
      include: { role: true }
    })

    await tx.emailVerificationToken.create({
      data: {
        userId: created.id,
        tokenHash: hashToken(tokenPlain),
        expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3600 * 1000)
      }
    })

    return created
  })

  // Di LUAR transaksi, setelah commit. void: kegagalan SMTP tidak boleh
  // membatalkan pendaftaran yang sudah tersimpan.
  void sendMailSafe(verifyEmailTemplate({ to: user.email, name: user.name, url: verifyUrl(tokenPlain), expiresInHours: VERIFY_TOKEN_TTL_HOURS }))

  // Langsung login. Email yang belum terverifikasi membatasi apa yang boleh
  // dilakukan (checkout booking), bukan apakah boleh masuk — memaksa
  // verifikasi sebelum masuk hanya memindahkan titik user menyerah.
  return issueCustomerSession(user, ipAddress, userAgent, res, 'Pendaftaran')
}

// ---------------------------------------------------------------------------
// 2. VERIFIKASI EMAIL
// ---------------------------------------------------------------------------

export const verifyEmailAuth = async (request: unknown) => {
  const validated = Validation.validate(AuthValidation.VERIFY_EMAIL, request)

  const stored = await prismaClient.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(validated.token) },
    include: { user: { select: { id: true, email: true, emailVerifiedAt: true } } }
  })

  if (!stored) throw new ResponseError(400, 'Tautan verifikasi tidak valid', 'VALIDATION_ERROR')

  // Sudah terverifikasi (tautan ini diklik dua kali, tautan dari email lama, Google OAuth, atau reset
  // password): anggap sukses, jangan menampilkan error yang membingungkan. Dicek SEBELUM usedAt,
  // karena kirim ulang menandai tautan lama "terpakai" juga.
  if (stored.user.emailVerifiedAt) {
    if (!stored.usedAt) await prismaClient.emailVerificationToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } })
    return { verified: true, email: stored.user.email }
  }

  if (stored.usedAt) {
    throw new ResponseError(
      400,
      'Tautan verifikasi ini sudah tidak berlaku. Pakai tautan di email terbaru, atau minta tautan baru.',
      'VALIDATION_ERROR'
    )
  }
  if (stored.expiresAt < new Date()) {
    throw new ResponseError(400, 'Tautan verifikasi sudah kedaluwarsa. Minta tautan baru.', 'VALIDATION_ERROR')
  }

  await prismaClient.$transaction(async (tx) => {
    await tx.user.update({ where: { id: stored.userId }, data: { emailVerifiedAt: new Date() } })
    await tx.emailVerificationToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } })
    // Token lain milik user yang sama jadi tidak berguna — cabut sekalian.
    await tx.emailVerificationToken.updateMany({
      where: { userId: stored.userId, usedAt: null, id: { not: stored.id } },
      data: { usedAt: new Date() }
    })
  })

  logger.info(`Email terverifikasi: ${stored.user.email}`)
  return { verified: true, email: stored.user.email }
}

// ---------------------------------------------------------------------------
// 3. KIRIM ULANG VERIFIKASI
// ---------------------------------------------------------------------------

const GENERIC_SENT_MESSAGE = 'Bila email tersebut terdaftar, kami sudah mengirim tautan ke kotak masuk Anda.'

/**
 * Jeda antar-email satu akun dan batas per 24 jam — supaya SMTP tidak dihujani. Berlaku untuk kirim
 * ulang verifikasi DAN lupa password (dua form yang bisa diklik berulang oleh siapa pun).
 */
export const MAIL_RESEND_COOLDOWN_SECONDS = 60
export const MAIL_RESEND_MAX_PER_DAY = 5

const DAY_MS = 24 * 3600 * 1000

/**
 * Terbitkan token baru dan kirim email verifikasi, kecuali ditahan jeda atau batas harian. Setiap
 * kiriman sudah meninggalkan satu baris email_verification_tokens (createdAt), jadi tabel itu sekaligus
 * log kirimannya — tanpa kolom baru. Baris users dikunci supaya dua klik bersamaan tidak sama-sama
 * lolos cek jeda. Satu-satunya jalan kirim ulang: publik, pelanggan login, dan staff.
 */
export async function issueVerification(userId: string): Promise<ResendVerificationDto> {
  const outcome = await prismaClient.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`
    const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true, emailVerifiedAt: true } })
    if (!user || user.emailVerifiedAt) return { sent: false, retryAfterSeconds: 0, alreadyVerified: true }

    const nowMs = Date.now()
    const recent = await tx.emailVerificationToken.findMany({
      where: { userId, createdAt: { gte: new Date(nowMs - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true }
    })
    const cooldown = recent[0] ? Math.ceil((recent[0].createdAt.getTime() + MAIL_RESEND_COOLDOWN_SECONDS * 1000 - nowMs) / 1000) : 0
    if (cooldown > 0) return { sent: false, retryAfterSeconds: cooldown, alreadyVerified: false }
    if (recent.length >= MAIL_RESEND_MAX_PER_DAY) {
      // Kuota kembali saat kiriman tertua di jendela 24 jam keluar dari jendela itu.
      const reopensAt = recent[recent.length - 1].createdAt.getTime() + DAY_MS
      return { sent: false, retryAfterSeconds: Math.max(1, Math.ceil((reopensAt - nowMs) / 1000)), alreadyVerified: false }
    }

    const tokenPlain = createRefreshToken()
    // Cabut token lama supaya hanya tautan terbaru yang berlaku.
    await tx.emailVerificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } })
    await tx.emailVerificationToken.create({
      data: { userId, tokenHash: hashToken(tokenPlain), expiresAt: new Date(nowMs + VERIFY_TOKEN_TTL_HOURS * 3600 * 1000) }
    })
    return { sent: true, retryAfterSeconds: MAIL_RESEND_COOLDOWN_SECONDS, alreadyVerified: false, mail: { ...user, tokenPlain } }
  })

  if ('mail' in outcome && outcome.mail) {
    const { email, name, tokenPlain } = outcome.mail
    void sendMailSafe(verifyEmailTemplate({ to: email, name, url: verifyUrl(tokenPlain), expiresInHours: VERIFY_TOKEN_TTL_HOURS }))
  }
  return { sent: outcome.sent, retryAfterSeconds: outcome.retryAfterSeconds, alreadyVerified: outcome.alreadyVerified }
}

export const resendVerificationAuth = async (request: unknown) => {
  const validated = Validation.validate(AuthValidation.RESEND_VERIFICATION, request)

  const user = await prismaClient.user.findUnique({ where: { email: validated.email }, select: { id: true, emailVerifiedAt: true } })

  // Balasan sama persis untuk email tidak terdaftar, sudah terverifikasi, dan yang ditahan jeda —
  // ketiganya pulang tanpa membocorkan apa pun.
  if (user && !user.emailVerifiedAt) await issueVerification(user.id)

  return { message: GENERIC_SENT_MESSAGE }
}

// ---------------------------------------------------------------------------
// 4. LUPA PASSWORD
// ---------------------------------------------------------------------------

export const forgotPasswordAuth = async (request: unknown) => {
  const validated = Validation.validate(AuthValidation.FORGOT_PASSWORD, request)

  const user = await prismaClient.user.findUnique({ where: { email: validated.email }, select: { id: true, name: true, email: true } })

  // SELALU balas sukses. Perbedaan balasan antara email terdaftar dan tidak
  // adalah alat enumerasi akun gratis.
  if (!user) {
    logger.info(`forgot-password untuk email tidak terdaftar: ${validated.email}`)
    return { message: GENERIC_SENT_MESSAGE }
  }

  const tokenPlain = createRefreshToken()

  const issued = await prismaClient.$transaction(async (tx) => {
    // Jeda + batas harian per akun, sama dengan kirim ulang verifikasi. Baris users dikunci supaya dua
    // klik bersamaan tidak sama-sama lolos. Yang ditahan tetap dibalas pesan generik (anti-enumerasi).
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`
    const recent = await tx.passwordResetToken.findMany({
      where: { userId: user.id, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true }
    })
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < MAIL_RESEND_COOLDOWN_SECONDS * 1000) return false
    if (recent.length >= MAIL_RESEND_MAX_PER_DAY) return false

    // Satu tautan aktif per user: permintaan baru membatalkan yang lama.
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } })
    await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(tokenPlain), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000) }
    })
    return true
  })

  if (issued) {
    void sendMailSafe(
      resetPasswordTemplate({ to: user.email, name: user.name, url: resetUrl(tokenPlain), expiresInMinutes: RESET_TOKEN_TTL_MINUTES })
    )
  } else {
    logger.info(`forgot-password untuk ${validated.email} ditahan jeda/batas harian`)
  }

  return { message: GENERIC_SENT_MESSAGE }
}

// ---------------------------------------------------------------------------
// 5. RESET PASSWORD
// ---------------------------------------------------------------------------

export const resetPasswordAuth = async (request: unknown) => {
  const validated = Validation.validate(AuthValidation.RESET_PASSWORD, request)

  const stored = await prismaClient.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(validated.token) },
    include: { user: { select: { id: true, email: true } } }
  })

  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    // Satu pesan untuk tiga sebab: token tidak ada, sudah dipakai, kedaluwarsa.
    // Membedakannya memberi tahu penyerang bahwa tebakan tokennya "hampir benar".
    throw new ResponseError(400, 'Tautan reset tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.', 'VALIDATION_ERROR', {
      token: ['Tautan reset tidak valid atau sudah kedaluwarsa']
    })
  }

  const passwordHash = bcrypt.hashSync(validated.password, 10)

  await prismaClient.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: stored.userId },
      // Reset password sekaligus membuka akun yang terkunci karena 5 kali gagal
      // login: orang yang lupa password dan orang yang mengunci dirinya sendiri
      // biasanya orang yang sama.
      data: { password: passwordHash, failedLogins: 0, isLocked: false }
    })
    // Tautan reset sampai lewat email itu sendiri, jadi kepemilikannya sudah terbukti. Ini jalan masuk
    // akun yang dibuat FO di meja depan (tanpa password): cukup "Lupa password", tanpa verifikasi kedua.
    await tx.user.updateMany({ where: { id: stored.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } })
    await tx.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } })

    // Cabut SELURUH sesi di KEDUA audience. Kalau password diganti karena akun
    // diduga dibajak, sesi pembajak harus ikut mati — termasuk sesi panel staff
    // bila kebetulan orangnya staff.
    await tx.refreshToken.deleteMany({ where: { userId: stored.userId } })
  })

  logger.info(`Password di-reset: ${stored.user.email} — seluruh sesi dicabut`)
  return { message: 'Password berhasil diperbarui. Silakan masuk dengan password baru Anda.' }
}
