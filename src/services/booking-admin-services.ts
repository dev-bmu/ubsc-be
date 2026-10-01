import { BookingStatus, Prisma, Transaction } from '@prisma/client'
import type { AdminBookingCreatedDto, AdminBookingDto, AdminBookingIndexDto, BookingTransactionDto, FacilityOptionDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ADMIN_URL } from '../config'
import { ResponseError } from '../error/response-error'
import { dateOnly, dateOnlyToString, formatInstant, jakartaWallTimeToUtc, now, weekdayOf } from '../utils/clock'
import { receiptNumber, transferTotal } from '../utils/money'
import { withConflictRetry } from '../utils/prisma-errors'
import { randomAlphanumeric } from '../utils/random'
import { BookingAdminValidation } from '../validation/booking-admin-validation'
import { Validation } from '../validation/Validation'
import { blockingForDay, paxOverlapping } from './availability-services'
import { groupWhere, LeadRef, lockGroup, lockTransaction, openTransfer, recordFreeTransaction } from './manual-payment-services'
import { calculateSubtotal, FACILITY_WITH_PRICING } from './pricing-services'
import { capacityFor, cleanClosedDatesForMonth } from './schedule-services'

// ============================================================================
// === Booking admin — port dari Admin\BookingController ===
// ============================================================================
// index/transformBooking, store (walk-in staff), update (ubah status), destroy (soft-cancel).
// Okupansi/tabrakan LEWAT blocking() (blockingForDay), harga LEWAT resolver yang sama dengan
// pelanggan (calculateSubtotal), sehingga meja depan dan pelanggan tidak pernah berbeda pendapat.

const ADMIN_BASE = ADMIN_URL.replace(/\/+$/, '')

// ===== Pemuat + tipe =====

/**
 * groupLead.transaction ikut dimuat: sesi follower sebuah paket tidak membawa transaksi sendiri, jadi
 * tanpa ini setiap sesi setelah yang pertama terbaca UNPAID di panel (payableTransaction lewat lead).
 */
const ADMIN_BOOKING_INCLUDE = {
  user: { select: { id: true, name: true, phoneNumber: true, identityCategory: true } },
  facility: { select: { name: true, bookingMode: true } },
  facilityUnit: { select: { name: true } },
  transaction: true,
  bookingGroup: { select: { transaction: true } },
  checkedInBy: { select: { name: true } }
} satisfies Prisma.BookingInclude

type AdminBookingRow = Prisma.BookingGetPayload<{ include: typeof ADMIN_BOOKING_INCLUDE }>

/** Hanya lead paket memegang transaksi; follower melihat menembus ke lead (Booking::payableTransaction). */
function payableTransaction(booking: {
  transaction: Transaction | null
  bookingGroup: { transaction: Transaction | null } | null
}): Transaction | null {
  return booking.transaction ?? booking.bookingGroup?.transaction ?? null
}

/**
 * Status tampilan (Booking::getEffectiveStatusAttribute). Booking confirmed yang sudah lewat endsAt
 * tampil 'completed' — display saja, ketersediaan tetap dihitung blocking().
 */
function effectiveStatusOf(status: BookingStatus, endsAt: Date, at: Date): BookingStatus {
  if (status === 'cancelled' || status === 'completed') return status
  return status === 'confirmed' && endsAt.getTime() < at.getTime() ? 'completed' : status
}

/** checkout_url Laravel di-drop dari skema (bug 3/8); diturunkan saat baca dari booking pemilik transaksi (lead). */
function transactionDto(t: Transaction): BookingTransactionDto {
  return {
    id: t.id,
    amount: t.amount,
    adminFee: t.adminFee,
    uniqueCode: t.uniqueCode,
    total: transferTotal(t),
    paymentStatus: t.paymentStatus,
    checkoutUrl: t.bookingId ? `${ADMIN_BASE}/bookings/${t.bookingId}` : null,
    paidAt: t.paidAt ? formatInstant(t.paidAt, 'Y-m-d H:i') : null,
    receiptNumber: receiptNumber(t.receiptSequence),
    verificationStatus: t.verificationStatus,
    proofUploadedAt: t.proofUploadedAt ? formatInstant(t.proofUploadedAt, 'd M Y H:i') : null,
    proofUrl: t.proofPath ? `/admin/payments/${t.id}/bukti` : null,
    rejectionReason: t.rejectionReason
  }
}

