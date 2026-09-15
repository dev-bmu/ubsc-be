import { randomInt } from 'crypto'
import { Prisma } from '@prisma/client'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, now } from '../utils/clock'
import { logger } from '../utils/logger'
import { isUniqueViolation, withConflictRetry } from '../utils/prisma-errors'
import { deletePrivateFile } from './payment-proof-services'

// ============================================================================
// === ManualPayment — transfer bank yang diverifikasi staff ===
// ============================================================================
// Port dari app/Support/ManualPayment.php. Tiga hal yang MENANGGUNG BEBAN dan mudah salah:
//
// 1. KODE UNIK. Setiap transfer yang belum selesai diberi total rupiah yang berbeda, sehingga satu
//    baris di rekening koran menunjuk tepat satu booking. Keunikan dijamin UNIQUE index pada
//    transactions.pendingTotal, BUKAN oleh query "sudah dipakai?" — dua checkout di milidetik yang
//    sama akan membaca kode bebas yang sama. P2002 yang ditangkap di dalam transaksi interaktif TIDAK
//    mematikan transaksinya (terverifikasi), jadi loop coba-insert aman.
//
// 2. HOLD. Booking pending menahan slot hanya sampai holdExpiresAt. Begitu bukti diunggah, hold
//    menjadi tanpa batas (NULL) karena uang pelanggan sudah keluar dari rekeningnya.
//
// 3. KUNCI DULU, BARU BACA DAN TULIS. Rewrite.md mengandalkan `updateMany().count` sebagai
//    compare-and-swap. TIDAK BERLAKU di Prisma 7 dengan relationMode = "prisma": updateMany dikompilasi
//    menjadi `SELECT id ... WHERE <syarat>` (baca TANPA kunci) lalu `UPDATE ... WHERE id IN (...)` yang
//    TIDAK mengulang syaratnya (terverifikasi dari log query, Fase 3). Dua transaksi bisa sama-sama
//    membaca UNPAID lalu sama-sama menulis — test konkurensi menangkap approve dan expire yang
//    dua-duanya "menang". Karena itu setiap operasi di bawah mengambil `SELECT ... FOR UPDATE` lebih
//    dulu; pola baca-cek-tulis setelahnya aman HANYA karena kunci itu dipegang sampai commit.
//
// Urutan kunci SERAGAM di semua operasi: baris transaksi DULU, lalu baris booking grupnya. Laravel
// mengunci dengan urutan terbalik di attachProof dibanding expire — deadlock saat bukti masuk bersamaan
// dengan sweep. Siapa pun yang kelak menulis status booking berbayar (panel admin Fase 8) wajib
// mengikuti urutan yang sama.

type Db = Prisma.TransactionClient

/** Kode ditambahkan ke harga, jadi harus di bawah 1000. */
const CODE_MIN = 1
const CODE_MAX = 999
/** Batas percobaan alokasi kode (R11) — setelah itu gagal bersih, tidak berputar. */
const CODE_ATTEMPTS = 25

export const DEFAULT_HOLD_MINUTES = 120

// ===== Pengaturan =====

async function setting(key: string, fallback: string): Promise<string> {
  const row = await prismaClient.systemSetting.findUnique({ where: { key }, select: { value: true } })
  return row?.value ?? fallback
}

export async function holdMinutes(): Promise<number> {
  const configured = Math.trunc(Number(await setting('payment_hold_minutes', String(DEFAULT_HOLD_MINUTES))))
  return configured > 0 ? configured : DEFAULT_HOLD_MINUTES
}

export async function bankAccount(): Promise<{ bank: string; accountNumber: string; accountHolder: string }> {
  const [bank, accountNumber, accountHolder] = await Promise.all([
    setting('payment_bank_name', ''),
    setting('payment_bank_account_number', ''),
    setting('payment_bank_account_holder', '')
  ])
  return { bank, accountNumber, accountHolder }
}

export async function isConfigured(): Promise<boolean> {
  const account = await bankAccount()
  return account.bank !== '' && account.accountNumber !== ''
}

// ===== Grup booking & kunci =====

interface LeadRef {
  id: string
  bookingGroupId: string | null
}

/**
 * Semua booking yang dibayar transaksi lead ini. Booking standalone adalah grup berisi satu; lead
 * paket menyimpan ID-nya sendiri di bookingGroupId, jadi satu klausa mencakup seluruh grup.
 */
function groupWhere(lead: LeadRef): Prisma.BookingWhereInput {
  return lead.bookingGroupId ? { bookingGroupId: lead.bookingGroupId } : { id: lead.id }
}

