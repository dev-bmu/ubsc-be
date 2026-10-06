import { CookieOptions, Response } from 'express'
import { randomUUID } from 'crypto'
import { isIP } from 'net'
import bcrypt from 'bcryptjs'
import { RefreshToken } from '@prisma/client'
import { prismaClient } from '../application/database'
import {
  COOKIE_DOMAIN,
  IS_PRODUCTION,
  LANDING_URL,
  MAX_FAILED_LOGINS,
  MAX_SESSIONS,
  REFRESH_TOKEN_EXPIRES_SECONDS as REFRESH_EXPIRES
} from '../config'
import { ResponseError } from '../error/response-error'
import { UserWithRelations } from '../type/user-request'
import { TokenAudience, signAccessToken } from '../utils/jwt'
import { createRefreshToken, hashToken } from '../utils/token'
import { logger } from '../utils/logger'
import { getPermissionsByRole } from './permission-services'
import { Validation } from '../validation/Validation'
import { AuthValidation } from '../validation/auth-validation'

// ============================================================================
// === AUTH DUA AUDIENCE — FASE 0: login email + password ===
// ============================================================================
// Satu jalur login dipakai dua audience. Yang membedakan customer dan staff:
// nama cookie, secret JWT (lihat utils/jwt), klaim aud, kolom audience di
// refresh_tokens, dan keharusan punya role staff.
//
// Register, verifikasi email, forgot/reset password, dan Google OAuth adalah
// Fase 1 — daftar TODO-nya ada di bagian paling bawah file ini.
// ============================================================================

// ===== Cookie per audience =====

interface AudienceCookies {
  refresh: string
  role: string
  permissions: string
}

/**
 * KONTRAK LINTAS-REPO — JANGAN diubah tanpa mengubah kedua app Next di commit yang sama.
 *
 * Nama-nama ini dibaca middleware ubsc-landing (prefix ubsc_c_*) dan ubsc-admin (prefix
 * ubsc_s_*) untuk memutuskan route mana yang boleh dirender sebelum ada request ke API.
 * Satu huruf yang berbeda di salah satu repo membuat middleware menyimpulkan "tidak ada
 * sesi" dan memantulkan user yang sebenarnya sudah login ke halaman masuk — tanpa error,
 * tanpa baris log, di ketiga repo sekaligus.
 *
 * Karena itu nilainya hardcode di sini dan SENGAJA tidak dibaca dari environment. Var env
 * untuk ini pernah ada (CUSTOMER_REFRESH_COOKIE / STAFF_REFRESH_COOKIE) dan sudah dihapus:
 * satu-satunya yang bisa dilakukannya adalah memutus kontrak tiga repo secara diam-diam,
 * lewat perubahan yang tidak muncul di diff mana pun.
 *
 * R4: prefix kedua audience WAJIB berbeda. Nama yang sama membuat cookie staff dan cookie
 * customer saling menimpa di browser yang sama.
 */
const COOKIES: Record<TokenAudience, AudienceCookies> = {
  customer: { refresh: 'ubsc_c_refresh', role: 'ubsc_c_role', permissions: 'ubsc_c_permissions' },
  staff: { refresh: 'ubsc_s_refresh', role: 'ubsc_s_role', permissions: 'ubsc_s_permissions' }
}

/** Cookie refresh hanya dikirim ke endpoint yang benar-benar memakainya. */
const REFRESH_COOKIE_PATH = '/api/auth'

/** Cookie mirror dibaca middleware Next di seluruh situs, jadi tetap di root. */
const MIRROR_COOKIE_PATH = '/'

/**
 * Customer tidak punya role staff, tapi middleware Next tetap butuh satu cookie
 * non-httpOnly sebagai penanda "ada sesi" — cookie refresh httpOnly ber-Path
 * /api/auth tidak terlihat olehnya. Nilai ini label tampilan, bukan baris di
 * tabel roles, dan tidak pernah dipakai untuk keputusan otorisasi.
 */
