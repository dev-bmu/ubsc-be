import sharp from 'sharp'
import request from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { gymVisitReport, lookupGymMember, membershipCard, recordGymVisit } from '../src/services/gym-services'
import { captureMemberPhoto, submitMemberPhoto } from '../src/services/member-photo-services'
import { addMinutes, jakartaWallTimeToUtc, setNowForTests } from '../src/utils/clock'
import { customerNumber } from '../src/utils/money'
import { bearer, closeDatabase, createCustomer, createPaidMembership, createStaff, FROZEN_NOW, resetDatabase, settle } from './helpers/fixtures'

// ============================================================================
// === Gym: meja check-in, batas harian, analitik, kartu member (tahap D) ===
// ============================================================================
// Gate utama: dua scan bersamaan untuk member yang sama menghasilkan tepat satu kunjungan, dan masuk
// ulang hanya lewat alasan yang ikut tercatat.

let planId: string
let staffId: string

beforeAll(async () => {
  await resetDatabase()
  planId = (await prismaClient.membershipPlan.create({ data: { name: 'Gym Bulanan', price: 250_000, durationMonths: 1 } })).id
  staffId = (await createStaff('Staff Front Office')).id
})

beforeEach(() => setNowForTests(FROZEN_NOW))

afterAll(closeDatabase)

const face = () =>
  sharp({ create: { width: 48, height: 48, channels: 3, background: '#445566' } })
    .png()
    .toBuffer()
const freshUser = (id: string) => prismaClient.user.findUniqueOrThrow({ where: { id }, include: { role: true } })

/** Member siap masuk: membership lunas sejak startDate + foto yang diambil staff (langsung disetujui). */
async function readyMember(startDate = '2026-10-05') {
  const customer = await createCustomer()
  await createPaidMembership({ userId: customer.id, membershipPlanId: planId, startDate })
  await captureMemberPhoto(customer.id, { buffer: await face(), originalname: 'meja.png' })
  return { customer, code: customerNumber(customer.customerSequence) }
}

describe('meja check-in', () => {
  it('vonis berurutan: nomor, membership, foto, lalu batas harian', async () => {
    expect((await lookupGymMember({ code: customerNumber(2_000_000_000) })).verdict).toBe('not_found')
    expect((await lookupGymMember({ code: 'Budi' })).verdict).toBe('not_found')

    const noMembership = await createCustomer()
    expect((await lookupGymMember({ code: customerNumber(noMembership.customerSequence) })).verdict).toBe('no_active_membership')

    const noPhoto = await createCustomer()
    await createPaidMembership({ userId: noPhoto.id, membershipPlanId: planId, startDate: '2026-10-05' })
    const noPhotoCode = customerNumber(noPhoto.customerSequence)
    expect((await lookupGymMember({ code: noPhotoCode })).verdict).toBe('photo_not_approved')
    await submitMemberPhoto(noPhoto.id, { buffer: await face(), originalname: 'wajah.png' })
    expect((await lookupGymMember({ code: noPhotoCode })).verdict).toBe('photo_not_approved')

    const { code } = await readyMember()
    // Nomor hasil ketik FO tanpa tanda hubung tetap dikenali.
    const lookup = await lookupGymMember({ code: code.toLowerCase().replace('-', '') })
    expect(lookup).toMatchObject({ verdict: 'ok', maxPerDay: 1, membership: { planName: 'Gym Bulanan' }, visitsToday: [] })
  })

  it('satu kali per hari; masuk ulang hanya dengan alasan, dan alasannya tercatat', async () => {
    const { code } = await readyMember()

    const first = await recordGymVisit(staffId, { code, source: 'scan' })
    expect(first.verdict).toBe('already_checked_in')
    expect(first.visitsToday).toEqual([expect.objectContaining({ source: 'scan', isOverride: false, time: '08:00' })])

    await expect(recordGymVisit(staffId, { code, source: 'manual' })).rejects.toMatchObject({
      status: 409,
      fields: { overrideReason: [expect.any(String)] }
    })

    setNowForTests(addMinutes(FROZEN_NOW, 180))
    const again = await recordGymVisit(staffId, { code, source: 'manual', overrideReason: 'Keluar makan siang, masuk lagi' })
    expect(again.visitsToday).toHaveLength(2)
    expect(again.visitsToday[1]).toMatchObject({ isOverride: true, overrideReason: 'Keluar makan siang, masuk lagi', time: '11:00' })

    // Besoknya hijau lagi.
    setNowForTests(jakartaWallTimeToUtc('2026-10-06', '07:00'))
    expect((await lookupGymMember({ code })).verdict).toBe('ok')
  })

  it('tanpa membership yang berlaku tidak bisa dicatat — alasan pun tidak menolong', async () => {
    const customer = await createCustomer()
    await expect(
      recordGymVisit(staffId, { code: customerNumber(customer.customerSequence), source: 'manual', overrideReason: 'coba saja' })
    ).rejects.toMatchObject({ status: 409 })
    expect(await prismaClient.gymVisit.count({ where: { userId: customer.id } })).toBe(0)
  })

  it('GATE: dua scan bersamaan di dua komputer FO — tepat satu kunjungan tercatat', async () => {
    const { customer, code } = await readyMember()

    const { fulfilled, rejected } = await settle([
      recordGymVisit(staffId, { code, source: 'scan' }),
      recordGymVisit(staffId, { code, source: 'scan' })
    ])

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(await prismaClient.gymVisit.count({ where: { userId: customer.id } })).toBe(1)
  })
})

