import request from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { createBooking } from '../src/services/booking-services'
import { addMinutes, dateOnly, jakartaWallTimeToUtc, setNowForTests } from '../src/utils/clock'
import { waitForPendingMail } from '../src/utils/mailer'
import {
  bearer,
  closeDatabase,
  configurePayments,
  createCustomer,
  createFacility,
  createStaff,
  FROZEN_NOW,
  insertBooking,
  openMonth,
  resetDatabase
} from './helpers/fixtures'

// ============================================================================
// === Pindah jadwal staff lewat HTTP ===
// ============================================================================
// Jam beku: Senin 5 Oktober 2026 08:00 WIB. Oktober buka dengan 20 Oktober tutup; Desember belum dibuka.
// Balapan (kursi terakhir, expire, batal sesi) diuji di booking-concurrency.test.ts.

const CLOSED_DATE = '2026-10-20'

let fo: string
let foName: string
let foId: string

beforeAll(async () => {
  await resetDatabase()
  await configurePayments()
  await openMonth(2026, 10, [CLOSED_DATE])
  const staff = await createStaff('Staff Front Office')
  fo = bearer(staff, 'staff')
  foName = staff.name
  foId = staff.id
})

beforeEach(() => setNowForTests(FROZEN_NOW))

afterAll(closeDatabase)

const move = (id: string, body: object, auth = fo) => request(web).patch(`/api/admin/bookings/${id}/reschedule`).set('Authorization', auth).send(body)
const options = (id: string, query: object, auth = fo) =>
  request(web).get(`/api/admin/bookings/${id}/reschedule-options`).query(query).set('Authorization', auth)

function expectFieldError(res: request.Response, field: string): void {
  expect(res.status).toBe(422)
  expect(res.body.error.code).toBe('VALIDATION_ERROR')
  expect(Object.keys(res.body.error.fields)).toEqual([field])
}

/** Kelas Selasa & Kamis 18:00, satu grup. */
const createClass = () =>
  createFacility({ mode: 'class', activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] }, units: [{ name: 'Grup A', capacity: 10 }] })

