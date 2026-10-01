import { z } from 'zod'

// ===== Validasi ulasan pelanggan =====
// Port aturan $request->validate() di ReviewController::store (Public/ReviewController.php:17-20):
//
//   'rating' => ['required', 'numeric', 'min:0.5', 'max:5'],
//   'text'   => ['required', 'string', 'min:10', 'max:1000'],
//
// Nama field sudah camelCase dan sama dengan Laravel (rating, text), jadi tidak ada pemetaan nama.
// Pesan ditulis bahasa Indonesia mengikuti konvensi booking-validation.ts (lang/ Laravel hanya punya
// `en`, jadi pesan bawaan di sana justru tampil berbahasa Inggris — bukan sesuatu yang layak ditiru).
//
// Aturan bisnis "harus punya booking yang sudah selesai" TIDAK ada di sini: Laravel pun memeriksanya
// SETELAH validate() dan membalasnya 403, bukan 422. Tempatnya service.

/**
 * `numeric` Laravel menerima angka MAUPUN string numerik ("4.5"), jadi keduanya diterima di sini.
 * String kosong dan spasi saja ditolak lebih dulu supaya tidak jatuh ke Number('') === 0, yang akan
 * lolos sebagai angka lalu ditolak min:0.5 dengan pesan yang membingungkan.
 *
 * Nilai yang sudah number diteruskan apa adanya; selain string dan number tidak dikonversi sama
 * sekali (array/objek/boolean bukan `numeric` di Laravel, dan Number(true) === 1 akan meloloskannya).
 */
const numericField = (label: string) =>
  z.preprocess(
    (value) => {
      if (typeof value === 'number') return value
      if (typeof value !== 'string') return value
      const trimmed = value.trim()
      if (trimmed === '') return value
      const parsed = Number(trimmed)
      return Number.isNaN(parsed) ? value : parsed
    },
    z.number({ error: `${label} wajib diisi.` }).refine(Number.isFinite, { error: `${label} harus berupa angka.` })
  )

export class CustomerReviewValidation {
  /**
   * POST /api/customer/reviews.
   *
   * rating: 0.5 – 5 TANPA pembulatan kelipatan. Laravel hanya menulis min/max, jadi 4.3 memang sah —
   * kolomnya Float (schema.prisma:779), bukan decimal(3,1) yang membulatkan. Jangan menambahkan
   * `.multipleOf(0.5)`: itu aturan baru yang tidak pernah ditegakkan Laravel.
   *
   * text: `min:10` dan `max:1000` Laravel dihitung SETELAH middleware TrimStrings, jadi .trim()
   * mendahului batasnya di sini juga. Panjangnya dihitung per unit UTF-16 (JS) sementara Laravel
   * memakai mb_strlen — berbeda hanya untuk karakter di luar BMP (emoji), dan hanya di batas 1000.
   */
  static readonly STORE = z.object({
    rating: numericField('Rating')
      .refine((value) => value >= 0.5, { error: 'Rating minimal 0.5.' })
      .refine((value) => value <= 5, { error: 'Rating maksimal 5.' }),
    text: z
      .string({ error: 'Ulasan wajib diisi.' })
      .trim()
      .min(10, { error: 'Ulasan minimal 10 karakter.' })
      .max(1000, { error: 'Ulasan maksimal 1000 karakter.' })
  })
}

export type CreateReviewInput = z.infer<typeof CustomerReviewValidation.STORE>
