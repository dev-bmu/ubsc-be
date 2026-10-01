import type { PaymentDecisionDto } from '../../shared/contracts'
import { LANDING_URL } from '../config'
import { receiptNumber } from '../utils/money'
import { sendMailSafe } from '../utils/mailer'
import { membershipActiveTemplate, paymentApprovedTemplate, paymentRejectedTemplate } from '../utils/mail-templates'
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

/** Beranda landing membuka modal Membership Gym (kartu) untuk ?kartu=1 setelah login. */
export const MEMBERSHIP_CARD_PATH = '/?kartu=1'

function decisionDto(decision: PaymentDecision, mailQueued: boolean): PaymentDecisionDto {
  return { transactionId: decision.transactionId, receiptNumber: receiptNumber(decision.receiptSequence), mailQueued }
}

/** Staff memastikan uangnya masuk: seluruh sesi grup terkonfirmasi. */
export async function approvePayment(transactionId: string, staffId: string): Promise<PaymentDecisionDto> {
  const decision = await approve(transactionId, staffId)

  const email = decision.customer.email
  const membership = decision.membership
  if (email && membership?.customerNumber) {
    // Membership online: email "reservasi terkonfirmasi" tidak cocok — kirim kartu member-nya.
    void sendMailSafe(
      membershipActiveTemplate({
        to: email,
        name: decision.customer.name ?? 'Member',
        planName: membership.planName,
        startDate: membership.startDate,
        endDate: membership.endDate,
        customerNumber: membership.customerNumber,
        payment: { receiptNumber: receiptNumber(decision.receiptSequence), total: decision.total },
        cardUrl: landing(MEMBERSHIP_CARD_PATH)
      })
    )
  } else if (email) {
    void sendMailSafe(
      paymentApprovedTemplate({
        to: email,
        receiptNumber: receiptNumber(decision.receiptSequence),
        amount: decision.total,
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
        // Membership yang ditolak dibeli ulang dari halaman paket, bukan dari /booking.
        bookingUrl: landing(decision.membership ? '/pricing' : '/booking')
      })
    )
  }

  return decisionDto(decision, Boolean(email))
}
