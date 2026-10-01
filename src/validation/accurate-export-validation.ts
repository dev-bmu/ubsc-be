import { z } from 'zod'
import { addDays, isValidDateString } from '../utils/clock'

// ===== Validasi export Accurate (admin/finance) =====

/** Satu export mencakup paling lama sebulan — cukup untuk mengejar hari yang terlewat. */
export const MAX_EXPORT_DAYS = 31

const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)
const optionalDate = (label: string) =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .refine(isValidDateString, { error: `${label} harus berformat YYYY-MM-DD.` })
      .nullish()
  )

export class AccurateExportValidation {
  /** GET /api/admin/finance/accurate/{pelanggan,faktur}?from=&to= — kosong = hari ini (WIB). */
  static readonly RANGE = z.object({ from: optionalDate('Tanggal awal'), to: optionalDate('Tanggal akhir') }).superRefine((value, ctx) => {
    if (!value.from || !value.to) return
    if (value.to < value.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Tanggal akhir harus sama atau setelah tanggal awal.' })
    else if (value.to > addDays(value.from, MAX_EXPORT_DAYS - 1)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `Rentang export maksimal ${MAX_EXPORT_DAYS} hari.` })
    }
  })
}
