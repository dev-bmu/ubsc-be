import { randomInt } from 'crypto'
import { Prisma, UserCategory } from '@prisma/client'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, jakartaDate, now } from '../utils/clock'
import { logger } from '../utils/logger'
import { customerNumber, invoiceNumber, transferTotal } from '../utils/money'
import { isUniqueViolation, withConflictRetry } from '../utils/prisma-errors'
import { activatePendingMembership, lapsePendingMembership } from './membership-services'
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
/** Pembaca setting: klien biasa, atau klien transaksi supaya dibaca di koneksi yang sama. */
type SettingsDb = Pick<Prisma.TransactionClient, 'systemSetting'>

/** Kode 0 tidak bisa dibedakan dari "tanpa kode". */
const CODE_MIN = 1
/** Kode ditambahkan ke harga, jadi batas atasnya di bawah 1000. */
export const CODE_MAX_LIMIT = 999
/** Batas percobaan alokasi kode (R11) — setelah itu gagal bersih, tidak berputar. */
const CODE_ATTEMPTS = 25

export const DEFAULT_HOLD_MINUTES = 120
/** Catatan client 2026-09: biaya admin Rp500 + kode unik maksimal 500 — tambahan paling banyak Rp1.000. */
export const DEFAULT_ADMIN_FEE = 500
export const DEFAULT_UNIQUE_CODE_MAX = 500

// ===== Pengaturan =====

async function setting(key: string, fallback: string, db: SettingsDb = prismaClient): Promise<string> {
  const row = await db.systemSetting.findUnique({ where: { key }, select: { value: true } })
  return row?.value ?? fallback
}

export async function holdMinutes(): Promise<number> {
  const configured = Math.trunc(Number(await setting('payment_hold_minutes', String(DEFAULT_HOLD_MINUTES))))
  return configured > 0 ? configured : DEFAULT_HOLD_MINUTES
}

/** Rupiah per transaksi; 0 = biaya admin dimatikan. */
export async function adminFee(db?: SettingsDb): Promise<number> {
  const configured = Math.trunc(Number(await setting('payment_admin_fee', String(DEFAULT_ADMIN_FEE), db)))
  return configured >= 0 ? configured : DEFAULT_ADMIN_FEE
}

/** Batas atas kode unik. Kapasitas transfer terbuka bersamaan per nominal = nilai ini. */
export async function uniqueCodeMax(db?: SettingsDb): Promise<number> {
  const configured = Math.trunc(Number(await setting('payment_unique_code_max', String(DEFAULT_UNIQUE_CODE_MAX), db)))
  return configured >= CODE_MIN && configured <= CODE_MAX_LIMIT ? configured : DEFAULT_UNIQUE_CODE_MAX
}

export async function bankAccount(): Promise<{ bank: string; accountNumber: string; accountHolder: string }> {
  const [bank, accountNumber, accountHolder] = await Promise.all([
    setting('payment_bank_name', ''),
    setting('payment_bank_account_number', ''),
    setting('payment_bank_account_holder', '')
  ])
  return { bank, accountNumber, accountHolder }
}

/**
 * QRIS statis merchant (keputusan client 2026-10-01: pembayaran lewat QRIS, pelanggan mengetik
 * nominalnya sendiri). null = belum diunggah; halaman bayar lalu jatuh ke rekening bank.
 */
export async function qrisSetting(): Promise<{ imageUrl: string; merchantName: string | null } | null> {
  const [imageUrl, merchantName] = await Promise.all([setting('payment_qris_image', ''), setting('payment_qris_merchant', '')])
  return imageUrl ? { imageUrl, merchantName: merchantName || null } : null
}

/** Kode akun Kas/Bank Accurate (kolom EXPENSE ACCOUNT NO export Penerimaan Penjualan); '' = belum diisi. */
export async function accurateCashAccountNo(): Promise<string> {
  return (await setting('accurate_cash_account_no', '')).trim()
}

/** Checkout online hanya dibuka bila pelanggan punya cara membayar: QRIS atau rekening bank. */
export async function isConfigured(): Promise<boolean> {
  const [account, qris] = await Promise.all([bankAccount(), qrisSetting()])
  return qris !== null || (account.bank !== '' && account.accountNumber !== '')
}

