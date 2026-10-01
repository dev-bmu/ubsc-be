import { z } from 'zod'
import { ADMINISTRATOR_ROLE, STAFF_ROLES } from '../config/permissions'

// ===== Validasi pengaturan sistem: Role & Access + Pengguna Internal (Fase 8G) =====
// Port aturan $request->validate() di Admin\RoleController::update dan Admin\UserController::store/update.
// Nama field camelCase; pesan bahasa Indonesia supaya errorMiddleware bisa memetakannya ke
// error.fields dan applyApiErrors() menempelkannya ke input form.
//
// Seperti berkas validasi lain di repo ini, schema di sini hanya memeriksa BENTUK data. Aturan yang
// menyentuh database — `exists:permissions,name` dan `unique:users,email` — dicek di service
// (settings-admin-services.ts), bukan di sini.

/**
 * Role yang boleh DIBERIKAN dari halaman staff = `UserController::INTERNAL_ROLES` Laravel.
 *
 * Diturunkan dari STAFF_ROLES di shared/permissions.ts dikurangi Administrator, BUKAN disalin
 * sebagai literal baru: daftar role staff hanya boleh ditulis di satu tempat. Administrator sengaja
 * tidak assignable — akun Administrator dibuat lewat seeder, bukan lewat panel.
 */
export const INTERNAL_ROLES: string[] = STAFF_ROLES.filter((role) => role !== ADMINISTRATOR_ROLE)

/** Laravel TrimStrings berjalan sebelum validasi, jadi ' a@b.c ' memang sah di sana. */
const trimString = (value: unknown): unknown => (typeof value === 'string' ? value.trim() : value)

/**
 * '' / null / spasi-saja -> undefined.
 *
 * Padanan gabungan `nullable` + ConvertEmptyStringsToNull + cek falsy `$data['password'] ? ...` di
 * UserController::update: password kosong BERARTI "jangan ubah password", bukan "kosongkan password".
 */
const blankToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value

/** `required|string|max:255`. */
const nameField = z
  .string({ error: 'Nama wajib diisi.' })
  .trim()
  .min(1, { error: 'Nama wajib diisi.' })
  .max(255, { error: 'Nama maksimal 255 karakter.' })

/**
 * `required|email` (+ `unique:users,email` yang dicek service).
 *
 * Dinormalkan ke huruf kecil seperti emailField di auth-validation.ts. Laravel menyimpan email apa
 * adanya, tapi jalur login di repo ini SUDAH meng-lowercase sebelum mencari barisnya — akun staff
 * yang dibuat dengan 'Budi@Ub.ac.id' tidak akan pernah bisa login. Normalisasi di sini adalah
 * penyimpangan yang disengaja demi konsistensi satu repo, bukan kelalaian.
 *
 * max(190) mengikuti batas yang sama dengan auth-validation.ts (Laravel tidak memberi batas eksplisit).
 */
const emailField = z.preprocess(
  trimString,
  z
    .email({ error: 'Format email tidak valid.' })
    .max(190, { error: 'Email maksimal 190 karakter.' })
    .transform((value) => value.toLowerCase())
)

/** `min:8`. max(100) mengikuti newPasswordField auth-validation.ts; Laravel tidak membatasi atas. */
const passwordRules = z.string({ error: 'Password wajib diisi.' }).min(8, { error: 'Password minimal 8 karakter.' }).max(100, {
  error: 'Password maksimal 100 karakter.'
})

/** `required|in:Manager,Finance,Staff Central,Staff Front Office`. */
const roleField = z
  .string({ error: 'Role wajib dipilih.' })
  .trim()
  .refine((value) => INTERNAL_ROLES.includes(value), { error: 'Role tidak valid.' })

export class SettingsAdminValidation {
  /**
   * PUT /api/admin/settings/roles/:name
   *
   * Laravel: `permissions => ['required','array']`, `permissions.* => ['string','exists:permissions,name']`.
   * `required` pada array menolak array kosong (Validator::validateRequired menganggap [] kosong),
   * jadi min(1) di bawah bukan tambahan melainkan padanannya.
   *
   * `exists:permissions,name` TIDAK dicek di sini — service yang mencocokkannya ke Permission.code dan
   * melempar 422 per-index (`permissions.0`, `permissions.1`, ...) persis seperti kunci field Laravel.
   */
  static readonly ROLE_PERMISSIONS = z.object({
    permissions: z
      .array(z.string({ error: 'Hak akses tidak valid.' }).trim().min(1, { error: 'Hak akses tidak valid.' }), {
        error: 'Daftar hak akses tidak valid.'
      })
      .min(1, { error: 'Pilih minimal satu hak akses.' })
  })

  /** POST /api/admin/settings/users — password WAJIB. */
  static readonly STAFF_USER_CREATE = z.object({
    name: nameField,
    email: emailField,
    password: passwordRules,
    role: roleField
  })

  /** PUT /api/admin/settings/users/:id — password opsional; absen/kosong = password lama dipertahankan. */
  static readonly STAFF_USER_UPDATE = z.object({
    name: nameField,
    email: emailField,
    password: z.preprocess(blankToUndefined, passwordRules.optional()),
    role: roleField
  })
}

export type StaffUserCreateInput = z.infer<typeof SettingsAdminValidation.STAFF_USER_CREATE>
export type StaffUserUpdateInput = z.infer<typeof SettingsAdminValidation.STAFF_USER_UPDATE>
