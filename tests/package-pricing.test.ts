import { prismaClient } from '../src/application/database'
import { createBooking, getMonth } from '../src/services/booking-services'
import { closeDatabase, configurePayments, createCustomer, createFacility, freezeAt, openMonth, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === Harga paket bulanan — aturan exact-match ===
// ============================================================================
// Harga paket hanya berlaku bila himpunan sesi yang dibeli PERSIS sama dengan seluruh sesi bookable
// bulan itu, dan hanya selama belum ada sesi bulan itu yang lewat.
//
// Oktober 2026, kelas Selasa + Kamis 18:00: Kamis 1, 8, 15, 22, 29 dan Selasa 6, 13, 20, 27 = 9 sesi.

const OCTOBER = ['2026-10-01', '2026-10-06', '2026-10-08', '2026-10-13', '2026-10-15', '2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29']
const sessionsOf = (dates: string[]) => dates.map((date) => ({ date, startTime: '18:00', endTime: '19:00' }))

async function classFacility(packagePrice = 700_000) {
  return createFacility({ mode: 'class', capacity: 10, price: 100_000, packagePrice, activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] } })
}

const bookingsOf = (leadId: string) => prismaClient.booking.findMany({ where: { bookingGroupId: leadId }, orderBy: { bookingDate: 'asc' } })

beforeAll(async () => {
  await resetDatabase()
  await configurePayments()
  await openMonth(2026, 10)
  await openMonth(2026, 11, ['2026-11-12'])
})

beforeEach(() => freezeAt('2026-09-30', '12:00'))

afterAll(closeDatabase)

describe('tampilan bulan', () => {
  it('menawarkan paket sebelum ada sesi yang lewat, lengkap dengan pola dan penghematan', async () => {
    const facility = await classFacility()

    const month = await getMonth({ facilityId: facility.id, month: '2026-10' })

    expect(month).toMatchObject({
      month: '2026-10',
      monthLabel: 'Oktober 2026',
      closed: false,
      requiresUnit: false,
      capacity: 10,
      sessionNote: '1 jam per sesi'
    })
    expect(Object.keys(month.days)).toEqual(OCTOBER)
    expect(month.summary).toEqual({
      sessionCount: 9,
      availableCount: 9,
      totalRaw: 900_000,
      total: 'Rp 900.000',
      package: { priceRaw: 700_000, price: 'Rp 700.000', sessionCount: 9, savingRaw: 200_000 }
    })
    // Urutan pola = urutan kemunculan pertama: Kamis 1 Oktober lebih dulu dari Selasa 6 Oktober.
    expect(month.patterns).toEqual([
      { weekday: 'Thursday', weekdayLabel: 'Kamis', startTime: '18:00', endTime: '19:00', sessionCount: 5 },
      { weekday: 'Tuesday', weekdayLabel: 'Selasa', startTime: '18:00', endTime: '19:00', sessionCount: 4 }
    ])
  })

  it('tanpa paket begitu satu sesi bulan itu sudah berjalan', async () => {
    const facility = await classFacility()
    freezeAt('2026-10-01', '18:00')

    const month = await getMonth({ facilityId: facility.id, month: '2026-10' })

    expect(month.days['2026-10-01'].sessions[0].status).toBe('past')
    expect(month.summary).toMatchObject({ availableCount: 8, totalRaw: 800_000, package: null })
  })
})

describe('POST booking', () => {
  it('seluruh sesi bulan itu: harga paket, dibagi rata ke setiap baris dengan sisa di sesi pertama', async () => {
    const facility = await classFacility()
    const created = await createBooking(await createCustomer(), { facilityId: facility.id, sessions: sessionsOf(OCTOBER) })

    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(700_000)
    const rows = await bookingsOf(created.bookingId)
    expect(rows).toHaveLength(9)
    // 700.000 / 9 = 77.777 sisa 7.
    expect(rows.map((r) => r.subtotalPrice)).toEqual([77_784, 77_777, 77_777, 77_777, 77_777, 77_777, 77_777, 77_777, 77_777])
    expect(rows.reduce((sum, r) => sum + r.subtotalPrice, 0)).toBe(700_000)
    expect(rows[0].id).toBe(created.bookingId)
  })

  it('urutan dan duplikat di request tidak mengubah hasil', async () => {
    const facility = await classFacility()
    const shuffled = sessionsOf([...OCTOBER].reverse().concat(['2026-10-13']))
    const created = await createBooking(await createCustomer(), { facilityId: facility.id, sessions: shuffled })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(700_000)
  })

  it('subset bulan: harga per sesi, bukan paket', async () => {
    const facility = await classFacility()
    const created = await createBooking(await createCustomer(), { facilityId: facility.id, sessions: sessionsOf(OCTOBER.slice(0, 8)) })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(800_000)
    ;(await bookingsOf(created.bookingId)).forEach((r) => expect(r.subtotalPrice).toBe(100_000))
  })

  it('setelah sesi pertama lewat, sisa sesi bulan itu dibayar per sesi', async () => {
    const facility = await classFacility()
    freezeAt('2026-10-02', '09:00')
    const created = await createBooking(await createCustomer(), { facilityId: facility.id, sessions: sessionsOf(OCTOBER.slice(1)) })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(800_000)
  })

  it('tanggal tutup tidak dihitung: seluruh sesi BOOKABLE November = paket', async () => {
    // November 2026: Selasa 3, 10, 17, 24; Kamis 5, 12 (tutup), 19, 26.
    const facility = await classFacility()
    const bookable = ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-17', '2026-11-19', '2026-11-24', '2026-11-26']

    const month = await getMonth({ facilityId: facility.id, month: '2026-11' })
    expect(month.days['2026-11-12'].sessions[0].status).toBe('closed')
    expect(month.summary.package).toMatchObject({ sessionCount: 7, savingRaw: 0 })

    const created = await createBooking(await createCustomer(), { facilityId: facility.id, sessions: sessionsOf(bookable) })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(700_000)
  })

  it('harga paket unit menang atas harga paket fasilitas', async () => {
    const facility = await createFacility({
      mode: 'class',
      capacity: 10,
      price: 100_000,
      packagePrice: 700_000,
      activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] },
      units: [{ name: 'Grup Pagi', capacity: 10 }]
    })
    const unit = facility.units[0]
    await prismaClient.facilityUnitPrice.create({
      data: { facilityUnitId: unit.id, userCategory: 'umum', priceType: 'monthly_package', label: 'Paket Grup', price: 650_000, durationMinutes: 60 }
    })

    const created = await createBooking(await createCustomer(), { facilityId: facility.id, facilityUnitId: unit.id, sessions: sessionsOf(OCTOBER) })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: created.transactionId } })).amount).toBe(650_000)
  })

  it('sesi di bulan berbeda dalam satu paket ditolak', async () => {
    const facility = await classFacility()
    await expect(
      createBooking(await createCustomer(), { facilityId: facility.id, sessions: sessionsOf(['2026-10-29', '2026-11-03']) })
    ).rejects.toMatchObject({
      status: 422,
      fields: { sessions: ['Semua sesi harus berada di bulan yang sama.'] }
    })
  })
})
