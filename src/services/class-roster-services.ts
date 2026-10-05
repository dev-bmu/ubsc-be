import { Transaction } from '@prisma/client'
import type { ClassOptionDto, ClassRosterDto, DayCellDto, RosterRowDto, SessionCellDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { addDays, dateOnly, dateOnlyToString, daysInMonth, formatInstant, jakartaDate, translatedDate, weekdayOf } from '../utils/clock'

import { withConflictRetry } from '../utils/prisma-errors'
import { BookingAdminValidation } from '../validation/booking-admin-validation'
import { Validation } from '../validation/Validation'
import { cancelledSessionKeys } from './availability-services'
import { FACILITY_WITH_PRICING, FacilityWithPricing, UnitWithPrices } from './pricing-services'
import { capacityFor, cleanClosedDatesForMonth, timeRangesFor } from './schedule-services'

// ============================================================================
// === Roster kelas admin — port dari Admin\ClassSessionController ===
// ============================================================================
// index/buildMonth/rosterFor, cancel (batalkan pertemuan), restore (buka kembali). Jam sesi & kapasitas
// LEWAT timeRangesFor()/capacityFor() yang sama dengan pelanggan; sesi yang dibatalkan staff lewat
// cancelledSessionKeys(). "taken" mengikuti Laravel: COUNT status in [pending, confirmed, completed].

const pad = (n: number) => String(n).padStart(2, '0')

function payableTransaction(booking: {
  transaction: Transaction | null
  bookingGroup: { transaction: Transaction | null } | null
}): Transaction | null {
  return booking.transaction ?? booking.bookingGroup?.transaction ?? null
}

/**
 * "YYYY-MM" -> {monthStr, year, month}, longgar seperti monthFrom() Laravel: pola tak cocok / kosong ->
 * bulan berjalan (Jakarta). Bulan di luar 1..12 di-overflow seperti Carbon (2026-13 -> 2027-01).
 */
function monthFrom(raw: string | null | undefined): { monthStr: string; year: number; month: number } {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const base = new Date(Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, 1))
    const year = base.getUTCFullYear()
    const month = base.getUTCMonth() + 1
    return { monthStr: `${year}-${pad(month)}`, year, month }
  }
  const today = jakartaDate()
  return { monthStr: today.slice(0, 7), year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
}

// ===== buildMonth =====

async function buildMonth(
  facility: FacilityWithPricing,
  unit: UnitWithPrices | null,
  year: number,
  month: number
): Promise<Record<string, DayCellDto>> {
  const unitId = unit?.id ?? null
  const firstStr = `${year}-${pad(month)}-01`
  const gte = dateOnly(firstStr)
  const lt = dateOnly(addDays(firstStr, daysInMonth(year, month)))

  const schedule = await prismaClient.bookingSchedule.findUnique({ where: { month_year: { month, year } } })
  const closedDates = cleanClosedDatesForMonth(schedule?.closedDates, month, year)

  // "taken" = COUNT booking status in [pending, confirmed, completed], per tanggal+jam mulai (Laravel).
  const counts = await prismaClient.booking.groupBy({
    by: ['bookingDate', 'startTime'],
    where: {
      facilityId: facility.id,
      ...(unitId ? { facilityUnitId: unitId } : {}),
      bookingDate: { gte, lt },
      status: { in: ['pending', 'confirmed', 'completed'] }
    },
    _count: { _all: true }
  })
  const takenMap = new Map<string, number>()
  for (const row of counts) takenMap.set(`${dateOnlyToString(row.bookingDate)} ${row.startTime.slice(0, 5)}`, row._count._all)

  const cancelled = await cancelledSessionKeys(prismaClient, unitId, year, month)

  const days: Record<string, DayCellDto> = {}
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const dateStr = `${year}-${pad(month)}-${pad(day)}`
    const weekday = weekdayOf(dateStr)
    const sessions: SessionCellDto[] = []

    for (const [startTime, endTime] of timeRangesFor(facility, unit, dateStr)) {
      const key = `${dateStr} ${startTime}`
      sessions.push({
        startTime,
        endTime,
        taken: takenMap.get(key) ?? 0,
        capacity: capacityFor(facility, unit, weekday, startTime),
        cancelled: cancelled.has(key)
      })
    }

    if (sessions.length > 0) {
      days[dateStr] = { weekday: translatedDate(dateStr, 'l'), closed: closedDates.includes(dateStr), sessions }
    }
  }

  return days
}

// ===== rosterFor =====

async function rosterFor(facility: FacilityWithPricing, unit: UnitWithPrices | null, date: string): Promise<RosterRowDto[]> {
  const rows = await prismaClient.booking.findMany({
    where: { facilityId: facility.id, ...(unit ? { facilityUnitId: unit.id } : {}), bookingDate: dateOnly(date) },
    include: { user: { select: { name: true, phoneNumber: true } }, transaction: true, bookingGroup: { select: { transaction: true } } },
    // Laravel: start_time, id (PK auto-increment = urutan dibuat). PK uuid -> createdAt menggantikan urutan itu.
    orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })

  return rows.map((b) => {
    const tx = payableTransaction(b)
    return {
      id: b.id,
      startTime: b.startTime.slice(0, 5),
      // `?:` PHP: string kosong ikut jatuh ke fallback.
      name: b.customerName || b.user?.name || '-',
      phone: b.customerPhone || b.user?.phoneNumber || null,
      status: b.status,
      paymentStatus: tx?.paymentStatus ?? 'UNPAID',
      receipt: tx ? tx.invoiceNumber : null,
      checkedInAt: b.checkedInAt ? formatInstant(b.checkedInAt, 'H:i') : null,
      isPackage: b.bookingGroupId != null
    }
  })
}