describe('berhasil', () => {
  it('pindah tumpang tindih di hari yang sama (10-12 -> 11-13) pada lapangan berkapasitas 1: booking tidak menghalangi dirinya sendiri', async () => {
    const court = await createFacility({ capacity: 1 })
    const manager = bearer(await createStaff('Manager'), 'staff')
    const created = await request(web)
      .post('/api/admin/bookings')
      .set('Authorization', manager)
      .send({
        customerName: 'Tamu',
        customerPhone: '0811111111',
        facilityId: court.id,
        bookingDate: '2026-10-06',
        startTime: '10:00',
        endTime: '12:00'
      })
      .expect(201)
    const walkIn = { id: created.body.data.bookingId as string }

    const res = await move(walkIn.id, { bookingDate: '2026-10-06', startTime: '11:00' }).expect(200)

    // Walk-in tanpa akun: tidak ada email, FO menelepon nomornya.
    expect(res.body.data).toEqual({ id: walkIn.id, mailQueued: false, customerPhone: '0811111111' })
    expect(await prismaClient.booking.findUniqueOrThrow({ where: { id: walkIn.id } })).toMatchObject({ startTime: '11:00', endTime: '13:00' })
  })

  it('jadwal, unit, startsAt/endsAt pindah; harga, transaksi, token, dan hold tetap; riwayat + email tercatat; slot lama kembali dijual', async () => {
    const court = await createFacility({ capacity: 1, units: [{ name: 'A' }, { name: 'B' }] })
    const [unitA, unitB] = court.units
    const customer = await createCustomer()
    const created = await createBooking(customer, {
      facilityId: court.id,
      facilityUnitId: unitA.id,
      bookingDate: '2026-10-07',
      startTime: '10:00',
      endTime: '11:00'
    })
    const before = await prismaClient.booking.findUniqueOrThrow({ where: { id: created.bookingId }, include: { transaction: true } })

    // Pending yang hold-nya masih hidup boleh dipindah (D3).
    const res = await move(created.bookingId, {
      bookingDate: '2026-10-08',
      startTime: '14:00',
      facilityUnitId: unitB.id,
      reason: 'Lapangan A diperbaiki'
    }).expect(200)
    expect(res.body.data).toEqual({ id: created.bookingId, mailQueued: true, customerPhone: customer.phoneNumber })

    const after = await prismaClient.booking.findUniqueOrThrow({ where: { id: created.bookingId }, include: { transaction: true } })
    expect(after).toMatchObject({
      bookingDate: dateOnly('2026-10-08'),
      startTime: '14:00',
      endTime: '15:00',
      startsAt: jakartaWallTimeToUtc('2026-10-08', '14:00'),
      endsAt: jakartaWallTimeToUtc('2026-10-08', '15:00'),
      facilityUnitId: unitB.id,
      status: 'pending',
      subtotalPrice: before.subtotalPrice,
      checkInToken: before.checkInToken,
      holdExpiresAt: before.holdExpiresAt
    })
    expect(after.transaction).toMatchObject({ amount: before.transaction?.amount, pendingTotal: before.transaction?.pendingTotal })

    const [history] = await prismaClient.bookingReschedule.findMany({ where: { bookingId: created.bookingId } })
    expect(history).toMatchObject({
      actorId: foId,
      fromDate: dateOnly('2026-10-07'),
      fromStartTime: '10:00',
      fromEndTime: '11:00',
      fromUnitName: 'A',
      toDate: dateOnly('2026-10-08'),
      toStartTime: '14:00',
      toEndTime: '15:00',
      toUnitName: 'B',
      reason: 'Lapangan A diperbaiki'
    })

    // Riwayat ikut di daftar admin.
    const list = await request(web).get('/api/admin/bookings').set('Authorization', fo).expect(200)
    const row = list.body.data.bookings.find((b: { id: string }) => b.id === created.bookingId)
    expect(row.reschedules).toEqual([
      {
        at: expect.stringMatching(/^\d{2} (Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agt|Sep|Okt|Nov|Des) \d{4} \d{2}:\d{2}$/),
        by: foName,
        from: { date: '2026-10-07', startTime: '10:00', endTime: '11:00', unitName: 'A' },
        to: { date: '2026-10-08', startTime: '14:00', endTime: '15:00', unitName: 'B' },
        reason: 'Lapangan A diperbaiki'
      }
    ])

    // Slot lama kembali dijual.
    await createBooking(await createCustomer(), {
      facilityId: court.id,
      facilityUnitId: unitA.id,
      bookingDate: '2026-10-07',
      startTime: '10:00',
      endTime: '11:00'
    })

    await waitForPendingMail(10_000)
    expect(await prismaClient.emailLog.count({ where: { toEmail: customer.email, template: 'booking-rescheduled' } })).toBe(1)
  })
})