// ===== Nomor invoice =====

/**
 * Terbitkan nomor invoice berikutnya untuk tahun berjalan (WIB). WAJIB di dalam transaksi pembuat
 * baris transaksinya: kenaikan counter ikut di-rollback bila transaksinya gagal, jadi tidak ada nomor
 * yang hilang. Baris counter terkunci sampai commit — pembuatan transaksi berbaris di sini, dan itu
 * memang yang menjamin urutan tanpa celah. Kunci ini selalu diambil TERAKHIR (setelah kunci bisnis
 * pemanggil), jadi tidak membentuk siklus. Saat tahun baru, dua sesi pertama yang sama-sama
 * menyisipkan barisnya bisa deadlock sekali; withConflictRetry di pemanggil mengulangnya.
 */
async function allocateInvoiceNumber(tx: Db): Promise<string> {
  const day = jakartaDate(now())
  const year = Number(day.slice(0, 4))
  await tx.$executeRaw`INSERT INTO invoice_counters (year, lastSeq) VALUES (${year}, LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE lastSeq = LAST_INSERT_ID(lastSeq + 1)`
  const [row] = await tx.$queryRaw<Array<{ seq: bigint | number }>>`SELECT LAST_INSERT_ID() AS seq`
  return invoiceNumber(Number(day.slice(5, 7)), year, Number(row.seq))
}

// ===== Grup booking & kunci =====

export interface LeadRef {
  id: string
  bookingGroupId: string | null
}

/**
 * Semua booking yang dibayar transaksi lead ini. Booking standalone adalah grup berisi satu; lead
 * paket menyimpan ID-nya sendiri di bookingGroupId, jadi satu klausa mencakup seluruh grup.
 *
 * Diekspor supaya penulis status booking berbayar lain (panel admin Fase 8B) memakai definisi grup
 * yang SAMA, bukan menyalin ulang klausanya.
 */
export function groupWhere(lead: LeadRef): Prisma.BookingWhereInput {
  return lead.bookingGroupId ? { bookingGroupId: lead.bookingGroupId } : { id: lead.id }
}

/**
 * Kunci baris transaksi — SELALU statement pertama. false bila transaksinya tidak ada.
 *
 * Diekspor untuk panel admin (Fase 8B): setiap penulisan status booking berbayar wajib mengunci
 * baris transaksi DULU lewat fungsi ini, lalu lockGroup(), mengikuti urutan kunci seragam di header.
 */
