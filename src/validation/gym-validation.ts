import { z } from 'zod'
import { isValidDateString } from '../utils/clock'

// ===== Validasi meja check-in + analitik gym (tahap D) =====

const CODE_REQUIRED = 'Pindai kartu atau ketik nomor member.'
const code = z.string({ error: CODE_REQUIRED }).trim().min(1, { error: CODE_REQUIRED }).max(32, { error: 'Nomor member tidak valid.' })

/** '' / spasi-saja -> null. */
const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)
const optionalDate = (label: string) =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .refine(isValidDateString, { error: `${label} harus berformat YYYY-MM-DD.` })
      .nullish()
  )

/** Rentang laporan dibatasi supaya satu permintaan tidak menarik seluruh isi tabel. */
export const MAX_REPORT_DAYS = 92

export class GymValidation {
  /** GET /api/admin/gym/checkin/lookup?code= */
  static readonly LOOKUP = z.object({ code })

  /** POST /api/admin/gym/checkin */
  static readonly CHECK_IN = z.object({
    code,
    source: z.enum(['scan', 'manual'], { error: 'Sumber check-in tidak valid.' }).default('manual'),
    overrideReason: z.preprocess(
      blankToNull,
      z.string({ error: 'Alasan harus berupa teks.' }).trim().max(120, { error: 'Alasan maksimal 120 karakter.' }).nullish()
    )
  })

  /** GET /api/admin/gym/visits?from=&to= */
  static readonly REPORT = z.object({ from: optionalDate('Tanggal awal'), to: optionalDate('Tanggal akhir') }).superRefine((value, ctx) => {
    if (value.from && value.to && value.to < value.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Tanggal akhir harus sama atau setelah tanggal awal.' })
    }
  })
}