describe('ditolak 422', () => {
  it('jam di luar grid, tanggal tutup, bulan belum dibuka, jam yang sudah lewat hari ini', async () => {
    const court = await createFacility({ capacity: 1 })
    const booking = await insertBooking({ facilityId: court.id, date: '2026-10-09', startTime: '10:00', endTime: '11:00' })

    expectFieldError(await move(booking.id, { bookingDate: '2026-10-09', startTime: '10:30' }), 'startTime')
    expectFieldError(await move(booking.id, { bookingDate: CLOSED_DATE, startTime: '10:00' }), 'bookingDate')
    expectFieldError(await move(booking.id, { bookingDate: '2026-12-01', startTime: '10:00' }), 'bookingDate')
    expectFieldError(await move(booking.id, { bookingDate: '2026-10-05', startTime: '08:00' }), 'startTime')
  })

  it('slot tujuan penuh, dan pindah ke jadwal yang sama persis', async () => {
    const court = await createFacility({ capacity: 1 })
    const booking = await insertBooking({ facilityId: court.id, date: '2026-10-09', startTime: '10:00', endTime: '11:00' })
    await insertBooking({ facilityId: court.id, date: '2026-10-09', startTime: '12:00', endTime: '13:00' })

    expectFieldError(await move(booking.id, { bookingDate: '2026-10-09', startTime: '12:00' }), 'startTime')
    expectFieldError(await move(booking.id, { bookingDate: '2026-10-09', startTime: '10:00' }), 'startTime')
  })

  it('kelas: sesi yang dibatalkan staff, dan pelanggan yang sudah terdaftar di sesi tujuan', async () => {
    const yoga = await createClass()
    const unitId = yoga.units[0].id
    const customer = await createCustomer()
    const tuesday = await insertBooking({
      facilityId: yoga.id,
      facilityUnitId: unitId,
      userId: customer.id,
      date: '2026-10-13',
      startTime: '18:00',
      endTime: '19:00'
    })
    await insertBooking({
      facilityId: yoga.id,
      facilityUnitId: unitId,
      userId: customer.id,
      date: '2026-10-15',
      startTime: '18:00',
      endTime: '19:00'
    })
    await prismaClient.classSessionException.create({
      data: { facilityId: yoga.id, facilityUnitId: unitId, sessionDate: dateOnly('2026-10-22'), startTime: '18:00' }
    })

    expectFieldError(await move(tuesday.id, { bookingDate: '2026-10-22', startTime: '18:00' }), 'startTime')
    expectFieldError(await move(tuesday.id, { bookingDate: '2026-10-15', startTime: '18:00' }), 'startTime')
    expect(await prismaClient.bookingReschedule.count({ where: { bookingId: tuesday.id } })).toBe(0)
    // Opsi slot memakai aturan yang sama: sesi yang sudah dipegang pelanggan tidak ditawarkan.
    expect((await options(tuesday.id, { date: '2026-10-15' }).expect(200)).body.data.slots).toMatchObject([
      { startTime: '18:00', status: 'registered' }
    ])
  })
})

describe('unit nonaktif', () => {
  it('unit booking nonaktif dan tak ada unit aktif lain: pindah ke level fasilitas; masih ada unit aktif: wajib pilih', async () => {
    const solo = await createFacility({ capacity: 1, units: [{ name: 'A' }] })
    const onA = await insertBooking({
      facilityId: solo.id,
      facilityUnitId: solo.units[0].id,
      date: '2026-10-09',
      startTime: '10:00',
      endTime: '11:00'
    })
    await prismaClient.facilityUnit.update({ where: { id: solo.units[0].id }, data: { isActive: false } })

    expect((await options(onA.id, { date: '2026-10-09' }).expect(200)).body.data).toMatchObject({ requiresUnit: false })
    await move(onA.id, { bookingDate: '2026-10-09', startTime: '10:00', facilityUnitId: null }).expect(200)
    expect(await prismaClient.booking.findUniqueOrThrow({ where: { id: onA.id } })).toMatchObject({ facilityUnitId: null })

    const pair = await createFacility({ capacity: 1, units: [{ name: 'A' }, { name: 'B' }] })
    const onPairA = await insertBooking({
      facilityId: pair.id,
      facilityUnitId: pair.units[0].id,
      date: '2026-10-09',
      startTime: '10:00',
      endTime: '11:00'
    })
    await prismaClient.facilityUnit.update({ where: { id: pair.units[0].id }, data: { isActive: false } })

    expect((await options(onPairA.id, { date: '2026-10-09' }).expect(200)).body.data).toMatchObject({ requiresUnit: true })
    expectFieldError(await move(onPairA.id, { bookingDate: '2026-10-09', startTime: '11:00' }), 'facilityUnitId')
  })
})

