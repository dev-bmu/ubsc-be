import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import sharp from 'sharp'
import type { AdminPaymentIndexDto, AdminPaymentRowDto, ApiMeta, PaymentQueueTab, PaymentSettingsDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, formatInstant, jakartaWallTimeToUtc } from '../utils/clock'
import { transferTotal } from '../utils/money'
import { paginationMeta } from '../utils/respond'
import { deleteObjects, ownedPublicKey, publicUrl, putObject } from '../utils/storage'
import { PaymentValidation } from '../validation/payment-validation'
import { Validation } from '../validation/Validation'
import { accurateCashAccountNo, adminFee, bankAccount, holdMinutes, qrisSetting, uniqueCodeMax } from './manual-payment-services'

// ============================================================================
// === Antrean verifikasi + pengaturan rekening — port Admin\PaymentVerificationController ===
// ============================================================================
// Hanya index() dan updateSettings(). approve/reject/bukti sudah ada sejak Fase 3
// (payment-verification-services.ts + manual-payment-services.ts) dan TIDAK disentuh di sini.
// Rekening & durasi hold dibaca lewat bankAccount()/holdMinutes() yang sama dengan jalur pelanggan,
// jadi panel dan halaman pembayaran tidak pernah berbeda pendapat.

/** Transaction::scopeAwaitingVerification — UNPAID + bukti sudah masuk. */
const AWAITING_VERIFICATION = { paymentStatus: 'UNPAID', verificationStatus: 'awaiting' } satisfies Prisma.TransactionWhereInput

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
    receiptNumber: t.invoiceNumber,
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
 *
 * Tab Lunas sengaja TANPA method='manual' (beda dari Laravel): method tidak ada di indeks, jadi COUNT(*)
 * meta paginasi akan me-lookup setiap baris PAID (~200 ms per 50 rb baris); tanpa itu COUNT terjawab dari
 * indeks (~20 ms). Hasilnya sama karena 'manual' satu-satunya method yang pernah ditulis (default kolom,
 * manual-payment-services, data Laravel). Bila kelak ada method lain, kembalikan filternya + indeks
 * [paymentStatus, method, ...] — dan periksa EXPLAIN: optimizer MySQL 8.0 masih memilih indeks
 * paymentStatus_createdAt untuk COUNT walau indeks itu tersedia.
 */
function queueQuery(tab: PaymentQueueTab): { where: Prisma.TransactionWhereInput; orderBy: Prisma.TransactionOrderByWithRelationInput[] } {
  switch (tab) {
    case 'rejected':
      return { where: { method: 'manual', verificationStatus: 'rejected' }, orderBy: [{ receiptSequence: 'asc' }] }
    case 'paid':
      return { where: { paymentStatus: 'PAID' }, orderBy: [{ paidAt: 'desc' }, { receiptSequence: 'desc' }] }
    default:
      return { where: { method: 'manual', ...AWAITING_VERIFICATION }, orderBy: [{ proofUploadedAt: 'asc' }, { receiptSequence: 'asc' }] }
  }
}

/** Kolom Int MySQL; angka di atasnya bukan nominal (mis. no. HP) dan akan ditolak Prisma. */
const INT_MAX = 2_147_483_647

/**
 * Pencarian: invoice, pelanggan (akun: nama/email/no. HP; walk-in: nama/no. HP di booking/membership),
 * fasilitas, paket. LIKE mengikuti collation kolom (utf8mb4 *_ci) -> tidak peka huruf besar.
 *
 * Kata kunci yang berupa angka setelah sen ',00', 'Rp', spasi, titik, koma dibuang ('Rp 150.732') juga mencocokkan
 * nominal: harga (amount) ATAU total transfer amount + adminFee + uniqueCode. Total dihitung lewat raw
 * SQL karena Prisma tidak bisa menjumlah kolom di where; pendingTotal tidak dipakai karena dikosongkan
 * saat disetujui/ditolak, padahal staff juga mencocokkan mutasi dengan transaksi yang sudah lunas.
 *
 * ponytail: LIKE '%q%' + jumlah kolom = full scan transactions. Cukup untuk puluhan ribu baris; bila
 * terasa lambat, tambah FULLTEXT / kolom total ber-indeks.
 */
