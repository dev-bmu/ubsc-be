import { randomUUID } from 'crypto'
import type {
  BookingCreatedDto,
  BookingHistoryItemDto,
  MonthDayDto,
  MonthDto,
  MonthPatternDto,
  MonthSessionDto,
  MonthSummaryDto,
  SlotDto,
  SlotsDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { UserWithRelations } from '../type/user-request'
import {
  addMinutes,
  dateOnly,
  dateOnlyToString,
  daysInMonth,
  formatInstant,
  jakartaDate,
  jakartaHm,
  jakartaWallTimeToUtc,
  now,
  translatedDate,
  weekdayOf
} from '../utils/clock'
import { receiptNumber, rupiahPlain, slotPriceLabel, transferTotal } from '../utils/money'
import { withConflictRetry } from '../utils/prisma-errors'
import { randomAlphanumeric } from '../utils/random'
import { BookingValidation, CreateBookingInput } from '../validation/booking-validation'
import { Validation } from '../validation/Validation'
import {
  blockingForDay,
  cancelledSessionKeys,
  occupiedPaxForMonth,
  occupiedPaxForSessions,
  ownSessionKeysForMonth,
  paxOverlapping
} from './availability-services'
import { holdMinutes, isConfigured, openTransfer } from './manual-payment-services'
import {
  calculateSubtotal,
  durationForCategoryForUnit,
  FACILITY_WITH_PRICING,
  FacilityWithPricing,
  packagePrice,
  priceCategoryFor,
  priceForSlotForUnit,
  UnitWithPrices
} from './pricing-services'
import { capacityFor, cleanClosedDatesForMonth, isClassMode, sessionNoteFor, timeRangesFor } from './schedule-services'

// ============================================================================
// === Booking publik — port dari PublicBookingController ===
// ============================================================================
// slots()   grid satu tanggal untuk lapangan
// month()   sebulan penuh untuk kelas
// create()  POST booking 12 langkah
// history() riwayat pelanggan, satu kartu per pembelian
//
// Semua yang dikirim klien DIANGGAP TIDAK TEPERCAYA: harga, ketersediaan, jendela jadwal, dan batas
// slot diturunkan ulang di server. Tampilan (slots/month) dan penerimaan (create) memakai
// timeRangesFor() dan blocking() yang sama, jadi apa yang dilihat pelanggan dan apa yang diterima
// server tidak pernah bisa berbeda pendapat.

/**
 * Rentang slot berurutan terpanjang untuk satu reservasi lapangan.
 * Cermin MAX_SLOTS di komponen BookingListItem — tanpa batas ini dua klik bisa menghasilkan booking
 * 06:00-22:00.
 */
export const MAX_COURT_SLOTS = 6

function fieldError(field: string, message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { [field]: [message] })
}

const pad = (n: number) => String(n).padStart(2, '0')

// ===== Pemuat bersama =====

async function scheduleFor(year: number, month: number): Promise<{ isOpen: boolean; closedDates: string[] }> {
  const schedule = await prismaClient.bookingSchedule.findUnique({ where: { month_year: { month, year } } })
  return { isOpen: schedule?.isOpen ?? false, closedDates: cleanClosedDatesForMonth(schedule?.closedDates, month, year) }
}

/**
 * Aturan `exists:facilities,id` dan `exists:facility_units,id` Laravel, dijalankan sebagai bagian
 * dari validasi (sebelum aturan bisnis apa pun). Fasilitas ikut dimuat lengkap dengan harga dan unit
 * karena setiap jalur yang lolos dari sini membutuhkannya.
 */
async function facilityOrValidationError(facilityId: string, facilityUnitId: string | null | undefined): Promise<FacilityWithPricing> {
  const [facility, unitExists] = await Promise.all([
    prismaClient.facility.findUnique({ where: { id: facilityId }, include: FACILITY_WITH_PRICING }),
    facilityUnitId ? prismaClient.facilityUnit.count({ where: { id: facilityUnitId } }) : Promise.resolve(1)
  ])

  const fields: Record<string, string[]> = {}
  // Fasilitas nonaktif = tidak ada bagi publik: slot dan kalendernya tidak disajikan, sama seperti daftar.
  const usable = facility?.isActive ? facility : null
  if (!usable) fields.facilityId = ['Fasilitas tidak ditemukan.']
  if (!unitExists) fields.facilityUnitId = ['Unit tidak valid untuk fasilitas ini.']
  if (!usable || !unitExists) throw new ResponseError(422, Object.values(fields)[0][0], 'VALIDATION_ERROR', fields)

  return usable
}