describe('ditolak 409', () => {
  it('dibatalkan, selesai, sudah check-in, sudah berakhir; pending yang hold-nya lewat = HOLD_LAPSED', async () => {
    const court = await createFacility({ capacity: 5 })
    const at = (startTime: string, endTime: string, extra: Partial<Parameters<typeof insertBooking>[0]> = {}) =>
      insertBooking({ facilityId: court.id, date: '2026-10-09', startTime, endTime, ...extra })
    const target = { bookingDate: '2026-10-10', startTime: '10:00' }

    const cancelled = await at('10:00', '11:00', { status: 'cancelled' })
    const completed = await at('11:00', '12:00', { status: 'completed' })
    const checkedIn = await at('12:00', '13:00')
    await prismaClient.booking.update({ where: { id: checkedIn.id }, data: { checkedInAt: FROZEN_NOW } })
    // Sudah berakhir 07:00, jam beku 08:00, tidak pernah check-in (D5: hangus).
    const ended = await insertBooking({ facilityId: court.id, date: '2026-10-05', startTime: '06:00', endTime: '07:00' })
    const lapsed = await at('13:00', '14:00', { status: 'pending', holdExpiresAt: addMinutes(FROZEN_NOW, -1) })

    for (const booking of [cancelled, completed, checkedIn, ended]) {
      const res = await move(booking.id, target).expect(409)
      expect(res.body.error.code).toBe('CONFLICT')
    }
    expect((await move(lapsed.id, target).expect(409)).body.error.code).toBe('HOLD_LAPSED')
    expect(await prismaClient.bookingReschedule.count({ where: { booking: { facilityId: court.id } } })).toBe(0)
  })

  it('booking yang tidak ada = 404', async () => {
    await move('tidak-ada', { bookingDate: '2026-10-10', startTime: '10:00' }).expect(404)
  })
})

describe('permission', () => {
  it('FO (default) boleh, Finance 403, token pelanggan ditolak', async () => {
    const court = await createFacility({ capacity: 1 })
    const booking = await insertBooking({ facilityId: court.id, date: '2026-10-09', startTime: '10:00', endTime: '11:00' })
    const finance = bearer(await createStaff('Finance'), 'staff')
    const customer = bearer(await createCustomer(), 'customer')

    await options(booking.id, { date: '2026-10-09' }).expect(200)
    await options(booking.id, { date: '2026-10-09' }, finance).expect(403)
    await move(booking.id, { bookingDate: '2026-10-09', startTime: '14:00' }, finance).expect(403)
    await move(booking.id, { bookingDate: '2026-10-09', startTime: '14:00' }, customer).expect(401)
    await move(booking.id, { bookingDate: '2026-10-09', startTime: '14:00' }).expect(200)
  })
})

describe('opsi slot', () => {
  it('slot booking itu sendiri tersedia dan bertanda current; durasi asli dipakai untuk jam selesai', async () => {
    const court = await createFacility({ capacity: 1 })
    const booking = await insertBooking({ facilityId: court.id, date: '2026-10-09', startTime: '10:00', endTime: '12:00' })
    await insertBooking({ facilityId: court.id, date: '2026-10-09', startTime: '14:00', endTime: '15:00' })

    const res = await options(booking.id, { date: '2026-10-09' }).expect(200)
    const slots = res.body.data.slots as Array<{ startTime: string; endTime: string; status: string; current: boolean }>

    expect(res.body.data).toMatchObject({ closed: false, requiresUnit: false, durationMinutes: 120 })
    expect(slots.find((s) => s.startTime === '10:00')).toEqual({
      startTime: '10:00',
      endTime: '12:00',
      remaining: 1,
      capacity: 1,
      status: 'available',
      current: true
    })
    // 13:00-15:00 dan 14:00-16:00 menabrak booking 14:00; 21:00-23:00 melewati jam tutup 22:00.
    expect(slots.filter((s) => s.status === 'full').map((s) => s.startTime)).toEqual(['13:00', '14:00'])
    expect(slots[slots.length - 1].startTime).toBe('20:00')

    expect((await options(booking.id, { date: CLOSED_DATE }).expect(200)).body.data).toMatchObject({ closed: true, reason: 'date_closed', slots: [] })
  })

  it('kelas: sesi yang dibatalkan staff tampil cancelled', async () => {
    const yoga = await createClass()
    const unitId = yoga.units[0].id
    const booking = await insertBooking({ facilityId: yoga.id, facilityUnitId: unitId, date: '2026-10-13', startTime: '18:00', endTime: '19:00' })
    await prismaClient.classSessionException.create({
      data: { facilityId: yoga.id, facilityUnitId: unitId, sessionDate: dateOnly('2026-10-15'), startTime: '18:00' }
    })

    const res = await options(booking.id, { date: '2026-10-15' }).expect(200)
    expect(res.body.data.slots).toEqual([{ startTime: '18:00', endTime: '19:00', remaining: 10, capacity: 10, status: 'cancelled', current: false }])
  })
})