async function searchWhere(q: string): Promise<Prisma.TransactionWhereInput | null> {
  if (!q) return null
  // Prisma tidak meng-escape wildcard LIKE: '%' / '_' akan mencocokkan semua baris. '\' = escape bawaan MySQL.
  const contains = { contains: q.replace(/[\\%_]/g, (c) => '\\' + c) }
  const or: Prisma.TransactionWhereInput[] = [
    { invoiceNumber: contains },
    { user: { is: { OR: [{ name: contains }, { email: contains }, { phoneNumber: contains }] } } },
    { booking: { is: { OR: [{ customerName: contains }, { customerPhone: contains }, { facility: { is: { name: contains } } }] } } },
    { membership: { is: { OR: [{ customerName: contains }, { membershipPlan: { is: { name: contains } } }] } } }
  ]

  // Sen nol dari mutasi bank ('150.732,00' / '150,732.00') dibuang dulu, kalau tidak ikut jadi digit.
  const digits = q.replace(/[.,]00\s*$/, '').replace(/rp|[\s.,]/gi, '')
  const nominal = /^\d+$/.test(digits) ? Number(digits) : 0
  if (nominal > 0 && nominal <= INT_MAX) {
    const totals = await prismaClient.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM transactions WHERE method = 'manual' AND amount + adminFee + COALESCE(uniqueCode, 0) = ${nominal}`
    or.push({ amount: nominal }, { id: { in: totals.map((t) => t.id) } })
  }
  return { OR: or }
}

export async function listPaymentQueue(query: unknown): Promise<{ data: AdminPaymentIndexDto; meta: ApiMeta }> {
  const { tab, q, page, perPage } = Validation.validate(PaymentValidation.QUEUE, query)
  const queue = queueQuery(tab)
  const search = await searchWhere(q)
  const where = search ? { AND: [queue.where, search] } : queue.where

  const [rows, total, awaiting, rejected, settings] = await Promise.all([
    // Halaman lewat akhir -> skip melewati semua baris -> daftar kosong (meta tetap benar), bukan 404.
    prismaClient.transaction.findMany({ where, orderBy: queue.orderBy, skip: (page - 1) * perPage, take: perPage, include: QUEUE_INCLUDE }),
    prismaClient.transaction.count({ where }),
    // Hitungan badge TIDAK difilter method='manual' maupun pencarian — sama persis dengan Laravel.
    prismaClient.transaction.count({ where: AWAITING_VERIFICATION }),
    prismaClient.transaction.count({ where: { verificationStatus: 'rejected' } }),
    paymentSettings()
  ])

  return {
    data: { tab, transactions: rows.map(presentRow), counts: { awaiting, rejected }, ...settings },
    meta: paginationMeta(page, perPage, total)
  }
}

/** Keadaan pengaturan, dibaca lewat helper yang sama dengan jalur pelanggan. */
async function paymentSettings(): Promise<PaymentSettingsDto> {
  const [bank, qris, hold, fee, codeMax, cashAccount] = await Promise.all([
    bankAccount(),
    qrisSetting(),
    holdMinutes(),
    adminFee(),
    uniqueCodeMax(),
    accurateCashAccountNo()
  ])
  return { bank, qris, holdMinutes: hold, adminFee: fee, uniqueCodeMax: codeMax, accurateCashAccountNo: cashAccount }
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
    ['payment_qris_merchant', v.qrisMerchantName],
    ['payment_hold_minutes', String(v.holdMinutes)],
    ['payment_admin_fee', String(v.adminFee)],
    ['payment_unique_code_max', String(v.uniqueCodeMax)],
    ['accurate_cash_account_no', v.accurateCashAccountNo]
  ]
  await prismaClient.$transaction(
    entries.map(([key, value]) => prismaClient.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } })),
    { isolationLevel: TX_OPTIONS.isolationLevel }
  )

  return paymentSettings()
}

// ===== 3. Gambar QRIS merchant =====
// Keputusan client 2026-10-01: pembayaran lewat QRIS statis — pelanggan memindai gambar QRIS merchant
// lalu mengetik nominal (harga + biaya admin + kode unik) sendiri. Gambarnya publik (halaman bayar,
// invoice, email), jadi tinggal di area public 'qris/' (utils/storage.ts), bernama acak. Encode ulang ke PNG LOSSLESS: kompresi lossy
// bisa mengaburkan modul QR kecil sampai tidak terbaca.

const QRIS_MAX_EDGE = 1600
const QRIS_FORMATS = new Set(['jpeg', 'png', 'webp'])
const { maxWidth: QRIS_MAX_WIDTH, maxHeight: QRIS_MAX_HEIGHT } = UPLOAD_LIMITS.CMS_IMAGE
export const QRIS_TOO_LARGE_MESSAGE = 'Ukuran gambar QRIS maksimal 5 MB.'

export interface UploadedQrisImage {
  buffer: Buffer
  originalname: string
}

function qrisRejection(message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { image: [message] })
}

/** Hapus berkas QRIS lama — hanya yang ditulis modul ini (nilai setting berasal dari DB). Tidak pernah melempar. */
function unlinkOwnedQris(url: string | null | undefined): void {
  const key = ownedPublicKey(url, 'qris')
  if (key) deleteObjects('public', [key])
}

/** POST /api/admin/payments/settings/qris — field `image`. Mengganti gambar QRIS yang lama. */
export async function uploadQrisImage(file: UploadedQrisImage | undefined): Promise<PaymentSettingsDto> {
  if (!file) throw qrisRejection('Pilih gambar QRIS terlebih dahulu.')

  const limitInputPixels = QRIS_MAX_WIDTH * QRIS_MAX_HEIGHT
  const meta = await sharp(file.buffer, { limitInputPixels })
    .metadata()
    .catch(() => null)
  if (!meta?.format || !QRIS_FORMATS.has(meta.format)) throw qrisRejection('Gambar QRIS harus JPG, PNG, atau WEBP.')

  const data = await sharp(file.buffer, { limitInputPixels })
    .rotate()
    .resize({ width: QRIS_MAX_EDGE, height: QRIS_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const objectKey = `qris/${randomUUID()}.png`
  await putObject('public', objectKey, data, 'image/png')

  const previous = (await qrisSetting())?.imageUrl
  const key = 'payment_qris_image'
  const value = publicUrl(objectKey)
  await prismaClient.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  unlinkOwnedQris(previous)
  return paymentSettings()
}

/** DELETE /api/admin/payments/settings/qris — halaman bayar kembali memakai rekening bank. */
export async function removeQrisImage(): Promise<PaymentSettingsDto> {
  const previous = (await qrisSetting())?.imageUrl
  const key = 'payment_qris_image'
  await prismaClient.systemSetting.upsert({ where: { key }, create: { key, value: '' }, update: { value: '' } })
  unlinkOwnedQris(previous)
  return paymentSettings()
}