/** Kunci baris transaksi — SELALU statement pertama. false bila transaksinya tidak ada. */
async function lockTransaction(tx: Db, transactionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM transactions WHERE id = ${transactionId} FOR UPDATE`
  return rows.length > 0
}

/** Kunci seluruh baris booking grup, SETELAH baris transaksinya. */
async function lockGroup(tx: Db, lead: LeadRef): Promise<void> {
  if (lead.bookingGroupId) {
    await tx.$queryRaw`SELECT id FROM bookings WHERE bookingGroupId = ${lead.bookingGroupId} FOR UPDATE`
  } else {
    await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${lead.id} FOR UPDATE`
  }
}

/** Baca transaksi yang SUDAH dikunci, beserta lead booking-nya. */
function lockedTransaction(tx: Db, transactionId: string) {
  return tx.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: {
      paymentStatus: true,
      verificationStatus: true,
      proofPath: true,
      membershipId: true,
      booking: { select: { id: true, bookingGroupId: true } }
    }
  })
}

// ===== 1. Buka transfer =====

/** Kode bebas untuk nominal ini, diacak. Hanya transfer yang belum selesai yang memakai kode. */
async function candidateCodes(tx: Db, amount: number): Promise<number[]> {
  const taken = await tx.transaction.findMany({
    where: { pendingTotal: { gte: amount + CODE_MIN, lte: amount + CODE_MAX } },
    select: { pendingTotal: true }
  })
  const used = new Set(taken.map((t) => (t.pendingTotal as number) - amount))
  const free: number[] = []
  for (let code = CODE_MIN; code <= CODE_MAX; code++) if (!used.has(code)) free.push(code)

  // Fisher-Yates dengan crypto.randomInt: dua checkout bersamaan sebaiknya tidak mencoba kode yang sama duluan.
  for (let i = free.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[free[i], free[j]] = [free[j], free[i]]
  }
  return free.slice(0, CODE_ATTEMPTS)
}

export interface TransferSubject {
  bookingId?: string
  membershipId?: string
}

/**
 * Buka transfer untuk subject senilai `amount` rupiah.
 *
 * WAJIB dipanggil di dalam transaksi yang sudah memegang kunci yang dibutuhkan pemanggil; fungsi ini
 * hanya menambahkan alokasi kode.
 */
export async function openTransfer(tx: Db, subject: TransferSubject, userId: string, amount: number, expiresAt: Date) {
  if (Boolean(subject.bookingId) === Boolean(subject.membershipId)) {
    // Pengganti polymorphic transactionable: TEPAT SATU yang boleh terisi.
    throw new Error('openTransfer butuh tepat satu dari bookingId / membershipId')
  }

  // Coba-insert, bukan pre-check: request lain bisa mengambil kode di antara baca dan tulis kita,
  // dan UNIQUE index-lah yang memutuskan.
  for (const code of await candidateCodes(tx, amount)) {
    try {
      return await tx.transaction.create({
        data: {
          userId,
          bookingId: subject.bookingId ?? null,
          membershipId: subject.membershipId ?? null,
          amount,
          method: 'manual',
          uniqueCode: code,
          pendingTotal: amount + code,
          paymentStatus: 'UNPAID',
          expiresAt
        }
      })
    } catch (e) {
      if (!isUniqueViolation(e, 'pendingTotal')) throw e
    }
  }

  throw new ResponseError(409, 'Tidak ada kode unik tersisa untuk nominal ini. Coba beberapa saat lagi.', 'PENDING_TOTAL_EXHAUSTED')
}

// ===== 2. Lampirkan bukti =====

export const HOLD_LAPSED_MESSAGE = 'Batas waktu transfer sudah lewat dan slot telah dilepas. Silakan pesan ulang.'

/**
 * Lampirkan bukti dan pindahkan transfer ke antrean verifikasi. Hold booking menjadi tanpa batas.
 *
 * Hold harus masih HIDUP saat bukti mendarat. Begitu lewat, slotnya dijual lagi dan mungkin sudah
 * ditahan orang lain — mengubah hold booking ini kembali jadi tanpa batas berarti dua booking hidup
 * di satu slot. Pemeriksaan dan penulisan terjadi di bawah kunci baris transaksi + grup, jadi sweep
 * expiry tidak bisa menyelip di antaranya.
 *
 * Untuk paket: semua atau tidak sama sekali. Satu sesi yang hold-nya lewat menggagalkan seluruh grup —
 * mengklaim hanya sesi yang selamat berarti mengonfirmasi pembelian yang salah satu sesinya sudah dijual.
 */