/**
 * Unit untuk tampilan slots/month. Unit yang dikirim tapi tidak aktif / bukan milik fasilitas ini
 * adalah 404 (abort Laravel), berbeda dengan POST yang menjawab 422 menempel ke field.
 */
function unitForView(
  facility: FacilityWithPricing,
  facilityUnitId: string | null | undefined
): { unit: UnitWithPrices | null; requiresUnit: boolean } {
  const activeUnits = facility.units.filter((u) => u.isActive)
  let unit: UnitWithPrices | null = null

  if (facilityUnitId) {
    unit = activeUnits.find((u) => u.id === facilityUnitId) ?? null
    if (!unit) throw new ResponseError(404, 'Unit fasilitas tidak ditemukan')
  }

  return { unit, requiresUnit: activeUnits.length > 0 && !unit }
}

// ===== 1. Grid slot satu tanggal =====

export async function getSlots(query: unknown, user?: UserWithRelations): Promise<SlotsDto> {
  const v = Validation.validate(BookingValidation.SLOTS, query)
  const facility = await facilityOrValidationError(v.facilityId, v.facilityUnitId)

  const year = Number(v.date.slice(0, 4))
  const month = Number(v.date.slice(5, 7))
  const { isOpen, closedDates } = await scheduleFor(year, month)

  if (!isOpen) return { closed: true, reason: 'month_closed', slots: [], closedDates }
  if (closedDates.includes(v.date)) return { closed: true, reason: 'date_closed', slots: [], closedDates }

  const { unit, requiresUnit } = unitForView(facility, v.facilityUnitId)
  if (requiresUnit) return { closed: false, requiresUnit: true, slots: [], closedDates }

  const at = now()
  const today = jakartaDate(at)
  const nowHm = jakartaHm(at)
  const weekday = weekdayOf(v.date)
  const priceCategory = priceCategoryFor(user)

  // Bug 5 Rewrite.md: satu query okupansi untuk seluruh tanggal, bukan satu per slot.
  const occupiedRows = await blockingForDay(prismaClient, facility.id, unit?.id ?? null, v.date, at)

  const slots: SlotDto[] = timeRangesFor(facility, unit, v.date).map(([startTime, endTime]) => {
    const capacity = capacityFor(facility, unit, weekday, startTime)
    const price = priceForSlotForUnit(facility, unit, priceCategory, v.date, startTime, endTime)
    const occupiedPax = paxOverlapping(occupiedRows, startTime, endTime)

    // Slot yang sudah mulai tidak bisa dipesan lagi. Cek tanggal lampau wajib ada: tanpanya setiap
    // slot di tanggal yang SUDAH LEWAT kembali terbaca bisa dipesan, karena isToday bernilai false.
    const isPast = v.date < today || (v.date === today && startTime <= nowHm)
    const isBooked = occupiedPax >= capacity

    return {
      startTime,
      endTime,
      label: `${startTime} - ${endTime}`,
      price: slotPriceLabel(price),
      priceRaw: price,
      // Tiga keadaan, bukan dua: slot kosong yang sekadar lewat tidak boleh terlihat sama dengan slot terjual.
      status: isBooked ? 'booked' : isPast ? 'past' : 'available',
      past: isPast,
      wasBooked: occupiedPax > 0,
      remaining: Math.max(0, capacity - occupiedPax),
      capacity,
      facilityUnitId: unit?.id ?? null
    }
  })

  return { closed: false, requiresUnit: false, slots, closedDates }
}

// ===== 2. Sebulan penuh untuk kelas =====

function emptyMonthSummary(): MonthSummaryDto {
  return { sessionCount: 0, availableCount: 0, totalRaw: 0, total: 'Rp 0', package: null }
}

/**
 * Kelas berjalan dengan pola mingguan tetap dan dibeli per bulan, jadi pelanggan perlu melihat bentuk
 * sebulannya sebelum memilih. Okupansi sebulan dibaca dalam SATU query lalu dicocokkan di memori.
 *
 * Perbaikan atas Laravel: `Carbon::createFromFormat('Y-m', ...)` tanpa `!` mengisi hari dari tanggal
 * HARI INI, sehingga meminta "2026-02" pada tanggal 30 meluap ke Maret. Di sini bulan dibaca apa adanya.
 */
