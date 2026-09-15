import { prismaClient } from '../src/application/database'
import { createBooking, getMonth, getSlots } from '../src/services/booking-services'
import { addMinutes, setNowForTests } from '../src/utils/clock'
import {
  closeDatabase,
  configurePayments,
  createCustomer,
  createFacility,
  freezeAt,
  FROZEN_NOW,
  insertBooking,
  openMonth,
  resetDatabase
} from './helpers/fixtures'

// ============================================================================
// === blocking() — satu invarian ketersediaan untuk semua jalur ===
// ============================================================================
// Booking `pending` yang hold-nya sudah lewat WAJIB dikecualikan oleh grid slot, kalender bulan, DAN
// pemeriksaan kapasitas POST booking. `completed` tetap memblokir; hold NULL memblokir selamanya.

beforeAll(async () => {
  await resetDatabase()
  await configurePayments()
  await openMonth(2026, 10)
})

beforeEach(() => setNowForTests(FROZEN_NOW))

afterAll(closeDatabase)

const slotAt = <T extends { startTime: string }>(slots: T[], start: string): T | undefined => slots.find((s) => s.startTime === start)

describe('status okupansi di grid slot', () => {
  it('hold lewat membebaskan, hold hidup / hold NULL / completed memblokir, cancelled membebaskan', async () => {
    const facility = await createFacility({ capacity: 1 })
    const date = '2026-10-06'
    await insertBooking({
      facilityId: facility.id,
      date,
      startTime: '09:00',
      endTime: '10:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, -1)
    })
    await insertBooking({
      facilityId: facility.id,
      date,
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, 30)
    })
    await insertBooking({ facilityId: facility.id, date, startTime: '11:00', endTime: '12:00', status: 'pending', holdExpiresAt: null })
    await insertBooking({ facilityId: facility.id, date, startTime: '12:00', endTime: '13:00', status: 'completed' })
    await insertBooking({ facilityId: facility.id, date, startTime: '13:00', endTime: '14:00', status: 'cancelled' })

    const { slots } = await getSlots({ facilityId: facility.id, date })

    expect(slotAt(slots, '09:00')).toMatchObject({ status: 'available', wasBooked: false, remaining: 1 })
    expect(slotAt(slots, '10:00')).toMatchObject({ status: 'booked', wasBooked: true, remaining: 0 })
    expect(slotAt(slots, '11:00')).toMatchObject({ status: 'booked' })
    expect(slotAt(slots, '12:00')).toMatchObject({ status: 'booked' })
    expect(slotAt(slots, '13:00')).toMatchObject({ status: 'available' })
  })

  it('POST booking memakai aturan yang sama: hold lewat bisa dipesan, hold hidup ditolak', async () => {
    const facility = await createFacility({ capacity: 1 })
    const customer = await createCustomer()
    await insertBooking({
      facilityId: facility.id,
      date: '2026-10-07',
      startTime: '09:00',
      endTime: '10:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, -1)
    })
    await insertBooking({
      facilityId: facility.id,
      date: '2026-10-07',
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, 30)
    })

    await expect(
      createBooking(customer, { facilityId: facility.id, bookingDate: '2026-10-07', startTime: '09:00', endTime: '10:00' })
    ).resolves.toHaveProperty('bookingId')
    await expect(
      createBooking(customer, { facilityId: facility.id, bookingDate: '2026-10-07', startTime: '10:00', endTime: '11:00' })
    ).rejects.toMatchObject({ status: 422 })
  })

  it('kalender bulan memakai aturan yang sama', async () => {
    const facility = await createFacility({ mode: 'class', capacity: 1, activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] } })
    await insertBooking({
      facilityId: facility.id,
      date: '2026-10-13',
      startTime: '18:00',
      endTime: '19:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, -1)
    })
    await insertBooking({ facilityId: facility.id, date: '2026-10-15', startTime: '18:00', endTime: '19:00', status: 'completed' })

    const month = await getMonth({ facilityId: facility.id, month: '2026-10' })

    expect(month.days['2026-10-13'].sessions[0]).toMatchObject({ status: 'available', wasBooked: false })
    expect(month.days['2026-10-15'].sessions[0]).toMatchObject({ status: 'full', remaining: 0 })
  })

  it('booking tanpa unit menahan SEMUA unit; booking di unit A tidak menahan unit B', async () => {
    const facility = await createFacility({ capacity: 1, units: [{ name: 'A' }, { name: 'B' }] })
    const [unitA, unitB] = facility.units
    const date = '2026-10-08'
    await insertBooking({ facilityId: facility.id, facilityUnitId: null, date, startTime: '09:00', endTime: '10:00' })
    await insertBooking({ facilityId: facility.id, facilityUnitId: unitA.id, date, startTime: '10:00', endTime: '11:00' })

    const a = await getSlots({ facilityId: facility.id, facilityUnitId: unitA.id, date })
    const b = await getSlots({ facilityId: facility.id, facilityUnitId: unitB.id, date })

    expect(slotAt(a.slots, '09:00')?.status).toBe('booked')
    expect(slotAt(b.slots, '09:00')?.status).toBe('booked')
    expect(slotAt(a.slots, '10:00')?.status).toBe('booked')
    expect(slotAt(b.slots, '10:00')?.status).toBe('available')
  })
})

