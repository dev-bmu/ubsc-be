import type { PendingPaymentDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { now } from '../utils/clock'
import { transferTotal } from '../utils/money'

// ===== Transfer tertunda paling mendesak milik satu customer =====
// Port dari HandleInertiaRequests::pendingPayment (app/Http/Middleware/HandleInertiaRequests.php:71-102).
// Di Laravel ini prop Inertia yang ikut di SETIAP response; di sini ia endpoint tersendiri karena
// per-user dan tidak boleh ikut ter-cache bersama HomeDto (lihat catatan di kepala shared/contracts.ts).
//
// `Schema::hasColumn('bookings','hold_expires_at')` TIDAK diport: kolomnya dijamin ada oleh Prisma.
// Guard itu di Laravel hanya pagar untuk instalasi yang belum dimigrasikan.

/**
 * Booking pending milik user yang transaksinya masih UNPAID dan hold-nya belum lewat.
 *
 * Urutan Laravel: `ORDER BY hold_expires_at IS NULL, hold_expires_at ASC` — yang punya tenggat lebih
 * dulu (paling mendesak), yang tanpa tenggat paling belakang. MySQL mengurutkan NULL lebih dulu secara
 * default, jadi ekspresi `IS NULL` itulah yang membalikkannya; di Prisma padanannya `nulls: 'last'`.
 */
export async function getPendingPayment(userId: string): Promise<PendingPaymentDto | null> {
  const at = now()

  const open = await prismaClient.booking.findMany({
    where: {
      userId,
      status: 'pending',
      OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: at } }],
      transaction: { paymentStatus: 'UNPAID' }
    },
    select: {
      id: true,
      holdExpiresAt: true,
      transaction: { select: { invoiceNumber: true, verificationStatus: true, amount: true, adminFee: true, uniqueCode: true } }
    },
    orderBy: { holdExpiresAt: { sort: 'asc', nulls: 'last' } }
  })

  if (open.length === 0) return null

  // Yang masih HARUS ditransfer didahulukan; yang buktinya sudah dikirim tinggal menunggu.
  const first = open.find((b) => b.transaction?.verificationStatus !== 'awaiting') ?? open[0]
  const tx = first.transaction

  return {
    count: open.length,
    awaitingCount: open.filter((b) => b.transaction?.verificationStatus === 'awaiting').length,
    bookingId: first.id,
    receipt: tx ? tx.invoiceNumber : null,
    awaiting: tx?.verificationStatus === 'awaiting',
    total: tx ? transferTotal(tx) : 0,
    holdExpiresAt: first.holdExpiresAt?.toISOString() ?? null,
    // Path halaman Next, bukan URL absolut: pemanggilnya satu-satunya adalah Navbar landing.
    url: `/booking/${first.id}/pembayaran`
  }
}