export async function getMonth(query: unknown, user?: UserWithRelations): Promise<MonthDto> {
  const v = Validation.validate(BookingValidation.MONTH, query)
  const facility = await facilityOrValidationError(v.facilityId, v.facilityUnitId)

  const year = Number(v.month.slice(0, 4))
  const month = Number(v.month.slice(5, 7))
  const { isOpen, closedDates } = await scheduleFor(year, month)

  const envelope = { month: v.month, monthLabel: translatedDate(`${v.month}-01`, 'F Y'), closedDates }

  if (!isOpen) {
    return { ...envelope, closed: true, reason: 'month_closed', requiresUnit: false, days: {}, patterns: [], summary: emptyMonthSummary() }
  }

  const { unit, requiresUnit } = unitForView(facility, v.facilityUnitId)
  if (requiresUnit) {
    return { ...envelope, closed: false, reason: null, requiresUnit: true, days: {}, patterns: [], summary: emptyMonthSummary() }
  }

  const unitId = unit?.id ?? null
  const at = now()
  const today = jakartaDate(at)
  const nowHm = jakartaHm(at)
  const priceCategory = priceCategoryFor(user)

  const [cancelled, occupied, mine] = await Promise.all([
    cancelledSessionKeys(prismaClient, unitId, year, month),
    occupiedPaxForMonth(facility.id, unitId, year, month, at),
    ownSessionKeysForMonth(user?.id ?? null, facility.id, unitId, year, month, at)
  ])

  const days: Record<string, MonthDayDto> = {}
  const patterns = new Map<string, MonthPatternDto>()
  let sessionCount = 0
  let availableCount = 0
  let availableTotal = 0
  let hasPast = false

  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const dateStr = `${v.month}-${pad(day)}`
    const weekday = weekdayOf(dateStr)
    const isClosed = closedDates.includes(dateStr)
    const sessions: MonthSessionDto[] = []

    for (const [startTime, endTime] of timeRangesFor(facility, unit, dateStr)) {
      const key = `${dateStr} ${startTime}`
      const taken = occupied.get(key) ?? 0
      const seats = capacityFor(facility, unit, weekday, startTime)
      const price = priceForSlotForUnit(facility, unit, priceCategory, dateStr, startTime, endTime)
      const isPast = dateStr < today || (dateStr === today && startTime <= nowHm)
      const alreadyBooked = mine.has(key)

      // 'full' diuji sebelum 'past' supaya sesi yang habis terjual lalu berjalan tidak mengaku kosong.
      const status = cancelled.has(key) ? 'cancelled' : isClosed ? 'closed' : taken >= seats ? 'full' : isPast ? 'past' : 'available'

      sessions.push({
        date: dateStr,
        startTime,
        endTime,
        label: `${startTime} - ${endTime}`,
        price: slotPriceLabel(price),
        priceRaw: price,
        status,
        past: isPast,
        wasBooked: taken > 0,
        remaining: Math.max(0, seats - taken),
        capacity: seats,
        alreadyBooked,
        facilityUnitId: unitId
      })

      sessionCount++
      // Sengaja dihitung untuk SEMUA sesi yang lewat, termasuk yang dibatalkan/tutup — sama seperti
      // Laravel. monthSessionKeys() (dipakai POST) melewati sesi tutup/batal lebih dulu; perbedaan kecil
      // itu dipertahankan demi paritas, lihat docs/fase-3.md.
      if (isPast) hasPast = true

      if (status === 'available' && !alreadyBooked) {
        availableCount++
        availableTotal += price

        // Satu chip per hari+jam, supaya pola mingguannya dinyatakan terang-terangan.
        const patternKey = `${weekday} ${startTime}`
        const pattern = patterns.get(patternKey) ?? { weekday, weekdayLabel: translatedDate(dateStr, 'l'), startTime, endTime, sessionCount: 0 }
        pattern.sessionCount++
        patterns.set(patternKey, pattern)
      }
    }

    if (sessions.length > 0) days[dateStr] = { weekday, closed: isClosed, sessions }
  }

  // Paket sebulan hanya jujur sebelum ada satu sesi pun yang berjalan.
  const monthlyPackage = hasPast ? null : isClassMode(facility) ? packagePrice(facility, unit, priceCategory) : null

  return {
    ...envelope,
    closed: false,
    reason: null,
    requiresUnit: false,
    capacity: capacityFor(facility, unit),
    sessionNote: sessionNoteFor(facility, durationForCategoryForUnit(facility, unit, 'umum')),
    days,
    patterns: [...patterns.values()],
    summary: {
      sessionCount,
      availableCount,
      totalRaw: availableTotal,
      total: rupiahPlain(availableTotal),
      package:
        monthlyPackage && availableCount > 1
          ? {
              priceRaw: monthlyPackage,
              price: rupiahPlain(monthlyPackage),
              sessionCount: availableCount,
              savingRaw: Math.max(0, availableTotal - monthlyPackage)
            }
          : null
    }
  }
}