const CUSTOMER_ROLE_LABEL = 'Customer'

export function getRefreshCookieName(audience: TokenAudience): string {
  return COOKIES[audience].refresh
}

/**
 * R4 — atribut Domain sengaja TIDAK di-set bila COOKIE_DOMAIN kosong, dan di
 * produksi memang dikosongkan. Cookie host-only inilah yang memisahkan sesi
 * staff di dash.ubsportcenter.co.id dari sesi customer di ubsportcenter.co.id;
 * mengisi '.ubsportcenter.co.id' membagikan seluruh cookie ke kedua subdomain.
 * Perhatikan: key domain tidak disertakan sama sekali, bukan dikirim bernilai
 * string kosong.
 */
function withDomain(options: CookieOptions): CookieOptions {
  return COOKIE_DOMAIN ? { ...options, domain: COOKIE_DOMAIN } : options
}

function refreshCookieOptions() {
  const maxAge = REFRESH_EXPIRES * 1000
  return withDomain({ httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', maxAge, path: REFRESH_COOKIE_PATH })
}

function mirrorCookieOptions() {
  const maxAge = REFRESH_EXPIRES * 1000
  return withDomain({ httpOnly: false, secure: IS_PRODUCTION, sameSite: 'lax', maxAge, path: MIRROR_COOKIE_PATH })
}

/**
 * Domain induk tempat cookie auth LAMA bisa tertinggal: produksi pernah berjalan dengan
 * COOKIE_DOMAIN=.ubsportcenter.co.id. Cookie ber-Domain itu terkirim ke kedua host, bernama dan
 * ber-Path sama dengan cookie host-only yang baru, dan dikirim LEBIH DULU (RFC 6265: path sama,
 * yang tertua duluan) — cookie host-only tidak pernah bisa menghapusnya. Diturunkan dari host
 * LANDING_URL (apex): dash.<apex> ikut domain-match, jadi clear-nya diterima dari kedua host.
 * Kosong untuk localhost/IP (dev).
 */
const SHADOW_COOKIE_DOMAIN = (() => {
  const host = new URL(LANDING_URL).hostname
  return host.includes('.') && !isIP(host.replace(/[[\]]/g, '')) ? host : ''
})()

const bareDomain = (domain: string) => domain.replace(/^\./, '').toLowerCase()

/** Scope cookie yang SEDANG dipakai untuk menulis: Domain=COOKIE_DOMAIN, atau host-only (undefined). */
const liveScope = (): string | undefined => COOKIE_DOMAIN || undefined

/** Scope selain liveScope tempat sisa cookie lama mungkin bertahan. */
function staleScopes(): (string | undefined)[] {
  const scopes: (string | undefined)[] = COOKIE_DOMAIN ? [undefined] : []
  if (SHADOW_COOKIE_DOMAIN && bareDomain(SHADOW_COOKIE_DOMAIN) !== bareDomain(COOKIE_DOMAIN)) scopes.push(SHADOW_COOKIE_DOMAIN)
  return scopes
}

function expireCookies(res: Response, audience: TokenAudience, domains: (string | undefined)[]) {
  const names = COOKIES[audience]
  for (const domain of domains) {
    // Path wajib sama persis dengan saat di-set, kalau tidak cookie-nya tidak terhapus.
    const scope = domain ? { domain } : {}
    res.clearCookie(names.refresh, { path: REFRESH_COOKIE_PATH, ...scope })
    res.clearCookie(names.role, { path: MIRROR_COOKIE_PATH, ...scope })
    res.clearCookie(names.permissions, { path: MIRROR_COOKIE_PATH, ...scope })
  }
}

function clearAuthCookies(res: Response, audience: TokenAudience) {
  expireCookies(res, audience, [liveScope(), ...staleScopes()])
}

/**
 * Dipanggil SEBELUM cookie segar dipasang (login & rotasi). Set-Cookie diterapkan browser
 * berurutan (res.clearCookie/res.cookie meng-append), dan liveScope tidak disentuh.
 */
function clearShadowCookies(res: Response, audience: TokenAudience) {
  expireCookies(res, audience, staleScopes())
}

/** Cookie non-httpOnly dipakai middleware Next untuk gate route sebelum render. */
function setSessionCookies(res: Response, user: UserWithRelations, permissions: string[], audience: TokenAudience) {
  const names = COOKIES[audience]
  res.cookie(names.role, user.role?.name ?? CUSTOMER_ROLE_LABEL, mirrorCookieOptions())
  res.cookie(names.permissions, encodeURIComponent(JSON.stringify(permissions)), mirrorCookieOptions())
}

function publicUser(user: UserWithRelations, permissions: string[]) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role?.name ?? null,
    permissions,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null
  }
}