export async function lockTransaction(tx: Db, transactionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM transactions WHERE id = ${transactionId} FOR UPDATE`
  return rows.length > 0
}

/** Kunci seluruh baris booking grup, SETELAH baris transaksinya. */
export async function lockGroup(tx: Db, lead: LeadRef): Promise<void> {
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

/** Kode bebas untuk nominal dasar ini, diacak. Hanya transfer yang belum selesai yang memakai kode. */
async function candidateCodes(tx: Db, base: number, codeMax: number): Promise<number[]> {
  const taken = await tx.transaction.findMany({
    where: { pendingTotal: { gte: base + CODE_MIN, lte: base + codeMax } },
    select: { pendingTotal: true }
  })
  const used = new Set(taken.map((t) => (t.pendingTotal as number) - base))
  const free: number[] = []
  for (let code = CODE_MIN; code <= codeMax; code++) if (!used.has(code)) free.push(code)

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
 * Buka transfer untuk subject senilai `amount` rupiah. Pelanggan mentransfer
 * amount + biaya admin + kode unik; biaya admin satu kali per transaksi, jadi paket N sesi tetap satu.
 *
 * WAJIB dipanggil di dalam transaksi yang sudah memegang kunci yang dibutuhkan pemanggil; fungsi ini
 * hanya menambahkan alokasi kode.
 *
 * `userId` boleh null: booking tamu yang dibuat staff di meja depan tidak punya akun. `expiresAt`
 * boleh null: transfer yang ditahan SELAMANYA (booking staff) tidak pernah di-sweep expiry.
 * `priceCategory` = tarif yang dipakai menghitung `amount` (menentukan nomor item Accurate).
 */
export async function openTransfer(
  tx: Db,
  subject: TransferSubject,
  userId: string | null,
  amount: number,
  expiresAt: Date | null,
  priceCategory: UserCategory
) {
  if (Boolean(subject.bookingId) === Boolean(subject.membershipId)) {
    // Pengganti polymorphic transactionable: TEPAT SATU yang boleh terisi.
    throw new Error('openTransfer butuh tepat satu dari bookingId / membershipId')
  }

  const fee = await adminFee(tx)
  const base = amount + fee
  const number = await allocateInvoiceNumber(tx)

  // Coba-insert, bukan pre-check: request lain bisa mengambil kode di antara baca dan tulis kita,
  // dan UNIQUE index-lah yang memutuskan.
  for (const code of await candidateCodes(tx, base, await uniqueCodeMax(tx))) {
    try {
      return await tx.transaction.create({
        data: {
          invoiceNumber: number,
          userId,
          bookingId: subject.bookingId ?? null,
          membershipId: subject.membershipId ?? null,
          amount,
          adminFee: fee,
          method: 'manual',
          uniqueCode: code,
          pendingTotal: base + code,
          paymentStatus: 'UNPAID',
          expiresAt,
          priceCategory
        }
      })
    } catch (e) {
      if (!isUniqueViolation(e, 'pendingTotal')) throw e
    }
  }

  throw new ResponseError(409, 'Tidak ada kode unik tersisa untuk nominal ini. Coba beberapa saat lagi.', 'PENDING_TOTAL_EXHAUSTED')
}

/**
 * Transaksi bernominal 0 (booking gratis walk-in, membership gratis): langsung lunas, tanpa biaya admin
 * dan tanpa kode unik — tidak ada yang ditransfer. Yang bernominal selalu lewat openTransfer + lunas
 * belakangan (approve), termasuk membership meja depan sejak 2026-09-28.
 */
export async function recordFreeTransaction(tx: Db, subject: TransferSubject, userId: string | null) {
  return tx.transaction.create({
    data: {
      invoiceNumber: await allocateInvoiceNumber(tx),
      userId,
      bookingId: subject.bookingId ?? null,
      membershipId: subject.membershipId ?? null,
      amount: 0,
      method: 'manual',
      paymentStatus: 'PAID',
      paidAt: now()
    }
  })
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
  invoiceNumber: string
  /** Harga + biaya admin + kode unik — nominal yang ditransfer pelanggan. */
  total: number
  rejectionReason: string | null
  customer: { email: string | null; name: string | null }
  /** Booking lead yang dibayar transaksi ini; null untuk transaksi membership. */
  booking: { id: string; facilityName: string; unitName: string | null; date: string; startTime: string; endTime: string } | null
  /** Membership yang dibayar transaksi ini (tanggal SETELAH aktivasi); null untuk transaksi booking. */
  membership: { planName: string; startDate: string; endDate: string; customerNumber: string | null } | null
}

async function decisionInfo(tx: Db, transactionId: string): Promise<PaymentDecision> {
  const t = await tx.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: {
      id: true,
      invoiceNumber: true,
      amount: true,
      adminFee: true,
      uniqueCode: true,
      rejectionReason: true,
      user: { select: { email: true, name: true, customerSequence: true } },
      membership: { select: { startDate: true, endDate: true, membershipPlan: { select: { name: true } } } },
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
    invoiceNumber: t.invoiceNumber,
    total: transferTotal(t),
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
      : null,
    membership: t.membership
      ? {
          planName: t.membership.membershipPlan?.name ?? 'Membership',
          startDate: dateOnlyToString(t.membership.startDate),
          endDate: dateOnlyToString(t.membership.endDate),
          customerNumber: t.user ? customerNumber(t.user.customerSequence) : null
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
        // Membership pending_payment (dibeli online atau didaftarkan di meja depan): aktif sekarang,
        // masa aktif dihitung dari hari verifikasi.
        await activatePendingMembership(tx, transaction.membershipId, staffId)
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
      } else if (transaction.membershipId) {
        await lapsePendingMembership(tx, transaction.membershipId, 'payment_rejected', staffId)
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
        } else if (transaction.membershipId) {
          await lapsePendingMembership(tx, transaction.membershipId, 'payment_expired', null)
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
