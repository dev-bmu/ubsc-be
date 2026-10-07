import { Prisma } from '@prisma/client'
import request from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { addMinutes, dateOnly, setNowForTests } from '../src/utils/clock'
import {
  bearer,
  closeDatabase,
  configurePayments,
  createCustomer,
  createFacility,
  createStaff,
  FROZEN_NOW,
  insertBooking,
  resetDatabase
} from './helpers/fixtures'

// ============================================================================
// === GET /api/admin/payments — antrean ter-paginasi + pencarian ===
// ============================================================================
// Transaksi ditanam langsung (tanpa alur checkout) supaya urutan, nominal, dan status bisa dipastikan.

const FILLERS = 25
let finance: string
let budiAwaitingId: string
let walkInId: string
let budiPaidId: string
let rejectedId: string

let invoiceSeq = 0
const transaction = (data: Omit<Prisma.TransactionUncheckedCreateInput, 'invoiceNumber'> & { invoiceNumber?: string }) =>
  prismaClient.transaction.create({ data: { invoiceNumber: `UBSC-X-2026-${1000 + ++invoiceSeq}`, ...data } })

const queue = (query: Record<string, string | number>) => request(web).get('/api/admin/payments').query(query).set('Authorization', finance)

const ids = (res: request.Response): string[] => res.body.data.transactions.map((t: { id: string }) => t.id)

beforeAll(async () => {
  await resetDatabase()
  await configurePayments()
  setNowForTests(FROZEN_NOW)
  finance = bearer(await createStaff('Finance'), 'staff')

  const filler = await createCustomer()
  for (let i = 0; i < FILLERS; i++) {
    await transaction({
      userId: filler.id,
      amount: 100_000,
      adminFee: 500,
      uniqueCode: i + 1,
      pendingTotal: 100_500 + i + 1,
      verificationStatus: 'awaiting',
      proofPath: 'x',
      proofUploadedAt: addMinutes(FROZEN_NOW, i)
    })
  }

  const budi = await prismaClient.user.update({
    where: { id: (await createCustomer()).id },
    data: { name: 'Budi Santoso', email: 'budi.santoso@test.ubsc.id', phoneNumber: '081299887766' }
  })
  const facility = await prismaClient.facility.update({ where: { id: (await createFacility()).id }, data: { name: 'Lapangan Cendana' } })
  const booking = await insertBooking({ facilityId: facility.id, userId: budi.id, date: '2026-10-06', startTime: '10:00', endTime: '11:00' })
  budiAwaitingId = (
    await transaction({
      invoiceNumber: 'UBSC-X-2026-0001',
      userId: budi.id,
      bookingId: booking.id,
      amount: 150_000,
      adminFee: 500,
      uniqueCode: 232,
      pendingTotal: 150_732,
      verificationStatus: 'awaiting',
      proofPath: 'x',
      proofUploadedAt: addMinutes(FROZEN_NOW, 100)
    })
  ).id

  const walkInBooking = await prismaClient.booking.update({
    where: { id: (await insertBooking({ facilityId: facility.id, date: '2026-10-06', startTime: '12:00', endTime: '13:00' })).id },
    data: { customerName: 'Siti Walkin' }
  })
  walkInId = (
    await transaction({
      bookingId: walkInBooking.id,
      amount: 75_000,
      uniqueCode: 5,
      pendingTotal: 75_005,
      verificationStatus: 'awaiting',
      proofPath: 'x',
      proofUploadedAt: addMinutes(FROZEN_NOW, 101)
    })
  ).id

  const plan = await prismaClient.membershipPlan.create({ data: { name: 'Gym Bulanan Cari', price: 200_000, durationMonths: 1 } })
  const membership = await prismaClient.membership.create({
    data: { userId: budi.id, membershipPlanId: plan.id, startDate: dateOnly('2026-10-05'), endDate: dateOnly('2026-11-05') }
  })
  // Lunas: pendingTotal sudah dikosongkan approve(), jadi nominal hanya bisa dicocokkan lewat amount + adminFee + uniqueCode.
  budiPaidId = (
    await transaction({
      invoiceNumber: 'UBSC-X-2026-0002',
      userId: budi.id,
      membershipId: membership.id,
      amount: 200_000,
      adminFee: 500,
      uniqueCode: 99,
      paymentStatus: 'PAID',
      paidAt: FROZEN_NOW
    })
  ).id

  rejectedId = (
    await transaction({ userId: budi.id, amount: 150_000, adminFee: 500, uniqueCode: 7, paymentStatus: 'FAILED', verificationStatus: 'rejected' })
  ).id
})

afterAll(closeDatabase)

