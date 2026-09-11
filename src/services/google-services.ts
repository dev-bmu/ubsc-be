import { Response } from 'express'
import { randomBytes } from 'crypto'
import { prismaClient } from '../application/database'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, IS_PRODUCTION, COOKIE_DOMAIN } from '../config'
import { ResponseError } from '../error/response-error'
import { logger } from '../utils/logger'
import { issueCustomerSession } from './auth-services'

// ============================================================================
// === GOOGLE OAUTH (audience customer saja) ===
// ============================================================================
// Di-port dari Laravel Socialite. Tiga perilaku yang harus dipertahankan:
//
//  1. ACCOUNT LINKING BY EMAIL. Kalau email Google-nya sudah punya akun lokal,
//     akun itu yang dipakai dan googleId-nya diisi — bukan membuat akun kedua.
//     Tanpa ini, orang yang pernah daftar dengan password lalu masuk lewat
//     Google akan menemukan riwayat bookingnya "hilang".
//  2. NORMALISASI AVATAR. Google mengembalikan URL berakhiran =s96-c; suffix
//     ukurannya diganti =s256-c supaya avatar tidak buram di layar retina.
//  3. EMAIL OTOMATIS TERVERIFIKASI. Google sudah memverifikasi alamatnya —
//     hanya bila field email_verified pada respons memang true.
//
// Implementasinya memakai endpoint OAuth 2.0 Google langsung lewat fetch
// bawaan Node 24, tanpa SDK: alurnya hanya dua permintaan HTTP, dan satu
// dependency lagi untuk itu tidak sepadan.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

/** Cookie state anti-CSRF; umurnya pendek karena alurnya memang sebentar. */
const STATE_COOKIE = 'ubsc_oauth_state'
const STATE_TTL_MS = 10 * 60 * 1000

interface GoogleUserInfo {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

function assertConfigured(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    // 503, bukan 500: konfigurasinya yang belum ada, bukan kodenya yang rusak.
    throw new ResponseError(503, 'Masuk dengan Google belum tersedia', 'SERVICE_UNAVAILABLE')
  }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri: GOOGLE_REDIRECT_URI }
}

/**
 * Ganti suffix ukuran avatar Google menjadi =s256-c.
 * Contoh: '.../photo.jpg=s96-c' -> '.../photo.jpg=s256-c'
 * URL tanpa suffix ukuran dibiarkan apa adanya.
 */
export function normalizeGoogleAvatar(url: string | undefined): string | null {
  if (!url) return null
  return url.replace(/=s\d+(-c)?$/, '=s256-c')
}

// ---------------------------------------------------------------------------
// 1. REDIRECT ke Google
// ---------------------------------------------------------------------------

export function googleRedirect(res: Response): string {
  const { clientId, redirectUri } = assertConfigured()

  const state = randomBytes(24).toString('hex')
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: STATE_TTL_MS,
    path: '/api/auth',
    // Sama seperti cookie auth lain: host-only di produksi (R4).
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {})
  })

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // Minta refresh token tidak diperlukan: kita hanya butuh identitasnya
    // sekali, lalu memakai sesi sendiri.
    prompt: 'select_account'
  })

  return `${AUTH_ENDPOINT}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// 2. CALLBACK dari Google
// ---------------------------------------------------------------------------

export const googleCallback = async (
  query: { code?: string; state?: string; error?: string },
  cookieState: string | undefined,
  ipAddress: string | null,
  userAgent: string | null,
  res: Response
) => {
  const { clientId, clientSecret, redirectUri } = assertConfigured()

  // Cookie state sekali pakai, dibersihkan apa pun hasilnya.
  res.clearCookie(STATE_COOKIE, { path: '/api/auth' })
  if (COOKIE_DOMAIN) res.clearCookie(STATE_COOKIE, { path: '/api/auth', domain: COOKIE_DOMAIN })

  if (query.error) {
    // User menekan "batal" di layar Google. Bukan error sistem.
    throw new ResponseError(400, 'Masuk dengan Google dibatalkan', 'VALIDATION_ERROR')
  }
  if (!query.code) throw new ResponseError(400, 'Balasan Google tidak lengkap', 'VALIDATION_ERROR')
  if (!query.state || !cookieState || query.state !== cookieState) {
    logger.warn('OAUTH_STATE_MISMATCH — kemungkinan CSRF atau cookie state kedaluwarsa')
    throw new ResponseError(400, 'Sesi masuk Google tidak valid. Silakan coba lagi.', 'VALIDATION_ERROR')
  }

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: query.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })

  if (!tokenResponse.ok) {
    logger.error(`Google token exchange gagal: ${tokenResponse.status} ${await tokenResponse.text()}`)
    throw new ResponseError(502, 'Gagal menghubungi Google. Silakan coba lagi.', 'INTERNAL_ERROR')
  }

  const tokenJson = (await tokenResponse.json()) as { access_token?: string }
  if (!tokenJson.access_token) throw new ResponseError(502, 'Gagal menghubungi Google. Silakan coba lagi.', 'INTERNAL_ERROR')

  const infoResponse = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${tokenJson.access_token}` } })
  if (!infoResponse.ok) {
    logger.error(`Google userinfo gagal: ${infoResponse.status}`)
    throw new ResponseError(502, 'Gagal membaca profil Google. Silakan coba lagi.', 'INTERNAL_ERROR')
  }

  const info = (await infoResponse.json()) as GoogleUserInfo
  const email = info.email?.trim().toLowerCase()
  if (!email) throw new ResponseError(400, 'Akun Google Anda tidak memiliki alamat email', 'VALIDATION_ERROR')

  const avatar = normalizeGoogleAvatar(info.picture)
  const name = info.name?.trim() || email.split('@')[0]

  // ===== Account linking =====
  // Cari berdasarkan googleId dulu, baru email. Urutan ini penting: user yang
  // mengganti alamat Gmail-nya tetap mendarat di akun yang sama.
  let user = await prismaClient.user.findUnique({ where: { googleId: info.sub }, include: { role: true } })

  if (!user) {
    const byEmail = await prismaClient.user.findUnique({ where: { email }, include: { role: true } })

    if (byEmail) {
      // Akun lokal sudah ada -> tautkan, jangan buat akun kedua.
      user = await prismaClient.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: info.sub,
          avatar: byEmail.avatar ?? avatar,
          // Google sudah memverifikasi alamatnya — tapi hanya percaya bila
          // field email_verified memang true.
          emailVerifiedAt: byEmail.emailVerifiedAt ?? (info.email_verified ? new Date() : null)
        },
        include: { role: true }
      })
      logger.info(`Google account linking: ${email}`)
    } else {
      user = await prismaClient.user.create({
        data: {
          name,
          email,
          googleId: info.sub,
          avatar,
          // password tetap NULL — akun ini belum punya password lokal. Jalur
          // untuk menambahkannya adalah "lupa password".
          emailVerifiedAt: info.email_verified ? new Date() : null
        },
        include: { role: true }
      })
      logger.info(`Akun baru lewat Google: ${email}`)
    }
  } else if (avatar && user.avatar !== avatar) {
    user = await prismaClient.user.update({ where: { id: user.id }, data: { avatar }, include: { role: true } })
  }

  if (user.isLocked) throw new ResponseError(403, 'Akun terkunci. Hubungi administrator.', 'FORBIDDEN')

  return issueCustomerSession(user, ipAddress, userAgent, res, 'Masuk dengan Google')
}

export { STATE_COOKIE }
