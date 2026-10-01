import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import sharp from 'sharp'
import { prismaClient } from '../src/application/database'
import { ResponseError } from '../src/error/response-error'
import { releaseExpiredPayments } from '../src/jobs/release-expired-payments'
import { approve, openTransfer, reject } from '../src/services/manual-payment-services'
import { captureMemberPhoto, decideMemberPhoto, listMemberPhotoQueue, submitMemberPhoto } from '../src/services/member-photo-services'
import { customerInvoice, staffInvoice } from '../src/services/invoice-services'
import {
  createAdminMembership,
  createCustomerAccount,
  markMembershipPaid,
  searchCustomers,
  updateMembershipStatus
} from '../src/services/membership-admin-services'
import { membershipCheckoutPreview, startMembershipCheckout } from '../src/services/membership-checkout-services'
import { createMembership, renewMembership } from '../src/services/membership-services'
import { addMinutes, dateOnly, setNowForTests } from '../src/utils/clock'
import { waitForPendingMail } from '../src/utils/mailer'
import { customerNumber, parseCustomerNumber } from '../src/utils/money'
import {
  closeDatabase,
  configurePayments,
  createCustomer,
  createPaidMembership,
  createStaff,
  FROZEN_NOW,
  resetDatabase,
  settle
} from './helpers/fixtures'

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

  it('membership meja depan menunggu pembayaran, riwayat audit bernomor kuitansi, lalu Tandai Lunas mengaktifkan', async () => {
    const customer = await createCustomer()
    const membership = await createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-01-31', actorId: null })

    // addMonths ala Carbon: 31 Januari + 1 bulan meluap ke 3 Maret (tanggal sementara).
    expect(membership.endDate.toISOString().slice(0, 10)).toBe('2026-03-03')
    expect(membership.status).toBe('pending_payment')
    const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })
    // Transfer terbuka tanpa batas waktu sebesar harga + biaya admin + kode unik — FO yang menandai lunas.
    expect(transaction).toMatchObject({ paymentStatus: 'UNPAID', amount: 300_000, adminFee: 500, expiresAt: null })
    expect(transaction.uniqueCode).toBeGreaterThanOrEqual(1)
    expect(transaction.uniqueCode).toBeLessThanOrEqual(500)
    expect(transaction.pendingTotal).toBe(300_500 + (transaction.uniqueCode as number))
    const history = await prismaClient.membershipHistory.findFirstOrThrow({ where: { membershipId: membership.id } })
    expect(history).toMatchObject({ action: 'created', transactionId: transaction.id })
    expect(history.metadata).toMatchObject({
      plan_name: 'Bulanan Uji',
      receipt_number: `UBSC-${String(transaction.receiptSequence).padStart(6, '0')}`
    })

    const staffId = (await createStaff('Staff Front Office')).id
    const paid = await markMembershipPaid(membership.id, staffId)
    // Tanggal mulai yang sudah lewat bergeser ke hari lunas (jam beku 5 Oktober), tidak ada hari yang hilang.
    expect(paid).toMatchObject({ status: 'active', startDate: '2026-10-05', endDate: '2026-11-05', transaction: { paymentStatus: 'PAID' } })
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).toMatchObject({
      pendingTotal: null,
      verifiedById: staffId
    })
    await expect(markMembershipPaid(membership.id, staffId)).rejects.toMatchObject({ status: 409 })
  })

  it('FO: tagihan terkirim ke email, invoice sama untuk FO dan pelanggan, dan hanya pemiliknya yang bisa membuka', async () => {
    await configurePayments()
    const customer = await createCustomer()
    const staffId = (await createStaff('Staff Front Office')).id
    const dto = await createAdminMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-05' }, staffId)
    expect(dto).toMatchObject({ status: 'pending_payment', transaction: { paymentStatus: 'UNPAID' } })
    const transactionId = dto.transaction?.id as string

    await waitForPendingMail(10_000)
    const mails = readdirSync(resolve(process.cwd(), process.env.MAIL_PREVIEW_DIR as string))
    expect(mails.some((name) => name.includes('__membership-invoice__') && name.includes(customer.email))).toBe(true)

    const forCustomer = await customerInvoice(customer.id, transactionId)
    expect(forCustomer.number).toBe(dto.transaction?.receiptNumber)
    for (const text of ['BELUM DIBAYAR', 'Membership Bulanan Uji', 'BCA 1234567890', 'Cetak / Simpan PDF', `/membership/${dto.id}/pembayaran`]) {
      expect(forCustomer.html).toContain(text)
    }
    expect((await staffInvoice(transactionId)).html).toBe(forCustomer.html)
    await expect(customerInvoice((await createCustomer()).id, transactionId)).rejects.toMatchObject({ status: 404 })

    await markMembershipPaid(dto.id, staffId)
    const receipt = (await customerInvoice(customer.id, transactionId)).html
    expect(receipt).toContain('LUNAS')
    expect(receipt).not.toContain('BCA 1234567890')
  })

  it('membership bernominal 0 tidak kena biaya admin dan tidak diberi kode unik', async () => {
    const customer = await createCustomer()
    const membership = await createMembership({ userId: customer.id, startDate: '2027-01-01', endDate: '2027-02-01', amount: 0 })

    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })).toMatchObject({
      paymentStatus: 'PAID',
      amount: 0,
      adminFee: 0,
      uniqueCode: null,
      pendingTotal: null
    })
  })

  it('perpanjangan dimulai sehari setelah masa lama berakhir dan tidak dianggap overlap', async () => {
    const customer = await createCustomer()
    const first = await createPaidMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-05' })

    const renewal = await renewMembership(first.id, {})

    expect(renewal.startDate.toISOString().slice(0, 10)).toBe('2026-11-06')
    expect(renewal.status).toBe('pending_payment')
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

// ============================================================================
// === Tahap B: pending_payment, nomor pelanggan, foto member ===
// ============================================================================

/** Membership online yang belum dibayar, persis bentuk yang kelak dibuat checkout (tahap C). */
async function openPending(userId: string, startDate: string, endDate: string, holdMinutes = 120) {
  return prismaClient.$transaction(async (tx) => {
    const membership = await tx.membership.create({
      data: {
        userId,
        membershipPlanId: planId,
        startDate: dateOnly(startDate),
        endDate: dateOnly(endDate),
        status: 'pending_payment',
        createdVia: 'self'
      }
    })
    const transaction = await openTransfer(tx, { membershipId: membership.id }, userId, 300_000, addMinutes(FROZEN_NOW, holdMinutes), 'umum')
    return { membership, transaction }
  })
}

const membershipOf = (id: string) => prismaClient.membership.findUniqueOrThrow({ where: { id } })
const iso = (value: Date) => value.toISOString().slice(0, 10)

describe('pending_payment', () => {
  let staffId: string
  beforeAll(async () => {
    staffId = (await createStaff('Finance')).id
  })
  beforeEach(() => setNowForTests(FROZEN_NOW))

  it('menahan periodenya: membership meja depan yang bertumpuk ditolak, perpanjangan & ubah status manual juga', async () => {
    const customer = await createCustomer()
    const { membership } = await openPending(customer.id, '2026-10-05', '2026-11-05')

    await expect(createMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-20' })).rejects.toMatchObject({ status: 422 })
    await expect(renewMembership(membership.id, {})).rejects.toMatchObject({
      fields: { membership: ['Membership yang belum dibayar tidak dapat diperpanjang.'] }
    })
    await expect(updateMembershipStatus(membership.id, { status: 'active' }, staffId)).rejects.toMatchObject({ status: 422 })
  })

  it('transfer disetujui: aktif, masa aktif mulai hari verifikasi, riwayat "activated"', async () => {
    const customer = await createCustomer()
    // Checkout tanggal 1, diverifikasi tanggal 5 (FROZEN_NOW): tanggal mulai ikut maju.
    const { membership, transaction } = await openPending(customer.id, '2026-10-01', '2026-11-01')

    await approve(transaction.id, staffId)

    const active = await membershipOf(membership.id)
    expect(active.status).toBe('active')
    expect([iso(active.startDate), iso(active.endDate)]).toEqual(['2026-10-05', '2026-11-05'])
    const history = await prismaClient.membershipHistory.findFirstOrThrow({ where: { membershipId: membership.id, action: 'activated' } })
    expect(history).toMatchObject({ actorId: staffId, paymentStatus: 'PAID' })
  })

  it('perpanjangan online tidak mundur, dan tidak pernah menumpuk membership aktif lain', async () => {
    const customer = await createCustomer()
    const { membership: renewal, transaction: renewalTx } = await openPending(customer.id, '2026-11-02', '2026-12-02')
    await approve(renewalTx.id, staffId)
    expect(iso((await membershipOf(renewal.id)).startDate)).toBe('2026-11-02')

    // Baris aktif yang bertumpuk (mis. data lama) menggeser mulai ke sehari setelah ujungnya.
    const other = await createCustomer()
    await prismaClient.membership.create({
      data: { userId: other.id, membershipPlanId: planId, startDate: dateOnly('2026-09-20'), endDate: dateOnly('2026-10-20'), status: 'active' }
    })
    const { membership, transaction } = await openPending(other.id, '2026-10-05', '2026-11-05')
    await approve(transaction.id, staffId)
    const shifted = await membershipOf(membership.id)
    expect([iso(shifted.startDate), iso(shifted.endDate)]).toEqual(['2026-10-21', '2026-11-21'])
  })

  it('transfer kedaluwarsa atau ditolak: membership batal dan periodenya lepas', async () => {
    const customer = await createCustomer()
    const lapsed = await openPending(customer.id, '2026-10-05', '2026-11-05', 30)

    setNowForTests(addMinutes(FROZEN_NOW, 31))
    expect(await releaseExpiredPayments()).toBeGreaterThanOrEqual(1)
    expect((await membershipOf(lapsed.membership.id)).status).toBe('cancelled')
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: lapsed.transaction.id } })).toMatchObject({
      paymentStatus: 'EXPIRED',
      pendingTotal: null
    })

    // Periodenya kosong lagi: pembelian berikutnya boleh, lalu ditolak staff.
    setNowForTests(FROZEN_NOW)
    const again = await openPending(customer.id, '2026-10-05', '2026-11-05')
    await reject(again.transaction.id, staffId, 'Nominal tidak sesuai')
    expect((await membershipOf(again.membership.id)).status).toBe('cancelled')
    expect(await prismaClient.membershipHistory.count({ where: { membershipId: again.membership.id, action: 'payment_rejected' } })).toBe(1)
  })
})