function transformBooking(booking: AdminBookingRow, at: Date): AdminBookingDto {
  // Warga kampus -> warga_ub. transformBooking Laravel TIDAK mengecek identityStatus di sini (beda dari
  // priceCategoryFor), jadi pemetaan mentah dipertahankan.
  const userCategory = booking.user?.identityCategory === 'warga_kampus' ? 'warga_ub' : 'umum'
  const transaction = payableTransaction(booking)

  return {
    id: booking.id,
    userId: booking.userId,
    facilityId: booking.facilityId,
    facilityUnitId: booking.facilityUnitId,
    bookingDate: dateOnlyToString(booking.bookingDate),
    startTime: booking.startTime.slice(0, 5),
    endTime: booking.endTime.slice(0, 5),
    subtotalPrice: booking.subtotalPrice,
    status: booking.status,
    effectiveStatus: effectiveStatusOf(booking.status, booking.endsAt, at),
    notes: booking.notes,
    // Utamakan customer_name tersimpan; jatuh ke nama user; lalu 'Guest'.
    customerName: booking.customerName ?? booking.user?.name ?? 'Guest',
    customerPhone: booking.user?.phoneNumber ?? booking.customerPhone,
    isFree: booking.subtotalPrice === 0 && booking.userId === null,
    userCategory,
    facilityName: booking.facility.name,
    bookingMode: booking.facility.bookingMode ?? 'court',
    facilityUnitName: booking.facilityUnit?.name ?? null,
    checkedInAt: booking.checkedInAt ? formatInstant(booking.checkedInAt, 'd M Y H:i') : null,
    checkedInBy: booking.checkedInBy?.name ?? null,
    checkInUrl: booking.checkInToken ? `${ADMIN_BASE}/checkin/${booking.checkInToken}` : null,
    hasEnded: booking.endsAt.getTime() < at.getTime(),
    transaction: transaction ? transactionDto(transaction) : null
  }
}

// ===== 1. Index — daftar penuh + opsi fasilitas =====

async function facilityOptions(): Promise<FacilityOptionDto[]> {
  const facilities = await prismaClient.facility.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      bookingMode: true,
      units: { where: { isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }
    }
  })

  return facilities.map((f) => ({
    id: f.id,
    name: f.name,
    bookingMode: f.bookingMode ?? 'court',
    units: f.units.map((u) => ({ id: u.id, name: u.name }))
  }))
}

export async function listAdminBookings(): Promise<AdminBookingIndexDto> {
  const at = now()
  const [bookings, facilities] = await Promise.all([
    prismaClient.booking.findMany({
      include: ADMIN_BOOKING_INCLUDE,
      // Laravel: booking_date desc, start_time asc. Tanpa paginasi (mirror .get()).
      orderBy: [{ bookingDate: 'desc' }, { startTime: 'asc' }]
    }),
    facilityOptions()
  ])

  return { bookings: bookings.map((b) => transformBooking(b, at)), facilities }
}

// ===== 2. Store — walk-in staff =====

function fieldError(field: string, message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { [field]: [message] })
}

/** Jendela jadwal + tanggal tutup, cek yang sama dengan alur pelanggan (booking-services). */
async function scheduleGate(dateStr: string): Promise<void> {
  const year = Number(dateStr.slice(0, 4))
  const month = Number(dateStr.slice(5, 7))
  const schedule = await prismaClient.bookingSchedule.findUnique({ where: { month_year: { month, year } } })

  if (!schedule?.isOpen) throw fieldError('bookingDate', 'Jadwal untuk bulan ini belum dibuka oleh pengelola.')
  if (cleanClosedDatesForMonth(schedule.closedDates, month, year).includes(dateStr)) {
    throw fieldError('bookingDate', 'Fasilitas tutup pada tanggal ini (Libur/Pemeliharaan).')
  }
}