// ===== 3. Buat booking (12 langkah) =====

interface PricedSession {
  date: string
  startTime: string
  endTime: string
  subtotal: number
}

/** Kedua bentuk request menjadi satu daftar terurut tanpa duplikat. Booking lapangan = paket berisi satu. */
function normaliseSessions(v: CreateBookingInput): PricedSession[] {
  const raw = v.sessions ?? [{ date: v.bookingDate as string, startTime: v.startTime as string, endTime: v.endTime as string }]

  // Kunci "tanggal jam": duplikat terakhir menang, lalu diurutkan menurut kunci (ksort PHP).
  const unique = new Map<string, PricedSession>()
  for (const s of raw) unique.set(`${s.date} ${s.startTime}`, { date: s.date, startTime: s.startTime, endTime: s.endTime, subtotal: 0 })

  return [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, session]) => session)
}

/**
 * Rentang harus berupa rangkaian slot BERURUTAN yang persis: dibuka di awal slot, setiap slot berikut
 * mulai tepat di akhir slot sebelumnya, dan rangkaian berakhir tepat di jam selesai yang diminta.
 *
 * Mengecek "apakah jam awal" dan "apakah jam akhir" secara terpisah tidak cukup: fasilitas yang buka
 * 08:00-10:00 dan 13:00-15:00 akan menerima 09:00-14:00, menjual empat jam yang tidak pernah buka.
 */
function contiguousSpan(ranges: Array<[string, string]>, startTime: string, endTime: string): { slots: number; reachesEnd: boolean } {
  let slots = 0
  let cursor = startTime
  // Urutan iterasi = urutan tersimpan, tidak diurutkan — sama seperti Laravel.
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeStart === cursor && rangeEnd <= endTime) {
      slots++
      cursor = rangeEnd
    }
  }
  return { slots, reachesEnd: cursor === endTime }
}

/**
 * Setiap sesi bookable bulan itu, dan apakah ada yang sudah lewat. Sesi di tanggal tutup atau yang
 * dibatalkan staff tidak dihitung sama sekali.
 */
function monthSessionKeys(
  facility: FacilityWithPricing,
  unit: UnitWithPrices | null,
  year: number,
  month: number,
  cancelled: Set<string>,
  closedDates: string[],
  today: string,
  nowHm: string
): { keys: string[]; hasPast: boolean } {
  const keys: string[] = []
  let hasPast = false

  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const dateStr = `${year}-${pad(month)}-${pad(day)}`
    for (const [startTime] of timeRangesFor(facility, unit, dateStr)) {
      const key = `${dateStr} ${startTime}`
      if (closedDates.includes(dateStr) || cancelled.has(key)) continue
      if (dateStr < today || (dateStr === today && startTime <= nowHm)) {
        hasPast = true
        continue
      }
      keys.push(key)
    }
  }

  return { keys, hasPast }
}

/**
 * Harga paket sebulan, bila pembelian ini MEMANG sebulan penuh.
 *
 * Hanya ditawarkan selama belum ada sesi bulan itu yang lewat — pelanggan yang bergabung tanggal 25
 * tidak boleh membayar harga sebulan untuk satu pertemuan. Syarat exact-match mencegah harga paket
 * diklaim untuk subset murah dari bulan itu.
 */
