import { z } from 'zod'
import { isValidDateString, jakartaDate } from '../utils/clock'

// ===== Validasi booking =====
// Port aturan $request->validate() di PublicBookingController. Nama field camelCase, pesan bahasa
// Indonesia (lang/ Laravel hanya punya `en`, jadi pesan bawaan di sana tampil berbahasa Inggris).
//
// Schema ini murni BENTUK data. Aturan `exists:facilities,id` Laravel dicek service, karena butuh
// database; begitu pula semua aturan bisnis (jadwal, kontiguitas, kapasitas).

/** Laravel ConvertEmptyStringsToNull + TrimStrings: '' dan spasi saja dianggap tidak diisi. */
const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value)

const idField = (required: string) => z.string({ error: required }).trim().min(1, { error: required }).max(64, { error: 'ID tidak valid.' })

const optionalIdField = z.preprocess(blankToNull, z.string().trim().max(64, { error: 'ID tidak valid.' }).nullish())

/** `date_format:Y-m-d` — tanggal yang benar-benar ada, bukan sekadar pola (2026-02-30 ditolak). */
const dateField = (label: string) =>
  z.string({ error: `${label} wajib diisi.` }).refine(isValidDateString, { error: `${label} harus berformat YYYY-MM-DD.` })

/**
 * `date_format:Y-m-d|after_or_equal:today`. "Hari ini" dihitung di Jakarta SAAT parse, tidak pernah
 * saat modul dimuat — proses API hidup berhari-hari.
 */
const bookableDateField = (label: string) =>
  z.string({ error: `${label} wajib diisi.` }).superRefine((value, ctx) => {
    if (!isValidDateString(value)) {
      ctx.addIssue({ code: 'custom', message: `${label} harus berformat YYYY-MM-DD.` })
    } else if (value < jakartaDate()) {
      ctx.addIssue({ code: 'custom', message: `${label} tidak boleh sebelum hari ini.` })
    }
  })

/** `date_format:H:i` — 00:00 sampai 23:59. "24:00" ditolak, sama seperti round-trip PHP. */
const timeField = (label: string) =>
  z.string({ error: `${label} wajib diisi.` }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: `${label} harus berformat HH:mm.` })

/** Batas sesi per pembelian kelas (`sessions` max:40). */
export const MAX_SESSIONS_PER_BOOKING = 40

const sessionSchema = z.object({
  date: bookableDateField('Tanggal sesi'),
  startTime: timeField('Jam mulai'),
  endTime: timeField('Jam selesai')
})

export class BookingValidation {
  /** GET /api/public/booking/slots */
  static readonly SLOTS = z.object({
    facilityId: idField('Fasilitas wajib dipilih.'),
    facilityUnitId: optionalIdField,
    date: dateField('Tanggal')
  })

  /** GET /api/public/booking/month */
  static readonly MONTH = z.object({
    facilityId: idField('Fasilitas wajib dipilih.'),
    facilityUnitId: optionalIdField,
    month: z.string({ error: 'Bulan wajib diisi.' }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: 'Bulan harus berformat YYYY-MM.' })
  })

  /**
   * POST /api/customer/booking — dua bentuk dalam satu schema:
   *   lapangan: bookingDate + startTime + endTime (satu rentang)
   *   kelas:    sessions[] (banyak sesi dibayar bersama)
   * Aturan `required_without` Laravel diterjemahkan di superRefine: kalau sessions tidak dikirim,
   * ketiga field lapangan wajib; kalau bookingDate tidak dikirim, sessions wajib.
   */
  static readonly CREATE = z
    .object({
      facilityId: idField('Fasilitas wajib dipilih.'),
      facilityUnitId: optionalIdField,
      bookingDate: z.preprocess(blankToNull, bookableDateField('Tanggal booking').nullish()),
      startTime: z.preprocess(blankToNull, timeField('Jam mulai').nullish()),
      endTime: z.preprocess(blankToNull, timeField('Jam selesai').nullish()),
      sessions: z
        .array(sessionSchema, { error: 'Daftar sesi tidak valid.' })
        .min(1, { error: 'Pilih minimal satu sesi.' })
        .max(MAX_SESSIONS_PER_BOOKING, { error: `Maksimal ${MAX_SESSIONS_PER_BOOKING} sesi per pemesanan.` })
        .nullish(),
      notes: z.preprocess(
        blankToNull,
        z.string({ error: 'Catatan harus berupa teks.' }).trim().max(500, { error: 'Catatan maksimal 500 karakter.' }).nullish()
      )
    })
    .superRefine((value, ctx) => {
      const hasSessions = value.sessions !== null && value.sessions !== undefined
      if (!hasSessions) {
        if (!value.bookingDate) ctx.addIssue({ code: 'custom', path: ['bookingDate'], message: 'Tanggal booking wajib diisi.' })
        if (!value.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Jam mulai wajib diisi.' })
        if (!value.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Jam selesai wajib diisi.' })
      }
      if (!hasSessions && !value.bookingDate) {
        ctx.addIssue({ code: 'custom', path: ['sessions'], message: 'Pilih minimal satu sesi.' })
      }
    })
}

export type CreateBookingInput = z.infer<typeof BookingValidation.CREATE>
