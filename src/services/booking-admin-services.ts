import { BookingStatus, Prisma, Transaction } from '@prisma/client'
import type {
  AdminBookingCreatedDto,
  AdminBookingDto,
  AdminBookingIndexDto,
  AdminRescheduleResultDto,
  BookingTransactionDto,
  ClosedReason,
  FacilityOptionDto,
  RescheduleOptionsDto,
  RescheduleSlotDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ADMIN_URL, LANDING_URL } from '../config'
import { ResponseError } from '../error/response-error'
import {
  dateOnly,
  dateOnlyToString,
  formatInstant,
  fromMinutes,
  jakartaDate,
  jakartaHm,
  jakartaWallTimeToUtc,
  now,
  toMinutes,
  translatedDate,
  weekdayOf
} from '../utils/clock'
import { bookingRescheduledTemplate } from '../utils/mail-templates'
import { sendMailSafe } from '../utils/mailer'
import { transferTotal } from '../utils/money'
import { withConflictRetry } from '../utils/prisma-errors'
import { randomAlphanumeric } from '../utils/random'
import { BookingAdminValidation } from '../validation/booking-admin-validation'
import { Validation } from '../validation/Validation'
import { blocking, blockingForDay, cancelledSessionKeys, lockResource, paxOverlapping } from './availability-services'
import { contiguousSpan } from './booking-services'
import { groupWhere, LeadRef, lockGroup, lockTransaction, openTransfer, recordFreeTransaction } from './manual-payment-services'
import { calculateSubtotal, FACILITY_WITH_PRICING, FacilityWithPricing, UnitWithPrices } from './pricing-services'
import { capacityFor, cleanClosedDatesForMonth, isClassMode, timeRangesFor } from './schedule-services'

// ============================================================================
// === Booking admin — port dari Admin\BookingController ===
// ============================================================================
// index/transformBooking, store (walk-in staff), update (ubah status), destroy (soft-cancel), plus
// pindah jadwal oleh staff (baru, tanpa padanan Laravel).
// Okupansi/tabrakan LEWAT blocking() (blockingForDay), harga LEWAT resolver yang sama dengan
// pelanggan (calculateSubtotal), sehingga meja depan dan pelanggan tidak pernah berbeda pendapat.

const ADMIN_BASE = ADMIN_URL.replace(/\/+$/, '')
const LANDING_BASE = LANDING_URL.replace(/\/+$/, '')

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
  checkedInBy: { select: { name: true } },
  reschedules: { orderBy: { createdAt: 'desc' }, include: { actor: { select: { name: true } } } }
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
    receiptNumber: t.invoiceNumber,
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
    transaction: transaction ? transactionDto(transaction) : null,
    reschedules: booking.reschedules.map((r) => ({
      at: `${translatedDate(jakartaDate(r.createdAt), 'd M Y')} ${jakartaHm(r.createdAt)}`,
      by: r.actor?.name ?? null,
      from: { date: dateOnlyToString(r.fromDate), startTime: r.fromStartTime, endTime: r.fromEndTime, unitName: r.fromUnitName },
      to: { date: dateOnlyToString(r.toDate), startTime: r.toStartTime, endTime: r.toEndTime, unitName: r.toUnitName },
      reason: r.reason
    }))
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

/** Bulan belum dibuka / tanggal tutup, cek yang sama dengan alur pelanggan (booking-services). null = buka. */
async function closedReason(dateStr: string): Promise<ClosedReason | null> {
  const year = Number(dateStr.slice(0, 4))
  const month = Number(dateStr.slice(5, 7))
  const schedule = await prismaClient.bookingSchedule.findUnique({ where: { month_year: { month, year } } })

  if (!schedule?.isOpen) return 'month_closed'
  return cleanClosedDatesForMonth(schedule.closedDates, month, year).includes(dateStr) ? 'date_closed' : null
}