describe('paginasi', () => {
  it('meta di envelope, irisan halaman mengikuti urutan antrean, default perPage 20', async () => {
    const all = await queue({ tab: 'awaiting', perPage: 100 }).expect(200)
    expect(all.body.meta).toEqual({ page: 1, perPage: 100, total: FILLERS + 2, lastPage: 1 })
    expect(ids(all).slice(-2)).toEqual([budiAwaitingId, walkInId])

    const pages = await Promise.all([1, 2, 3].map((page) => queue({ tab: 'awaiting', perPage: 10, page }).expect(200)))
    expect(pages.map((res) => res.body.meta)).toEqual([1, 2, 3].map((page) => ({ page, perPage: 10, total: 27, lastPage: 3 })))
    expect(pages.flatMap(ids)).toEqual(ids(all))

    const byDefault = await queue({}).expect(200)
    expect(byDefault.body.data.tab).toBe('awaiting')
    expect(byDefault.body.meta).toEqual({ page: 1, perPage: 20, total: 27, lastPage: 2 })
    expect(ids(byDefault)).toHaveLength(20)
  })

  it('halaman lewat akhir: daftar kosong dengan meta yang benar, bukan 404', async () => {
    const res = await queue({ tab: 'awaiting', page: 9 }).expect(200)
    expect(res.body.data.transactions).toEqual([])
    expect(res.body.meta).toEqual({ page: 9, perPage: 20, total: 27, lastPage: 2 })
  })

  it('validasi: perPage > 100, page 0, angka bukan bulat -> 400 VALIDATION_ERROR; tab asing jatuh ke awaiting', async () => {
    for (const [query, field] of [
      [{ perPage: 101 }, 'perPage'],
      [{ perPage: 0 }, 'perPage'],
      [{ page: 0 }, 'page'],
      [{ page: 'abc' }, 'page'],
      [{ page: 1.5 }, 'page'],
      [{ q: 'x'.repeat(101) }, 'q']
    ] as const) {
      const res = await queue(query).expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(Object.keys(res.body.error.fields)).toEqual([field])
    }
    expect((await queue({ tab: 'xyz' }).expect(200)).body.data.tab).toBe('awaiting')
  })
})

describe('pencarian', () => {
  const search = async (tab: string, q: string) => ids(await queue({ tab, q }).expect(200))

  it('invoice, nama/email/no. HP pelanggan, walk-in, fasilitas, paket — tidak peka huruf besar', async () => {
    expect(await search('awaiting', 'ubsc-x-2026-0001')).toEqual([budiAwaitingId])
    expect(await search('awaiting', 'BUDI santoso')).toEqual([budiAwaitingId])
    expect(await search('awaiting', 'budi.santoso@')).toEqual([budiAwaitingId])
    expect(await search('awaiting', '0812998877')).toEqual([budiAwaitingId])
    expect(await search('awaiting', 'siti')).toEqual([walkInId])
    expect(await search('awaiting', 'cendana')).toEqual([budiAwaitingId, walkInId])
    expect(await search('paid', 'gym bulanan')).toEqual([budiPaidId])
    expect(await search('awaiting', 'tidak-ada-yang-cocok')).toEqual([])
    // Wildcard LIKE dicari apa adanya, bukan mencocokkan semua baris.
    expect(await search('awaiting', '%')).toEqual([])
    expect(await search('awaiting', '_')).toEqual([])
    expect(await search('awaiting', 'budi_santoso')).toEqual([])
  })

  it('nominal: total transfer (juga yang sudah lunas, pendingTotal kosong) dan harga', async () => {
    expect(await search('awaiting', 'Rp 150.732')).toEqual([budiAwaitingId])
    // Disalin dari mutasi bank: sen ',00' / '.00' bukan bagian nominal.
    expect(await search('awaiting', 'Rp150.732,00')).toEqual([budiAwaitingId])
    expect(await search('awaiting', '150,732.00')).toEqual([budiAwaitingId])
    expect(await search('paid', '200.599')).toEqual([budiPaidId])
    expect(await search('awaiting', '150,000')).toEqual([budiAwaitingId])
    expect(await search('rejected', '150000')).toEqual([rejectedId])
  })

  it('tab tetap terisolasi, total meta ikut tersaring, hitungan badge tidak', async () => {
    const awaiting = await queue({ tab: 'awaiting', q: 'budi' }).expect(200)
    expect(ids(awaiting)).toEqual([budiAwaitingId])
    expect(awaiting.body.meta).toEqual({ page: 1, perPage: 20, total: 1, lastPage: 1 })
    expect(awaiting.body.data.counts).toEqual({ awaiting: 27, rejected: 1 })

    expect(await search('paid', 'budi')).toEqual([budiPaidId])
    expect(await search('rejected', 'budi')).toEqual([rejectedId])
  })
})