// ===== index =====

function emptyRoster(monthStr: string): ClassRosterDto {
  return {
    classes: [],
    facility: null,
    unit: null,
    month: monthStr,
    monthLabel: translatedDate(`${monthStr}-01`, 'F Y'),
    days: {},
    date: null,
    roster: []
  }
}

function classOptions(facilities: FacilityWithPricing[]): ClassOptionDto[] {
  return facilities.map((f) => ({
    id: f.id,
    name: f.name,
    units: f.units.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name, capacity: u.capacity }))
  }))
}

export async function classRoster(query: unknown): Promise<ClassRosterDto> {
  const v = Validation.validate(BookingAdminValidation.ROSTER, query)
  const { monthStr, year, month } = monthFrom(v.month)

  const classes = await prismaClient.facility.findMany({
    where: { bookingMode: 'class' },
    include: FACILITY_WITH_PRICING,
    orderBy: { name: 'asc' }
  })

  // filled(facility_id) ? firstWhere(id) : first(). Param yang tak cocok -> null -> respons kosong (Laravel).
  const facility = v.facilityId ? (classes.find((f) => f.id === v.facilityId) ?? null) : (classes[0] ?? null)
  if (!facility) return emptyRoster(monthStr)

  const activeUnits = facility.units.filter((u) => u.isActive)
  const unit = v.facilityUnitId ? (activeUnits.find((u) => u.id === v.facilityUnitId) ?? null) : (activeUnits[0] ?? null)

  const days = await buildMonth(facility, unit, year, month)
  const date = v.date && days[v.date] ? v.date : null
  const roster = date ? await rosterFor(facility, unit, date) : []

  return {
    classes: classOptions(classes),
    facility: { id: facility.id, name: facility.name },
    unit: unit ? { id: unit.id, name: unit.name } : null,
    month: monthStr,
    monthLabel: translatedDate(`${monthStr}-01`, 'F Y'),
    days,
    date,
    roster
  }
}

// ===== cancel / restore =====

function fieldError(field: string, message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { [field]: [message] })
}

/**
 * Batalkan satu pertemuan. Baris exception itulah yang menyetop pendaftaran baru — membatalkan
 * booking saja akan meninggalkan slot terbuka dan kursi yang baru bebas langsung diambil orang.
 * Refund tetap manual (memang begitu di transfer manual).
 */
export async function cancelSession(request: unknown, staffId: string): Promise<{ cancelledBookings: number }> {
  const v = Validation.validate(BookingAdminValidation.CANCEL_SESSION, request)

  const [facilityExists, unitExists] = await Promise.all([
    prismaClient.facility.count({ where: { id: v.facilityId } }),
    prismaClient.facilityUnit.count({ where: { id: v.facilityUnitId } })
  ])
  if (!facilityExists) throw fieldError('facilityId', 'Fasilitas tidak ditemukan.')
  if (!unitExists) throw fieldError('facilityUnitId', 'Unit tidak ditemukan.')

  const sessionDate = dateOnly(v.sessionDate)

  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      // Cancel sesi yang sudah dibatalkan = perbarui catatan (upsert), bukan bentrok unique index.
      await tx.classSessionException.upsert({
        where: { facilityUnitId_sessionDate_startTime: { facilityUnitId: v.facilityUnitId, sessionDate, startTime: v.startTime } },
        create: {
          facilityId: v.facilityId,
          facilityUnitId: v.facilityUnitId,
          sessionDate,
          startTime: v.startTime,
          reason: v.reason ?? null,
          createdById: staffId
        },
        update: { facilityId: v.facilityId, reason: v.reason ?? null, createdById: staffId }
      })

      const result = await tx.booking.updateMany({
        where: {
          facilityId: v.facilityId,
          facilityUnitId: v.facilityUnitId,
          bookingDate: sessionDate,
          startTime: v.startTime,
          status: { in: ['pending', 'confirmed'] }
        },
        data: { status: 'cancelled', cancelledReason: 'session_cancelled', holdExpiresAt: null }
      })

      return { cancelledBookings: result.count }
    }, TX_OPTIONS)
  )
}

/**
 * Buka kembali sesi. Sengaja TIDAK meng-un-cancel booking lama: orang-orang itu sudah diberi tahu
 * kelas batal, jadi kursinya kembali dijual kosong.
 */
export async function restoreSession(request: unknown): Promise<{ restored: number }> {
  const v = Validation.validate(BookingAdminValidation.RESTORE_SESSION, request)

  const unitExists = await prismaClient.facilityUnit.count({ where: { id: v.facilityUnitId } })
  if (!unitExists) throw fieldError('facilityUnitId', 'Unit tidak ditemukan.')

  const result = await prismaClient.classSessionException.deleteMany({
    where: { facilityUnitId: v.facilityUnitId, sessionDate: dateOnly(v.sessionDate), startTime: v.startTime }
  })

  return { restored: result.count }
}
