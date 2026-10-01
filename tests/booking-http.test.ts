import { readdirSync } from 'fs'
import { resolve } from 'path'
import sharp from 'sharp'
import request from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { setNowForTests } from '../src/utils/clock'
import { waitForPendingMail } from '../src/utils/mailer'
import {
  bearer,
  closeDatabase,
  configurePayments,
  createCustomer,
  createFacility,
  createStaff,
  FROZEN_NOW,
  openMonth,
  resetDatabase,
  sleep
} from './helpers/fixtures'

// ============================================================================
// === Alur booking lewat HTTP — route, middleware, controller, envelope ===
// ============================================================================
// Service sudah diuji langsung di berkas lain; di sini yang diuji adalah sambungannya: path sesuai
// route-inventory, pagar akun per baris route, multer + sharp, stream berkas privat, dan permission.

let facilityId: string

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 600, channels: 3, background: '#1d4ed8' } })
    .png()
    .toBuffer()
}

beforeAll(async () => {
  await resetDatabase()
  await configurePayments()
  await openMonth(2026, 10)
  facilityId = (await createFacility({ capacity: 1, price: 125_000 })).id
})

beforeEach(() => setNowForTests(FROZEN_NOW))

afterAll(closeDatabase)

describe('publik', () => {
  it('GET slots: envelope sukses, header no-store, harga terformat seperti Laravel', async () => {
    const res = await request(web).get('/api/public/booking/slots').query({ facilityId, date: '2026-10-06' }).expect(200)

    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body.success).toBe(true)
    expect(res.body.data.slots[0]).toMatchObject({
      startTime: '06:00',
      endTime: '07:00',
      label: '06:00 - 07:00',
      price: 'Rp 125.000',
      priceRaw: 125_000,
      status: 'available'
    })
  })

  it('validasi query: 400 VALIDATION_ERROR dengan pesan per field', async () => {
    const res = await request(web).get('/api/public/booking/slots').query({ facilityId, date: '06-10-2026' }).expect(400)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: { date: ['Tanggal harus berformat YYYY-MM-DD.'] } })
  })
})

