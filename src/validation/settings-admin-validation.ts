import { z } from 'zod'
import { ADMINISTRATOR_ROLE } from '../config/permissions'

// ===== Validasi pengaturan sistem: Role & Access + Pengguna Internal (Fase 8G) =====
// Port aturan $request->validate() di Admin\RoleController::update dan Admin\UserController::store/update.
// Nama field camelCase; pesan bahasa Indonesia supaya errorMiddleware bisa memetakannya ke
// error.fields dan applyApiErrors() menempelkannya ke input form.
//
// Seperti berkas validasi lain di repo ini, schema di sini hanya memeriksa BENTUK data. Aturan yang
// menyentuh database — `exists:permissions,name` dan `unique:users,email` — dicek di service
// (settings-admin-services.ts), bukan di sini.

/**
 * Nama yang tidak boleh dipakai role buatan panel (dibandingkan tanpa beda huruf besar-kecil):
 *   - Administrator: satu-satunya role ber-bypass, dikenali dari NAMA-nya (isAdministrator).
 *   - Customer: label cookie sesi pelanggan (CUSTOMER_ROLE_LABEL di auth-services) — role staf bernama
 *     sama hanya membingungkan.
 */
const RESERVED_ROLE_NAMES = [ADMINISTRATOR_ROLE, 'Customer'].map((name) => name.toLowerCase())

/**
 * Nama role buatan panel. Spasi di tengah dirapikan jadi satu supaya 'Staff  Gudang' dan 'Staff Gudang'
 * tidak menjadi dua role. Karakter dibatasi huruf/angka/spasi dan sedikit tanda baca karena nama role
 * ikut menjadi segmen URL (PUT/PATCH/DELETE /api/admin/settings/roles/:name) dan nilai cookie ubsc_s_role.
 */
const roleNameField = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value),
  z
    .string({ error: 'Nama role wajib diisi.' })
    .min(2, { error: 'Nama role minimal 2 karakter.' })
    .max(50, { error: 'Nama role maksimal 50 karakter.' })
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} &().'-]*$/u, { error: "Nama role hanya boleh berisi huruf, angka, spasi, dan tanda & ( ) . ' -" })
    .refine((value) => !RESERVED_ROLE_NAMES.includes(value.toLowerCase()), { error: 'Nama role ini dipakai sistem. Pilih nama lain.' })
)

/** Daftar kode permission; `exists:permissions` dicek service per-index (permissions.0, permissions.1, ...). */
const permissionCodesField = z
  .array(z.string({ error: 'Hak akses tidak valid.' }).trim().min(1, { error: 'Hak akses tidak valid.' }), {
    error: 'Daftar hak akses tidak valid.'
  })
  .min(1, { error: 'Pilih minimal satu hak akses.' })

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

/**
 * Nama role tujuan akun staf. Daftar role kini ada di tabel roles (bisa ditambah dari Role & Access), jadi
 * keberadaannya — dan larangan memberi role Administrator — dicek service (internalRoleIdFor).
 */
const roleField = z.string({ error: 'Role wajib dipilih.' }).trim().min(1, { error: 'Role wajib dipilih.' }).max(50, { error: 'Role tidak valid.' })

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
    permissions: permissionCodesField
  })

  /**
   * POST /api/admin/settings/roles — role baru (BARU 2026-10-20, tidak ada di Laravel). Minimal satu hak
   * akses, sama dengan update: role tanpa baris role_permissions jatuh ke default shared/permissions.ts
   * menurut NAMA-nya, dan role baru yang kebetulan bernama sama dengan role bawaan yang pernah dihapus akan
   * diam-diam mewarisi hak akses bawaannya.
   */
  static readonly ROLE_CREATE = z.object({
    name: roleNameField,
    permissions: permissionCodesField
  })

  /** PATCH /api/admin/settings/roles/:name — ganti nama role. */
  static readonly ROLE_RENAME = z.object({
    name: roleNameField
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
