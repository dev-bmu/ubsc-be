import { prismaClient } from '../src/application/database'
import { ResponseError } from '../src/error/response-error'
import { createBooking } from '../src/services/booking-services'
import { DEFAULT_ADMIN_FEE, DEFAULT_UNIQUE_CODE_MAX } from '../src/services/manual-payment-services'
import { setNowForTests } from '../src/utils/clock'
import {
  closeDatabase,
  configurePayments,
  createCustomer,
  createFacility,
  FROZEN_NOW,
  insertBooking,
  openMonth,
  resetDatabase,
  settle,
  sleep
} from './helpers/fixtures'

// ============================================================================
// === GATE FASE 3 — dua booking bersamaan pada slot terakhir, tepat satu menang ===
// ============================================================================
// Mekanismenya: SELECT ... FOR UPDATE pada baris fasilitas/unit sebagai statement pertama transaksi
// ReadCommitted, lalu okupansi dibaca ULANG di dalam kunci. Test pertama membuktikan mekanisme itu
// secara deterministik (pesaing benar-benar menunggu dan melihat hasil commit pemegang kunci); test
// berikutnya membuktikan hasilnya di bawah balapan sungguhan.

const LAST_SEAT_TAKEN = 'Maaf, sebagian slot pada rentang ini baru saja terpesan. Silakan pilih waktu lain.'

function expectSlotTaken(reason: unknown, field = 'startTime') {
  expect(reason).toBeInstanceOf(ResponseError)
  const error = reason as ResponseError
  expect(error.status).toBe(422)
  expect(error.fields?.[field]?.[0]).toMatch(/baru saja (terpesan|penuh)/)
}

beforeAll(async () => {
  await resetDatabase()
  await configurePayments()
  await openMonth(2026, 10)
  setNowForTests(FROZEN_NOW)
})

afterAll(closeDatabase)

