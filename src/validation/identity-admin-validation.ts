import { z } from 'zod'

// ===== Validasi antrean verifikasi identitas (panel staff) =====
// Port aturan $request->validate() di Admin\IdentityQueueController::verify:
//   'status'            => ['required', Rule::in(['verified', 'rejected'])]
//   'identity_category' => ['nullable', Rule::in(['umum', 'warga_kampus'])]
// Nama field camelCase; pesan bahasa Indonesia. Schema ini murni BENTUK data — keberadaan baris user
// (route-model binding Laravel) dicek di service.
//
// blankToNull menyamai Laravel TrimStrings + ConvertEmptyStringsToNull: '' (atau spasi saja) menjadi
// null sehingga lolos aturan `nullable`. Bedanya dengan ABSEN (undefined) tidak penting di sini:
// Laravel hanya menulis kolom identity_category kalau `filled()`, jadi null MAUPUN absen sama-sama
// membiarkan kolomnya apa adanya (lihat verifyIdentity di identity-admin-services.ts).

/** Laravel ConvertEmptyStringsToNull: '' dan spasi-saja -> null. */
const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)

export class IdentityAdminValidation {
  /** PATCH /api/admin/identity/:userId/verify */
  static readonly VERIFY = z.object({
    status: z.enum(['verified', 'rejected'], { error: 'Status tidak valid.' }),
    identityCategory: z.preprocess(blankToNull, z.enum(['umum', 'warga_kampus'], { error: 'Kategori identitas tidak valid.' }).nullish())
  })
}

export type IdentityVerifyInput = z.infer<typeof IdentityAdminValidation.VERIFY>
