import { z } from 'zod'
import { isValidDateString } from '../utils/clock'

// ===== Validasi membership + paket membership (panel staff) =====
// Port aturan $request->validate() di Admin\MembershipController dan Admin\MembershipPlanController.
// Nama field camelCase; pesan bahasa Indonesia. Schema ini murni BENTUK data — aturan `exists:*`
// (user, paket) dan aturan bisnis (akun staff, overlap) dicek di service.
//
// DUA preprocessor, dan bedanya disengaja:
//   - blankToNull: field `nullable` yang boleh DIKOSONGKAN. Laravel ConvertEmptyStringsToNull membuat ''
//     menjadi null, lalu update() menulis null ke kolom. Field yang TIDAK dikirim tetap undefined dan
//     tidak menyentuh kolom (Laravel hanya mengisi $data dengan key yang ada di request).
//   - emptyToUndefined: angka opsional (amount, sortOrder) — '' dari form tidak boleh jadi NaN.

/** Laravel TrimStrings + ConvertEmptyStringsToNull: '' dan spasi-saja -> null. */
const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)

/** '' / null / undefined -> undefined (angka opsional yang dikoersi dari string form). */
const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value

/** `boolean` Laravel yang TIDAK wajib: absen/kosong -> undefined (kolom tidak disentuh / default DB). */
const optionalBool = z.preprocess(
  (value: unknown) => {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1' || value === 1) return true
    if (value === 'false' || value === '0' || value === 0) return false
    if (value === undefined || value === null || value === '') return undefined
    return value
  },
  z.boolean({ error: 'Nilai tidak valid.' }).optional()
)

/** `nullable|exists:*` untuk id uuid — keberadaan barisnya dicek service. */
const optionalId = z.preprocess(blankToNull, z.string({ error: 'ID tidak valid.' }).trim().max(64, { error: 'ID tidak valid.' }).nullish())

/** `nullable|integer|min:0` — nominal manual. */
const amountField = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number({ error: 'Nominal harus berupa angka.' })
    .int({ error: 'Nominal harus bilangan bulat.' })
    .min(0, { error: 'Nominal tidak boleh negatif.' })
    .optional()
)

/** `nullable|string|max:N` yang boleh dikosongkan. */
const nullableString = (max: number, message: string) =>
  z.preprocess(blankToNull, z.string({ error: 'Nilai harus berupa teks.' }).trim().max(max, { error: message }).nullish())

const DURATION_MONTHS = [1, 3, 6, 12] as const

/** Aturan paket — store dan update Laravel memakai array rules yang identik. */
const PLAN = z.object({
  name: z
    .string({ error: 'Nama paket wajib diisi.' })
    .trim()
    .min(1, { error: 'Nama paket wajib diisi.' })
    .max(100, { error: 'Nama paket maksimal 100 karakter.' }),
  description: z.preprocess(blankToNull, z.string({ error: 'Deskripsi harus berupa teks.' }).trim().nullish()),
  publicBadge: nullableString(80, 'Badge maksimal 80 karakter.'),
  savingsLabel: nullableString(80, 'Label hemat maksimal 80 karakter.'),
  ctaLabel: nullableString(80, 'Label tombol maksimal 80 karakter.'),
  // String polos (URL/path) seperti model Laravel — BUKAN upload.
  cardImageUrl: nullableString(255, 'URL gambar kartu maksimal 255 karakter.'),
  accurateItemNo: nullableString(30, 'Nomor item Accurate maksimal 30 karakter.'),
  accurateItemNoWarga: nullableString(30, 'Nomor item Accurate maksimal 30 karakter.'),
  price: z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: 'Harga wajib diisi.' }).int({ error: 'Harga harus bilangan bulat.' }).min(0, { error: 'Harga tidak boleh negatif.' })
  ),
  // Kosong = paket tidak punya tarif Warga UB (harga umum berlaku untuk semua).
  wargaPrice: z.preprocess(
    blankToNull,
    z.coerce
      .number({ error: 'Harga Warga UB harus berupa angka.' })
      .int({ error: 'Harga Warga UB harus bilangan bulat.' })
      .min(0, { error: 'Harga Warga UB tidak boleh negatif.' })
      .nullish()
  ),
  durationMonths: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: 'Durasi wajib dipilih.' })
      .refine((value) => (DURATION_MONTHS as readonly number[]).includes(value), { error: 'Durasi harus 1, 3, 6, atau 12 bulan.' })
  ),
  // `nullable|array` + `features.*: string|max:200`. Laravel memangkas dan meng-null-kan string kosong
  // bersarang juga, sehingga baris fitur kosong gagal aturan `string` — ditiru dengan min(1).
  features: z.preprocess(
    (value: unknown) => (value === '' ? null : value),
    z
      .array(
        z
          .string({ error: 'Fitur harus berupa teks.' })
          .trim()
          .min(1, { error: 'Fitur tidak boleh kosong.' })
          .max(200, { error: 'Fitur maksimal 200 karakter.' }),
        { error: 'Daftar fitur tidak valid.' }
      )
      .nullish()
  ),
  isActive: optionalBool,
  sortOrder: z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: 'Urutan harus bilangan bulat.' }).int({ error: 'Urutan harus bilangan bulat.' }).optional()
  )
})