export async function attachProof(transactionId: string, storedPath: string): Promise<void> {
  const previousPath = await withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      if (!(await lockTransaction(tx, transactionId))) throw new ResponseError(404, 'Transaksi tidak ditemukan')
      const transaction = await lockedTransaction(tx, transactionId)

      if (transaction.booking) {
        await lockGroup(tx, transaction.booking)
        const group = await tx.booking.findMany({ where: groupWhere(transaction.booking), select: { status: true, holdExpiresAt: true } })
        const at = now()
        const allAlive =
          group.length > 0 && group.every((b) => b.status === 'pending' && (b.holdExpiresAt === null || b.holdExpiresAt.getTime() > at.getTime()))
        if (!allAlive) throw new ResponseError(409, HOLD_LAPSED_MESSAGE, 'HOLD_LAPSED', { proof: [HOLD_LAPSED_MESSAGE] })

        await tx.booking.updateMany({ where: groupWhere(transaction.booking), data: { holdExpiresAt: null } })
      }

      await tx.transaction.update({
        where: { id: transactionId },
        data: { proofPath: storedPath, proofUploadedAt: now(), verificationStatus: 'awaiting', rejectionReason: null }
      })

      return transaction.proofPath
    }, TX_OPTIONS)
  )

  // Unggahan ulang menggantikan berkas lama — dihapus SETELAH commit, supaya rollback tidak pernah
  // meninggalkan baris DB yang menunjuk berkas yang sudah hilang.
  if (previousPath && previousPath !== storedPath) deletePrivateFile(previousPath)
}

// ===== 3. Setujui =====

/** Hasil approve/reject: cukup untuk menyusun email pelanggan SETELAH commit, tanpa query ulang. */
export interface PaymentDecision {
  transactionId: string
  receiptSequence: number
  amount: number
  rejectionReason: string | null
  customer: { email: string | null; name: string | null }
  /** Booking lead yang dibayar transaksi ini; null untuk transaksi membership. */
  booking: { id: string; facilityName: string; unitName: string | null; date: string; startTime: string; endTime: string } | null
}

async function decisionInfo(tx: Db, transactionId: string): Promise<PaymentDecision> {
  const t = await tx.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: {
      id: true,
      receiptSequence: true,
      amount: true,
      rejectionReason: true,
      user: { select: { email: true, name: true } },
      booking: {
        select: {
          id: true,
          bookingDate: true,
          startTime: true,
          endTime: true,
          facility: { select: { name: true } },
          facilityUnit: { select: { name: true } }
        }
      }
    }
  })
  return {
    transactionId: t.id,
    receiptSequence: t.receiptSequence,
    amount: t.amount,
    rejectionReason: t.rejectionReason,
    customer: { email: t.user?.email ?? null, name: t.user?.name ?? null },
    booking: t.booking
      ? {
          id: t.booking.id,
          facilityName: t.booking.facility.name,
          unitName: t.booking.facilityUnit?.name ?? null,
          date: dateOnlyToString(t.booking.bookingDate),
          startTime: t.booking.startTime,
          endTime: t.booking.endTime
        }
      : null
  }
}

const ALREADY_PROCESSED = 'Transaksi sudah diproses.'

/**
 * Kunci transaksi, pastikan masih UNPAID. Perbaikan atas Laravel (R1): controller Laravel mengecek UNPAID
 * lalu memanggil approve() yang meng-update tanpa syarat — dua staff yang menekan setuju bersamaan
 * sama-sama lolos, dan approve yang berbarengan dengan sweep bisa mengonfirmasi ulang booking yang
 * slotnya sudah dilepas ke orang lain. Di sini cek dan tulis berada di bawah satu kunci.
 */
async function lockUnpaid(tx: Db, transactionId: string) {
  if (!(await lockTransaction(tx, transactionId))) throw new ResponseError(404, 'Transaksi tidak ditemukan')
  const transaction = await lockedTransaction(tx, transactionId)
  if (transaction.paymentStatus !== 'UNPAID') throw new ResponseError(409, ALREADY_PROCESSED, 'CONFLICT')
  if (transaction.booking) await lockGroup(tx, transaction.booking)
  return transaction
}