// ===== Helper sesi =====

/**
 * Jendela toleransi rotasi. Dua tab (atau dua request) yang memulihkan sesi hampir bersamaan
 * mengirim token yang SAMA; yang kalah tiba sepersekian detik setelah token itu dirotasi. Begitu
 * juga balasan rotasi yang hilang (navigasi membatalkan fetch refresh; server sudah merotasi).
 * Itu balapan biasa, bukan pencurian — tanpa toleransi ini, membuka dua tab sekaligus mencabut
 * semua sesi pelanggan.
 */
const ROTATION_GRACE_MS = 30_000

/**
 * Token revoked yang dicabut di luar jendela toleransi. Saat rotasi, lastUsedAt token lama diisi
 * waktu pencabutannya; token yang baru dicabut WAJIB tetap ada selama jendela itu, kalau tidak
 * request paralel yang masih membawanya mendapat "tidak ditemukan" dan cookie-nya dihapus.
 */
const staleRevoked = () => ({ revoked: true, lastUsedAt: { lt: new Date(Date.now() - ROTATION_GRACE_MS) } })

/**
 * Buang token expired/revoked, lalu paksa batas MAX_SESSIONS.
 * Batasnya PER AUDIENCE: login di panel staff tidak boleh menendang sesi
 * customer milik orang yang sama di situs publik.
 */
async function pruneAndEnforce(userId: string, audience: TokenAudience) {
  await prismaClient.refreshToken.deleteMany({
    where: { userId, audience, OR: [{ expiresAt: { lt: new Date() } }, staleRevoked()] }
  })

  const active = await prismaClient.refreshToken.findMany({
    where: { userId, audience, revoked: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, familyId: true }
  })

  // Dihitung per family (= satu sesi device), bukan per baris: refresh paralel dan token saudara dari
  // jalur toleransi menambah baris hidup di family yang sama, dan tidak boleh menendang device lain.
  // Kunci family lama yang null = id barisnya sendiri.
  const sessions = [...new Set(active.map((row) => row.familyId ?? row.id))]
  if (sessions.length >= MAX_SESSIONS) {
    const evicted = sessions.slice(MAX_SESSIONS - 1)
    await prismaClient.refreshToken.deleteMany({ where: { userId, audience, OR: [{ familyId: { in: evicted } }, { id: { in: evicted } }] } })
  }
}

// ---------------------------------------------------------------------------
// 1. LOGIN (email + password)
// ---------------------------------------------------------------------------

