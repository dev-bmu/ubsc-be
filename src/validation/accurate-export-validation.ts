import { z } from 'zod'
import { addDays, isValidDateString, jakartaDate } from '../utils/clock'
import { PaymentValidation } from './payment-validation'

// ===== Validasi export Accurate + ledger keuangan (admin/finance) =====

/** Satu export mencakup paling lama sebulan — cukup untuk mengejar hari yang terlewat. */
export const MAX_EXPORT_DAYS = 31

/** Ledger dipaginasi dan diringkas lewat agregat, jadi boleh setahun penuh. */
export const MAX_LEDGER_DAYS = 366

const blankToNull = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? null : value)
const optionalDate = (label: string) =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .refine(isValidDateString, { error: `${label} harus berformat YYYY-MM-DD.` })
      .nullish()
  )

const dateRange = { from: optionalDate('Tanggal awal'), to: optionalDate('Tanggal akhir') }

/**
 * to >= from dan rentang paling lama maxDays hari (inklusif). from kosong diperiksa sebagai hari ini (WIB),
 * default yang sama dengan service; to kosong = from, selalu sah.
 */
const rangeRule =
  (maxDays: number, noun: string) =>
  (value: { from?: string | null; to?: string | null }, ctx: z.RefinementCtx): void => {
    if (!value.to) return
    const from = value.from ?? jakartaDate()
    if (value.to < from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Tanggal akhir harus sama atau setelah tanggal awal.' })
    else if (value.to > addDays(from, maxDays - 1)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `Rentang ${noun} maksimal ${maxDays} hari.` })
    }
  }

/** Pilihan opsional: absen / '' -> nilai pertama, nilai asing -> 400. */
const choice = <const T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.enum(values, { error: `${label} tidak dikenal.` }).default(values[0]))

const { q, page, perPage } = PaymentValidation.QUEUE.shape

export class AccurateExportValidation {
  /** GET /api/admin/finance/accurate/{pelanggan,faktur,penerimaan}?from=&to= — kosong = hari ini (WIB). */
  static readonly RANGE = z.object(dateRange).superRefine(rangeRule(MAX_EXPORT_DAYS, 'export'))

  /**
   * GET /api/admin/finance/ledger — rentang sama dengan export (kosong = hari ini WIB). basis 'created' =
   * tanggal transaksi dibuat (tanggal export Faktur), 'paid' = tanggal lunas (tanggal export Penerimaan).
   * q/page/perPage persis antrean pembayaran.
   */
  static readonly LEDGER = z
    .object({
      ...dateRange,
      basis: choice(['created', 'paid'], 'Dasar tanggal'),
      type: choice(['all', 'booking', 'membership', 'other'], 'Tipe transaksi'),
      status: choice(['all', 'PAID', 'UNPAID', 'FAILED', 'EXPIRED'], 'Status pembayaran'),
      q,
      page,
      perPage
    })
    .superRefine(rangeRule(MAX_LEDGER_DAYS, 'ledger'))
}
