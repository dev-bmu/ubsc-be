import { z } from 'zod'

// ===== Validasi CMS "kartu beranda" (panel staff) — Fase 8F =====
// Port aturan inline $request->validate() dari Admin\PromoCarouselController, Admin\SponsorLogoController,
// Admin\ReelController, dan Admin\TestimonialController. Nama field camelCase di kabel (FE port yang
// rename dari snake_case Laravel); pesan bahasa Indonesia. Schema ini murni BENTUK data — keberadaan
// baris (promo/sponsor/reel/testimoni/review) dicek service, dan berkas unggahan divalidasi ISI-nya oleh
// sharp / sniffer video di media-store-services, bukan di sini.
//
// SATU perbedaan yang menentukan perilaku dan karena itu ditulis eksplisit:
//
//   `is_active` dan `sort_order` ABSEN ≠ `false`/`0`.
//   Keempat controller menulis `'is_active' => $data['is_active'] ?? $existing->is_active` pada update
//   (dan `?? true` / `?? 0` pada create). Artinya field yang TIDAK DIKIRIM mempertahankan nilai lama,
//   sedangkan `false` yang DIKIRIM tetap menulis false. Jadi optionalBool/optionalSortOrder di bawah
//   mengembalikan `undefined` saat absen — BUKAN default `false`/`0` seperti boolFrom() di
//   facility-validation.ts, yang memang meniru controller Laravel lain yang tidak punya cabang `??`.
//   Mengganti keduanya dengan default akan diam-diam menonaktifkan slide setiap kali form mengirim
//   sebagian field (mis. hanya mengganti gambar), tanpa satu pun error.
//
// Dua bentuk input melewati schema ini:
//   1. multipart (semua create/update — slide/logo/thumbnail/video/image ikut): SEMUA field non-berkas
//      tiba sebagai STRING, jadi angka dikoersi z.coerce dan boolean lewat preprocessor.
//   2. application/json (reorder, dan update tanpa berkas): field sudah bertipe asli, koersi jadi no-op.

// ===== Preprocessor bersama =====

/** Laravel TrimStrings + ConvertEmptyStringsToNull: '' dan spasi-saja -> null (kolom ditulis null). */
const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)

/** '' / null / undefined -> undefined: field dianggap TIDAK DIKIRIM (lihat catatan `??` di kepala berkas). */
const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value

/**
 * `['boolean']` Laravel yang TIDAK wajib: absen/kosong -> undefined supaya service bisa memakai
 * `?? nilai lama` / `?? true`. Bentuknya sama dengan optionalBool di membership-admin-validation.ts.
 *
 * Menerima 'true'/'false' selain '1'/'0' — Laravel sendiri hanya menerima [true,false,1,0,'1','0'],
 * jadi ini SENGAJA lebih longgar: Inertia mengirim '1'/'0' di FormData, tapi klien lain (fetch manual,
 * axios) lazim mengirim 'true'/'false' dan menolaknya hanya menghasilkan 422 yang membingungkan.
 */
const optionalBool = z.preprocess(
  (value: unknown) => {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1' || value === 1) return true
    if (value === 'false' || value === '0' || value === 0) return false
    if (value === undefined || value === null || value === '') return undefined
    return value
  },
  z.boolean({ error: 'Nilai aktif tidak valid.' }).optional()
)

/** `['integer','min:0']` yang tidak wajib — absen -> undefined, bukan 0. */
const optionalSortOrder = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number({ error: 'Urutan harus bilangan bulat.' })
    .int({ error: 'Urutan harus bilangan bulat.' })
    .min(0, { error: 'Urutan minimal 0.' })
    .optional()
)

/** `['required','string','max:N']`. */
const requiredString = (max: number, messages: { required: string; max: string }) =>
  z.string({ error: messages.required }).trim().min(1, { error: messages.required }).max(max, { error: messages.max })

/** `['nullable','string','max:N']` — '' dikosongkan jadi null, absen jadi undefined. */
const nullableString = (max: number, message: string) =>
  z.preprocess(blankToNull, z.string({ error: 'Nilai harus berupa teks.' }).trim().max(max, { error: message }).nullish())

export class CmsCardAdminValidation {
  /**
   * POST /api/admin/promo & PUT /api/admin/promo/:id — PromoCarouselController::store/update.
   *
   * `title` nullable: controller menulis `$data['title'] ?? null` di KEDUA aksi, jadi judul yang tidak
   * dikirim MENGOSONGKAN kolom (bukan mempertahankannya seperti is_active/sort_order). Perilaku itu
   * ditiru apa adanya di service.
   */
  static readonly PROMO = z.object({
    title: nullableString(255, 'Judul maksimal 255 karakter.'),
    isActive: optionalBool,
    sortOrder: optionalSortOrder
  })

  /** POST /api/admin/sponsors & PUT /api/admin/sponsors/:id — `name` WAJIB di kedua aksi. */
  static readonly SPONSOR = z.object({
    name: requiredString(255, { required: 'Nama sponsor wajib diisi.', max: 'Nama sponsor maksimal 255 karakter.' }),
    isActive: optionalBool,
    sortOrder: optionalSortOrder
  })

  /** POST /api/admin/reels & PUT /api/admin/reels/:id — reels TIDAK punya kolom sort_order. */
  static readonly REEL = z.object({
    title: requiredString(255, { required: 'Judul reel wajib diisi.', max: 'Judul maksimal 255 karakter.' }),
    isActive: optionalBool
  })

  /** POST /api/admin/testimonials & PUT /api/admin/testimonials/:id — `quote` tanpa batas panjang (kolom Text). */
  static readonly TESTIMONIAL = z.object({
    authorName: requiredString(255, { required: 'Nama penulis wajib diisi.', max: 'Nama penulis maksimal 255 karakter.' }),
    authorRole: requiredString(255, { required: 'Peran penulis wajib diisi.', max: 'Peran penulis maksimal 255 karakter.' }),
    quote: z.string({ error: 'Kutipan wajib diisi.' }).trim().min(1, { error: 'Kutipan wajib diisi.' }),
    isActive: optionalBool,
    sortOrder: optionalSortOrder
  })

  /**
   * POST .../reorder untuk promo, sponsors, dan testimonials — { ids: [] }, sortOrder = index + 1.
   *
   * `ids` BOLEH KOSONG, dan itu bukan kelalaian: ketiga controller membaca `$request->input('ids', [])`
   * lalu mem-foreach-nya tanpa satu pun aturan validasi, sehingga daftar kosong (atau field yang tidak
   * dikirim sama sekali) adalah no-op yang berbalas 200 — bukan 422. FacilityValidation.REORDER
   * (Fase 8A) memakai `.min(1)` karena di sana daftar kosong memang tidak punya arti; di sini `.min(1)`
   * akan menolak permintaan yang di Laravel berhasil, jadi SENGAJA tidak dipakai.
   */
  static readonly REORDER = z.object({
    ids: z.array(z.string({ error: 'ID tidak valid.' }).trim().min(1, { error: 'ID tidak valid.' }), { error: 'Daftar ID tidak valid.' }).default([])
  })
}

export type PromoInput = z.infer<typeof CmsCardAdminValidation.PROMO>
export type SponsorInput = z.infer<typeof CmsCardAdminValidation.SPONSOR>
export type ReelInput = z.infer<typeof CmsCardAdminValidation.REEL>
export type TestimonialInput = z.infer<typeof CmsCardAdminValidation.TESTIMONIAL>
export type ReorderInput = z.infer<typeof CmsCardAdminValidation.REORDER>
