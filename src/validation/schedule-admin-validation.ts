import { z } from 'zod'
import { isValidDateString } from '../utils/clock'

// ===== Validasi pengaturan jadwal bulanan (panel staff) — Fase 8G =====
// Port aturan inline $request->validate() dari Admin\ScheduleController::toggle() dan
// ::updateClosedDates() — TAPI camelCase di kabel (closed_dates -> closedDates).
//
// Bentuk input SELALU application/json di sini (tidak ada berkas pada layar ini), jadi angka tiba
// sebagai number asli. z.coerce tetap dipakai supaya form yang mengirim '9' / '2026' sebagai string
// tidak ditolak — koersinya no-op untuk input yang sudah bertipe benar, sama seperti
// news-admin-validation.ts.
//
// Aturan yang TIDAK di sini karena bergantung pada bulan yang sedang diedit (perbandingan
// month/year tiap tanggal) ditegakkan service dengan 422 per-field, persis pola
// rethrowSlugConflict/assertCategoryExists di facility-services.ts.

/** `between:1,12` */
const monthField = z.coerce
  .number({ error: 'Bulan tidak valid.' })
  .int({ error: 'Bulan tidak valid.' })
  .min(1, { error: 'Bulan tidak valid.' })
  .max(12, { error: 'Bulan tidak valid.' })

/** `min:2020|max:2099` */
const yearField = z.coerce
  .number({ error: 'Tahun tidak valid.' })
  .int({ error: 'Tahun tidak valid.' })
  .min(2020, { error: 'Tahun tidak valid.' })
  .max(2099, { error: 'Tahun tidak valid.' })

/**
 * Dua pesan yang ditulis ScheduleController sendiri lewat ValidationException::withMessages().
 * Diekspor supaya service memakai string yang SAMA — bukan salinannya — saat menolak tanggal yang
 * bocor ke bulan lain.
 */
export const CLOSED_DATE_FORMAT_MESSAGE = 'Format tanggal tutup tidak valid.'
export const CLOSED_DATE_MONTH_MESSAGE = 'Tanggal tutup harus berada pada bulan yang sedang diedit.'

/**
 * Padanan gabungan `date_format:Y-m-d` + pemeriksaan ulang Carbon di controller.
 *
 * Laravel memakai DUA lapis untuk hal yang sama: aturan `date_format:Y-m-d` menolak bentuk yang
 * salah, lalu controller-nya membandingkan `Carbon::createFromFormat(...)->format('Y-m-d')` dengan
 * string aslinya untuk menangkap tanggal yang BENTUKNYA benar tapi ORANGNYA tidak ada — '2026-02-30'
 * lolos date_format lalu diam-diam menggeser ke 2026-03-02. isValidDateString() melakukan
 * round-trip yang sama persis, jadi satu refine menutup kedua lapis.
 *
 * Pesannya disatukan ke CLOSED_DATE_FORMAT_MESSAGE: pesan bawaan `date_format` Laravel tidak pernah
 * terlihat user pada layar ini (formnya date picker), dan menyalinnya hanya melahirkan dua kalimat
 * berbeda untuk satu kesalahan yang sama.
 */
const closedDateField = z.string({ error: CLOSED_DATE_FORMAT_MESSAGE }).trim().refine(isValidDateString, { error: CLOSED_DATE_FORMAT_MESSAGE })

export class ScheduleAdminValidation {
  /** POST /api/admin/settings/schedules/toggle */
  static readonly TOGGLE = z.object({
    month: monthField,
    year: yearField
  })

  /**
   * POST /api/admin/settings/schedules/update-dates
   *
   * `closedDates` memakai aturan `present|array`, BUKAN `required`: array kosong adalah kiriman yang
   * sah dan artinya "tidak ada tanggal tutup bulan ini". Di Zod itu berarti field WAJIB ADA (tanpa
   * .optional() dan tanpa .default()) tapi boleh berisi nol elemen — menambahkan .min(1) akan
   * membuat staff tidak pernah bisa mengosongkan kembali daftar tanggal tutup.
   */
  static readonly CLOSED_DATES = z.object({
    month: monthField,
    year: yearField,
    closedDates: z.array(closedDateField, { error: 'Daftar tanggal tutup wajib dikirim.' })
  })
}

export type ScheduleToggleInput = z.infer<typeof ScheduleAdminValidation.TOGGLE>
export type ScheduleClosedDatesInput = z.infer<typeof ScheduleAdminValidation.CLOSED_DATES>