export const loginAuth = async (request: unknown, audience: TokenAudience, ipAddress: string | null, userAgent: string | null, res: Response) => {
  const validated = Validation.validate(AuthValidation.LOGIN, request)
  const email = validated.email.trim().toLowerCase()

  const user = await prismaClient.user.findUnique({ where: { email }, include: { role: true } })
  // Pesan yang sama untuk email tidak terdaftar dan password salah: jangan
  // membocorkan email mana yang punya akun.
  if (!user) throw new ResponseError(401, 'Email atau password salah', 'UNAUTHENTICATED')
  if (user.isLocked) throw new ResponseError(403, 'Akun terkunci. Hubungi administrator.', 'FORBIDDEN')

  // password NULL = akun yang hanya punya Google OAuth dan belum pernah
  // menetapkan password lokal. Perlakukan seperti password salah — TANPA
  // memanggil bcrypt dengan null — supaya tidak membocorkan cara akun itu
  // dibuat. Jalur keluarnya adalah "lupa password", yang menetapkan password
  // lokal untuk akun itu.
  if (!user.password || !bcrypt.compareSync(validated.password, user.password)) {
    const failedLogins = user.failedLogins + 1
    await prismaClient.user.update({ where: { id: user.id }, data: { failedLogins, isLocked: failedLogins >= MAX_FAILED_LOGINS } })
    throw new ResponseError(401, 'Email atau password salah', 'UNAUTHENTICATED')
  }

  // Customer tidak boleh masuk lewat panel staff. Kebalikannya dibiarkan:
  // staff yang membuka situs publik memang sekadar pengunjung biasa di sana.
  if (audience === 'staff' && !user.role) throw new ResponseError(403, 'Akun ini tidak punya akses ke panel staff', 'FORBIDDEN')

  if (user.failedLogins > 0) {
    await prismaClient.user.update({ where: { id: user.id }, data: { failedLogins: 0 } })
  }

  return issueSession(user, audience, ipAddress, userAgent, res, 'Login')
}

/**
 * Terbitkan sesi customer. Dipakai registration-services (register) dan
 * google-services (callback) supaya keduanya menghasilkan sesi yang identik
 * bentuknya dengan hasil login biasa. Sengaja dikunci ke audience 'customer':
 * tidak ada satu pun jalur pendaftaran mandiri yang boleh mencetak sesi staff.
 */
export async function issueCustomerSession(
  user: UserWithRelations,
  ipAddress: string | null,
  userAgent: string | null,
  res: Response,
  reason: string
) {
  return issueSession(user, 'customer', ipAddress, userAgent, res, reason)
}

/**
 * Terbitkan sesi baru: pangkas sesi lama, cetak access token, simpan refresh
 * token, pasang cookie. Dipakai loginAuth, registerAuth, dan googleCallback —
 * ketiganya harus menghasilkan sesi yang identik bentuknya, dan menduplikasi
 * blok ini adalah cara yang rapi untuk membuat salah satunya diam-diam berbeda.
 */
async function issueSession(
  user: UserWithRelations,
  audience: TokenAudience,
  ipAddress: string | null,
  userAgent: string | null,
  res: Response,
  reason: string
) {
  await pruneAndEnforce(user.id, audience)

  const permissions = user.role ? await getPermissionsByRole(user.role.name) : []
  const accessToken = signAccessToken({ userId: user.id, role: user.role?.name ?? null }, audience)

  const refreshPlain = createRefreshToken()
  await prismaClient.refreshToken.create({
    data: {
      userId: user.id,
      audience,
      tokenHash: hashToken(refreshPlain),
      expiresAt: new Date(Date.now() + REFRESH_EXPIRES * 1000),
      familyId: randomUUID(),
      ipAddress,
      userAgent
    }
  })

  clearShadowCookies(res, audience)
  res.cookie(COOKIES[audience].refresh, refreshPlain, refreshCookieOptions())
  setSessionCookies(res, user, permissions, audience)
  logger.info(`${reason} sukses (${audience}): ${user.email}`)

  return { accessToken, user: publicUser(user, permissions) }
}

// ---------------------------------------------------------------------------
// 2. REFRESH (rotasi + reuse detection)
// ---------------------------------------------------------------------------

const isLive = (row: RefreshToken, audience: TokenAudience, now: Date) => !row.revoked && row.expiresAt > now && row.audience === audience

/**
 * Baris hidup di family (sesi device) token yang dicabut DI DALAM jendela toleransi, atau null.
 * Jendela dihitung dari pengganti PERTAMA (= saat token ini dicabut), bukan dari ujung rantai:
 * kalau dari ujung, token curian lama lolos selamanya selama pemilik aslinya rajin merotasi.
 * Maksimal dua query per nilai cookie — tanpa jalan hop per hop yang panjangnya bisa diatur klien.
 */