describe('pelanggan', () => {
  it('alur penuh: booking -> instruksi transfer -> unggah bukti -> staff setuju -> riwayat bertiket', async () => {
    const customer = await createCustomer()
    const auth = bearer(customer, 'customer')

    // 1. Buat booking.
    const created = await request(web)
      .post('/api/customer/booking')
      .set('Authorization', auth)
      .send({ facilityId, bookingDate: '2026-10-06', startTime: '10:00', endTime: '12:00' })
      .expect(201)
    const { bookingId, transactionId } = created.body.data

    // 2. Instruksi transfer.
    const payment = await request(web).get(`/api/customer/booking/${bookingId}/pembayaran`).set('Authorization', auth).expect(200)
    expect(payment.body.data).toMatchObject({
      sessions: null,
      booking: { id: bookingId, startTime: '10:00', endTime: '12:00', status: 'pending' },
      payment: { amount: 250_000, paymentStatus: 'UNPAID', hasProof: false, canUpload: true },
      bank: { bank: 'BCA', accountNumber: '1234567890' },
      ticket: null
    })
    const { adminFee, uniqueCode, total, receiptNumber } = payment.body.data.payment
    expect(adminFee).toBe(500)
    expect(total).toBe(250_000 + adminFee + uniqueCode)
    expect(receiptNumber).toMatch(/^UBSC-\d{6}$/)

    // 3. Unggah bukti.
    const uploaded = await request(web)
      .post(`/api/customer/booking/${bookingId}/pembayaran/bukti`)
      .set('Authorization', auth)
      .attach('proof', await png(), { filename: 'bukti.png', contentType: 'image/png' })
      .expect(200)
    expect(uploaded.body.data.payment).toMatchObject({ hasProof: true, verificationStatus: 'awaiting', canUpload: false })
    expect(uploaded.body.data.booking.holdExpiresAt).toBeNull()

    // 4. Berkas bukti: pemilik bisa, pelanggan lain tidak, staff lewat route admin.
    const file = await request(web).get(`/api/customer/payments/${transactionId}/bukti`).set('Authorization', auth).expect(200)
    expect(file.headers['content-type']).toMatch(/^image\/(webp|png)/)
    expect(file.headers['cache-control']).toBe('private, max-age=0, no-store')
    expect(file.headers['content-disposition']).toMatch(new RegExp(`^inline; filename="bukti-${receiptNumber}\\.(webp|png)"$`))
    const stranger = await createCustomer()
    await request(web).get(`/api/customer/payments/${transactionId}/bukti`).set('Authorization', bearer(stranger, 'customer')).expect(404)
    await request(web).get(`/api/customer/booking/${bookingId}/pembayaran`).set('Authorization', bearer(stranger, 'customer')).expect(404)

    // 5. Permission staff: Front Office tidak punya bookings.manage/payments.manage.
    const frontOffice = await createStaff('Staff Front Office')
    await request(web).post(`/api/admin/payments/${transactionId}/approve`).set('Authorization', bearer(frontOffice, 'staff')).expect(403)
    const finance = await createStaff('Finance')
    await request(web).get(`/api/admin/payments/${transactionId}/bukti`).set('Authorization', bearer(finance, 'staff')).expect(200)

    const approved = await request(web)
      .post(`/api/admin/payments/${transactionId}/approve`)
      .set('Authorization', bearer(finance, 'staff'))
      .expect(200)
    expect(approved.body.data).toEqual({ transactionId, receiptNumber, mailQueued: true })
    await request(web).post(`/api/admin/payments/${transactionId}/approve`).set('Authorization', bearer(finance, 'staff')).expect(409)

    // 6. Tiket muncul setelah PAID; riwayat menampilkan kartu lunas.
    const paid = await request(web).get(`/api/customer/booking/${bookingId}/pembayaran`).set('Authorization', auth).expect(200)
    expect(paid.body.data.ticket.checkInUrl).toMatch(/\/checkin\/[A-Za-z0-9]{32}$/)
    const history = await request(web).get('/api/customer/booking').set('Authorization', auth).expect(200)
    expect(history.body.data[0]).toMatchObject({
      id: bookingId,
      paymentStatus: 'PAID',
      hasTicket: true,
      receipt: receiptNumber,
      amount: 250_000,
      sessions: null
    })

    // 7. Email keputusan dikirim setelah commit, tanpa ditunggu request — tercatat di email_logs.
    let log = null
    for (let i = 0; i < 20 && !log; i++) {
      log = await prismaClient.emailLog.findFirst({ where: { toEmail: customer.email, template: 'payment-approved', status: 'sent' } })
      if (!log) await sleep(100)
    }
    expect(log).not.toBeNull()
    expect(log?.subject).toBe(`Pembayaran ${receiptNumber} dikonfirmasi — UB Sport Center`)
  })

  it('pagar akun: email belum terverifikasi 422 di POST, staff 403, tanpa token 401', async () => {
    const unverified = await createCustomer({ verified: false })
    const res = await request(web)
      .post('/api/customer/booking')
      .set('Authorization', bearer(unverified, 'customer'))
      .send({ facilityId, bookingDate: '2026-10-07', startTime: '10:00', endTime: '11:00' })
      .expect(422)
    expect(res.body.error.fields.email[0]).toBe('Verifikasi email Anda terlebih dahulu sebelum melanjutkan pembayaran.')

    const staff = await createStaff('Manager')
    await request(web).post('/api/customer/booking').set('Authorization', bearer(staff, 'customer')).send({ facilityId }).expect(403)
    await request(web).post('/api/customer/booking').send({ facilityId }).expect(401)
  })

  it('unggah bukti: tanpa berkas, bukan gambar, dan melewati 10 MB', async () => {
    const customer = await createCustomer()
    const auth = bearer(customer, 'customer')
    const { bookingId } = (
      await request(web)
        .post('/api/customer/booking')
        .set('Authorization', auth)
        .send({ facilityId, bookingDate: '2026-10-08', startTime: '10:00', endTime: '11:00' })
        .expect(201)
    ).body.data
    const url = `/api/customer/booking/${bookingId}/pembayaran/bukti`

    const empty = await request(web).post(url).set('Authorization', auth).field('catatan', 'tanpa berkas').expect(422)
    expect(empty.body.error.fields.proof).toEqual(['Pilih gambar bukti transfer terlebih dahulu.'])

    const fake = await request(web)
      .post(url)
      .set('Authorization', auth)
      .attach('proof', Buffer.from('bukan gambar sama sekali'), { filename: 'bukti.jpg', contentType: 'image/jpeg' })
      .expect(422)
    expect(fake.body.error.fields.proof).toEqual(['Bukti transfer harus berupa gambar.'])

    const huge = await request(web)
      .post(url)
      .set('Authorization', auth)
      .attach('proof', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'besar.jpg', contentType: 'image/jpeg' })
    expect(huge.status).toBe(413)
    expect(huge.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', fields: { proof: ['Ukuran gambar maksimal 10 MB.'] } })

    expect(await prismaClient.transaction.count({ where: { booking: { id: bookingId }, proofPath: { not: null } } })).toBe(0)
  })

  it('URL pembayaran anggota paket diarahkan ke lead', async () => {
    const classFacility = await createFacility({ mode: 'class', capacity: 5, activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] } })
    const customer = await createCustomer()
    const auth = bearer(customer, 'customer')
    const { bookingId } = (
      await request(web)
        .post('/api/customer/booking')
        .set('Authorization', auth)
        .send({
          facilityId: classFacility.id,
          sessions: [
            { date: '2026-10-06', startTime: '18:00', endTime: '19:00' },
            { date: '2026-10-08', startTime: '18:00', endTime: '19:00' }
          ]
        })
        .expect(201)
    ).body.data

    const follower = await prismaClient.booking.findFirstOrThrow({ where: { bookingGroupId: bookingId, id: { not: bookingId } } })
    const redirect = await request(web).get(`/api/customer/booking/${follower.id}/pembayaran`).set('Authorization', auth).expect(200)
    expect(redirect.body.data).toEqual({ redirectToBookingId: bookingId })

    const lead = await request(web).get(`/api/customer/booking/${bookingId}/pembayaran`).set('Authorization', auth).expect(200)
    expect(lead.body.data.sessions).toHaveLength(2)
    expect(lead.body.data.sessions[0]).toMatchObject({ date: 'Sel, 06 Okt 2026', time: '18:00 – 19:00', status: 'pending', checkInUrl: null })

    const history = await request(web).get('/api/customer/booking').set('Authorization', auth).expect(200)
    expect(history.body.data).toHaveLength(1)
    expect(history.body.data[0].sessions).toHaveLength(2)
  })

  it('staff menolak: alasan wajib, lalu slot dilepas', async () => {
    const customer = await createCustomer()
    const { transactionId } = (
      await request(web)
        .post('/api/customer/booking')
        .set('Authorization', bearer(customer, 'customer'))
        .send({ facilityId, bookingDate: '2026-10-09', startTime: '10:00', endTime: '11:00' })
        .expect(201)
    ).body.data
    const manager = bearer(await createStaff('Manager'), 'staff')

    const missing = await request(web)
      .post(`/api/admin/payments/${transactionId}/reject`)
      .set('Authorization', manager)
      .send({ reason: '   ' })
      .expect(400)
    expect(missing.body.error.fields.reason).toEqual(['Tulis alasan penolakan agar pengguna tahu harus memperbaiki apa.'])

    await request(web)
      .post(`/api/admin/payments/${transactionId}/reject`)
      .set('Authorization', manager)
      .send({ reason: 'Tidak ada mutasi masuk' })
      .expect(200)
    const slots = await request(web).get('/api/public/booking/slots').query({ facilityId, date: '2026-10-09' }).expect(200)
    expect(slots.body.data.slots.find((s: { startTime: string }) => s.startTime === '10:00').status).toBe('available')
  })
})

