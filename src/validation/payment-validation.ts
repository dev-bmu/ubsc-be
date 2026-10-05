import { z } from 'zod'

// ===== Validasi verifikasi pembayaran (panel staff) =====

const REASON_REQUIRED = 'Tulis alasan penolakan agar pengguna tahu harus memperbaiki apa.'

/** Teks opsional: null/absen = '' (setting tersimpan sebagai string kosong), dipangkas, dibatasi panjang. */
const optionalText = (max: number, tooLong: string) => z.preprocess((value: unknown) => value ?? '', z.string().trim().max(max, { error: tooLong }))

/** '' / spasi-saja / null -> undefined, supaya `required` yang gagal, bukan coercion ke 0. */
const emptyToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value

const HOLD_REQUIRED = 'Durasi hold wajib diisi.'
const HOLD_RANGE = 'Durasi hold harus antara 15 dan 1440 menit.'
const FEE_REQUIRED = 'Biaya admin wajib diisi (0 untuk mematikan).'
const FEE_RANGE = 'Biaya admin harus antara Rp0 dan Rp10.000.'
const CODE_MAX_REQUIRED = 'Batas kode unik wajib diisi.'
// Di bawah 100, satu nominal hanya muat segelintir transfer terbuka sebelum checkout ditolak 409.
const CODE_MAX_RANGE = 'Batas kode unik harus antara 100 dan 999.'

/** Bilangan bulat wajib dalam rentang, dari angka atau string form. */
const requiredInt = (required: string, min: number, max: number, range: string) =>
  z.preprocess(emptyToUndefined, z.coerce.number({ error: required }).int({ error: range }).min(min, { error: range }).max(max, { error: range }))

export class PaymentValidation {
  /** POST /api/admin/payments/:transactionId/reject — alasannya dikirim ke pelanggan lewat email. */
  static readonly REJECT = z.object({
    reason: z
      .string({ error: REASON_REQUIRED })
      .trim()
      .min(1, { error: REASON_REQUIRED })
      .max(300, { error: 'Alasan penolakan maksimal 300 karakter.' })
  })

  /**
   * POST /api/admin/payments/settings — port updateSettings(): bank_name max:60, account_number max:40,
   * account_holder max:80, hold_minutes integer 15..1440. Nama field camelCase. adminFee dan
   * uniqueCodeMax baru (catatan client 2026-09), bukan dari Laravel.
   */
  static readonly SETTINGS = z.object({
    // Rekening opsional sejak QRIS (2026-10-01): dipakai hanya bila gambar QRIS belum diunggah.
    bankName: optionalText(60, 'Nama bank maksimal 60 karakter.'),
    accountNumber: optionalText(40, 'Nomor rekening maksimal 40 karakter.'),
    accountHolder: optionalText(80, 'Nama pemilik rekening maksimal 80 karakter.'),
    /** Nama merchant yang tercetak di QRIS (ditampilkan di bawah gambar). */
    qrisMerchantName: optionalText(80, 'Nama merchant QRIS maksimal 80 karakter.'),
    holdMinutes: z.preprocess(
      emptyToUndefined,
      z.coerce
        .number({ error: HOLD_REQUIRED })
        .int({ error: 'Durasi hold harus bilangan bulat.' })
        .min(15, { error: HOLD_RANGE })
        .max(1440, { error: HOLD_RANGE })
    ),
    adminFee: requiredInt(FEE_REQUIRED, 0, 10_000, FEE_RANGE),
    uniqueCodeMax: requiredInt(CODE_MAX_REQUIRED, 100, 999, CODE_MAX_RANGE)
  })
}

export type PaymentSettingsInput = z.infer<typeof PaymentValidation.SETTINGS>
