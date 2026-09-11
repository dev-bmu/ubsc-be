import { z } from 'zod'

// ===== Validasi auth =====
// Setiap pesan berbahasa Indonesia dan menempel pada field-nya, karena
// errorMiddleware memetakan ZodError menjadi error.fields = { email: [...] }
// yang dipasang applyApiErrors() ke form di sisi Next.

export class AuthValidation {
  static readonly LOGIN = z.object({
    email: z.email({ message: 'Format email tidak valid' }).max(190, { message: 'Email maksimal 190 karakter' }),
    password: z.string().min(1, { message: 'Password wajib diisi' }).max(100, { message: 'Password maksimal 100 karakter' })
  })

  // TODO Fase 1: schema yang menyusul bersama endpoint-nya —
  //   REGISTER             (name, email, phone, password + konfirmasi, persetujuan syarat)
  //   FORGOT_PASSWORD      (email)
  //   RESET_PASSWORD       (token, password baru + konfirmasi)
  //   RESEND_VERIFICATION  (email)
  // Aturan password Laravel lama (min 8) ikut di-port ke REGISTER dan
  // RESET_PASSWORD, bukan ke LOGIN — menaikkan batas di LOGIN akan mengunci
  // akun lama yang password-nya lebih pendek.
}
