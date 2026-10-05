import { Transaction } from '@prisma/client'
import type { BookingSessionDto, PaymentDetailDto, PaymentRedirectDto, TransferPaymentDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { ADMIN_URL } from '../config'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, formatInstant, now, translatedDate } from '../utils/clock'
import { transferTotal } from '../utils/money'
import { attachProof, bankAccount, qrisSetting } from './manual-payment-services'
import { deletePrivateFile, proofMimeFor, readPrivateFile, storePaymentProof } from './payment-proof-services'

// ============================================================================
// === Pembayaran sisi pelanggan — port dari Public\PaymentController ===
// ============================================================================
// Instruksi transfer satu booking, unggah bukti, dan pengambilan berkas bukti. Berkas bukti adalah
// dokumen bank: tidak pernah lewat /uploads publik, selalu di-stream setelah pemeriksaan pemilik.

const NOT_FOUND = 'Booking tidak ditemukan'

/**
 * URL absolut yang dikodekan ke QR pelanggan; membuka halaman check-in staff di panel admin.
 * Setara route('admin.checkin.show', token) Laravel.
 */
export function checkInUrl(token: string | null): string | null {
  if (!token) return null
  return `${ADMIN_URL.replace(/\/+$/, '')}/checkin/${token}`
}

type LeadWithPayment = NonNullable<Awaited<ReturnType<typeof loadOwnedBooking>>>

/**
 * Booking milik pemanggil. Booking orang lain dijawab 404, bukan 403 (Laravel): jawaban yang sama untuk
 * "tidak ada" dan "bukan milikmu" tidak membocorkan keberadaan booking.
 */
async function loadOwnedBooking(userId: string, bookingId: string) {
  const booking = await prismaClient.booking.findUnique({
    where: { id: bookingId },
    include: { facility: { select: { name: true } }, facilityUnit: { select: { name: true } }, transaction: true }
  })
  if (!booking || booking.userId !== userId) return null
  return booking
}

/**
 * Jawaban tingkat layar. Pemeriksaan yang berwibawa adalah conditional UPDATE di attachProof(); ini hanya
 * memutuskan apakah form ditampilkan dan memberi alasan jujur saat sudah tidak bisa.
 */
function canUpload(booking: LeadWithPayment): boolean {
  const t = booking.transaction
  if (!t || t.paymentStatus !== 'UNPAID' || t.verificationStatus === 'awaiting') return false
  if (booking.status !== 'pending') return false
  // Carbon isPast(): lebih kecil dari sekarang, tidak sama dengan.
  if (booking.holdExpiresAt && booking.holdExpiresAt.getTime() < now().getTime()) return false
  return true
}

/** Blok pembayaran transfer — sama persis untuk halaman bayar booking dan membership. */
export function presentTransferPayment(transaction: Transaction, uploadAllowed: boolean): TransferPaymentDto {
  return {
    receiptNumber: transaction.invoiceNumber,
    amount: transaction.amount,
    adminFee: transaction.adminFee,
    uniqueCode: transaction.uniqueCode ?? 0,
    total: transferTotal(transaction),
    paymentStatus: transaction.paymentStatus,
    verificationStatus: transaction.verificationStatus,
    rejectionReason: transaction.rejectionReason,
    proofUploadedAt: transaction.proofUploadedAt?.toISOString() ?? null,
    hasProof: Boolean(transaction.proofPath),
    canUpload: uploadAllowed
  }
}

async function presentPayment(booking: LeadWithPayment): Promise<PaymentDetailDto> {
  const transaction = booking.transaction
  if (!transaction) throw new ResponseError(404, 'Pembayaran tidak ditemukan')

  const paid = transaction.paymentStatus === 'PAID'

  // Paket = satu transfer untuk N pertemuan. Menampilkan hanya pertemuan pertama di samping harga
  // sebulan terbaca seperti salah tagih.
  let sessions: BookingSessionDto[] | null = null
  if (booking.bookingGroupId) {
    const group = await prismaClient.booking.findMany({
      where: { bookingGroupId: booking.bookingGroupId },
      orderBy: [{ bookingDate: 'asc' }, { startTime: 'asc' }]
    })
    sessions = group.map((s) => ({
      id: s.id,
      date: translatedDate(dateOnlyToString(s.bookingDate), 'D, d M Y'),
      time: `${s.startTime.slice(0, 5)} – ${s.endTime.slice(0, 5)}`,
      status: s.status,
      checkedInAt: s.checkedInAt ? formatInstant(s.checkedInAt, 'd M H:i') : null,
      checkInUrl: paid && s.status !== 'cancelled' ? checkInUrl(s.checkInToken) : null
    }))
  }

  return {
    sessions,
    booking: {
      id: booking.id,
      facilityName: booking.facility.name,
      unitName: booking.facilityUnit?.name ?? null,
      date: dateOnlyToString(booking.bookingDate),
      startTime: booking.startTime.slice(0, 5),
      endTime: booking.endTime.slice(0, 5),
      status: booking.status,
      holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null
    },
    payment: presentTransferPayment(transaction, canUpload(booking)),
    bank: await bankAccount(),
    qris: await qrisSetting(),
    // Tiket baru ada setelah uang dikonfirmasi; sebelum itu QR hanya jadi cara masuk tanpa bayar.
    ticket:
      paid && booking.status !== 'cancelled'
        ? {
            checkInUrl: checkInUrl(booking.checkInToken) ?? '',
            checkedInAt: booking.checkedInAt ? formatInstant(booking.checkedInAt, 'd M Y H:i') : null
          }
        : null
  }
}

