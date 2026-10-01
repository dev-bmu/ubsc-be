import { z } from 'zod'
import { isValidDateString } from '../utils/clock'

// ===== Validasi domain fasilitas (panel staff) =====
// Port aturan inline $request->validate() dari FacilityController, FacilityUnitController,
// FacilityPriceController, dan FacilityCategoryController — TAPI camelCase di kabel (FE port yang
// rename dari snake_case Laravel) dan dengan koersi multipart.
//
// Tiga bentuk input berbeda melewati schema di sini:
//   1. multipart (create/update fasilitas + unit): SEMUA field non-berkas tiba sebagai STRING; angka
//      dikoersi z.coerce, boolean lewat toBool, dan activeSlots/slotQuotas/displayMetadata/prices tiba
//      sebagai STRING JSON yang di-parse dulu (parseJson).
//   2. application/json (kategori, pricing sync, reorder): field sudah bertipe asli, koersi jadi no-op.
//
// Schema ini murni BENTUK data. Aturan yang butuh database (exists kategori, unik slug) dicek service.

// ===== Preprocessor bersama =====

/** Laravel TrimStrings + ConvertEmptyStringsToNull: '' dan spasi-saja dianggap tidak diisi. */
const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value

/** `boolean` Laravel / $request->boolean(): terima 'true'/'false'/'1'/'0'/1/0/bool; sisanya jatuh ke `fallback`. */
const boolFrom = (fallback: boolean) =>
  z.preprocess((value: unknown) => {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1' || value === 1) return true
    if (value === 'false' || value === '0' || value === 0) return false
    if (value === undefined || value === null || value === '') return fallback
    return value
  }, z.boolean())

/** Field multipart JSON ('{"Wednesday":["15:00"]}') -> nilai JS. Parse gagal / kosong -> undefined. */
const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** integer opsional dengan koersi multipart. undefined/''/null -> undefined (bukan NaN). */
const optionalInt = (min: number, max: number | undefined, messages: { number: string; range: string }) => {
  let schema = z.coerce.number({ error: messages.number }).int({ error: messages.number }).min(min, { error: messages.range })
  if (max !== undefined) schema = schema.max(max, { error: messages.range })
  return z.preprocess(emptyToUndefined, schema.optional())
}

/** angka desimal opsional dengan koersi (rating). */
const optionalNumber = (min: number, max: number, messages: { number: string; range: string }) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: messages.number }).min(min, { error: messages.range }).max(max, { error: messages.range }).optional()
  )

/** string opsional (nullable string Laravel) dengan batas panjang. */
const optionalString = (max: number, message: string) => z.preprocess(emptyToUndefined, z.string().trim().max(max, { error: message }).optional())

/** objek jadwal/kuota (associative array Laravel) — di-parse dari JSON string bila multipart. */
const optionalJsonObject = z.preprocess(parseJson, z.record(z.string(), z.unknown()).nullish())

// ===== Baris harga (dipakai pricing sync fasilitas DAN harga custom unit) =====

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const PRICE_ROW = z.object({
  userCategory: z.enum(['warga_ub', 'umum'], { error: 'Kategori pengguna harus warga_ub atau umum.' }),
  priceType: z.preprocess(emptyToUndefined, z.enum(['per_session', 'monthly_package'], { error: 'Tipe harga tidak valid.' }).optional()),
  label: z
    .string({ error: 'Label harga wajib diisi.' })
    .trim()
    .min(1, { error: 'Label harga wajib diisi.' })
    .max(100, { error: 'Label maksimal 100 karakter.' }),
  price: z.coerce.number({ error: 'Harga harus berupa angka.' }).min(0, { error: 'Harga tidak boleh negatif.' }),
  durationMinutes: optionalInt(1, undefined, { number: 'Durasi harus bilangan bulat.', range: 'Durasi minimal 1 menit.' }),
  scheduleType: z.preprocess(
    emptyToUndefined,
    z.enum(['regular', 'always', 'weekly', 'date_range'], { error: 'Tipe jadwal tidak valid.' }).optional()
  ),
  applicableDays: z.preprocess(emptyToUndefined, z.array(z.enum(WEEKDAYS), { error: 'Hari tidak valid.' }).optional()),
  startsAt: z.preprocess(emptyToUndefined, z.string().regex(HHMM, { error: 'Jam mulai harus berformat HH:mm.' }).optional()),
  endsAt: z.preprocess(emptyToUndefined, z.string().regex(HHMM, { error: 'Jam selesai harus berformat HH:mm.' }).optional()),
  startsOn: z.preprocess(emptyToUndefined, z.string().refine(isValidDateString, { error: 'Tanggal mulai harus berformat YYYY-MM-DD.' }).optional()),
  endsOn: z.preprocess(emptyToUndefined, z.string().refine(isValidDateString, { error: 'Tanggal selesai harus berformat YYYY-MM-DD.' }).optional()),
  notes: optionalString(500, 'Catatan maksimal 500 karakter.'),
  sortOrder: optionalInt(0, undefined, { number: 'Urutan harus bilangan bulat.', range: 'Urutan minimal 0.' })
})