describe('waktu dan jadwal', () => {
  it('hari ini: slot yang sudah mulai "past"; tanggal lampau seluruhnya "past"', async () => {
    const facility = await createFacility({ capacity: 1 })

    const today = await getSlots({ facilityId: facility.id, date: '2026-10-05' })
    expect(slotAt(today.slots, '07:00')?.status).toBe('past')
    // Tepat 08:00 = sudah mulai (startTime <= jam sekarang).
    expect(slotAt(today.slots, '08:00')?.status).toBe('past')
    expect(slotAt(today.slots, '09:00')?.status).toBe('available')

    const yesterday = await getSlots({ facilityId: facility.id, date: '2026-10-04' })
    expect(yesterday.slots.every((s) => s.status === 'past')).toBe(true)
  })

  it('"hari ini" dihitung di Jakarta: 06:30 WIB tanggal 6 = 23:30 UTC tanggal 5, dan proses test ber-TZ UTC', async () => {
    const facility = await createFacility({ capacity: 1 })
    const customer = await createCustomer()
    freezeAt('2026-10-06', '06:30')

    // Di Jakarta tanggal 5 sudah kemarin: seluruh slotnya lewat, dan tidak bisa dipesan lagi.
    const yesterday = await getSlots({ facilityId: facility.id, date: '2026-10-05' })
    expect(yesterday.slots.every((s) => s.status === 'past')).toBe(true)
    await expect(
      createBooking(customer, { facilityId: facility.id, bookingDate: '2026-10-05', startTime: '21:00', endTime: '22:00' })
    ).rejects.toMatchObject({
      name: 'ZodError'
    })

    // Tanggal 6 adalah hari ini: 06:00 sudah mulai, 07:00 masih bisa dipesan.
    const today = await getSlots({ facilityId: facility.id, date: '2026-10-06' })
    expect(slotAt(today.slots, '06:00')?.status).toBe('past')
    expect(slotAt(today.slots, '07:00')?.status).toBe('available')
    await expect(
      createBooking(customer, { facilityId: facility.id, bookingDate: '2026-10-06', startTime: '06:00', endTime: '07:00' })
    ).rejects.toMatchObject({
      fields: { startTime: ['Slot waktu ini sudah lewat. Pilih jam berikutnya.'] }
    })
    await expect(
      createBooking(customer, { facilityId: facility.id, bookingDate: '2026-10-06', startTime: '07:00', endTime: '08:00' })
    ).resolves.toHaveProperty('bookingId')

    // startsAt disimpan sebagai instan UTC dari jam dinding Jakarta.
    const stored = await prismaClient.booking.findFirstOrThrow({ where: { facilityId: facility.id } })
    expect(stored.startsAt.toISOString()).toBe('2026-10-06T00:00:00.000Z')
  })

  it('bulan belum dibuka dan tanggal tutup', async () => {
    const facility = await createFacility({ capacity: 1 })
    await openMonth(2026, 11, ['2026-11-10', '2026-12-01', 'bukan-tanggal'])
    await openMonth(2026, 12, [], false)

    await expect(getSlots({ facilityId: facility.id, date: '2026-12-02' })).resolves.toMatchObject({
      closed: true,
      reason: 'month_closed',
      slots: []
    })
    // Bug 6: tanggal dari bulan lain dan sampah dibersihkan dari closedDates.
    await expect(getSlots({ facilityId: facility.id, date: '2026-11-10' })).resolves.toMatchObject({
      closed: true,
      reason: 'date_closed',
      closedDates: ['2026-11-10']
    })
  })

  it('fasilitas dengan unit aktif tanpa unit dipilih: requiresUnit', async () => {
    const facility = await createFacility({ capacity: 1, units: [{ name: 'A' }] })
    await expect(getSlots({ facilityId: facility.id, date: '2026-10-09' })).resolves.toMatchObject({ closed: false, requiresUnit: true, slots: [] })
    await expect(
      getSlots({ facilityId: facility.id, facilityUnitId: '00000000-0000-0000-0000-000000000000', date: '2026-10-09' })
    ).rejects.toMatchObject({ status: 422 })
  })

  it('bulan dibaca apa adanya pada tanggal 31 (Carbon::createFromFormat Laravel meluap ke bulan berikutnya)', async () => {
    const facility = await createFacility({ mode: 'class', capacity: 1, activeSlots: { Monday: ['18:00'] } })
    freezeAt('2026-10-31', '10:00')
    const month = await getMonth({ facilityId: facility.id, month: '2026-11' })
    expect(month).toMatchObject({ month: '2026-11', monthLabel: 'November 2026' })
  })
})

describe('kategori harga', () => {
  it('harga warga UB hanya untuk identitas warga kampus yang SUDAH diverifikasi (bug 2)', async () => {
    const facility = await createFacility({ capacity: 1, price: 150_000, wargaPrice: 90_000 })
    const verified = await createCustomer({ identityCategory: 'warga_kampus', identityStatus: 'verified' })
    const pending = await createCustomer({ identityCategory: 'warga_kampus', identityStatus: 'pending' })

    const asVerified = await getSlots({ facilityId: facility.id, date: '2026-10-10' }, verified)
    const asPending = await getSlots({ facilityId: facility.id, date: '2026-10-10' }, pending)
    const anonymous = await getSlots({ facilityId: facility.id, date: '2026-10-10' })

    expect(slotAt(asVerified.slots, '09:00')).toMatchObject({ priceRaw: 90_000, price: 'Rp 90.000' })
    expect(slotAt(asPending.slots, '09:00')).toMatchObject({ priceRaw: 150_000, price: 'Rp 150.000' })
    expect(slotAt(anonymous.slots, '09:00')?.priceRaw).toBe(150_000)

    const created = await createBooking(verified, { facilityId: facility.id, bookingDate: '2026-10-10', startTime: '09:00', endTime: '11:00' })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(180_000)
  })
})