function packagePriceFor(
  facility: FacilityWithPricing,
  unit: UnitWithPrices | null,
  priceCategory: Parameters<typeof packagePrice>[2],
  year: number,
  month: number,
  sessions: PricedSession[],
  cancelled: Set<string>,
  closedDates: string[],
  today: string,
  nowHm: string
): number | null {
  if (!isClassMode(facility) || sessions.length < 2) return null

  const price = packagePrice(facility, unit, priceCategory)
  if (!price) return null

  const all = monthSessionKeys(facility, unit, year, month, cancelled, closedDates, today, nowHm)
  if (all.hasPast) return null

  const chosen = sessions.map((s) => `${s.date} ${s.startTime}`).sort()
  const available = [...all.keys].sort()
  return chosen.length === available.length && chosen.every((key, i) => key === available[i]) ? price : null
}

/**
 * Booking swalayan. Urutan langkah mengikuti Laravel karena urutan itu menentukan pesan mana yang
 * dilihat pelanggan saat beberapa hal salah sekaligus.
 */
export async function createBooking(user: UserWithRelations, request: unknown): Promise<BookingCreatedDto> {
  // 1. Email wajib terverifikasi sebelum uang berpindah tangan.
  if (!user.emailVerifiedAt) throw fieldError('email', 'Verifikasi email Anda terlebih dahulu sebelum melanjutkan pembayaran.')

  // 2. Bentuk data + keberadaan fasilitas/unit.
  const v = Validation.validate(BookingValidation.CREATE, request)
  const facility = await facilityOrValidationError(v.facilityId, v.facilityUnitId)
  const fromSessions = v.sessions !== null && v.sessions !== undefined
  const fieldFor = (index: number) => (fromSessions ? `sessions.${index}` : 'startTime')

  // 3. Satu jalur kode untuk kedua bentuk.
  const sessions = normaliseSessions(v)

  // 4. Paket terkurung satu bulan kalender — satu-satunya granularitas booking_schedules.
  const monthKey = sessions[0].date.slice(0, 7)
  if (sessions.some((s) => s.date.slice(0, 7) !== monthKey)) throw fieldError('sessions', 'Semua sesi harus berada di bulan yang sama.')

  const year = Number(monthKey.slice(0, 4))
  const month = Number(monthKey.slice(5, 7))

  // 5. Jendela jadwal.
  const { isOpen, closedDates } = await scheduleFor(year, month)
  if (!isOpen) throw fieldError('bookingDate', 'Bulan ini belum dibuka untuk reservasi.')

  // 6. Fasilitas aktif dan unit yang sah.
  if (!facility.isActive) throw new ResponseError(404, 'Fasilitas tidak ditemukan')

  const activeUnits = facility.units.filter((u) => u.isActive)
  let unit: UnitWithPrices | null = null
  if (v.facilityUnitId) {
    unit = activeUnits.find((u) => u.id === v.facilityUnitId) ?? null
    if (!unit) throw fieldError('facilityUnitId', 'Unit tidak valid untuk fasilitas ini.')
  } else if (activeUnits.length > 0) {
    throw fieldError('facilityUnitId', 'Pilih unit fasilitas terlebih dahulu.')
  }
  const unitId = unit?.id ?? null

  // 7. Rekening tujuan transfer harus sudah diatur staff.
  if (!(await isConfigured())) throw fieldError('bookingDate', 'Pembayaran sedang tidak tersedia. Silakan hubungi kami untuk reservasi.')

  // 8. Setiap sesi diturunkan ulang dan dihargai ulang di server.
  const cancelled = await cancelledSessionKeys(prismaClient, unitId, year, month)
  const priceCategory = priceCategoryFor(user)
  const checkedAt = now()
  const today = jakartaDate(checkedAt)
  const nowHm = jakartaHm(checkedAt)

  sessions.forEach((session, index) => {
    const field = fieldFor(index)

    if (session.endTime <= session.startTime) throw fieldError(field, 'Jam selesai harus setelah jam mulai.')
    if (session.date === today && session.startTime <= nowHm) throw fieldError(field, 'Slot waktu ini sudah lewat. Pilih jam berikutnya.')
    if (closedDates.includes(session.date)) throw fieldError(field, `Fasilitas tutup pada ${translatedDate(session.date, 'd F Y')}.`)
    if (cancelled.has(`${session.date} ${session.startTime}`))
      throw fieldError(field, `Sesi ${translatedDate(session.date, 'd F Y')} sudah dibatalkan.`)

    const span = contiguousSpan(timeRangesFor(facility, unit, session.date), session.startTime, session.endTime)
    if (span.slots > 0 && span.reachesEnd && !isClassMode(facility) && span.slots > MAX_COURT_SLOTS) {
      throw fieldError(field, `Maksimal ${MAX_COURT_SLOTS} jam per reservasi lapangan.`)
    }
    if (span.slots === 0 || !span.reachesEnd) throw fieldError(field, 'Slot waktu tidak valid untuk fasilitas ini.')

    session.subtotal = calculateSubtotal(facility, unit, priceCategory, session.date, session.startTime, session.endTime)
    if (session.subtotal <= 0) throw fieldError(field, 'Harga untuk slot ini belum diatur. Silakan hubungi kami.')
  })

  // 9. Harga paket bulanan (exact-match).
  const packageTotal = packagePriceFor(facility, unit, priceCategory, year, month, sessions, cancelled, closedDates, today, nowHm)
  const total = packageTotal ?? sessions.reduce((sum, s) => sum + s.subtotal, 0)

  // 10. Paket = satu harga untuk N pertemuan, jadi setiap baris booking membawa BAGIANNYA. Membiarkan
  //     harga per sesi membuat setiap daftar dan kuitansi berjumlah lebih dari yang dibayar pelanggan.
  if (packageTotal !== null) {
    const share = Math.floor(packageTotal / sessions.length)
    const remainder = packageTotal - share * sessions.length
    sessions.forEach((s, i) => (s.subtotal = share + (i === 0 ? remainder : 0)))
  }

  const minutes = await holdMinutes()

  // 11-12. Cek tabrakan yang aman terhadap race, lalu insert.
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      // Serialisasi setiap percobaan bersamaan pada resource ini SEBELUM membaca ketersediaan. Mengunci
      // baris booking yang AKAN bertabrakan tidak cukup: bila belum ada booking yang tumpang tindih,
      // tidak ada yang terkunci, dan dua request sama-sama membaca "kosong". Baris induk memberi mereka
      // sesuatu yang nyata untuk mengantre — dan untuk paket, satu kunci mencakup semua sesinya.
      //
      // Serialisasinya per unit (atau per fasilitas bila tanpa unit). Cukup untuk volume ini; bila satu
      // fasilitas suatu saat menanggung booking bersamaan yang padat, pindah ke satu baris per slot
      // dengan unique index (unit, tanggal, jam mulai).
      if (unit) {
        await tx.$queryRaw`SELECT id FROM facility_units WHERE id = ${unit.id} FOR UPDATE`
      } else {
        await tx.$queryRaw`SELECT id FROM facilities WHERE id = ${facility.id} FOR UPDATE`
      }

      const lockedAt = now()
      const occupied = await occupiedPaxForSessions(tx, facility.id, unitId, sessions, lockedAt)

      // Semua atau tidak sama sekali. Mengisi sebagian paket dengan harga penuh = tiket komplain;
      // mengisinya dengan harga hitung ulang = mengubah angka setelah pelanggan menyetujuinya.
      sessions.forEach((session, index) => {
        const capacity = capacityFor(facility, unit, weekdayOf(session.date), session.startTime)
        if ((occupied.get(`${session.date} ${session.startTime}`) ?? 0) + 1 > capacity) {
          throw fieldError(
            fieldFor(index),
            sessions.length > 1
              ? `Sesi ${translatedDate(session.date, 'd F')} ${session.startTime} baru saja penuh. Hapus sesi itu lalu coba lagi.`
              : 'Maaf, sebagian slot pada rentang ini baru saja terpesan. Silakan pilih waktu lain.'
          )
        }
      })

      const holdExpiresAt = addMinutes(lockedAt, minutes)
      const isPackage = sessions.length > 1
      // Lead menunjuk dirinya sendiri, jadi satu klausa menjangkau seluruh grup tanpa flag "lead" terpisah.
      const leadId = randomUUID()

      await tx.booking.createMany({
        data: sessions.map((s, i) => ({
          id: i === 0 ? leadId : randomUUID(),
          bookingGroupId: isPackage ? leadId : null,
          userId: user.id,
          customerName: user.name,
          customerPhone: user.phoneNumber,
          facilityId: facility.id,
          facilityUnitId: unitId,
          bookingDate: dateOnly(s.date),
          startTime: s.startTime,
          endTime: s.endTime,
          startsAt: jakartaWallTimeToUtc(s.date, s.startTime),
          endsAt: jakartaWallTimeToUtc(s.date, s.endTime),
          pax: 1,
          subtotalPrice: s.subtotal,
          status: 'pending' as const,
          holdExpiresAt,
          // Token INILAH tiketnya (dikodekan ke QR); dibuat saat insert seperti hook creating Laravel.
          checkInToken: randomAlphanumeric(32),
          notes: v.notes ?? null
        }))
      })

      // Satu transfer, satu kode unik, satu baris di rekening koran — digantungkan ke booking lead.
      const transaction = await openTransfer(tx, { bookingId: leadId }, user.id, total, holdExpiresAt, priceCategory)

      return { bookingId: leadId, transactionId: transaction.id, holdExpiresAt: holdExpiresAt.toISOString() }
    }, TX_OPTIONS)
  )
}