/** Jendela jadwal + tanggal tutup sebagai error field. */
async function scheduleGate(dateStr: string): Promise<void> {
  const reason = await closedReason(dateStr)
  if (reason === 'month_closed') throw fieldError('bookingDate', 'Jadwal untuk bulan ini belum dibuka oleh pengelola.')
  if (reason === 'date_closed') throw fieldError('bookingDate', 'Fasilitas tutup pada tanggal ini (Libur/Pemeliharaan).')
}

/** Unit: harus milik fasilitas ini DAN aktif. Bila fasilitas punya unit aktif, salah satu wajib dipilih. */
function unitFor(facility: FacilityWithPricing, unitId: string | null | undefined): UnitWithPrices | null {
  const activeUnits = facility.units.filter((u) => u.isActive)
  if (unitId) {
    const unit = activeUnits.find((u) => u.id === unitId)
    if (!unit) throw fieldError('facilityUnitId', 'Unit tidak valid untuk fasilitas ini.')
    return unit
  }
  if (activeUnits.length > 0) throw fieldError('facilityUnitId', 'Pilih unit fasilitas terlebih dahulu.')
  return null
}

export async function createAdminBooking(request: unknown): Promise<AdminBookingCreatedDto> {
  const v = Validation.validate(BookingAdminValidation.CREATE, request)

  if (v.endTime <= v.startTime) throw fieldError('endTime', 'Jam selesai harus setelah jam mulai.')

  const facility = await prismaClient.facility.findUnique({ where: { id: v.facilityId }, include: FACILITY_WITH_PRICING })
  if (!facility) throw fieldError('facilityId', 'Fasilitas tidak ditemukan.')

  const unit = unitFor(facility, v.facilityUnitId)
  const unitId = unit?.id ?? null

  await scheduleGate(v.bookingDate)

  const requestedPax = v.pax ?? 1
  const capacity = capacityFor(facility, unit, weekdayOf(v.bookingDate), v.startTime)

  // Harga: gratis -> 0; selain itu resolver yang sama dengan pelanggan (walk-in = kategori 'umum'), prorata durasi.
  const subtotal = v.isFree ? 0 : calculateSubtotal(facility, unit, 'umum', v.bookingDate, v.startTime, v.endTime)

  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      // Tabrakan: kapasitas per slot vs pax yang sudah menahan slot (blocking()), sama seperti hasCollision —
      // dibaca DI BAWAH kunci resource yang sama dengan createBooking/rescheduleBooking. Dibaca di luar
      // kunci, walk-in bisa overbook melawan booking pelanggan atau pindah jadwal yang commit bersamaan.
      await lockResource(tx, facility.id, unitId)
      const occupiedPax = paxOverlapping(await blockingForDay(tx, facility.id, unitId, v.bookingDate, now()), v.startTime, v.endTime)
      if (occupiedPax + requestedPax > capacity) {
        throw fieldError('startTime', 'Jadwal sudah terpesan untuk fasilitas tersebut. Silakan pilih waktu lain.')
      }

      const booking = await tx.booking.create({
        data: {
          userId: null,
          customerName: v.customerName,
          customerPhone: v.customerPhone ?? null,
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

      // Gratis = lunas tanpa transfer (tanpa kode unik). Selain itu transfer digantung ke
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

// ===== 4. Pindah jadwal (staff) =====
// Satu baris booking per kali (satu sesi paket; sesi lain tetap). Fasilitas, durasi, pax, harga,
// transaksi, dan token check-in TIDAK berubah — yang pindah hanya tanggal, jam, dan unit. Setiap
// pindah tercatat di booking_reschedules.

const HOLD_LAPSED_FOR_STAFF = 'Batas waktu pembayaran reservasi ini sudah lewat dan slotnya sudah dilepas. Buat reservasi baru.'

/** Booking hidup lain milik pelanggan yang sama di fasilitas ini pada tanggal itu: satu orang satu kursi per sesi kelas. */
function ownSessionsWhere(id: string, userId: string, facilityId: string, date: string, at: Date): Prisma.BookingWhereInput {
  return { AND: [{ id: { not: id }, userId, facilityId, bookingDate: dateOnly(date) }, blocking(at)] }
}

/** Booking + fasilitasnya (lengkap dengan harga/unit/jadwal) — dimuat di luar kunci, untuk cek murah. */
async function rescheduleSubject(id: string) {
  const booking = await prismaClient.booking.findUnique({
    where: { id },
    select: { userId: true, facilityId: true, facilityUnitId: true, bookingDate: true, startTime: true, endTime: true, pax: true }
  })
  if (!booking) throw new ResponseError(404, 'Booking tidak ditemukan')
  const facility = await prismaClient.facility.findUniqueOrThrow({ where: { id: booking.facilityId }, include: FACILITY_WITH_PRICING })
  if (!facility.isActive) throw new ResponseError(409, 'Fasilitas ini sudah nonaktif; jadwal reservasinya tidak bisa dipindah.', 'CONFLICT')
  // Unit bila staff tidak memilih: unit saat ini, tapi HANYA selama masih aktif. Unit nonaktif -> wajib pilih
  // unit aktif lain, atau level fasilitas bila tak ada lagi unit aktif (sama seperti walk-in baru).
  const defaultUnitId = facility.units.some((u) => u.isActive && u.id === booking.facilityUnitId) ? booking.facilityUnitId : null
  // Durasi asli, tetap saat dipindah: jam selesai baru = jam mulai baru + durasi ini.
  return { booking, facility, defaultUnitId, durationMinutes: toMinutes(booking.endTime) - toMinutes(booking.startTime) }
}

/**
 * Slot tujuan pada satu tanggal + unit, untuk form pindah jadwal. Bahan yang sama dengan mutasinya:
 * grid timeRangesFor + contiguousSpan dengan durasi ASLI, okupansi tanpa booking ini sendiri, kuota per
 * slot, dan sesi yang dibatalkan staff. Bukan /public/booking/slots: itu menghitung booking ini
 * melawan dirinya sendiri, mengabaikan sesi batal, dan dibatasi rate per pengunjung.
 */
export async function rescheduleOptions(id: string, query: unknown): Promise<RescheduleOptionsDto> {
  const v = Validation.validate(BookingAdminValidation.RESCHEDULE_OPTIONS, query)
  const { booking, facility, defaultUnitId, durationMinutes } = await rescheduleSubject(id)
  const empty = { requiresUnit: false, durationMinutes, slots: [] }

  const reason = await closedReason(v.date)
  if (reason) return { closed: true, reason, ...empty }

  const requestedUnitId = v.facilityUnitId ?? defaultUnitId
  if (!requestedUnitId && facility.units.some((u) => u.isActive)) return { closed: false, ...empty, requiresUnit: true }
  const unit = unitFor(facility, requestedUnitId)
  const unitId = unit?.id ?? null

  const at = now()
  const today = jakartaDate(at)
  const nowHm = jakartaHm(at)
  const weekday = weekdayOf(v.date)
  const ranges = timeRangesFor(facility, unit, v.date)
  const [rows, cancelled, own] = await Promise.all([
    blockingForDay(prismaClient, facility.id, unitId, v.date, at, id),
    cancelledSessionKeys(prismaClient, unitId, Number(v.date.slice(0, 4)), Number(v.date.slice(5, 7))),
    isClassMode(facility) && booking.userId
      ? prismaClient.booking.findMany({ where: ownSessionsWhere(id, booking.userId, facility.id, v.date, at), select: { startTime: true } })
      : []
  ])
  const ownStarts = new Set(own.map((b) => b.startTime))
  const currentDate = dateOnlyToString(booking.bookingDate)

  const slots = ranges.flatMap(([startTime]): RescheduleSlotDto[] => {
    const endTime = fromMinutes(toMinutes(startTime) + durationMinutes)
    const span = contiguousSpan(ranges, startTime, endTime)
    if (span.slots === 0 || !span.reachesEnd) return []

    const capacity = capacityFor(facility, unit, weekday, startTime)
    const remaining = Math.max(0, capacity - paxOverlapping(rows, startTime, endTime))
    const isPast = v.date < today || (v.date === today && startTime <= nowHm)
    const status = cancelled.has(`${v.date} ${startTime}`)
      ? 'cancelled'
      : ownStarts.has(startTime)
        ? 'registered'
        : remaining < booking.pax
          ? 'full'
          : isPast
            ? 'past'
            : 'available'
    const current = v.date === currentDate && startTime === booking.startTime && unitId === booking.facilityUnitId

    return [{ startTime, endTime, remaining, capacity, status, current }]
  })

  return { closed: false, requiresUnit: false, durationMinutes, slots }
}

/**
 * Pindahkan satu booking. Cek murah (jadwal, unit, grid, jam lewat) di luar kunci; status, okupansi, dan
 * sesi batal dibaca ulang DI BAWAH kunci.
 *
 * Urutan kunci: resource DULU (sama seperti createBooking dan cancelSession), lalu baris transaksi, lalu
 * baris grup (urutan seragam manual-payment-services). approve/reject/expire/attachProof tidak pernah
 * mengambil kunci unit, jadi tidak ada siklus.
 *
 * ponytail: checkInStore tidak mengunci, jadi check-in yang mendarat di milidetik yang sama dengan pindah
 * jadwal bisa lolos keduanya. Kunci grup di checkInStore bila itu pernah terjadi.
 */
export async function rescheduleBooking(id: string, request: unknown, staffId: string): Promise<AdminRescheduleResultDto> {
  const v = Validation.validate(BookingAdminValidation.RESCHEDULE, request)
  const { facility, defaultUnitId, durationMinutes } = await rescheduleSubject(id)

  const unit = unitFor(facility, v.facilityUnitId ?? defaultUnitId)
  const unitId = unit?.id ?? null

  await scheduleGate(v.bookingDate)

  const date = v.bookingDate
  const startTime = v.startTime
  const endTime = fromMinutes(toMinutes(startTime) + durationMinutes)
  const at = now()
  if (date === jakartaDate(at) && startTime <= jakartaHm(at)) throw fieldError('startTime', 'Slot waktu ini sudah lewat. Pilih jam berikutnya.')

  // Kelas: memaksa jam mulai sesi yang persis (roster & kalender bulan mengunci "YYYY-MM-DD HH:mm").
  // Walk-in lama di luar grid hanya bisa dipindah ke grid; panjang slot fasilitas yang sudah berubah = ditolak.
  const span = contiguousSpan(timeRangesFor(facility, unit, date), startTime, endTime)
  if (span.slots === 0 || !span.reachesEnd) throw fieldError('startTime', 'Jam ini tidak cocok dengan slot fasilitas untuk durasi reservasi ini.')

  const capacity = capacityFor(facility, unit, weekdayOf(date), startTime)

  const moved = await withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      await lockResource(tx, facility.id, unitId)

      const ref = await tx.booking.findUniqueOrThrow({
        where: { id },
        select: { bookingGroupId: true, transaction: { select: { id: true } }, bookingGroup: { select: { transaction: { select: { id: true } } } } }
      })
      const payableTxId = ref.transaction?.id ?? ref.bookingGroup?.transaction?.id ?? null
      if (payableTxId) await lockTransaction(tx, payableTxId)
      await lockGroup(tx, { id, bookingGroupId: ref.bookingGroupId })

      // Dibaca ulang di bawah kunci: "dari" di riwayat berasal dari sini, bukan dari baca di luar kunci.
      const current = await tx.booking.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          checkedInAt: true,
          endsAt: true,
          holdExpiresAt: true,
          bookingDate: true,
          startTime: true,
          endTime: true,
          facilityUnitId: true,
          pax: true,
          userId: true,
          customerPhone: true,
          facilityUnit: { select: { name: true } },
          user: { select: { name: true, email: true, phoneNumber: true } }
        }
      })
      const lockedAt = now()

      if (current.status !== 'pending' && current.status !== 'confirmed') {
        throw new ResponseError(409, 'Reservasi yang sudah dibatalkan atau selesai tidak bisa dipindah jadwalnya.', 'CONFLICT')
      }
      if (current.checkedInAt) throw new ResponseError(409, 'Pelanggan sudah check-in; jadwalnya tidak bisa dipindah.', 'CONFLICT')
      // Sudah mulai tapi belum check-in (terlambat) masih boleh; yang sudah berakhir = hangus.
      if (current.endsAt.getTime() <= lockedAt.getTime()) throw new ResponseError(409, 'Jadwal reservasi ini sudah berakhir.', 'CONFLICT')
      // Hold yang lewat sudah dianggap bebas oleh blocking(); memindahkannya tidak berarti apa-apa. Hold tidak diperpanjang.
      if (current.status === 'pending' && current.holdExpiresAt && current.holdExpiresAt.getTime() <= lockedAt.getTime()) {
        throw new ResponseError(409, HOLD_LAPSED_FOR_STAFF, 'HOLD_LAPSED')
      }

      const fromDate = dateOnlyToString(current.bookingDate)
      if (fromDate === date && current.startTime === startTime && current.facilityUnitId === unitId) {
        throw fieldError('startTime', 'Jadwal baru sama dengan jadwal saat ini.')
      }

      if (unitId) {
        const exception = await tx.classSessionException.findUnique({
          where: { facilityUnitId_sessionDate_startTime: { facilityUnitId: unitId, sessionDate: dateOnly(date), startTime } },
          select: { id: true }
        })
        if (exception) throw fieldError('startTime', `Sesi ${translatedDate(date, 'd F Y')} ${startTime} sudah dibatalkan.`)
      }

      const occupied = paxOverlapping(await blockingForDay(tx, facility.id, unitId, date, lockedAt, id), startTime, endTime)
      if (occupied + current.pax > capacity) throw fieldError('startTime', 'Slot tujuan sudah penuh. Pilih jadwal lain.')

      if (isClassMode(facility) && current.userId) {
        const sameSession = await tx.booking.count({
          where: { AND: [ownSessionsWhere(id, current.userId, facility.id, date, lockedAt), { startTime }] }
        })
        if (sameSession > 0) throw fieldError('startTime', 'Pelanggan ini sudah terdaftar di sesi tersebut.')
      }

      await tx.booking.update({
        where: { id },
        data: {
          bookingDate: dateOnly(date),
          startTime,
          endTime,
          // Wajib ditulis ulang bersama bookingDate/startTime/endTime (skema Booking.startsAt).
          startsAt: jakartaWallTimeToUtc(date, startTime),
          endsAt: jakartaWallTimeToUtc(date, endTime),
          facilityUnitId: unitId
        }
      })

      const before = { date: fromDate, startTime: current.startTime, endTime: current.endTime, unitName: current.facilityUnit?.name ?? null }
      const after = { date, startTime, endTime, unitName: unit?.name ?? null }
      await tx.bookingReschedule.create({
        data: {
          bookingId: id,
          actorId: staffId,
          fromDate: dateOnly(before.date),
          fromStartTime: before.startTime,
          fromEndTime: before.endTime,
          fromUnitName: before.unitName,
          toDate: dateOnly(after.date),
          toStartTime: after.startTime,
          toEndTime: after.endTime,
          toUnitName: after.unitName,
          reason: v.reason ?? null
        }
      })

      return { before, after, user: current.user, customerPhone: current.user?.phoneNumber ?? current.customerPhone }
    }, TX_OPTIONS)
  )

  // Email SETELAH commit, tidak ditunggu (mailer.ts). Walk-in tidak punya email: FO menghubungi nomornya.
  const email = moved.user?.email
  if (email) {
    void sendMailSafe(
      bookingRescheduledTemplate({
        to: email,
        name: moved.user?.name ?? 'Pelanggan',
        before: { facilityName: facility.name, ...moved.before },
        after: { facilityName: facility.name, ...moved.after },
        reason: v.reason ?? null,
        url: `${LANDING_BASE}/riwayat-booking`
      })
    )
  }

  return { id, mailQueued: Boolean(email), customerPhone: moved.customerPhone }
}
