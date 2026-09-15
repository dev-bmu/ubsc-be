import { z } from 'zod'

// ===== Validasi verifikasi pembayaran (panel staff) =====

const REASON_REQUIRED = 'Tulis alasan penolakan agar pengguna tahu harus memperbaiki apa.'

export class PaymentValidation {
  /** POST /api/admin/payments/:transactionId/reject — alasannya dikirim ke pelanggan lewat email. */
  static readonly REJECT = z.object({
    reason: z
      .string({ error: REASON_REQUIRED })
      .trim()
      .min(1, { error: REASON_REQUIRED })
      .max(300, { error: 'Alasan penolakan maksimal 300 karakter.' })
  })
}