export class MembershipAdminValidation {
  /**
   * POST /api/admin/customers — akun minimal untuk walk-in (tahap C): tanpa password; pelanggan bisa
   * mengambil alih akunnya lewat "lupa password". Email wajib karena kolomnya unik dan tidak nullable.
   */
  static readonly CUSTOMER_CREATE = z.object({
    name: z.string({ error: 'Nama wajib diisi.' }).trim().min(1, { error: 'Nama wajib diisi.' }).max(255, { error: 'Nama maksimal 255 karakter.' }),
    email: z
      .email({ error: 'Format email tidak valid.' })
      .max(190, { error: 'Email maksimal 190 karakter.' })
      .transform((value) => value.trim().toLowerCase()),
    phoneNumber: z.preprocess(
      blankToNull,
      z.string({ error: 'Nomor HP harus berupa teks.' }).trim().max(20, { error: 'Nomor HP maksimal 20 karakter.' }).nullish()
    )
  })

  /** POST /api/admin/memberships — tautkan akun ATAU ketik nama walk-in. */
  static readonly CREATE = z
    .object({
      userId: optionalId,
      customerName: z.preprocess(
        blankToNull,
        z.string({ error: 'Nama member harus berupa teks.' }).trim().max(255, { error: 'Nama member maksimal 255 karakter.' }).nullish()
      ),
      membershipPlanId: optionalId,
      startDate: z.string({ error: 'Tanggal mulai wajib diisi.' }).refine(isValidDateString, { error: 'Tanggal mulai harus berformat YYYY-MM-DD.' }),
      endDate: z.preprocess(blankToNull, z.string().refine(isValidDateString, { error: 'Tanggal selesai harus berformat YYYY-MM-DD.' }).nullish()),
      amount: amountField
    })
    .superRefine((value, ctx) => {
      // `required_without:user_id`
      if (!value.userId && !value.customerName) {
        ctx.addIssue({ code: 'custom', path: ['customerName'], message: 'Pilih akun customer atau isi nama member.' })
      }
      // `after:start_date` — string "YYYY-MM-DD" terurut leksikografis.
      if (value.endDate && value.endDate <= value.startDate) {
        ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Tanggal selesai harus setelah tanggal mulai.' })
      }
    })

  /** POST /api/admin/memberships/:id/renew */
  static readonly RENEW = z.object({
    membershipPlanId: optionalId,
    amount: amountField
  })

  /** PATCH /api/admin/memberships/:id — ubah status. */
  static readonly UPDATE_STATUS = z.object({
    status: z.enum(['active', 'expired', 'cancelled'], { error: 'Status tidak valid.' })
  })

  /** GET /api/admin/customers/search?q= */
  static readonly CUSTOMER_SEARCH = z.object({
    q: z.preprocess((value) => (typeof value === 'string' ? value : ''), z.string()).transform((s) => s.trim())
  })

  /** POST /api/admin/memberships/plans & PATCH /api/admin/memberships/plans/:id */
  static readonly PLAN = PLAN
}

export type CreateMembershipAdminInput = z.infer<typeof MembershipAdminValidation.CREATE>
export type MembershipPlanInput = z.infer<typeof MembershipAdminValidation.PLAN>
