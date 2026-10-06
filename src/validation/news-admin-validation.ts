import { z } from 'zod'
import { SEO_LIMITS } from '../../shared/seo'
import { isValidDateString } from '../utils/clock'

// ===== Validasi CMS berita + kategori + info banner + gym traffic (panel staff) =====
// Port aturan inline $request->validate() dari Admin\NewsController::validateArticle,
// Admin\NewsCategoryController, Admin\InfoBannerController, dan closure PUT admin/settings/gym-traffic
// (routes/web.php:618-622) — TAPI camelCase di kabel dan dengan koersi multipart.
//
// Dua bentuk input melewati schema di sini:
//   1. multipart (store/update berita, karena membawa `thumbnail`): SEMUA field non-berkas tiba
//      sebagai STRING. Angka dan boolean karena itu dikoersi (z.coerce / toBool), sama seperti
//      facility-validation.ts.
//   2. application/json (kategori, info banner, reorder, gym traffic): field sudah bertipe asli dan
//      koersinya jadi no-op.
//
// Schema ini murni BENTUK data. Aturan yang menyentuh database — `exists:news_categories,id` dan
// `Rule::unique('news','slug')->ignore($id)` — ditegakkan di service (422 per-field), persis pola
// rethrowSlugConflict/assertCategoryExists di facility-services.ts.

// ===== Preprocessor bersama =====

/** Laravel TrimStrings + ConvertEmptyStringsToNull: '' dan spasi-saja -> null (kolom ditulis null). */
const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)

/** '' / null / undefined -> undefined. Untuk angka opsional dari form: '' tidak boleh jadi NaN. */
const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value

/**
 * `boolean` Laravel yang TIDAK wajib: absen/kosong -> undefined, sehingga pemanggil bisa memakai
 * `?? default` persis seperti `$data['is_active'] ?? true` (store) dan `?? $infoBanner->is_active`
 * (update) di InfoBannerController.
 *
 * PENYIMPANGAN KECIL YANG DISENGAJA: di Laravel nilai '' berubah jadi null oleh
 * ConvertEmptyStringsToNull lalu GAGAL aturan `boolean` (rule-nya tidak implicit, null bukan boolean).
 * Di sini '' diperlakukan sama dengan "tidak dikirim". Bentuk ini mengikuti optionalBool di
 * membership-admin-validation.ts: form multipart mengirim '' untuk checkbox kosong, dan menolaknya
 * hanya melahirkan error validasi yang tidak pernah dimaksudkan siapa pun.
 */
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

/**
 * `nullable|date` milik published_at, dipersempit menjadi jam dinding WIB yang bisa ditulis form.
 *
 * Bentuk yang diterima: 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm[:ss]', dan 'YYYY-MM-DDTHH:mm[:ss]' (nilai
 * mentah <input type="datetime-local">). Laravel `date` jauh lebih longgar (apa pun yang dicerna
 * strtotime, termasuk 'next monday'), tapi form berita hanya pernah mengirim salah satu bentuk di
 * atas — menerima sisanya hanya membuka jalan nilai yang tidak bisa dipetakan ke jam WIB dengan
 * pasti. Penyimpangan ini disengaja dan dicatat di laporan fase.
 *
 * Tanggalnya divalidasi benar-benar ada (2026-02-30 ditolak), jamnya 00-23:00-59[:00-59].
 */
