import crypto from 'crypto'

// ===== Token acak buram (opaque) =====
// Bentuk yang sama dipakai ulang di Fase 1 untuk PasswordResetToken dan
// EmailVerificationToken: kirim plaintext ke user (cookie / tautan email),
// simpan HANYA hash-nya di DB. Bocornya dump DB tidak memberi token yang bisa
// dipakai, dan pencocokan tetap satu lookup lewat kolom tokenHash @unique.

/** Refresh token plaintext (dikirim ke browser lewat cookie httpOnly). */
export function createRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex')
}

/** Yang disimpan di DB hanya hash-nya. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}
