import { Prisma } from '@prisma/client'
import type { AdminPaymentIndexDto, AdminPaymentRowDto, PaymentQueueTab, PaymentSettingsDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { dateOnlyToString, formatInstant, jakartaWallTimeToUtc } from '../utils/clock'
import { receiptNumber, transferTotal } from '../utils/money'
import { PaymentValidation } from '../validation/payment-validation'
import { Validation } from '../validation/Validation'
import { adminFee, bankAccount, holdMinutes, uniqueCodeMax } from './manual-payment-services'

// ============================================================================
// === Antrean verifikasi + pengaturan rekening — port Admin\PaymentVerificationController ===
// ============================================================================
// Hanya index() dan updateSettings(). approve/reject/bukti sudah ada sejak Fase 3
// (payment-verification-services.ts + manual-payment-services.ts) dan TIDAK disentuh di sini.
// Rekening & durasi hold dibaca lewat bankAccount()/holdMinutes() yang sama dengan jalur pelanggan,
// jadi panel dan halaman pembayaran tidak pernah berbeda pendapat.

const QUEUE_LIMIT = 100
const TABS: readonly PaymentQueueTab[] = ['awaiting', 'rejected', 'paid']

/** Transaction::scopeAwaitingVerification — UNPAID + bukti sudah masuk. */
const AWAITING_VERIFICATION = { paymentStatus: 'UNPAID', verificationStatus: 'awaiting' } satisfies Prisma.TransactionWhereInput

/**
 * `$request->string('tab')->toString() ?: 'awaiting'` + `match default`. PENYIMPANGAN kecil: Laravel
 * menggemakan string mentah (tab=xyz -> 'xyz' walau query-nya awaiting); di sini tab dinormalisasi
 * sehingga yang digemakan selalu tab yang benar-benar dijalankan (PaymentQueueTab).
 */
function normalizeTab(value: unknown): PaymentQueueTab {
  const tab = typeof value === 'string' ? value.trim() : ''
  return (TABS as readonly string[]).includes(tab) ? (tab as PaymentQueueTab) : 'awaiting'
}

// ===== Pemuat + present() =====

/** Padanan with(['user:id,name,email,phone_number', 'transactionable', 'verifier:id,name']) + loadMorph. */
const QUEUE_INCLUDE = {
  user: { select: { name: true, email: true, phoneNumber: true } },
  verifiedBy: { select: { name: true } },
  booking: {
    select: {
      bookingDate: true,
      startTime: true,
      endTime: true,
      status: true,
      facility: { select: { name: true } },
      facilityUnit: { select: { name: true } }
    }
  },
  membership: { select: { membershipPlan: { select: { name: true } } } }
} satisfies Prisma.TransactionInclude

type QueueRow = Prisma.TransactionGetPayload<{ include: typeof QUEUE_INCLUDE }>

/**
 * Carbon `->format('d M Y')` pada kolom tanggal: TIDAK diterjemahkan (bulan Inggris, 'Sep'), berbeda dari
 * translatedDate(). Tanggal kalender dijangkarkan ke tengah malam Jakarta supaya formatInstant (yang
 * membaca jam Jakarta) mengembalikan tanggal yang sama.
 */
function formatCalendarDate(value: Date): string {
  return formatInstant(jakartaWallTimeToUtc(dateOnlyToString(value), '00:00'), 'd M Y')
}

/** present() Laravel. Semua instan diformat 'd M Y H:i' jam Jakarta, bulan Inggris (Carbon::format). */
function presentRow(t: QueueRow): AdminPaymentRowDto {
  const uniqueCode = t.uniqueCode ?? 0

  // `$subject instanceof Booking` / `instanceof Membership`: yang dicek adalah relasi yang TERMUAT, bukan
  // sekadar kolom id — transaksi booking yang barisnya hilang jatuh ke cabang { plan } dengan type booking.
  const subject: Record<string, string | null> = t.booking
    ? {
        facility: t.booking.facility?.name ?? '-',
        unit: t.booking.facilityUnit?.name ?? null,
        date: formatCalendarDate(t.booking.bookingDate),
        time: `${t.booking.startTime.slice(0, 5)} - ${t.booking.endTime.slice(0, 5)}`,
        status: t.booking.status
      }
    : { plan: t.membership?.membershipPlan?.name ?? 'Membership' }

  return {
    id: t.id,
    receiptNumber: receiptNumber(t.receiptSequence),
    amount: t.amount,
    adminFee: t.adminFee,
    uniqueCode,
    total: transferTotal(t),
    paymentStatus: t.paymentStatus,
    verificationStatus: t.verificationStatus,
    rejectionReason: t.rejectionReason,
    // route('payments.proof') Laravel -> path relatif terhadap baseURL axios admin ('/api').
    proofUrl: t.proofPath ? `/admin/payments/${t.id}/bukti` : null,
    proofUploadedAt: t.proofUploadedAt ? formatInstant(t.proofUploadedAt, 'd M Y H:i') : null,
    paidAt: t.paidAt ? formatInstant(t.paidAt, 'd M Y H:i') : null,
    verifiedBy: t.verifiedBy?.name ?? null,
    customer: {
      name: t.user?.name ?? '-',
      email: t.user?.email ?? null,
      phone: t.user?.phoneNumber ?? null
    },
    type: t.membership ? 'membership' : 'booking',
    subject
  }
}

// ===== 1. Index — antrean per tab =====

/**
 * Urutan per tab. Laravel hanya memberi satu kunci (atau tidak sama sekali); kunci kedua receiptSequence
 * (padanan PK auto-increment Laravel, yang juga sumber receipt_number) ditambahkan supaya urutan seri
 * deterministik:
 *   awaiting  oldest('proof_uploaded_at')  -> proofUploadedAt ASC, receiptSequence ASC
 *   paid      latest('paid_at')            -> paidAt DESC, receiptSequence DESC
 *   rejected  tanpa orderBy (urutan fisik MySQL ~ PK) -> receiptSequence ASC
 */
function queueQuery(tab: PaymentQueueTab): { where: Prisma.TransactionWhereInput; orderBy: Prisma.TransactionOrderByWithRelationInput[] } {
  switch (tab) {
    case 'rejected':
      return { where: { method: 'manual', verificationStatus: 'rejected' }, orderBy: [{ receiptSequence: 'asc' }] }
    case 'paid':
      return { where: { method: 'manual', paymentStatus: 'PAID' }, orderBy: [{ paidAt: 'desc' }, { receiptSequence: 'desc' }] }
    default:
      return { where: { method: 'manual', ...AWAITING_VERIFICATION }, orderBy: [{ proofUploadedAt: 'asc' }, { receiptSequence: 'asc' }] }
  }
}

export async function listPaymentQueue(query: unknown): Promise<AdminPaymentIndexDto> {
  const tab = normalizeTab((query as Record<string, unknown> | undefined)?.tab)
  const { where, orderBy } = queueQuery(tab)

  const [rows, awaiting, rejected, settings] = await Promise.all([
    prismaClient.transaction.findMany({ where, orderBy, take: QUEUE_LIMIT, include: QUEUE_INCLUDE }),
    // Hitungan badge TIDAK difilter method='manual' — sama persis dengan Laravel.
    prismaClient.transaction.count({ where: AWAITING_VERIFICATION }),
    prismaClient.transaction.count({ where: { verificationStatus: 'rejected' } }),
    paymentSettings()
  ])

  return { tab, transactions: rows.map(presentRow), counts: { awaiting, rejected }, ...settings }
}

/** Keadaan pengaturan, dibaca lewat helper yang sama dengan jalur pelanggan. */
async function paymentSettings(): Promise<PaymentSettingsDto> {
  const [bank, hold, fee, codeMax] = await Promise.all([bankAccount(), holdMinutes(), adminFee(), uniqueCodeMax()])
  return { bank, holdMinutes: hold, adminFee: fee, uniqueCodeMax: codeMax }
}

// ===== 2. Pengaturan rekening, durasi hold, biaya admin, kode unik =====

/**
 * Laravel membalas redirect back() + flash; di sini dibalas keadaan tersimpan (dibaca ulang lewat helper
 * yang sama dengan index) supaya panel bisa langsung memperbarui kartu rekening tanpa refetch.
 *
 * Mengubah biaya admin tidak menyentuh transfer yang sudah terbuka: nominalnya disalin ke
 * transactions.adminFee saat dibuka.
 */
export async function updatePaymentSettings(request: unknown): Promise<PaymentSettingsDto> {
  const v = Validation.validate(PaymentValidation.SETTINGS, request)

  // SystemSetting::set = updateOrCreate(['key' => ...], ['value' => ...]); semuanya dalam satu DB::transaction.
  const entries: Array<[string, string]> = [
    ['payment_bank_name', v.bankName],
    ['payment_bank_account_number', v.accountNumber],
    ['payment_bank_account_holder', v.accountHolder],
    ['payment_hold_minutes', String(v.holdMinutes)],
    ['payment_admin_fee', String(v.adminFee)],
    ['payment_unique_code_max', String(v.uniqueCodeMax)]
  ]
  await prismaClient.$transaction(
    entries.map(([key, value]) => prismaClient.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } })),
    { isolationLevel: TX_OPTIONS.isolationLevel }
  )

  return paymentSettings()
}
