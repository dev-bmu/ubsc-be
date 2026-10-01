import { z } from 'zod'

// ===== Validasi profil akun staff yang sedang login — Fase 8G =====
// Port dari App\Http\Requests\ProfileUpdateRequest (dipakai ProfileController::update),
// Auth\PasswordController::update, dan ProfileController::destroy — TAPI camelCase di kabel
// (current_password -> currentPassword, password_confirmation -> passwordConfirmation).
//
// Ketiga endpoint-nya menyentuh AKUN PEMANGGIL SENDIRI, jadi tidak ada gate permission sama sekali;
// yang berlaku hanya autentikasi staff di level router. Lihat routes/details/admin-profile.ts.
//
// PROFILE tiba sebagai multipart (field `avatar` boleh ikut), jadi seluruh field non-berkas sampai
// sebagai STRING — sama seperti news-admin-validation.ts. Di sini tidak ada angka maupun boolean,
// sehingga tidak ada koersi yang perlu dilakukan.
//
// Aturan yang menyentuh database — `Rule::unique('users')->ignore($this->user()->id)` dan
// `current_password` — TIDAK di sini melainkan di service, dengan 422 yang menempel ke field-nya.
// Berkas avatar juga divalidasi di service (isi berkas, bukan Content-Type klien), persis alasan
// yang ditulis middleware/upload-middleware.ts.

/**
 * `string|lowercase|email|max:255`.
 *
 * PENYIMPANGAN YANG DISENGAJA pada `lowercase`: aturan Laravel itu MENOLAK alamat yang belum huruf
 * kecil, sedangkan di sini alamatnya DINORMALKAN. Alasannya konsistensi, bukan kemalasan — seluruh
 * jalur auth repo ini (emailField di auth-validation.ts, dipakai login/register/forgot) sudah
 * menormalkan, dan kolom email dicocokkan sebagai huruf kecil di mana-mana. Kalau endpoint ini
 * menolak 'Nama@Ubs.ac.id' sementara halaman login menerimanya, yang lahir bukan kesetiaan
 * melainkan dua aturan email yang berbeda di satu produk.
 */
const emailField = z
  .email({ error: 'Format email tidak valid.' })
  .max(255, { error: 'Email maksimal 255 karakter.' })
  .transform((value) => value.trim().toLowerCase())

/**
 * `Password::defaults()`. AppServiceProvider aplikasi Laravel TIDAK memanggil Password::defaults(...)
 * untuk menyetel apa pun (dicek: satu-satunya kemunculan Password::defaults ada di tiga controller
 * yang MEMAKAINYA), jadi yang berlaku adalah bawaan Laravel: minimal 8 karakter, tanpa syarat
 * campuran huruf/angka. Batas atas 100 karakter mengikuti newPasswordField di auth-validation.ts.
 */
const newPasswordField = z
  .string({ error: 'Password wajib diisi.' })
  .min(8, { error: 'Password minimal 8 karakter.' })
  .max(100, { error: 'Password maksimal 100 karakter.' })

export class StaffProfileValidation {
  /**
   * PATCH /api/admin/profile
   *
   * `email` memakai `sometimes|required`: field yang TIDAK dikirim membiarkan alamat lama apa adanya,
   * sedangkan field yang dikirim wajib valid. Di Zod itu `.optional()` — absen menjadi undefined, dan
   * service memakai `!== undefined` sebagai padanan array_key_exists() Laravel.
   *
   * `birth_place` / `birth_date` milik ProfileUpdateRequest SENGAJA tidak ikut: keduanya kolom profil
   * CUSTOMER (StaffProfileDto tidak memuatnya) dan layar profil staff tidak pernah mengirimnya.
   * Menerimanya di sini hanya membuka jalur tulis ke kolom yang tidak dirender di mana pun.
   */
  static readonly PROFILE = z.object({
    name: z.string({ error: 'Nama wajib diisi.' }).trim().min(1, { error: 'Nama wajib diisi.' }).max(255, { error: 'Nama maksimal 255 karakter.' }),
    email: emailField.optional()
  })

  /**
   * PUT /api/admin/profile/password — `current_password` + `Password::defaults()` + `confirmed`.
   *
   * Kecocokan `currentPassword` dengan hash yang tersimpan ditegakkan service (butuh database);
   * di sini ia hanya wajib terisi. `confirmed` menjadi .refine() dengan path ke passwordConfirmation
   * supaya pesannya menempel ke input konfirmasi, persis REGISTER di auth-validation.ts.
   */
  static readonly PASSWORD = z
    .object({
      currentPassword: z.string({ error: 'Password saat ini wajib diisi.' }).min(1, { error: 'Password saat ini wajib diisi.' }),
      password: newPasswordField,
      passwordConfirmation: z.string({ error: 'Konfirmasi password wajib diisi.' }).min(1, { error: 'Konfirmasi password wajib diisi.' })
    })
    .refine((data) => data.password === data.passwordConfirmation, {
      error: 'Konfirmasi password tidak cocok.',
      path: ['passwordConfirmation']
    })

  /** DELETE /api/admin/profile — `password` wajib dan harus cocok (dicek service). */
  static readonly ACCOUNT_DELETE = z.object({
    password: z.string({ error: 'Password wajib diisi.' }).min(1, { error: 'Password wajib diisi.' })
  })
}

export type StaffProfileInput = z.infer<typeof StaffProfileValidation.PROFILE>
export type StaffPasswordInput = z.infer<typeof StaffProfileValidation.PASSWORD>