async function liveTipWithinGrace(row: RefreshToken, audience: TokenAudience, now: Date): Promise<RefreshToken | null> {
  if (!row.revoked || !row.replacedBy) return null
  const first = await prismaClient.refreshToken.findUnique({ where: { id: row.replacedBy } })
  if (!first || now.getTime() - first.createdAt.getTime() > ROTATION_GRACE_MS) return null
  if (isLive(first, audience, now)) return first
  if (!first.familyId) return null
  return prismaClient.refreshToken.findFirst({
    where: { userId: first.userId, familyId: first.familyId, audience, revoked: false, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * `tokens` = SEMUA nilai cookie refresh audience ini di header Cookie. Browser bisa membawa lebih dari
 * satu (sisa cookie ber-Domain lama + cookie host-only baru, path sama, yang tertua dikirim duluan).
 */
export const refreshAuth = async (tokens: string[], audience: TokenAudience, ipAddress: string | null, res: Response) => {
  if (tokens.length === 0) {
    // Cookie penanda (role) tanpa cookie refresh membuat middleware Next mengira masih ada sesi.
    clearAuthCookies(res, audience)
    throw new ResponseError(401, 'Sesi tidak ditemukan. Silakan masuk kembali.', 'UNAUTHENTICATED')
  }

  const now = new Date()
  const hashes = tokens.map(hashToken)
  const found = await prismaClient.refreshToken.findMany({ where: { tokenHash: { in: hashes } } })
  const rows = hashes.flatMap((hash) => found.filter((row) => row.tokenHash === hash))

  // Pilih nilai yang bisa melanjutkan sesi: yang hidup, lalu yang baru dirotasi dan penggantinya
  // hidup. Nilai lain (sisa cookie lama) tidak boleh memicu reuse detection atau menghapus cookie
  // yang hidup. Bila tidak ada, semantik satu token berlaku untuk nilai pertama yang dikenal DB —
  // reuse dengan satu cookie tetap terdeteksi.
  let stored = rows.find((row) => isLive(row, audience, now))
  let tip = stored ?? null
  if (!stored) {
    for (const row of rows) {
      tip = await liveTipWithinGrace(row, audience, now)
      if (tip) {
        stored = row
        break
      }
    }
    stored ??= rows[0]
  }

  if (!stored) {
    clearAuthCookies(res, audience)
    throw new ResponseError(401, 'Sesi tidak valid. Silakan masuk kembali.', 'UNAUTHENTICATED')
  }

  // Audience WAJIB cocok (R4): refresh token customer yang diputar ulang di
  // endpoint staff tidak boleh mencetak access token staff. Cookie host-only
  // membuat itu sulit terjadi; cek inilah yang membuatnya mustahil.
  if (stored.audience !== audience) {
    logger.warn(`AUDIENCE_MISMATCH token=${stored.audience} diminta=${audience} userId=${stored.userId}`)
    await prismaClient.refreshToken.delete({ where: { id: stored.id } })
    clearAuthCookies(res, audience)
    throw new ResponseError(401, 'Sesi tidak valid. Silakan masuk kembali.', 'UNAUTHENTICATED')
  }

  if (stored.expiresAt <= now) {
    await prismaClient.refreshToken.delete({ where: { id: stored.id } })
    clearAuthCookies(res, audience)
    throw new ResponseError(401, 'Sesi kedaluwarsa. Silakan masuk kembali.', 'UNAUTHENTICATED')
  }

  // Token sudah dirotasi, di luar jendela toleransi (atau rantainya buntu), dipakai lagi = kemungkinan
  // dicuri. Hapus SEMUA sesi user di kedua audience: kalau satu device dikompromikan, memaksa login
  // ulang hanya di satu sisi bukan jawaban.
  if (stored.revoked && !tip) {
    logger.warn(`TOKEN_REUSE_DETECTED userId=${stored.userId} audience=${audience} ip=${ipAddress ?? '-'}`)
    await prismaClient.refreshToken.deleteMany({ where: { userId: stored.userId } })
    clearAuthCookies(res, audience)
    throw new ResponseError(401, 'Token dipakai ulang — semua sesi dicabut. Silakan masuk kembali.', 'UNAUTHENTICATED')
  }

  const user = await prismaClient.user.findUnique({ where: { id: stored.userId }, include: { role: true } })
  if (!user) {
    clearAuthCookies(res, audience)
    throw new ResponseError(404, 'Akun tidak ditemukan', 'NOT_FOUND')
  }

  if (user.isLocked) {
    await prismaClient.refreshToken.deleteMany({ where: { userId: user.id } })
    clearAuthCookies(res, audience)
    throw new ResponseError(403, 'Akun terkunci. Hubungi administrator.', 'FORBIDDEN')
  }

  // Role staff bisa dicabut setelah token terbit — periksa ulang tiap rotasi.
  if (audience === 'staff' && !user.role) {
    await prismaClient.refreshToken.deleteMany({ where: { userId: user.id, audience } })
    clearAuthCookies(res, audience)
    throw new ResponseError(403, 'Akun ini tidak punya akses ke panel staff', 'FORBIDDEN')
  }

  // Jalur hidup: rotasi token yang dikirim. Jalur toleransi (yang dikirim baru saja dirotasi: tab lain
  // menang, atau balasan rotasinya hilang karena navigasi membatalkan fetch): cetak token SAUDARA di
  // family `tip` TANPA mencabut baris mana pun. Setiap token yang mungkin dipegang browser — dari
  // balasan yang sampai maupun yang hilang — tetap hidup; balasan ini tetap membawa cookie token hidup.
  // Baris hidup ekstra di satu family dihitung sebagai satu sesi (pruneAndEnforce) dan ikut terhapus
  // saat logout family itu.
  const source = tip ?? stored
  const newPlain = createRefreshToken()
  const data = {
    userId: source.userId,
    audience,
    tokenHash: hashToken(newPlain),
    expiresAt: new Date(Date.now() + REFRESH_EXPIRES * 1000),
    familyId: source.familyId || randomUUID(),
    ipAddress: ipAddress || source.ipAddress,
    userAgent: source.userAgent,
    lastUsedAt: new Date()
  }
  if (stored.revoked) {
    await prismaClient.refreshToken.create({ data })
  } else {
    await prismaClient.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({ data })
      // Token lama ditandai revoked (bukan dihapus) supaya reuse terdeteksi; lastUsedAt = saat dicabut (staleRevoked).
      await tx.refreshToken.update({ where: { id: stored.id }, data: { revoked: true, replacedBy: created.id, lastUsedAt: new Date() } })
    })
  }

  // Sisakan token revoked yang dikirim (stored.id) sebagai umpan reuse detection, plus yang masih di
  // jendela toleransi — request paralel mungkin masih membawanya.
  await prismaClient.refreshToken.deleteMany({
    where: { userId: stored.userId, audience, id: { not: stored.id }, OR: [staleRevoked(), { expiresAt: { lt: new Date() } }] }
  })

  const permissions = user.role ? await getPermissionsByRole(user.role.name) : []
  const accessToken = signAccessToken({ userId: user.id, role: user.role?.name ?? null }, audience)

  clearShadowCookies(res, audience)
  res.cookie(COOKIES[audience].refresh, newPlain, refreshCookieOptions())
  setSessionCookies(res, user, permissions, audience)

  return { accessToken, user: publicUser(user, permissions) }
}

// ---------------------------------------------------------------------------
// 3. LOGOUT (hapus family sesi device ini; device lain tetap login)
// ---------------------------------------------------------------------------

export const logoutAuth = async (tokens: string[], audience: TokenAudience, res: Response) => {
  // Semua nilai yang dikirim browser ini (termasuk sisa cookie ber-Domain lama) ikut di-logout.
  const rows = tokens.length ? await prismaClient.refreshToken.findMany({ where: { tokenHash: { in: tokens.map(hashToken) }, audience } }) : []
  if (rows.length) {
    const families = rows.flatMap((row) => (row.familyId ? [row.familyId] : []))
    await prismaClient.refreshToken.deleteMany({ where: { OR: [{ familyId: { in: families } }, { id: { in: rows.map((row) => row.id) } }] } })
  }

  // Cookie tetap dibersihkan walau token tidak ditemukan: logout tidak pernah gagal.
  clearAuthCookies(res, audience)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 4. SESSION MANAGEMENT (multi-device, dalam audience yang sama)
// ---------------------------------------------------------------------------

export const getActiveSessions = async (userId: string, audience: TokenAudience) =>
  prismaClient.refreshToken.findMany({
    where: { userId, audience, revoked: false, expiresAt: { gt: new Date() } },
    select: { id: true, ipAddress: true, userAgent: true, createdAt: true, lastUsedAt: true },
    orderBy: { lastUsedAt: 'desc' }
  })

export const revokeSession = async (userId: string, sessionId: string, audience: TokenAudience) => {
  const session = await prismaClient.refreshToken.findFirst({ where: { id: sessionId, userId, audience, revoked: false } })
  if (!session) throw new ResponseError(404, 'Sesi tidak ditemukan', 'NOT_FOUND')

  if (session.familyId) await prismaClient.refreshToken.deleteMany({ where: { familyId: session.familyId } })
  else await prismaClient.refreshToken.delete({ where: { id: sessionId } })

  return { ok: true }
}

export const forceLogoutAll = async (userId: string, audience: TokenAudience) => {
  await prismaClient.refreshToken.deleteMany({ where: { userId, audience } })
  return { ok: true }
}

// ============================================================================
// === TODO FASE 1 — endpoint auth yang belum ada di file ini ===
// ============================================================================
// - registerAuth()           : pendaftaran customer (name, email, phone,
//                              password). Terbitkan EmailVerificationToken;
//                              belum boleh login sebelum emailVerifiedAt terisi.
// - verifyEmailAuth()        : konsumsi EmailVerificationToken sekali pakai
//                              (kolom usedAt), lalu isi User.emailVerifiedAt.
// - resendVerificationAuth() : terbitkan token baru, cabut yang lama.
// - forgotPasswordAuth()     : terbitkan PasswordResetToken + kirim email.
//                              Balasan SELALU sukses apa pun hasilnya — jangan
//                              membocorkan email mana yang terdaftar.
// - resetPasswordAuth()      : tukar token dengan password baru, lalu cabut
//                              seluruh refresh token user di kedua audience.
// - googleRedirect() / googleCallback() : OAuth customer. Account linking by
//                              email, normalisasi avatar =s<angka>(-c) menjadi
//                              =s256-c, email otomatis terverifikasi. Akun
//                              hasil Google tidak punya password lokal, jadi
//                              User.password menjadi nullable di skema Fase 1.
// - Semua pengiriman email lewat void sendMailSafe() SETELAH commit dan DI LUAR
//   $transaction, dicatat ke tabel email_log (R8).
// - CSRF: boilerplate menaruh csrf_token di cookie. Belum diikutkan karena
//   access token UBSC hidup di memori JS (bukan cookie) dan cookie refresh
//   sudah SameSite=Lax + Path=/api/auth. Tinjau ulang begitu ada endpoint tulis
//   yang bergantung cookie saja.
// - Rate limit yang boilerplate tidak punya: login 5/menit, register 6/menit,
//   password 5/menit. Pastikan X-Forwarded-For benar-benar sampai ke Express
//   lebih dulu — kalau tidak, limitnya menjadi global dan 5 percobaan gagal
//   mengunci seluruh situs (R18).
// ============================================================================
