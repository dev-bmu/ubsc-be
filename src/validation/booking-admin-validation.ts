import { z } from 'zod'
import { isValidDateString, jakartaDate } from '../utils/clock'

// ===== Validasi booking admin (panel staff) =====
// Port aturan $request->validate() di Admin\BookingController, CheckInController, ClassSessionController.
// Nama field camelCase; pesan bahasa Indonesia. Schema ini murni BENTUK data — aturan `exists:*` dan
// semua aturan bisnis (jadwal, unit milik fasilitas, kapasitas/tabrakan) dicek di service.

/** Laravel ConvertEmptyStringsToNull + TrimStrings: '' dan spasi saja dianggap tidak diisi. */
const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value)

const idField = (required: string) => z.string({ error: required }).trim().min(1, { error: required }).max(64, { error: 'ID tidak valid.' })
const optionalIdField = z.preprocess(blankToNull, z.string().trim().max(64, { error: 'ID tidak valid.' }).nullish())

/** `date_format:H:i` — 00:00 sampai 23:59. */
const timeField = (label: string) =>
  z.string({ error: `${label} wajib diisi.` }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: `${label} harus berformat HH:mm.` })

/** `date_format:Y-m-d` — tanggal yang benar-benar ada (2026-02-30 ditolak). */
const dateField = (label: string) =>
  z.string({ error: `${label} wajib diisi.` }).refine(isValidDateString, { error: `${label} harus berformat YYYY-MM-DD.` })

/** `date_format:Y-m-d|after_or_equal:today` — "hari ini" dihitung di Jakarta SAAT parse. */
const bookableDateField = (label: string) =>
  z.string({ error: `${label} wajib diisi.` }).superRefine((value, ctx) => {
    if (!isValidDateString(value)) ctx.addIssue({ code: 'custom', message: `${label} harus berformat YYYY-MM-DD.` })
    else if (value < jakartaDate()) ctx.addIssue({ code: 'custom', message: `${label} tidak boleh sebelum hari ini.` })
  })

/**
 * `boolean` Laravel: menerima true/false, 1/0, "1"/"0", "true"/"false". Kosong/null dianggap false —
 * checkbox yang tidak dicentang tidak dikirim FE.
 */
const booleanField = z.preprocess(
  (v) => {
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === '1' || v === 1) return true
    if (v === 'false' || v === '0' || v === 0 || v === '' || v === null || v === undefined) return false
    return v
  },
  z.boolean({ error: 'Nilai tidak valid.' })
)

/** `nullable|integer|min:1|max:9999`. Kosong -> undefined (service memakai default 1). */
const paxField = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce
    .number({ error: 'Jumlah peserta harus berupa angka.' })
    .int({ error: 'Jumlah peserta harus bilangan bulat.' })
    .min(1, { error: 'Jumlah peserta minimal 1.' })
    .max(9999, { error: 'Jumlah peserta maksimal 9999.' })
    .optional()
)

export class BookingAdminValidation {
  /** POST /api/admin/bookings — walk-in yang dibuat staff. */
  static readonly CREATE = z.object({
    customerName: z
      .string({ error: 'Nama pelanggan wajib diisi.' })
      .trim()
      .min(1, { error: 'Nama pelanggan wajib diisi.' })
      .max(255, { error: 'Nama pelanggan maksimal 255 karakter.' }),
    facilityId: idField('Fasilitas wajib dipilih.'),
    facilityUnitId: optionalIdField,
    bookingDate: bookableDateField('Tanggal booking'),
    startTime: timeField('Jam mulai'),
    endTime: timeField('Jam selesai'),
    pax: paxField,
    isFree: booleanField,
    notes: z.preprocess(
      blankToNull,
      z.string({ error: 'Catatan harus berupa teks.' }).trim().max(500, { error: 'Catatan maksimal 500 karakter.' }).nullish()
    )
  })

  /** PATCH /api/admin/bookings/:id — ubah status. */
  static readonly UPDATE_STATUS = z.object({
    status: z.enum(['pending', 'confirmed', 'cancelled', 'completed'], { error: 'Status tidak valid.' })
  })

  /** GET /api/admin/checkin?q= — pencarian meja check-in. */
  static readonly CHECKIN_INDEX = z.object({
    q: z.preprocess((v) => (v === undefined || v === null ? '' : v), z.string({ error: 'Kata kunci tidak valid.' })).transform((s) => s.trim())
  })

  /** GET /api/admin/classes — filter roster. month/date longgar; monthFrom() di service yang memutuskan. */
  static readonly ROSTER = z.object({
    facilityId: optionalIdField,
    facilityUnitId: optionalIdField,
    month: z.preprocess(blankToNull, z.string().trim().max(7).nullish()),
    date: z.preprocess(blankToNull, z.string().trim().max(10).nullish())
  })

  /** POST /api/admin/classes/cancel-session — batalkan satu pertemuan. */
  static readonly CANCEL_SESSION = z.object({
    facilityId: idField('Fasilitas wajib dipilih.'),
    facilityUnitId: idField('Unit wajib dipilih.'),
    sessionDate: dateField('Tanggal sesi'),
    startTime: timeField('Jam mulai'),
    reason: z.preprocess(blankToNull, z.string().trim().max(160, { error: 'Alasan maksimal 160 karakter.' }).nullish())
  })

  /** POST /api/admin/classes/restore-session — buka kembali (tidak un-cancel booking lama). */
  static readonly RESTORE_SESSION = z.object({
    facilityUnitId: idField('Unit wajib dipilih.'),
    sessionDate: dateField('Tanggal sesi'),
    startTime: timeField('Jam mulai')
  })
}

export type CreateAdminBookingInput = z.infer<typeof BookingAdminValidation.CREATE>
export type RosterQueryInput = z.infer<typeof BookingAdminValidation.ROSTER>
