import { z } from 'zod'
import { isValidDateString, jakartaDate } from '../utils/clock'

// ===== Validasi profil akun customer yang sedang login — Fase 6 =====
// Port dari App\Http\Requests\ProfileUpdateRequest (dipakai ProfileController::update),
// ProfileController::submitIdentity(), ProfileController::destroy(), dan
// Auth\PasswordController::update() — TAPI camelCase di kabel (birth_place -> birthPlace,
// identity_file -> identityFile, current_password -> currentPassword, dst).
//
// Bedanya dengan StaffProfileValidation (Fase 8G): ProfileUpdateRequest yang SAMA memuat dua kolom
// profil CUSTOMER — `birth_place` dan `birth_date` — yang sengaja dibuang di layar staff karena
// StaffProfileDto tidak merendernya. Di sini keduanya justru inti layarnya (ProfileModal.tsx), jadi
// keduanya ikut. Aturan `name`, `email`, dan `avatar` PERSIS sama dan memang harus sama: sumbernya
// satu FormRequest yang sama.
//
// PROFILE dan IDENTITY tiba sebagai multipart, jadi seluruh field non-berkas sampai sebagai STRING.
// Tidak ada angka maupun boolean di sini sehingga tidak ada koersi yang perlu dilakukan.
//
// Aturan yang menyentuh DATABASE atau ISI BERKAS tidak di sini:
//   - `Rule::unique('users')->ignore(...)`  -> services/staff-profile-services.updateStaffProfile()
//   - `current_password`                    -> services/staff-profile-services (password & destroy)
//   - `image|mimes:...` avatar              -> inspectAvatar() di staff-profile-services
//   - `file|mimes:jpeg,jpg,png,webp,pdf`    -> storeIdentityDocument() di customer-profile-services
//     (isi berkas diperiksa, BUKAN Content-Type yang ditulis klien — alasan yang sama dengan
//     middleware/upload-middleware.ts)

/**
 * Padanan middleware global Laravel TrimStrings + ConvertEmptyStringsToNull untuk satu field
 * `nullable|string`: dipangkas dulu, lalu string kosong menjadi null.
 *
 * Ini bukan kenyamanan, melainkan syarat paritas: FE (ProfileModal.tsx) SELALU mengirim
 * `birthPlace` dan `birthDate` — berisi '' saat kosong. Tanpa konversi ini '' akan tersimpan sebagai
 * string kosong di kolom yang di Laravel berisi NULL, dan `date` akan menolak '' alih-alih
 * melewatkannya.
 */
const nullableTrimmed = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, { error: tooLong })
    .transform((value) => (value === '' ? null : value))
    .nullable()

/**
 * `string|lowercase|email|max:255`.
 *
 * PENYIMPANGAN YANG DISENGAJA pada `lowercase`, identik dengan emailField di
 * staff-profile-validation.ts: aturan Laravel MENOLAK alamat yang belum huruf kecil, di sini
 * alamatnya DINORMALKAN. Seluruh jalur auth repo ini sudah menormalkan; dua aturan email yang
 * berbeda di satu produk lebih buruk daripada satu penolakan yang hilang.
 */
const emailField = z
  .email({ error: 'Format email tidak valid.' })
  .max(255, { error: 'Email maksimal 255 karakter.' })
  .transform((value) => value.trim().toLowerCase())

/**
 * `nullable|date|before_or_equal:today`.
 *
 * Bentuknya dipersempit menjadi 'YYYY-MM-DD' saja, bukan seluruh bentuk yang diterima strtotime().
 * Itu satu-satunya bentuk yang bisa dihasilkan <input type="date"> di ProfileModal.tsx, dan kolomnya
 * `@db.Date` yang memang hanya menyimpan tanggal kalender. isValidDateString() menolak tanggal yang
 * bentuknya benar tapi tidak ada (2026-02-30).
 *
 * `today` dihitung di Asia/Jakarta lewat jakartaDate(), BUKAN dari TZ proses — aturan R13
 * (utils/clock.ts). Perbandingan string 'YYYY-MM-DD' sudah setara perbandingan tanggal.
 */
const birthDateField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine((value) => value === null || isValidDateString(value), { error: 'Tanggal lahir tidak valid. Gunakan format YYYY-MM-DD.' })
  .refine((value) => value === null || value <= jakartaDate(), { error: 'Tanggal lahir tidak boleh melewati hari ini.' })

/**
 * `Password::defaults()`. AppServiceProvider aplikasi Laravel tidak menyetelnya, jadi yang berlaku
 * bawaan Laravel: minimal 8 karakter. Batas atas 100 mengikuti newPasswordField di
 * auth-validation.ts dan staff-profile-validation.ts.
 */
