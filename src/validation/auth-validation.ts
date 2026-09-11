import { z } from 'zod'

// ===== Validasi auth =====
// Setiap pesan berbahasa Indonesia dan menempel pada field-nya, karena
// errorMiddleware memetakan ZodError menjadi error.fields = { email: [...] }
// yang dipasang applyApiErrors() ke form di sisi Next.
//
// Schema di sini SENGAJA tidak di-share ke repo Next lewat shared/ (R12): API
// memvalidasi untuk keamanan, FE untuk UX, dan aturannya memang tidak sama —
// FE tidak bisa mengecek keunikan email, API tidak perlu mengecek konfirmasi
// password di level field.

const emailField = z
  .email({ message: 'Format email tidak valid' })
  .max(190, { message: 'Email maksimal 190 karakter' })
  .transform((value) => value.trim().toLowerCase())

/**
 * Minimal 8 karakter, mengikuti aturan Laravel lama. SENGAJA hanya dipakai di
 * REGISTER dan RESET_PASSWORD, tidak di LOGIN: menaikkan batas di LOGIN akan
 * mengunci akun lama yang password-nya lebih pendek dari 8.
 */
const newPasswordField = z.string().min(8, { message: 'Password minimal 8 karakter' }).max(100, { message: 'Password maksimal 100 karakter' })

/** Token opaque 64-byte hex dari utils/token. Panjangnya tetap 128 karakter. */
const tokenField = z
  .string()
  .min(1, { message: 'Token wajib diisi' })
  .regex(/^[a-f0-9]{128}$/, { message: 'Token tidak valid' })

export class AuthValidation {
  static readonly LOGIN = z.object({
    email: emailField,
    password: z.string().min(1, { message: 'Password wajib diisi' }).max(100, { message: 'Password maksimal 100 karakter' })
  })

  static readonly REGISTER = z
    .object({
      name: z.string().trim().min(2, { message: 'Nama minimal 2 karakter' }).max(190, { message: 'Nama maksimal 190 karakter' }),
      email: emailField,
      // Nomor Indonesia: 08xxx atau +628xxx. Opsional saat daftar; wajib baru
      // saat checkout booking, di mana petugas benar-benar membutuhkannya.
      phoneNumber: z
        .string()
        .trim()
        .regex(/^(\+62|62|0)8[1-9][0-9]{6,11}$/, { message: 'Nomor HP tidak valid. Contoh: 081234567890' })
        .optional()
        .or(z.literal('').transform(() => undefined)),
      password: newPasswordField,
      passwordConfirmation: z.string().min(1, { message: 'Konfirmasi password wajib diisi' })
    })
    .refine((data) => data.password === data.passwordConfirmation, {
      message: 'Konfirmasi password tidak cocok',
      // Tanpa path, pesannya mendarat di error form-level dan tidak menempel ke
      // input mana pun — persis kelemahan envelope boilerplate yang diperbaiki.
      path: ['passwordConfirmation']
    })

  static readonly FORGOT_PASSWORD = z.object({
    email: emailField
  })

  static readonly RESET_PASSWORD = z
    .object({
      token: tokenField,
      password: newPasswordField,
      passwordConfirmation: z.string().min(1, { message: 'Konfirmasi password wajib diisi' })
    })
    .refine((data) => data.password === data.passwordConfirmation, {
      message: 'Konfirmasi password tidak cocok',
      path: ['passwordConfirmation']
    })

  static readonly RESEND_VERIFICATION = z.object({
    email: emailField
  })

  static readonly VERIFY_EMAIL = z.object({
    token: tokenField
  })
}
