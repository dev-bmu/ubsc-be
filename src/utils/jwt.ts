import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken'
import { ACCESS_TOKEN_EXPIRES, ACCESS_TOKEN_SECRET, CUSTOMER_ACCESS_TOKEN_SECRET, STAFF_ACCESS_TOKEN_SECRET } from '../config'

// ===== Access token JWT — dua audience =====
// Customer (ubsportcenter.co.id) dan staff (dash.ubsportcenter.co.id) memakai
// SECRET YANG BERBEDA, bukan sekadar klaim yang berbeda. Token customer secara
// kriptografis tidak bisa diverifikasi di route staff, dan sebaliknya (R4).
// Klaim aud adalah lapis kedua: tetap dicek saat verify supaya salah pasang
// secret di konfigurasi tidak diam-diam lolos.

export type TokenAudience = 'customer' | 'staff'

export interface AccessPayload {
  userId: string
  /** null untuk customer — hanya akun staff yang punya role. */
  role: string | null
}

/**
 * Secret dipilih per audience, nilainya sudah divalidasi Zod saat boot.
 *
 * Di produksi config/env.ts sudah mewajibkan kedua secret terisi DAN berbeda,
 * jadi cabang fallback hanya berlaku di dev/test. Fallback-nya tetap diturunkan
 * per audience (bukan langsung ACCESS_TOKEN_SECRET) supaya isolasi antar
 * audience di dev sama kuatnya dengan di produksi: lupa mengisi .env tidak
 * boleh diam-diam membuat token customer valid di route staff.
 */
function secretFor(audience: TokenAudience): string {
  const configured = audience === 'customer' ? CUSTOMER_ACCESS_TOKEN_SECRET : STAFF_ACCESS_TOKEN_SECRET
  return configured ?? `${ACCESS_TOKEN_SECRET}:${audience}`
}

export function signAccessToken(payload: AccessPayload, audience: TokenAudience): string {
  const options: SignOptions = { expiresIn: ACCESS_TOKEN_EXPIRES as SignOptions['expiresIn'], audience }
  return jwt.sign(payload, secretFor(audience), options)
}

/**
 * Melempar bila tanda tangan salah, token kedaluwarsa, ATAU klaim aud tidak
 * sama dengan audience yang diminta. Pemanggil (auth-middleware) menerjemahkan
 * lemparan itu menjadi 401.
 */
export function verifyAccessToken(token: string, audience: TokenAudience): JwtPayload & AccessPayload {
  return jwt.verify(token, secretFor(audience), { audience }) as JwtPayload & AccessPayload
}