describe('kunci baris induk menserialisasi booking', () => {
  it('pesaing menunggu kunci, lalu membaca booking yang baru di-commit pemegang kunci', async () => {
    const facility = await createFacility({ capacity: 1 })
    const customer = await createCustomer()

    let lockHeld!: () => void
    const lockAcquired = new Promise<void>((done) => (lockHeld = done))

    // Pemegang kunci: ambil kunci yang sama dengan createBooking, tanam booking, tahan 1,5 detik.
    const holder = prismaClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM facilities WHERE id = ${facility.id} FOR UPDATE`
        lockHeld()
        await tx.booking.create({
          data: {
            facilityId: facility.id,
            bookingDate: new Date('2026-10-06T00:00:00.000Z'),
            startTime: '10:00',
            endTime: '11:00',
            startsAt: new Date('2026-10-06T03:00:00.000Z'),
            endsAt: new Date('2026-10-06T04:00:00.000Z'),
            subtotalPrice: 100_000,
            status: 'confirmed'
          }
        })
        await sleep(1500)
      },
      { timeout: 10_000 }
    )

    await lockAcquired
    const startedAt = Date.now()
    const contender = createBooking(customer, { facilityId: facility.id, bookingDate: '2026-10-06', startTime: '10:00', endTime: '11:00' })
    const outcome = await settle([contender])
    await holder

    // Sampai di sini pesaing HARUS sudah menunggu pemegang kunci...
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000)
    // ...dan setelah kunci lepas, membaca okupansi terbaru sehingga ditolak.
    expect(outcome.fulfilled).toHaveLength(0)
    expectSlotTaken(outcome.rejected[0])
    expect((outcome.rejected[0] as ResponseError).message).toBe(LAST_SEAT_TAKEN)
    expect(await prismaClient.booking.count({ where: { facilityId: facility.id } })).toBe(1)
  })
})

describe('balapan pada slot terakhir', () => {
  it('dua booking bersamaan pada kursi terakhir: tepat satu menang', async () => {
    // Kapasitas 2, satu kursi sudah terisi -> tersisa SATU kursi.
    const facility = await createFacility({ capacity: 2 })
    await insertBooking({ facilityId: facility.id, date: '2026-10-07', startTime: '09:00', endTime: '10:00' })
    const [a, b] = await Promise.all([createCustomer(), createCustomer()])
    const body = { facilityId: facility.id, bookingDate: '2026-10-07', startTime: '09:00', endTime: '10:00' }

    const { fulfilled, rejected } = await settle([createBooking(a, body), createBooking(b, body)])

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expectSlotTaken(rejected[0])

    const live = await prismaClient.booking.count({
      where: { facilityId: facility.id, bookingDate: new Date('2026-10-07T00:00:00.000Z'), status: { not: 'cancelled' } }
    })
    expect(live).toBe(2)
    expect(await prismaClient.transaction.count({ where: { booking: { facilityId: facility.id } } })).toBe(1)
  })

  it('delapan booking bersamaan pada slot berkapasitas 1: tepat satu menang', async () => {
    const facility = await createFacility({ capacity: 1 })
    const customers = await Promise.all(Array.from({ length: 8 }, () => createCustomer()))
    const body = { facilityId: facility.id, bookingDate: '2026-10-08', startTime: '19:00', endTime: '21:00' }

    const { fulfilled, rejected } = await settle(customers.map((c) => createBooking(c, body)))

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(7)
    rejected.forEach((reason) => expectSlotTaken(reason))
    expect(await prismaClient.booking.count({ where: { facilityId: facility.id } })).toBe(1)
  })

  it('rentang yang tumpang tindih sebagian ikut diserialisasi: 18-20 vs 19-21 tidak bisa sama-sama lolos', async () => {
    const facility = await createFacility({ capacity: 1 })
    const [a, b] = await Promise.all([createCustomer(), createCustomer()])

    const { fulfilled, rejected } = await settle([
      createBooking(a, { facilityId: facility.id, bookingDate: '2026-10-09', startTime: '18:00', endTime: '20:00' }),
      createBooking(b, { facilityId: facility.id, bookingDate: '2026-10-09', startTime: '19:00', endTime: '21:00' })
    ])

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expectSlotTaken(rejected[0])
  })

  it('kunci per unit: dua unit berbeda tidak saling menghalangi, satu unit tetap tepat satu', async () => {
    const facility = await createFacility({
      capacity: 1,
      units: [
        { name: 'A', capacity: 1 },
        { name: 'B', capacity: 1 }
      ]
    })
    const [unitA, unitB] = facility.units
    const customers = await Promise.all(Array.from({ length: 4 }, () => createCustomer()))
    const body = (unitId: string) => ({
      facilityId: facility.id,
      facilityUnitId: unitId,
      bookingDate: '2026-10-10',
      startTime: '08:00',
      endTime: '09:00'
    })

    const { fulfilled, rejected } = await settle([
      createBooking(customers[0], body(unitA.id)),
      createBooking(customers[1], body(unitA.id)),
      createBooking(customers[2], body(unitB.id)),
      createBooking(customers[3], body(unitB.id))
    ])

    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(2)
    const winners = await prismaClient.booking.findMany({ where: { facilityId: facility.id }, select: { facilityUnitId: true } })
    expect(winners.map((w) => w.facilityUnitId).sort()).toEqual([unitA.id, unitB.id].sort())
  })

  it('kelas berkapasitas 3: lima pembeli bersamaan, tepat tiga menang', async () => {
    const facility = await createFacility({ mode: 'class', capacity: 3, activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] } })
    const customers = await Promise.all(Array.from({ length: 5 }, () => createCustomer()))
    const body = { facilityId: facility.id, sessions: [{ date: '2026-10-13', startTime: '18:00', endTime: '19:00' }] }

    const { fulfilled, rejected } = await settle(customers.map((c) => createBooking(c, body)))

    expect(fulfilled).toHaveLength(3)
    expect(rejected).toHaveLength(2)
    rejected.forEach((reason) => expectSlotTaken(reason, 'sessions.0'))
  })
})

describe('kode unik pendingTotal di bawah balapan (R11)', () => {
  it('sembilan checkout bersamaan berebut sembilan kode tersisa: semua lolos dengan total berbeda, yang kesepuluh gagal bersih', async () => {
    const amount = 777_000
    // Nominal dasar = harga + biaya admin. Isi semua kode kecuali sembilan — tabrakan di UNIQUE index
    // menjadi pasti, bukan kebetulan.
    const base = amount + DEFAULT_ADMIN_FEE
    const prefilled = DEFAULT_UNIQUE_CODE_MAX - 9
    await prismaClient.transaction.createMany({
      data: Array.from({ length: prefilled }, (_, i) => ({
        amount,
        adminFee: DEFAULT_ADMIN_FEE,
        uniqueCode: i + 1,
        pendingTotal: base + i + 1,
        paymentStatus: 'UNPAID' as const
      }))
    })

    // Sembilan fasilitas berbeda = sembilan kunci berbeda, jadi transaksinya benar-benar berjalan paralel.
    const facilities = await Promise.all(Array.from({ length: 9 }, () => createFacility({ capacity: 1, price: amount })))
    const customers = await Promise.all(facilities.map(() => createCustomer()))
    const body = (facilityId: string) => ({ facilityId, bookingDate: '2026-10-14', startTime: '10:00', endTime: '11:00' })

    const { fulfilled, rejected } = await settle(facilities.map((f, i) => createBooking(customers[i], body(f.id))))

    expect(rejected).toEqual([])
    expect(fulfilled).toHaveLength(9)
    const totals = await prismaClient.transaction.findMany({
      where: { id: { in: fulfilled.map((f) => f.transactionId) } },
      select: { pendingTotal: true }
    })
    const codes = totals.map((t) => (t.pendingTotal as number) - base)
    expect(new Set(codes).size).toBe(9)
    codes.forEach((code) => {
      expect(code).toBeGreaterThan(prefilled)
      expect(code).toBeLessThanOrEqual(DEFAULT_UNIQUE_CODE_MAX)
    })

    const extra = await createFacility({ capacity: 1, price: amount })
    const late = await settle([createBooking(await createCustomer(), body(extra.id))])
    expect(late.fulfilled).toHaveLength(0)
    expect(late.rejected[0]).toMatchObject({ status: 409, code: 'PENDING_TOTAL_EXHAUSTED' })
    // Gagal bersih: tidak ada booking yatim tanpa transaksi.
    expect(await prismaClient.booking.count({ where: { facilityId: extra.id } })).toBe(0)
  })
})