describe('analitik kunjungan', () => {
  it('kedatangan per jam, pola hari x jam, dan ringkasan', async () => {
    const a = await readyMember('2026-11-01')
    const b = await readyMember('2026-11-01')

    // Senin 2 November dan Selasa 3 November 2026, jam WIB.
    setNowForTests(jakartaWallTimeToUtc('2026-11-02', '17:10'))
    await recordGymVisit(staffId, { code: a.code, source: 'scan' })
    setNowForTests(jakartaWallTimeToUtc('2026-11-02', '17:40'))
    await recordGymVisit(staffId, { code: b.code, source: 'manual' })
    setNowForTests(jakartaWallTimeToUtc('2026-11-03', '06:15'))
    await recordGymVisit(staffId, { code: a.code, source: 'scan' })

    const report = await gymVisitReport({ from: '2026-11-02', to: '2026-11-03' })
    expect(report.summary).toEqual({ totalVisits: 3, uniqueMembers: 2, averagePerDay: 1.5, peakHour: 17, overrides: 0 })
    expect(report.hourly[17]).toBe(2)
    expect(report.hourly[6]).toBe(1)
    expect(report.heatmap[0][17]).toBe(2)
    expect(report.heatmap[1][6]).toBe(1)
    expect(report.daily).toEqual([
      { date: '2026-11-02', visits: 2 },
      { date: '2026-11-03', visits: 1 }
    ])

    await expect(gymVisitReport({ from: '2026-01-01', to: '2026-12-31' })).rejects.toMatchObject({ status: 422 })
  })
})

describe('kartu member', () => {
  it('status kartu mengikuti membership dan foto', async () => {
    const customer = await createCustomer()
    expect((await membershipCard(await freshUser(customer.id))).state).toBe('none')

    await createPaidMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-05' })
    expect(await membershipCard(await freshUser(customer.id))).toMatchObject({
      state: 'photo_required',
      daysRemaining: 32,
      membership: { planName: 'Gym Bulanan', endDate: '2026-11-05' }
    })

    await captureMemberPhoto(customer.id, { buffer: await face(), originalname: 'meja.png' })
    const card = await membershipCard(await freshUser(customer.id))
    expect(card).toMatchObject({ state: 'active', customerNumber: customerNumber(customer.customerSequence) })

    setNowForTests(jakartaWallTimeToUtc('2026-11-10', '08:00'))
    expect((await membershipCard(await freshUser(customer.id))).state).toBe('expired')
  })
})

describe('lewat HTTP', () => {
  it('FO boleh mencatat; Finance hanya membuka analitik; pelanggan melihat kartunya', async () => {
    const { customer, code } = await readyMember()
    const frontOffice = bearer(await createStaff('Staff Front Office'), 'staff')
    const finance = bearer(await createStaff('Finance'), 'staff')

    await request(web).get('/api/admin/gym/checkin/lookup').query({ code }).set('Authorization', frontOffice).expect(200)
    await request(web).post('/api/admin/gym/checkin').set('Authorization', finance).send({ code, source: 'manual' }).expect(403)
    const recorded = await request(web).post('/api/admin/gym/checkin').set('Authorization', frontOffice).send({ code, source: 'manual' }).expect(201)
    expect(recorded.body.data.visitsToday).toHaveLength(1)

    const desk = await request(web).get('/api/admin/gym/checkin').set('Authorization', frontOffice).expect(200)
    expect(desk.body.data.visits.some((visit: { customerNumber: string }) => visit.customerNumber === code)).toBe(true)
    await request(web).get('/api/admin/gym/visits').set('Authorization', finance).expect(200)

    const card = await request(web).get('/api/customer/memberships/card').set('Authorization', bearer(customer, 'customer')).expect(200)
    expect(card.body.data).toMatchObject({ state: 'active', customerNumber: code })
  })
})