export async function createAdminBooking(request: unknown): Promise<AdminBookingCreatedDto> {
  const v = Validation.validate(BookingAdminValidation.CREATE, request)

  if (v.endTime <= v.startTime) throw fieldError('endTime', 'Jam selesai harus setelah jam mulai.')

  const facility = await prismaClient.facility.findUnique({ where: { id: v.facilityId }, include: FACILITY_WITH_PRICING })
  if (!facility) throw fieldError('facilityId', 'Fasilitas tidak ditemukan.')

  // Unit: harus milik fasilitas ini DAN aktif. Bila fasilitas punya unit aktif, salah satu wajib dipilih.
  const activeUnits = facility.units.filter((u) => u.isActive)
  let unit = null as (typeof facility.units)[number] | null
  if (v.facilityUnitId) {
    unit = activeUnits.find((u) => u.id === v.facilityUnitId) ?? null
    if (!unit) throw fieldError('facilityUnitId', 'Unit tidak valid untuk fasilitas ini.')
  } else if (activeUnits.length > 0) {
    throw fieldError('facilityUnitId', 'Pilih unit fasilitas terlebih dahulu.')
  }
  const unitId = unit?.id ?? null

  await scheduleGate(v.bookingDate)

  // Tabrakan: kapasitas per slot vs pax yang sudah menahan slot (blocking()). Sama seperti hasCollision.
  const requestedPax = v.pax ?? 1
  const at = now()
  const capacity = capacityFor(facility, unit, weekdayOf(v.bookingDate), v.startTime)
  const occupiedRows = await blockingForDay(prismaClient, facility.id, unitId, v.bookingDate, at)
  const occupiedPax = paxOverlapping(occupiedRows, v.startTime, v.endTime)
  if (occupiedPax + requestedPax > capacity) {
    throw fieldError('startTime', 'Jadwal sudah terpesan untuk fasilitas tersebut. Silakan pilih waktu lain.')
  }

  // Harga: gratis -> 0; selain itu resolver yang sama dengan pelanggan (walk-in = kategori 'umum'), prorata durasi.
  const subtotal = v.isFree ? 0 : calculateSubtotal(facility, unit, 'umum', v.bookingDate, v.startTime, v.endTime)

  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          userId: null,
          customerName: v.customerName,
          facilityId: facility.id,
          facilityUnitId: unitId,
          bookingDate: dateOnly(v.bookingDate),
          startTime: v.startTime,
          endTime: v.endTime,
          startsAt: jakartaWallTimeToUtc(v.bookingDate, v.startTime),
          endsAt: jakartaWallTimeToUtc(v.bookingDate, v.endTime),
          pax: requestedPax,
          subtotalPrice: subtotal,
          status: v.isFree ? 'confirmed' : 'pending',
          // Staff = ditahan SELAMANYA (bukan hold sementara).
          holdExpiresAt: null,
          // Token INILAH tiketnya (dikodekan ke QR), seperti hook creating Laravel.
          checkInToken: randomAlphanumeric(32),
          notes: v.notes ?? null
        }
      })

      // Gratis = lunas tanpa transfer (tanpa biaya admin & kode). Selain itu transfer digantung ke
      // booking dengan expiry null = tidak pernah di-sweep, sampai FO menandainya lunas (approve).
      const transaction = v.isFree
        ? await recordFreeTransaction(tx, { bookingId: booking.id }, null)
        : await openTransfer(tx, { bookingId: booking.id }, null, subtotal, null, 'umum')

      return { bookingId: booking.id, transactionId: transaction.id, total: transferTotal(transaction) }
    }, TX_OPTIONS)
  )
}

// ===== 3. Update status + destroy =====

/**
 * Tandai transfer lead FAILED, tapi HANYA setelah tak ada lagi yang ditanggungnya hidup.
 * Transaksi paket membayar banyak sesi — menggagalkannya karena satu sesi dibatalkan akan mematikan
 * pembayaran sesi lain. Cek & tulis di bawah kunci (transaksi DULU, lalu grup) — urutan kunci seragam.
 */
async function failTransactionIfWholeGroupIsDone(tx: Prisma.TransactionClient, lead: LeadRef, payableTxId: string | null): Promise<void> {
  if (!payableTxId) return

  const transaction = await tx.transaction.findUnique({ where: { id: payableTxId }, select: { paymentStatus: true } })
  if (transaction?.paymentStatus !== 'UNPAID') return

  const stillLive = await tx.booking.count({ where: { AND: [groupWhere(lead), { status: { in: ['pending', 'confirmed'] } }] } })
  // Nominalnya dibebaskan seperti reject/expire; kalau tidak, kode unik walk-in tertahan selamanya.
  if (stillLive === 0) await tx.transaction.update({ where: { id: payableTxId }, data: { paymentStatus: 'FAILED', pendingTotal: null } })
}

async function applyBookingStatus(id: string, status: BookingStatus): Promise<{ id: string; status: BookingStatus }> {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id },
        select: {
          id: true,
          bookingGroupId: true,
          transaction: { select: { id: true } },
          bookingGroup: { select: { transaction: { select: { id: true } } } }
        }
      })
      if (!booking) throw new ResponseError(404, 'Booking tidak ditemukan')

      const lead: LeadRef = { id: booking.id, bookingGroupId: booking.bookingGroupId }
      const payableTxId = booking.transaction?.id ?? booking.bookingGroup?.transaction?.id ?? null
      const finalising = status === 'cancelled' || status === 'completed'

      // Urutan kunci seragam: baris transaksi DULU, lalu baris booking grup.
      if (finalising && payableTxId) {
        await lockTransaction(tx, payableTxId)
        await lockGroup(tx, lead)
      }

      await tx.booking.update({ where: { id: booking.id }, data: { status } })

      if (finalising) await failTransactionIfWholeGroupIsDone(tx, lead, payableTxId)

      return { id: booking.id, status }
    }, TX_OPTIONS)
  )
}

export async function updateBookingStatus(id: string, request: unknown): Promise<{ id: string; status: BookingStatus }> {
  const v = Validation.validate(BookingAdminValidation.UPDATE_STATUS, request)
  return applyBookingStatus(id, v.status)
}

/** Soft-cancel — tidak pernah hard-delete. */
export async function destroyBooking(id: string): Promise<{ id: string; status: BookingStatus }> {
  return applyBookingStatus(id, 'cancelled')
}
