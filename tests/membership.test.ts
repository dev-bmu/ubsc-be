import { prismaClient } from '../src/application/database'
import { ResponseError } from '../src/error/response-error'
import { createMembership, renewMembership } from '../src/services/membership-services'
import { closeDatabase, createCustomer, FROZEN_NOW, resetDatabase, settle } from './helpers/fixtures'
import { setNowForTests } from '../src/utils/clock'

// ============================================================================
// === MembershipLifecycleService — pencegahan overlap ===
// ============================================================================
// Laravel "selamat" hanya berkat gap lock REPEATABLE READ. Di sini transaksi ReadCommitted, jadi
// yang menjaga adalah kunci baris users milik pelanggan. Test pertama membuktikannya di bawah balapan.

let planId: string

beforeAll(async () => {
  await resetDatabase()
  setNowForTests(FROZEN_NOW)
  planId = (await prismaClient.membershipPlan.create({ data: { name: 'Bulanan Uji', price: 300_000, durationMonths: 1 } })).id
})

afterAll(closeDatabase)

describe('overlap', () => {
  it('dua membership tumpang tindih dibuat bersamaan untuk pelanggan yang sama: tepat satu lolos', async () => {
    const customer = await createCustomer()

    const { fulfilled, rejected } = await settle([
      createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-10' }),
      createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-20' }),
      createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-25' })
    ])

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    rejected.forEach((reason) => {
      expect(reason).toBeInstanceOf(ResponseError)
      expect(reason).toMatchObject({ status: 422, fields: { membership: [expect.stringContaining('masih memiliki membership aktif')] } })
    })
    expect(await prismaClient.membership.count({ where: { userId: customer.id } })).toBe(1)
  })

  it('transaksi membership langsung PAID dan riwayat audit tercatat dengan nomor kuitansi', async () => {
    const customer = await createCustomer()
    const membership = await createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-01-31', actorId: null })

    // addMonths ala Carbon: 31 Januari + 1 bulan meluap ke 3 Maret.
    expect(membership.endDate.toISOString().slice(0, 10)).toBe('2026-03-03')
    const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })
    expect(transaction).toMatchObject({ paymentStatus: 'PAID', amount: 300_000 })
    const history = await prismaClient.membershipHistory.findFirstOrThrow({ where: { membershipId: membership.id } })
    expect(history).toMatchObject({ action: 'created', transactionId: transaction.id })
    expect(history.metadata).toMatchObject({
      plan_name: 'Bulanan Uji',
      receipt_number: `UBSC-${String(transaction.receiptSequence).padStart(6, '0')}`
    })
  })

  it('perpanjangan dimulai sehari setelah masa lama berakhir dan tidak dianggap overlap', async () => {
    const customer = await createCustomer()
    const first = await createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-01' })

    const renewal = await renewMembership(first.id, {})

    expect(renewal.startDate.toISOString().slice(0, 10)).toBe('2026-11-02')
    expect(renewal.renewedFromMembershipId).toBe(first.id)
  })

  it('membership yang dibatalkan tidak bisa diperpanjang', async () => {
    const customer = await createCustomer()
    const first = await createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-12-01' })
    await prismaClient.membership.update({ where: { id: first.id }, data: { status: 'cancelled' } })

    await expect(renewMembership(first.id, {})).rejects.toMatchObject({
      status: 422,
      fields: { membership: ['Membership yang dibatalkan tidak dapat diperpanjang.'] }
    })
  })
})