// ===== Instruksi transfer =====

export async function paymentDetail(userId: string, bookingId: string): Promise<PaymentDetailDto | PaymentRedirectDto> {
  const booking = await loadOwnedBooking(userId, bookingId)
  if (!booking) throw new ResponseError(404, NOT_FOUND)

  // Hanya lead paket yang memegang transfer; URL anggota diarahkan ke lead.
  if (booking.bookingGroupId && booking.bookingGroupId !== booking.id) return { redirectToBookingId: booking.bookingGroupId }

  return presentPayment(booking)
}

// ===== Unggah bukti =====

export interface UploadedFile {
  buffer: Buffer
  size: number
}

export async function uploadPaymentProof(userId: string, bookingId: string, file: UploadedFile | undefined): Promise<PaymentDetailDto> {
  const booking = await loadOwnedBooking(userId, bookingId)
  if (!booking) throw new ResponseError(404, NOT_FOUND)
  if (!booking.transaction) throw new ResponseError(404, 'Pembayaran tidak ditemukan')

  if (!canUpload(booking)) {
    const msg = 'Pembayaran ini sudah tidak menerima unggahan bukti.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { proof: [msg] })
  }
  if (!file || file.size === 0) {
    const msg = 'Pilih gambar bukti transfer terlebih dahulu.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { proof: [msg] })
  }

  // Validasi isi (decoder, bukan ekstensi) + encode ulang terjadi di sini.
  const storedPath = await storePaymentProof(file.buffer, booking.transaction.id)

  try {
    await attachProof(booking.transaction.id, storedPath)
  } catch (error) {
    // Berkas yang baru ditulis tidak pernah dirujuk baris mana pun — jangan tinggalkan sampah di disk.
    deletePrivateFile(storedPath)
    throw error
  }

  const fresh = await loadOwnedBooking(userId, bookingId)
  if (!fresh) throw new ResponseError(404, NOT_FOUND)
  return presentPayment(fresh)
}

// ===== Berkas bukti =====

export interface ProofFile {
  data: Buffer
  mime: string
  fileName: string
}

async function proofFileFor(transactionId: string, ownerId: string | null): Promise<ProofFile> {
  const transaction = await prismaClient.transaction.findUnique({
    where: { id: transactionId },
    select: { userId: true, proofPath: true, invoiceNumber: true }
  })
  // ownerId null = staff yang sudah lolos requireAnyPermission di route.
  if (!transaction || (ownerId !== null && transaction.userId !== ownerId)) throw new ResponseError(404, 'Bukti transfer tidak ditemukan')
  const data = transaction.proofPath ? await readPrivateFile(transaction.proofPath) : null
  if (!transaction.proofPath || !data) throw new ResponseError(404, 'Bukti transfer tidak ditemukan')

  const extension = transaction.proofPath.endsWith('.png') ? 'png' : 'webp'
  return {
    data,
    mime: proofMimeFor(transaction.proofPath),
    fileName: `bukti-${transaction.invoiceNumber}.${extension}`
  }
}

/** GET /api/customer/payments/:transactionId/bukti — hanya pemilik transaksi. */
export function customerProofFile(userId: string, transactionId: string): Promise<ProofFile> {
  return proofFileFor(transactionId, userId)
}

/** GET /api/admin/payments/:transactionId/bukti — staff dengan bookings.manage atau payments.manage. */
export function staffProofFile(transactionId: string): Promise<ProofFile> {
  return proofFileFor(transactionId, null)
}
