import { randomInt } from 'crypto'

// ===== String acak =====

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Setara `Str::random($length)` Laravel: huruf besar, huruf kecil, dan angka dari CSPRNG.
 *
 * Dipakai untuk token check-in booking — token itu ADALAH tiketnya (siapa pun yang memegang QR bisa
 * masuk), jadi Math.random tidak pernah boleh dipakai di sini. randomInt sudah menolak bias modulo,
 * sehingga ke-62 karakter berpeluang sama.
 */
export function randomAlphanumeric(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]
  return out
}