const PUBLISHED_AT = /^(\d{4}-\d{2}-\d{2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?$/

const publishedAtField = z.preprocess(
  blankToNull,
  z
    .string({ error: 'Tanggal terbit tidak valid.' })
    .trim()
    .refine(
      (value) => {
        const match = PUBLISHED_AT.exec(value)
        return match !== null && isValidDateString(match[1])
      },
      { error: 'Tanggal terbit harus berformat YYYY-MM-DD atau YYYY-MM-DD HH:mm.' }
    )
    .nullish()
)

/**
 * Empat nilai yang ditegakkan `in:` closure gym traffic (routes/web.php:620).
 *
 * DITULIS DI SINI, bukan diimpor: shared/contracts.ts hanya memuat tipe KnownGymTrafficDto dan TIDAK
 * mengekspor konstanta GYM_TRAFFIC_VALUES apa pun (dicek; berkas contracts di luar kepemilikan agen
 * ini, jadi tidak ditambahkan sepihak). Urutan dan ejaannya disalin persis dari aturan Laravel.
 */
export const GYM_TRAFFIC_VALUES = ['Low Occupancy', 'Medium Occupancy', 'High Occupancy', 'We Are Close'] as const

/** Teks SEO opsional: trim, kosong -> null (= pakai default/fallback), absen -> undefined (= tidak diubah). */
const seoText = (max: number, label: string) =>
  z.preprocess(
    blankToNull,
    z
      .string({ error: `${label} harus berupa teks.` })
      .trim()
      .max(max, { error: `${label} maksimal ${max} karakter.` })
      .nullish()
  )

const META_TITLE = seoText(SEO_LIMITS.titleMax, 'Judul SEO')
const META_DESCRIPTION = seoText(SEO_LIMITS.descriptionMax, 'Deskripsi SEO')

export class NewsAdminValidation {
  /**
   * POST & PUT /api/admin/news — padanan NewsController::validateArticle().
   *
   * `slug` memakai regex ASCII, bukan `alpha_dash` Laravel yang menerima huruf Unicode
   * (`/\A[\pL\pM\pN_-]+\z/u`). Penyempitan yang sama sudah dipakai slug fasilitas (FacilityValidation
   * .FACILITY, Fase 8A) supaya slug berita tetap aman dipasang di URL publik /news/<slug>.
   *
   * Keunikan slug (Rule::unique ignore id) dan `exists:news_categories,id` TIDAK di sini — keduanya
   * menyentuh database dan dijawab service dengan 422 per-field.
   */
  static readonly ARTICLE = z.object({
    newsCategoryId: z.preprocess(
      blankToNull,
      z.string({ error: 'Kategori tidak valid.' }).trim().max(64, { error: 'Kategori tidak valid.' }).nullish()
    ),
    title: z
      .string({ error: 'Judul wajib diisi.' })
      .trim()
      .min(1, { error: 'Judul wajib diisi.' })
      // 191, bukan 255 Laravel: kolomnya VARCHAR(191) di skema Prisma — 255 berujung 500 dari MySQL.
      .max(191, { error: 'Judul maksimal 191 karakter.' }),
    slug: z
      .string({ error: 'Slug wajib diisi.' })
      .trim()
      .min(1, { error: 'Slug wajib diisi.' })
      .max(191, { error: 'Slug maksimal 191 karakter.' })
      .regex(/^[A-Za-z0-9_-]+$/, { error: 'Slug hanya boleh berisi huruf, angka, tanda hubung, dan garis bawah.' }),
    excerpt: z.preprocess(
      blankToNull,
      z.string({ error: 'Ringkasan harus berupa teks.' }).trim().max(500, { error: 'Ringkasan maksimal 500 karakter.' }).nullish()
    ),
    // .trim() mengikuti middleware TrimStrings Laravel, yang juga menyentuh body artikel — sehingga
    // isi berupa spasi saja jatuh ke '' lalu gagal `required`, sama seperti di Laravel.
    // HTML editor. Disanitasi service (utils/sanitize-html.ts); isi yang kosong SETELAH sanitasi ditolak di sana.
    content: z.string({ error: 'Isi artikel wajib diisi.' }).trim().min(1, { error: 'Isi artikel wajib diisi.' }),
    status: z.enum(['draft', 'published', 'archived'], { error: 'Status tidak valid.' }),
    publishedAt: publishedAtField,
    metaTitle: META_TITLE,
    metaDescription: META_DESCRIPTION,
    noindex: optionalBool,
    /** '1' = hapus OG image lama (diabaikan bila berkas `ogImage` baru ikut dikirim). */
    removeOgImage: optionalBool
  })

  /** PUT /api/admin/seo-pages/:key — kosong = pakai default SEO_PAGES. */
  static readonly PAGE_SEO = z.object({
    title: META_TITLE,
    description: META_DESCRIPTION,
    noindex: optionalBool,
    removeOgImage: optionalBool
  })

  /** POST & PUT /api/admin/news-categories — slug diturunkan dari name di service (Str::slug). */
  static readonly CATEGORY = z.object({
    name: z
      .string({ error: 'Nama kategori wajib diisi.' })
      .trim()
      .min(1, { error: 'Nama kategori wajib diisi.' })
      .max(100, { error: 'Nama kategori maksimal 100 karakter.' })
  })

  /**
   * POST & PUT /api/admin/info-banners — array rules store dan update di Laravel identik; yang
   * berbeda hanya nilai default saat field-nya absen, dan itu diputuskan service.
   */
  static readonly INFO_BANNER = z.object({
    message: z
      .string({ error: 'Pesan banner wajib diisi.' })
      .trim()
      .min(1, { error: 'Pesan banner wajib diisi.' })
      .max(255, { error: 'Pesan banner maksimal 255 karakter.' }),
    isActive: optionalBool,
    sortOrder: z.preprocess(
      emptyToUndefined,
      z.coerce
        .number({ error: 'Urutan harus bilangan bulat.' })
        .int({ error: 'Urutan harus bilangan bulat.' })
        .min(0, { error: 'Urutan minimal 0.' })
        .optional()
    )
  })

  /**
   * POST /api/admin/info-banners/reorder — `$request->input('ids', [])`.
   *
   * Laravel tidak memvalidasi apa pun di sini dan diam saja untuk daftar kosong; schema ini hanya
   * memastikan bentuknya array string. Id yang tidak ada di tabel tetap dilewati tanpa error
   * (updateMany 0 baris), sama seperti `where('id',$id)->update()` Laravel.
   */
  static readonly REORDER = z.object({
    ids: z.array(z.string({ error: 'ID tidak valid.' }).trim().min(1, { error: 'ID tidak valid.' }), { error: 'Daftar ID tidak valid.' }).default([])
  })

  /** PUT /api/admin/settings/gym-traffic — `required|in:...` atas keempat nilai di atas. */
  static readonly GYM_TRAFFIC = z.object({
    value: z.enum(GYM_TRAFFIC_VALUES, { error: 'Status keramaian tidak valid.' })
  })
}

export type NewsArticleInput = z.infer<typeof NewsAdminValidation.ARTICLE>
export type InfoBannerInput = z.infer<typeof NewsAdminValidation.INFO_BANNER>
