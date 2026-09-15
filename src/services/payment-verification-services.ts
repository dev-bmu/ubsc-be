import type { PaymentDecisionDto } from '../../shared/contracts'
import { LANDING_URL } from '../config'
import { receiptNumber } from '../utils/money'
import { sendMailSafe } from '../utils/mailer'
import { paymentApprovedTemplate, paymentRejectedTemplate } from '../utils/mail-templates'
import { PaymentValidation } from '../validation/payment-validation'
import { Validation } from '../validation/Validation'
import { approve, PaymentDecision, reject } from './manual-payment-services'

// ============================================================================
// === Verifikasi pembayaran oleh staff — port dari Admin\PaymentVerificationController ===
// ============================================================================
// Keputusan dulu, email sesudahnya. Laravel mengirim email secara inline dan menunggu hasilnya; di sini
// email dikirim `void sendMailSafe()` SETELAH transaksi commit (Rewrite.md, R8): kegagalan SMTP tidak
// boleh muncul sebagai 500 setelah pembayaran benar-benar disetujui, dan tidak boleh menahan request.
// Kiriman yang gagal tercatat di email_logs untuk dikirim ulang dari panel admin.

const landing = (path: string) => `${LANDING_URL.replace(/\/+$/, '')}${path}`

function decisionDto(decision: PaymentDecision, mailQueued: boolean): PaymentDecisionDto {
  return { transactionId: decision.transactionId, receiptNumber: receiptNumber(decision.receiptSequence), mailQueued }
}

/** Staff memastikan uangnya masuk: seluruh sesi grup terkonfirmasi. */
export async function approvePayment(transactionId: string, staffId: string): Promise<PaymentDecisionDto> {
  const decision = await approve(transactionId, staffId)

  const email = decision.customer.email
  if (email) {
    void sendMailSafe(
      paymentApprovedTemplate({
        to: email,
        receiptNumber: receiptNumber(decision.receiptSequence),
        amount: decision.amount,
        booking: decision.booking ? { ...decision.booking, url: landing(`/booking/${decision.booking.id}/pembayaran`) } : null
      })
    )
  }

  return decisionDto(decision, Boolean(email))
}

/** Staff tidak bisa mencocokkan transfer: grup dibatalkan dan slotnya langsung dijual lagi. */
export async function rejectPayment(transactionId: string, staffId: string, request: unknown): Promise<PaymentDecisionDto> {
  const v = Validation.validate(PaymentValidation.REJECT, request)
  const decision = await reject(transactionId, staffId, v.reason)

  const email = decision.customer.email
  if (email) {
    void sendMailSafe(
      paymentRejectedTemplate({
        to: email,
        receiptNumber: receiptNumber(decision.receiptSequence),
        reason: decision.rejectionReason ?? '-',
        booking: decision.booking,
        bookingUrl: landing('/booking')
      })
    )
  }

  return decisionDto(decision, Boolean(email))
}