describe('nomor pelanggan', () => {
  it('tidak berurutan, unik, dan nomor yang dipindai/diketik FO kembali ke urutannya', () => {
    const numbers = new Set<string>()
    for (let sequence = 1; sequence <= 5000; sequence++) {
      const number = customerNumber(sequence)
      expect(number).toMatch(/^UB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
      expect(parseCustomerNumber(number)).toBe(sequence)
      numbers.add(number)
    }
    expect(numbers.size).toBe(5000)
    expect(customerNumber(124).slice(0, 7)).not.toBe(customerNumber(123).slice(0, 7))

    const number = customerNumber(123)
    const bare = number.replace(/-/g, '').slice(2)
    for (const typed of [number.toLowerCase(), bare, ` ${number}\r\n`, bare.replace(/0/g, 'O').replace(/1/g, 'I')]) {
      expect(parseCustomerNumber(typed)).toBe(123)
    }
    for (const typed of ['UB-000123', '123', 'Budi']) expect(parseCustomerNumber(typed)).toBeNull()
  })

  it('terbit otomatis dan bisa dicari persis dari pencarian pelanggan admin', async () => {
    const customer = await createCustomer()
    const number = customerNumber(customer.customerSequence)
    const hits = await searchCustomers({ q: number })
    expect(hits.find((hit) => hit.id === customer.id)?.customerNumber).toBe(number)
  })
})

describe('foto member', () => {
  const photo = (background: string) =>
    sharp({ create: { width: 64, height: 64, channels: 3, background } })
      .png()
      .toBuffer()
  const onDisk = (url: string) => existsSync(resolve(process.cwd(), process.env.UPLOAD_DIR as string, url.replace('/uploads/', '')))

  it('unggah -> pending; unggah ulang menghapus berkas lama; keputusan staff harus atas foto yang dilihat', async () => {
    const customer = await createCustomer()

    const first = await submitMemberPhoto(customer.id, { buffer: await photo('#ff0000'), originalname: 'wajah.png' })
    expect(first.memberPhotoStatus).toBe('pending')
    expect(first.memberPhotoUrl).toMatch(/^\/uploads\/members\/[0-9a-f-]+\.webp$/)
    expect(onDisk(first.memberPhotoUrl as string)).toBe(true)

    const second = await submitMemberPhoto(customer.id, { buffer: await photo('#00ff00'), originalname: 'wajah2.png' })
    expect(onDisk(first.memberPhotoUrl as string)).toBe(false)
    expect(onDisk(second.memberPhotoUrl as string)).toBe(true)

    await expect(decideMemberPhoto(customer.id, { status: 'approved', photoUrl: first.memberPhotoUrl })).rejects.toMatchObject({ status: 409 })
    const approved = await decideMemberPhoto(customer.id, { status: 'approved', photoUrl: second.memberPhotoUrl })
    expect(approved).toMatchObject({ status: 'approved', customerNumber: customerNumber(customer.customerSequence) })

    // Unggah ulang setelah disetujui kembali ke pending: foto baru belum pernah dilihat staff.
    const third = await submitMemberPhoto(customer.id, { buffer: await photo('#0000ff'), originalname: 'wajah3.png' })
    expect(third.memberPhotoStatus).toBe('pending')
    expect((await listMemberPhotoQueue()).users[0].status).toBe('pending')
  })

  it('berkas yang bukan gambar ditolak sebelum menyentuh disk', async () => {
    const customer = await createCustomer()
    await expect(submitMemberPhoto(customer.id, { buffer: Buffer.from('bukan gambar'), originalname: 'x.png' })).rejects.toMatchObject({
      status: 422,
      fields: { photo: ['Foto harus berupa gambar.'] }
    })
    expect((await prismaClient.user.findUniqueOrThrow({ where: { id: customer.id } })).memberPhotoPath).toBeNull()
  })
})

// ============================================================================
// === Tahap C: tarif Warga UB, checkout web, jalur meja depan ===
// ============================================================================

const facePhoto = (background = '#777777') =>
  sharp({ create: { width: 64, height: 64, channels: 3, background } })
    .png()
    .toBuffer()
const freshUser = (id: string) => prismaClient.user.findUniqueOrThrow({ where: { id }, include: { role: true } })

describe('tahap C: tarif Warga UB + checkout web', () => {
  let wargaPlanId: string
  beforeAll(async () => {
    await configurePayments()
    wargaPlanId = (await prismaClient.membershipPlan.create({ data: { name: 'Gym Warga', price: 250_000, wargaPrice: 200_000, durationMonths: 1 } }))
      .id
  })
  beforeEach(() => setNowForTests(FROZEN_NOW))

  it('meja depan: tarif Warga UB hanya untuk identitas yang sudah terverifikasi', async () => {
    const verified = await createCustomer({ identityCategory: 'warga_kampus', identityStatus: 'verified' })
    const waiting = await createCustomer({ identityCategory: 'warga_kampus', identityStatus: 'pending' })
    const amountFor = async (userId: string) => {
      const membership = await createMembership({ userId, membershipPlanId: wargaPlanId, startDate: '2026-10-05' })
      return (await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })).amount
    }
    expect(await amountFor(verified.id)).toBe(200_000)
    expect(await amountFor(waiting.id)).toBe(250_000)
  })

  it('checkout web: wajib foto; pending_payment + transfer ber-hold; klik ulang paket yang sama mengembalikan yang sama', async () => {
    const customer = await createCustomer({ identityCategory: 'warga_kampus', identityStatus: 'verified' })
    await expect(startMembershipCheckout(await freshUser(customer.id), { membershipPlanId: wargaPlanId })).rejects.toMatchObject({
      status: 422,
      fields: { photo: [expect.any(String)] }
    })

    await submitMemberPhoto(customer.id, { buffer: await facePhoto(), originalname: 'wajah.png' })
    const user = await freshUser(customer.id)
    expect(await membershipCheckoutPreview(user, wargaPlanId)).toMatchObject({
      amount: 200_000,
      priceCategory: 'warga_ub',
      adminFee: 500,
      startsAfterCurrent: null,
      pendingMembershipId: null,
      memberPhotoStatus: 'pending'
    })

    const first = await startMembershipCheckout(user, { membershipPlanId: wargaPlanId })
    expect(first.created).toBe(true)
    const membership = await prismaClient.membership.findUniqueOrThrow({ where: { id: first.membershipId }, include: { transaction: true } })
    expect(membership).toMatchObject({ status: 'pending_payment', createdVia: 'self' })
    expect(membership.transaction).toMatchObject({ paymentStatus: 'UNPAID', amount: 200_000, adminFee: 500 })
    expect(membership.transaction?.expiresAt?.getTime()).toBe(addMinutes(FROZEN_NOW, 120).getTime())

    expect(await startMembershipCheckout(user, { membershipPlanId: wargaPlanId })).toEqual({ created: false, membershipId: first.membershipId })
    await expect(startMembershipCheckout(user, { membershipPlanId: planId })).rejects.toMatchObject({
      status: 422,
      fields: { membership: [expect.stringContaining('menunggu pembayaran')] }
    })
    expect((await membershipCheckoutPreview(user, wargaPlanId)).pendingMembershipId).toBe(first.membershipId)
  })

  it('checkout saat masih punya membership aktif = perpanjangan, mulai sehari setelah masa aktifnya', async () => {
    const customer = await createCustomer()
    const current = await createPaidMembership({ userId: customer.id, membershipPlanId: planId, startDate: '2026-10-05' })
    await submitMemberPhoto(customer.id, { buffer: await facePhoto(), originalname: 'wajah.png' })
    const user = await freshUser(customer.id)

    expect((await membershipCheckoutPreview(user, wargaPlanId)).startsAfterCurrent).toBe('2026-11-06')
    const { membershipId } = await startMembershipCheckout(user, { membershipPlanId: wargaPlanId })
    const renewal = await membershipOf(membershipId)
    expect([iso(renewal.startDate), iso(renewal.endDate)]).toEqual(['2026-11-06', '2026-12-06'])
    expect(renewal.renewedFromMembershipId).toBe(current.id)
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId } })).amount).toBe(250_000)
  })

  it('meja depan: akun minimal walk-in, dan foto yang diambil staff langsung disetujui', async () => {
    const created = await createCustomerAccount({ name: 'Tamu Gym', email: 'Tamu.Gym@Test.ubsc.id', phoneNumber: '081200000000' })
    expect(created).toMatchObject({
      email: 'tamu.gym@test.ubsc.id',
      customerNumber: expect.stringMatching(/^UB-[0-9A-Z]{4}-[0-9A-Z]{4}$/),
      priceCategory: 'umum'
    })
    await expect(createCustomerAccount({ name: 'Lain', email: 'tamu.gym@test.ubsc.id' })).rejects.toMatchObject({
      status: 422,
      fields: { email: [expect.any(String)] }
    })

    expect((await captureMemberPhoto(created.id, { buffer: await facePhoto('#123456'), originalname: 'meja.png' })).memberPhotoStatus).toBe(
      'approved'
    )
    const staff = await createStaff('Manager')
    await expect(captureMemberPhoto(staff.id, { buffer: await facePhoto(), originalname: 'staff.png' })).rejects.toMatchObject({ status: 422 })
  })
})
