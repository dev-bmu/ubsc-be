import { prismaClient } from '../application/database'
import { expire, releaseWithoutTransaction } from '../services/manual-payment-services'
import { now } from '../utils/clock'
import { logger } from '../utils/logger'

// ===== payments:release-expired — port dari Console\Commands\ReleaseExpiredPayments =====
// Membatalkan booking yang jendela transfernya tutup dan mengembalikan slotnya ke penjualan.
// Dijadwalkan tiap 5 menit oleh jobs/scheduler.ts, hanya di proses worker.

/** Batas satu putaran. Sisanya diambil putaran berikutnya — lima menit lagi. */
const BATCH_SIZE = 500

export async function releaseExpiredPayments(): Promise<number> {
  // Waktu dikirim sebagai parameter, tidak pernah NOW() SQL (R13).
  const at = now()

  // Hanya hold yang BENAR-BENAR habis. Hold NULL berarti dibuat staff, atau bukti sudah masuk dan
  // manusia masih harus memeriksanya — keduanya bukan urusan sweep ini.
  const expired = await prismaClient.booking.findMany({
    where: {
      status: 'pending',
      holdExpiresAt: { not: null, lte: at },
      // Hanya lead dan booking standalone. Anggota paket dibatalkan oleh expire() milik lead-nya, yang
      // memeriksa ulang status pembayaran lebih dulu; mengambil anggota di sini bisa membatalkan satu
      // sesi tepat saat bukti pembayarannya tiba.
      OR: [{ bookingGroupId: null }, { bookingGroupId: { equals: prismaClient.booking.fields.id } }]
    },
    select: { id: true, transaction: { select: { id: true, paymentStatus: true } } },
    orderBy: { holdExpiresAt: 'asc' },
    take: BATCH_SIZE
  })

  let released = 0

  for (const booking of expired) {
    const transaction = booking.transaction

    // Dikonfirmasi di antara query dan sekarang; biarkan.
    if (transaction?.paymentStatus === 'PAID') continue

    if (transaction) {
      // false = bukti mendarat setelah baris ini terpilih; biarkan. Bukan error.
      if (!(await expire(transaction.id))) continue
    } else {
      await releaseWithoutTransaction(booking.id)
    }

    released++
  }

  // Membership yang dibeli online: hold-nya ada di transaksi (expiresAt), bukan di baris booking.
  // expire() memeriksa ulang di bawah kunci — transfer yang buktinya sudah masuk dilewati.
  const expiredMembershipTransfers = await prismaClient.transaction.findMany({
    where: { membershipId: { not: null }, paymentStatus: 'UNPAID', verificationStatus: null, expiresAt: { not: null, lte: at } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: BATCH_SIZE
  })
  for (const transaction of expiredMembershipTransfers) {
    if (await expire(transaction.id)) released++
  }

  logger.info(`payments:release-expired melepas ${released} hold (booking + membership) yang kedaluwarsa`)
  return released
}