/** Staff memastikan uangnya masuk. */
export async function approve(transactionId: string, staffId: string): Promise<PaymentDecision> {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const transaction = await lockUnpaid(tx, transactionId)
      const at = now()

      await tx.transaction.update({
        where: { id: transactionId },
        data: {
          paymentStatus: 'PAID',
          verificationStatus: null,
          paidAt: at,
          verifiedById: staffId,
          verifiedAt: at,
          rejectionReason: null,
          // Membebaskan angka rupiah untuk pelanggan berikutnya.
          pendingTotal: null
        }
      })

      if (transaction.booking) {
        // Setiap sesi paket, bukan hanya lead.
        await tx.booking.updateMany({ where: groupWhere(transaction.booking), data: { status: 'confirmed', holdExpiresAt: null } })
      } else if (transaction.membershipId) {
        // Bug 9 Rewrite.md: cabang ini BELUM TERJANGKAU hari ini — semua transaksi membership dibuat
        // langsung PAID oleh membership-services. SENGAJA dipertahankan: menghapusnya berarti alur
        // membership swalayan di masa depan diam-diam meninggalkan membership berstatus pending.
        await tx.membership.update({ where: { id: transaction.membershipId }, data: { status: 'active' } })
      }

      return decisionInfo(tx, transactionId)
    }, TX_OPTIONS)
  )
}

// ===== 4. Tolak =====

/**
 * Staff tidak bisa mencocokkan transfer. Slotnya langsung kembali dijual.
 *
 * Versi lama Laravel menahan booking dengan hold baru supaya pelanggan bisa unggah ulang — bagi
 * orang lain itu terbaca "masih dipesan" oleh pembayaran yang baru dinyatakan tidak sah. Melepasnya
 * adalah hasil yang jujur; pelanggan melihat alasannya dan bisa memesan lagi.
 */
export async function reject(transactionId: string, staffId: string, reason: string): Promise<PaymentDecision> {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const transaction = await lockUnpaid(tx, transactionId)

      await tx.transaction.update({
        where: { id: transactionId },
        data: {
          paymentStatus: 'FAILED',
          verificationStatus: 'rejected',
          verifiedById: staffId,
          verifiedAt: now(),
          rejectionReason: reason,
          pendingTotal: null
        }
      })

      if (transaction.booking) {
        await tx.booking.updateMany({
          where: groupWhere(transaction.booking),
          data: { status: 'cancelled', cancelledReason: 'proof_rejected', holdExpiresAt: null }
        })
      }

      return decisionInfo(tx, transactionId)
    }, TX_OPTIONS)
  )
}

// ===== 5. Kedaluwarsa =====

/**
 * Menyerah pada transfer yang tidak diselesaikan dan mengembalikan slot ke penjualan.
 *
 * Mengembalikan false bila tidak ada yang di-expire: bukti mungkin mendarat di antara SELECT sweep
 * dan sekarang. Pelanggan itu SUDAH membayar; membatalkannya adalah hasil terburuk yang bisa dibuat
 * sistem ini. Karena itu status diperiksa ulang DI BAWAH KUNCI, bukan dari baris yang dipilih sweep.
 */
export async function expire(transactionId: string): Promise<boolean> {
  try {
    return await withConflictRetry(() =>
      prismaClient.$transaction(async (tx) => {
        if (!(await lockTransaction(tx, transactionId))) return false
        const transaction = await lockedTransaction(tx, transactionId)
        if (transaction.paymentStatus !== 'UNPAID' || transaction.verificationStatus !== null) return false

        if (transaction.booking) await lockGroup(tx, transaction.booking)

        await tx.transaction.update({ where: { id: transactionId }, data: { paymentStatus: 'EXPIRED', pendingTotal: null } })

        if (transaction.booking) {
          await tx.booking.updateMany({
            where: { AND: [groupWhere(transaction.booking), { status: 'pending' }] },
            data: { status: 'cancelled', cancelledReason: 'payment_expired', holdExpiresAt: null }
          })
        }
        return true
      }, TX_OPTIONS)
    )
  } catch (e) {
    // Sweep dipanggil dari worker; satu transaksi yang gagal tidak boleh menghentikan sisanya.
    logger.error(`expire(${transactionId}) gagal: ${(e as Error).message}`)
    return false
  }
}

// ===== 6. Lepas booking tanpa transaksi =====

/**
 * Booking pending yang hold-nya habis tapi tidak punya transaksi (data lama / dibuat sebelum alur
 * transfer). Dibatalkan beserta anggota grupnya — di bawah kunci barisnya, dengan alasan yang sama
 * seperti di atas.
 */
export async function releaseWithoutTransaction(leadId: string): Promise<void> {
  await withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${leadId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM bookings WHERE bookingGroupId = ${leadId} FOR UPDATE`
      await tx.booking.updateMany({
        where: { OR: [{ id: leadId }, { bookingGroupId: leadId }], status: 'pending' },
        data: { status: 'cancelled', cancelledReason: 'payment_expired', holdExpiresAt: null }
      })
    }, TX_OPTIONS)
  )
}
