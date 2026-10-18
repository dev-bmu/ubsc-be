import { Prisma } from '@prisma/client'
import request from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { dateOnly, jakartaWallTimeToUtc, setNowForTests } from '../src/utils/clock'
import { bearer, closeDatabase, createCustomer, createFacility, createStaff, FROZEN_NOW, insertBooking, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === GET /api/admin/finance/ledger — rentang tanggal WIB, basis dibuat/lunas, paginasi server ===
// ============================================================================
// Transaksi ditanam langsung dengan createdAt/paidAt tepat di batas hari WIB 2026-10-01.

const DAY = '2026-10-01'
const at = (date: string, hm: string) => jakartaWallTimeToUtc(date, hm)

let finance: string
const tx: Record<'before' | 'start' | 'end' | 'after' | 'late' | 'other', { id: string; invoiceNumber: string }> = {} as never

let invoiceSeq = 0
const transaction = (data: Omit<Prisma.TransactionUncheckedCreateInput, 'invoiceNumber'>) =>
  prismaClient.transaction.create({ data: { invoiceNumber: `UBSC-X-2026-${2000 + ++invoiceSeq}`, ...data } })

const ledger = (query: Record<string, string | number>) => request(web).get('/api/admin/finance/ledger').query(query).set('Authorization', finance)
const ids = (res: request.Response): string[] => res.body.data.rows.map((row: { id: string }) => row.id)

beforeAll(async () => {
  await resetDatabase()
  setNowForTests(FROZEN_NOW)
  finance = bearer(await createStaff('Finance'), 'staff')

  const budi = await prismaClient.user.update({ where: { id: (await createCustomer()).id }, data: { name: 'Budi Ledger' } })
  const facility = await prismaClient.facility.update({ where: { id: (await createFacility()).id }, data: { name: 'Lapangan Cendana' } })
  const plan = await prismaClient.membershipPlan.create({ data: { name: 'Gym Ledger', price: 300_000, durationMonths: 1 } })
  const booking = (hour: number) =>
    insertBooking({ facilityId: facility.id, userId: budi.id, date: '2026-10-06', startTime: `${hour}:00`, endTime: `${hour + 1}:00` })
  const membership = (data: { userId?: string; customerName?: string }) =>
    prismaClient.membership.create({ data: { ...data, membershipPlanId: plan.id, startDate: dateOnly(DAY), endDate: dateOnly('2026-11-01') } })

  // Dibuat 23:59 WIB sehari sebelumnya, lunas tepat 00:00 WIB DAY.
  tx.before = await transaction({
    userId: budi.id,
    bookingId: (await booking(10)).id,
    amount: 100_000,
    uniqueCode: 501,
    paymentStatus: 'PAID',
    createdAt: at('2026-09-30', '23:59'),
    paidAt: at(DAY, '00:00')
  })
  // Walk-in membership (nama di baris membership), dibuat tepat 00:00 WIB, belum bayar.
  tx.start = await transaction({
    membershipId: (await membership({ customerName: 'Sari Walkin' })).id,
    amount: 200_000,
    uniqueCode: 502,
    createdAt: at(DAY, '00:00')
  })
  // Dibuat 23:59 WIB DAY, lunas keesokan harinya.
  tx.end = await transaction({
    userId: budi.id,
    bookingId: (await booking(12)).id,
    amount: 150_000,
    uniqueCode: 503,
    paymentStatus: 'PAID',
    createdAt: at(DAY, '23:59'),
    paidAt: at('2026-10-02', '09:00')
  })
  tx.after = await transaction({
    userId: budi.id,
    bookingId: (await booking(14)).id,
    amount: 120_000,
    uniqueCode: 504,
    paymentStatus: 'EXPIRED',
    createdAt: at('2026-10-02', '00:00')
  })
  // Lunas 23:59 WIB DAY (masih DAY, bukan besok).
  tx.late = await transaction({
    userId: budi.id,
    membershipId: (await membership({ userId: budi.id })).id,
    amount: 300_000,
    uniqueCode: 505,
    paymentStatus: 'PAID',
    createdAt: at(DAY, '12:00'),
    paidAt: at(DAY, '23:59')
  })
  tx.other = await transaction({ amount: 50_000, paymentStatus: 'FAILED', createdAt: at(DAY, '10:00') })
})

afterAll(closeDatabase)

describe('rentang + basis', () => {
  it("basis created (default): createdAt di [00:00, 24:00) WIB, urut createdAt DESC; 'paid': hanya PAID yang lunas di rentang itu", async () => {
    const created = await ledger({ from: DAY, to: DAY }).expect(200)
    expect(ids(created)).toEqual([tx.end.id, tx.late.id, tx.other.id, tx.start.id])
    expect(created.body.data.rows[0]).toMatchObject({
      receiptNumber: tx.end.invoiceNumber,
      customerName: 'Budi Ledger',
      type: 'booking',
      subject: 'Lapangan Cendana',
      amount: 150_000,
      uniqueCode: 503,
      total: 150_503,
      paymentStatus: 'PAID',
      createdAt: `${DAY} 23:59`,
      paidAt: '2026-10-02 09:00'
    })

    expect(ids(await ledger({ from: DAY, to: DAY, basis: 'paid' }).expect(200))).toEqual([tx.late.id, tx.before.id])
    // Rentang dua hari: hari berikutnya ikut.
    expect(ids(await ledger({ from: DAY, to: '2026-10-02', basis: 'paid' }).expect(200))).toEqual([tx.end.id, tx.late.id, tx.before.id])
  })

  it('tanpa from/to = hari ini (WIB); to kosong = from', async () => {
    const today = await ledger({}).expect(200)
    expect(today.body.data.rows).toEqual([])
    expect(today.body.meta).toEqual({ page: 1, perPage: 20, total: 0, lastPage: 1 })
    expect(today.body.data.summary).toEqual({
      paidAmount: 0,
      paidCount: 0,
      attentionAmount: 0,
      attentionCount: 0,
      bookingCount: 0,
      membershipCount: 0
    })
    expect(ids(await ledger({ from: '2026-09-30' }).expect(200))).toEqual([tx.before.id])
  })
})

describe('filter', () => {
  const find = async (query: Record<string, string>) => ids(await ledger({ from: DAY, to: DAY, ...query }).expect(200))

  it('tipe, status, pencarian (nama akun / walk-in, fasilitas, paket, invoice) — digabung dengan rentang', async () => {
    expect(await find({ type: 'booking' })).toEqual([tx.end.id])
    expect(await find({ type: 'membership' })).toEqual([tx.late.id, tx.start.id])
    expect(await find({ type: 'other' })).toEqual([tx.other.id])
    expect(await find({ status: 'PAID' })).toEqual([tx.end.id, tx.late.id])
    expect(await find({ status: 'UNPAID' })).toEqual([tx.start.id])
    expect(await find({ status: 'UNPAID', basis: 'paid' })).toEqual([])
    expect(await find({ q: 'budi' })).toEqual([tx.end.id, tx.late.id])
    expect(await find({ q: 'SARI' })).toEqual([tx.start.id])
    // tx.before juga di Lapangan Cendana tapi dibuat di luar rentang.
    expect(await find({ q: 'cendana' })).toEqual([tx.end.id])
    expect(await find({ q: 'gym ledger', status: 'PAID' })).toEqual([tx.late.id])
    expect(await find({ q: tx.start.invoiceNumber })).toEqual([tx.start.id])
    expect(await find({ q: '%' })).toEqual([])
  })
})

describe('paginasi + ringkasan', () => {
  const summary = {
    paidAmount: 150_503 + 300_505,
    paidCount: 2,
    attentionAmount: 200_502 + 50_000,
    attentionCount: 2,
    bookingCount: 1,
    membershipCount: 2
  }

  it('meta di envelope, irisan halaman mengikuti urutan, ringkasan = seluruh rentang (bukan halaman)', async () => {
    const all = ids(await ledger({ from: DAY, to: DAY }).expect(200))
    const pages = await Promise.all([1, 2, 3, 4, 5].map((page) => ledger({ from: DAY, to: DAY, perPage: 1, page }).expect(200)))
    expect(pages.map((res) => res.body.meta)).toEqual([1, 2, 3, 4, 5].map((page) => ({ page, perPage: 1, total: 4, lastPage: 4 })))
    expect(pages.flatMap(ids)).toEqual(all)
    for (const res of pages) expect(res.body.data.summary).toEqual(summary)

    const filtered = await ledger({ from: DAY, to: DAY, status: 'PAID', perPage: 1 }).expect(200)
    expect(filtered.body.meta).toEqual({ page: 1, perPage: 1, total: 2, lastPage: 2 })
    expect(filtered.body.data.summary).toEqual({ ...summary, attentionAmount: 0, attentionCount: 0, membershipCount: 1 })
  })
})

describe('validasi + izin', () => {
  it('tanggal salah, to < from, rentang > 366 hari, pilihan asing, perPage > 100 -> 400 VALIDATION_ERROR', async () => {
    for (const [query, field] of [
      [{ from: '01/10/2026' }, 'from'],
      [{ from: '2026-10-02', to: DAY }, 'to'],
      [{ to: '2000-01-01' }, 'to'],
      [{ from: '2025-09-30', to: DAY }, 'to'],
      [{ basis: 'lunas' }, 'basis'],
      [{ type: 'gym' }, 'type'],
      [{ status: 'paid' }, 'status'],
      [{ perPage: 101 }, 'perPage'],
      [{ page: 0 }, 'page']
    ] as const) {
      const res = await ledger(query).expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(Object.keys(res.body.error.fields)).toEqual([field])
    }
    // 366 hari inklusif masih boleh; pilihan kosong = default.
    await ledger({ from: '2025-10-01', to: DAY, basis: '', type: '', status: '' }).expect(200)
  })

  it('butuh reports.read', async () => {
    await request(web)
      .get('/api/admin/finance/ledger')
      .set('Authorization', bearer(await createStaff('Staff Central'), 'staff'))
      .expect(403)
  })
})