const newPasswordField = z
  .string({ error: 'Password wajib diisi.' })
  .min(8, { error: 'Password minimal 8 karakter.' })
  .max(100, { error: 'Password maksimal 100 karakter.' })

/** `regex:/^[A-Za-z0-9.\/-]+$/` — huruf, angka, titik, garis miring, strip. */
const IDENTITY_NUMBER_PATTERN = /^[A-Za-z0-9./-]+$/

export class CustomerProfileValidation {
  /**
   * POST /api/customer/profile (multipart; `avatar` opsional).
   *
   * `email` memakai `sometimes|required`: field yang TIDAK dikirim membiarkan alamat lama apa adanya.
   * ProfileModal.tsx memang TIDAK mengirimnya, jadi pada praktiknya cabang ini tidak pernah aktif dari
   * UI — tapi aturannya ada di ProfileUpdateRequest dan membuangnya berarti endpoint ini menolak
   * sesuatu yang Laravel terima. CustomerProfilePayload di shared/contracts.ts sengaja hanya memuat
   * tiga field yang benar-benar dikirim FE; `email` di sini adalah SUPERSET demi paritas Laravel.
   *
   * `birthPlace` / `birthDate` memakai `.optional()` agar padanan `array_key_exists()` Laravel tetap
   * berlaku: absen -> kolomnya tidak disentuh sama sekali, '' -> null, terisi -> ditulis.
   *
   * Field tak dikenal DIBUANG diam-diam (perilaku bawaan z.object), termasuk `_method=patch` yang
   * ikut dikirim FormData ProfileModal.tsx sebagai sisa method spoofing Laravel.
   */
  static readonly PROFILE = z.object({
    name: z.string({ error: 'Nama wajib diisi.' }).trim().min(1, { error: 'Nama wajib diisi.' }).max(255, { error: 'Nama maksimal 255 karakter.' }),
    email: emailField.optional(),
    birthPlace: nullableTrimmed(100, 'Tempat lahir maksimal 100 karakter.').optional(),
    birthDate: birthDateField.optional()
  })

  /**
   * PUT /api/customer/password — `current_password` + `Password::defaults()` + `confirmed`.
   *
   * Bentuknya SENGAJA identik dengan StaffProfileValidation.PASSWORD: sumbernya satu controller yang
   * sama (Auth\PasswordController::update, routes/auth.php:65) yang melayani kedua audience. Skema ini
   * ada di sini hanya sebagai dokumentasi bentuk CustomerPasswordPayload; penegakannya tetap satu,
   * lewat updateStaffPassword() (lihat catatan pemakaian ulang di customer-profile-services.ts).
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

  /**
   * POST /api/customer/identity (multipart; berkas di field `identityFile`).
   *
   * Pesan-pesannya disalin apa adanya dari array $messages ProfileController::submitIdentity(); yang
   * tidak punya pesan khusus di sana (min:5, max:50, in:) ditulis dalam gaya yang sama.
   *
   * `identityCategory` dikunci ke satu nilai (`Rule::in(['warga_kampus'])`) — satu-satunya kategori
   * yang masuk akal DIAJUKAN. 'umum' adalah keadaan bawaan, bukan sesuatu yang perlu diverifikasi.
   *
   * Berkasnya TIDAK divalidasi di sini: multer sudah memisahkannya dari req.body, dan keberadaan
   * (`required`) maupun jenisnya (`mimes`) diperiksa service atas ISI berkas.
   */
  static readonly IDENTITY = z.object({
    identityCategory: z.literal('warga_kampus', { error: 'Kategori identitas tidak valid.' }),
    identityNumber: z
      .string({ error: 'Isi NIM / NIP / nomor identitas kampus Anda.' })
      .trim()
      .min(1, { error: 'Isi NIM / NIP / nomor identitas kampus Anda.' })
      .min(5, { error: 'Nomor identitas minimal 5 karakter.' })
      .max(50, { error: 'Nomor identitas maksimal 50 karakter.' })
      .regex(IDENTITY_NUMBER_PATTERN, { error: 'Nomor identitas hanya boleh huruf, angka, titik, garis miring, dan strip.' })
  })

  /** DELETE /api/customer/profile — `password` wajib dan harus cocok (dicek service). */
  static readonly ACCOUNT_DELETE = z.object({
    password: z.string({ error: 'Password wajib diisi.' }).min(1, { error: 'Password wajib diisi.' })
  })
}

export type CustomerProfileInput = z.infer<typeof CustomerProfileValidation.PROFILE>
export type CustomerIdentityInput = z.infer<typeof CustomerProfileValidation.IDENTITY>