describe('foto member lewat HTTP (tahap B)', () => {
  it('pelanggan mengunggah field photo; staff ber-identity.verify meninjau, Finance tidak', async () => {
    const customer = await createCustomer()
    const auth = bearer(customer, 'customer')

    const uploaded = await request(web)
      .post('/api/customer/member-photo')
      .set('Authorization', auth)
      .attach('photo', await png(), { filename: 'wajah.png', contentType: 'image/png' })
      .expect(200)
    const { memberPhotoUrl } = uploaded.body.data
    expect(uploaded.body.data.memberPhotoStatus).toBe('pending')

    const profile = await request(web).get('/api/customer/profile').set('Authorization', auth).expect(200)
    expect(profile.body.data).toMatchObject({
      memberPhotoUrl,
      memberPhotoStatus: 'pending',
      customerNumber: expect.stringMatching(/^UB-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    })
    // Disajikan mount /uploads, tanpa auth — FO menampilkannya langsung.
    await request(web).get(memberPhotoUrl).expect(200)

    const frontOffice = bearer(await createStaff('Staff Front Office'), 'staff')
    const queue = await request(web).get('/api/admin/identity/member-photos').set('Authorization', frontOffice).expect(200)
    expect(queue.body.data.users.find((user: { id: string }) => user.id === customer.id)).toMatchObject({
      photoUrl: memberPhotoUrl,
      status: 'pending'
    })

    const decision = { status: 'approved', photoUrl: memberPhotoUrl }
    const finance = bearer(await createStaff('Finance'), 'staff')
    await request(web).patch(`/api/admin/identity/${customer.id}/member-photo`).set('Authorization', finance).send(decision).expect(403)
    const decided = await request(web)
      .patch(`/api/admin/identity/${customer.id}/member-photo`)
      .set('Authorization', frontOffice)
      .send(decision)
      .expect(200)
    expect(decided.body.data.status).toBe('approved')
  })
})

describe('checkout membership lewat HTTP (tahap C)', () => {
  it('pratinjau -> checkout -> instruksi transfer -> unggah bukti -> masuk antrean staff', async () => {
    const customer = await createCustomer()
    const auth = bearer(customer, 'customer')
    const plan = await prismaClient.membershipPlan.create({ data: { name: 'Gym HTTP', price: 150_000, durationMonths: 1 } })

    await request(web)
      .post('/api/customer/member-photo')
      .set('Authorization', auth)
      .attach('photo', await png(), { filename: 'wajah.png', contentType: 'image/png' })
      .expect(200)

    const preview = await request(web).get(`/api/customer/memberships/checkout/${plan.id}`).set('Authorization', auth).expect(200)
    expect(preview.body.data).toMatchObject({ amount: 150_000, adminFee: 500, pendingMembershipId: null })

    const created = await request(web).post('/api/customer/memberships').set('Authorization', auth).send({ membershipPlanId: plan.id }).expect(201)
    const { membershipId } = created.body.data
    await request(web).post('/api/customer/memberships').set('Authorization', auth).send({ membershipPlanId: plan.id }).expect(200)

    const detail = await request(web).get(`/api/customer/memberships/${membershipId}/pembayaran`).set('Authorization', auth).expect(200)
    expect(detail.body.data).toMatchObject({
      membership: { id: membershipId, status: 'pending_payment', planName: 'Gym HTTP' },
      payment: { amount: 150_000, adminFee: 500, canUpload: true },
      bank: { bank: 'BCA' }
    })
    await request(web)
      .get(`/api/customer/memberships/${membershipId}/pembayaran`)
      .set('Authorization', bearer(await createCustomer(), 'customer'))
      .expect(404)

    const uploaded = await request(web)
      .post(`/api/customer/memberships/${membershipId}/pembayaran/bukti`)
      .set('Authorization', auth)
      .attach('proof', await png(), { filename: 'bukti.png', contentType: 'image/png' })
      .expect(200)
    expect(uploaded.body.data.payment).toMatchObject({ hasProof: true, verificationStatus: 'awaiting', canUpload: false })

    const finance = bearer(await createStaff('Finance'), 'staff')
    const queue = await request(web).get('/api/admin/payments?tab=awaiting').set('Authorization', finance).expect(200)
    const row = queue.body.data.transactions.find((item: { subject: { plan?: string } }) => item.subject.plan === 'Gym HTTP')
    expect(row).toMatchObject({ type: 'membership', total: 150_000 + 500 + uploaded.body.data.payment.uniqueCode })

    // Disetujui: membership aktif, dan email yang terkirim adalah kartu member, bukan "reservasi terkonfirmasi".
    await request(web).post(`/api/admin/payments/${row.id}/approve`).set('Authorization', finance).expect(200)
    expect((await prismaClient.membership.findUniqueOrThrow({ where: { id: membershipId } })).status).toBe('active')
    await waitForPendingMail(10_000)
    const mails = readdirSync(resolve(process.cwd(), process.env.MAIL_PREVIEW_DIR as string))
    expect(mails.some((name) => name.includes('__membership-active__') && name.includes(customer.email))).toBe(true)
  })
})