export type FacilityPriceRowInput = z.infer<typeof PRICE_ROW>

/**
 * Aturan silang-field per baris harga — port `->after()` dari FacilityPriceController /
 * FacilityUnitController. Path-nya camelCase ('prices.0.applicableDays') supaya menempel ke field FE.
 */
function refinePriceRows(prices: FacilityPriceRowInput[] | undefined, ctx: z.RefinementCtx): void {
  ;(prices ?? []).forEach((price, index) => {
    const scheduleType = price.scheduleType ?? 'regular'
    const { startsAt, endsAt, startsOn, endsOn } = price

    if (scheduleType === 'weekly' && (!price.applicableDays || price.applicableDays.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['prices', index, 'applicableDays'], message: 'Pilih minimal satu hari untuk harga khusus.' })
    }

    if (scheduleType === 'date_range') {
      if (!startsOn || !endsOn) {
        ctx.addIssue({ code: 'custom', path: ['prices', index, 'startsOn'], message: 'Tanggal mulai dan tanggal selesai wajib diisi.' })
      } else if (endsOn < startsOn) {
        ctx.addIssue({ code: 'custom', path: ['prices', index, 'endsOn'], message: 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.' })
      }
    }

    if ((startsAt && !endsAt) || (!startsAt && endsAt)) {
      ctx.addIssue({ code: 'custom', path: ['prices', index, 'startsAt'], message: 'Jam mulai dan jam selesai harus diisi lengkap.' })
    }

    if (startsAt && endsAt && startsAt === endsAt) {
      ctx.addIssue({ code: 'custom', path: ['prices', index, 'endsAt'], message: 'Jam selesai harus berbeda dari jam mulai.' })
    }
  })
}

// ===== Unit fasilitas (create & update hanya beda default is_active) =====

const unitSchema = (isActiveDefault: boolean) =>
  z
    .object({
      name: z
        .string({ error: 'Nama unit wajib diisi.' })
        .trim()
        .min(1, { error: 'Nama unit wajib diisi.' })
        .max(150, { error: 'Nama unit maksimal 150 karakter.' }),
      isActive: boolFrom(isActiveDefault),
      capacity: optionalInt(1, 9999, { number: 'Kapasitas harus bilangan bulat.', range: 'Kapasitas antara 1 dan 9999.' }),
      useCustomSchedule: boolFrom(false),
      activeSlots: optionalJsonObject,
      slotQuotas: optionalJsonObject,
      useCustomPricing: boolFrom(false),
      prices: z.preprocess(parseJson, z.array(PRICE_ROW).optional()),
      removeUnitImage: boolFrom(false)
    })
    .superRefine((value, ctx) => {
      if (value.useCustomPricing && (value.prices?.length ?? 0) === 0) {
        ctx.addIssue({ code: 'custom', path: ['prices'], message: 'Isi minimal satu harga jika harga custom diaktifkan.' })
      }
      refinePriceRows(value.prices, ctx)
    })

export class FacilityValidation {
  /** POST /facilities & PUT /facilities/:id — keunikan slug ditegakkan DB (isUniqueViolation), bukan di sini. */
  static readonly FACILITY = z.object({
    facilityCategoryId: z
      .string({ error: 'Kategori wajib dipilih.' })
      .trim()
      .min(1, { error: 'Kategori wajib dipilih.' })
      .max(64, { error: 'Kategori tidak valid.' }),
    name: z
      .string({ error: 'Nama fasilitas wajib diisi.' })
      .trim()
      .min(1, { error: 'Nama fasilitas wajib diisi.' })
      .max(150, { error: 'Nama maksimal 150 karakter.' }),
    slug: z
      .string({ error: 'Slug wajib diisi.' })
      .trim()
      .min(1, { error: 'Slug wajib diisi.' })
      .max(160, { error: 'Slug maksimal 160 karakter.' })
      .regex(/^[A-Za-z0-9_-]+$/, { error: 'Slug hanya boleh berisi huruf, angka, tanda hubung, dan garis bawah.' }),
    description: optionalString(2000, 'Deskripsi maksimal 2000 karakter.'),
    location: optionalString(100, 'Lokasi maksimal 100 karakter.'),
    venueType: optionalString(100, 'Tipe venue maksimal 100 karakter.'),
    capacity: optionalInt(1, 9999, { number: 'Kapasitas harus bilangan bulat.', range: 'Kapasitas antara 1 dan 9999.' }),
    bookingMode: z.preprocess(emptyToUndefined, z.enum(['court', 'class'], { error: 'Mode booking tidak valid.' }).optional()),
    activeSlots: optionalJsonObject,
    slotQuotas: optionalJsonObject,
    sessionNote: optionalString(160, 'Catatan sesi maksimal 160 karakter.'),
    classCode: optionalString(50, 'Kode kelas maksimal 50 karakter.'),
    accurateItemNo: optionalString(30, 'Nomor item Accurate maksimal 30 karakter.'),
    accurateItemNoWarga: optionalString(30, 'Nomor item Accurate maksimal 30 karakter.'),
    rating: optionalNumber(0, 5, { number: 'Rating harus berupa angka.', range: 'Rating antara 0 dan 5.' }),
    displayMetadata: z.preprocess(parseJson, z.unknown()),
    isActive: boolFrom(false),
    sortOrder: optionalInt(0, undefined, { number: 'Urutan harus bilangan bulat.', range: 'Urutan minimal 0.' }),
    removeHero: boolFrom(false)
  })

  /** POST & PUT /facility-categories/:id — slug diturunkan dari name di service. */
  static readonly CATEGORY = z.object({
    name: z
      .string({ error: 'Nama kategori wajib diisi.' })
      .trim()
      .min(1, { error: 'Nama kategori wajib diisi.' })
      .max(100, { error: 'Nama kategori maksimal 100 karakter.' }),
    description: optionalString(500, 'Deskripsi maksimal 500 karakter.'),
    sortOrder: optionalInt(0, undefined, { number: 'Urutan harus bilangan bulat.', range: 'Urutan minimal 0.' })
  })

  /** POST /facilities/reorder & /facility-categories/reorder — { ids: string[] }, sortOrder = index + 1. */
  static readonly REORDER = z.object({
    ids: z
      .array(z.string({ error: 'ID tidak valid.' }).trim().min(1, { error: 'ID tidak valid.' }), { error: 'Daftar ID tidak valid.' })
      .min(1, { error: 'Daftar ID tidak boleh kosong.' })
  })

  /** POST /facilities/:id/pricing/sync — full-replace daftar harga fasilitas. */
  static readonly PRICING_SYNC = z
    .object({
      prices: z.array(PRICE_ROW, { error: 'Daftar harga tidak valid.' }).min(1, { error: 'Isi minimal satu baris harga.' })
    })
    .superRefine((value, ctx) => refinePriceRows(value.prices, ctx))

  static readonly UNIT_CREATE = unitSchema(true)
  static readonly UNIT_UPDATE = unitSchema(false)
}