// ===== 4. Riwayat booking pelanggan =====

/**
 * Paket adalah satu pembelian, jadi satu kartu. Pengelompokan ini juga mencegah sesi anggota terbaca
 * UNPAID: hanya lead yang memegang transaksi, dan semua field pembayaran dibaca dari lead.
 */
export async function bookingHistory(userId: string): Promise<BookingHistoryItemDto[]> {
  const rows = await prismaClient.booking.findMany({
    where: { userId },
    include: { facility: { select: { name: true } }, facilityUnit: { select: { name: true } }, transaction: true },
    // Laravel: booking_date desc, id desc (PK auto-increment = urutan dibuat). PK di sini uuid, jadi
    // createdAt yang menggantikan urutan dibuat.
    orderBy: [{ bookingDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: 200
  })

  const groups = new Map<string, typeof rows>()
  for (const booking of rows) {
    const key = booking.bookingGroupId ?? booking.id
    const group = groups.get(key)
    if (group) group.push(booking)
    else groups.set(key, [booking])
  }

  const cards = [...groups.values()].map((group) => {
    const lead = group.find((b) => b.transaction !== null) ?? group[0]
    const sessions = [...group].sort(
      (a, b) => a.bookingDate.getTime() - b.bookingDate.getTime() || (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0)
    )
    return { lead, sessions }
  })

  // Sort stabil menurut tanggal sesi pertama, terbaru dulu.
  cards.sort((a, b) => b.sessions[0].bookingDate.getTime() - a.sessions[0].bookingDate.getTime())

  return cards.slice(0, 50).map(({ lead, sessions }) => {
    const t = lead.transaction
    return {
      sessions:
        sessions.length > 1
          ? sessions.map((s) => ({
              id: s.id,
              date: translatedDate(dateOnlyToString(s.bookingDate), 'D, d M Y'),
              time: `${s.startTime.slice(0, 5)} – ${s.endTime.slice(0, 5)}`,
              status: s.status
            }))
          : null,
      id: lead.id,
      facilityName: lead.facility.name,
      unitName: lead.facilityUnit?.name ?? null,
      date: dateOnlyToString(lead.bookingDate),
      startTime: lead.startTime.slice(0, 5),
      endTime: lead.endTime.slice(0, 5),
      status: lead.status,
      amount: t ? t.amount : sessions.reduce((sum, s) => sum + s.subtotalPrice, 0),
      paymentStatus: t?.paymentStatus ?? 'UNPAID',
      verificationStatus: t?.verificationStatus ?? null,
      transferTotal: t ? transferTotal(t) : lead.subtotalPrice,
      hasPayment: t !== null,
      holdExpiresAt: lead.holdExpiresAt?.toISOString() ?? null,
      hasTicket: t?.paymentStatus === 'PAID' && (lead.status === 'confirmed' || lead.status === 'completed'),
      // format() Carbon TIDAK diterjemahkan: "17 Aug 2026 10:00".
      checkedInAt: lead.checkedInAt ? formatInstant(lead.checkedInAt, 'd M Y H:i') : null,
      receipt: t ? receiptNumber(t.receiptSequence) : null,
      createdAt: formatInstant(lead.createdAt, 'd M Y H:i')
    }
  })
}
