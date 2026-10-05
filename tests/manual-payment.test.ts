import { existsSync } from 'fs'
import { resolve } from 'path'
import sharp from 'sharp'
import { prismaClient } from '../src/application/database'
import { releaseExpiredPayments } from '../src/jobs/release-expired-payments'
import { ResponseError } from '../src/error/response-error'
import { createAdminBooking, destroyBooking } from '../src/services/booking-admin-services'
import { createBooking } from '../src/services/booking-services'
import { getFinanceReport } from '../src/services/finance-report-services'
import { staffInvoice } from '../src/services/invoice-services'
import { approve, attachProof, expire, reject } from '../src/services/manual-payment-services'
import { createMembership } from '../src/services/membership-services'
import { removeQrisImage, updatePaymentSettings, uploadQrisImage } from '../src/services/payment-admin-services'
import { paymentDetail } from '../src/services/payment-services'
import { addMinutes, jakartaWallTimeToUtc, setNowForTests } from '../src/utils/clock'
import {
  closeDatabase,
  configurePayments,
  createCustomer,
  createFacility,
  createStaff,
  FROZEN_NOW,
  insertBooking,
  openMonth,
  resetDatabase,
  settle
} from './helpers/fixtures'

// ============================================================================
// === State machine pembayaran manual ===
// ============================================================================
// Gate Fase 3: bukti masuk saat hold lewat -> HOLD_LAPSED; expire() no-op bila bukti sudah ada.
// Plus approve/reject pada grup paket, dan balapan antar operasi yang semuanya mengunci baris
// transaksi lebih dulu.

const HOLD_MINUTES = 120

async function bookCourt(date = '2026-10-06', startTime = '10:00', endTime = '11:00') {
  const facility = await createFacility({ capacity: 1 })
  const customer = await createCustomer()
  const created = await createBooking(customer, { facilityId: facility.id, bookingDate: date, startTime, endTime })
  return { facility, customer, ...created }
}

/** Paket kelas tiga sesi (Selasa, Kamis, Selasa) — satu transfer, tiga baris booking. */
async function bookPackage() {
  const facility = await createFacility({ mode: 'class', capacity: 10, activeSlots: { Tuesday: ['18:00'], Thursday: ['18:00'] } })
  const customer = await createCustomer()
  const created = await createBooking(customer, {
    facilityId: facility.id,
    sessions: [
      { date: '2026-10-06', startTime: '18:00', endTime: '19:00' },
      { date: '2026-10-08', startTime: '18:00', endTime: '19:00' },
      { date: '2026-10-13', startTime: '18:00', endTime: '19:00' }
    ]
  })
  return { facility, customer, ...created }
}

const groupOf = (leadId: string) =>
  prismaClient.booking.findMany({ where: { OR: [{ id: leadId }, { bookingGroupId: leadId }] }, orderBy: { bookingDate: 'asc' } })

let staffId: string

beforeAll(async () => {
  await resetDatabase()
  await configurePayments(HOLD_MINUTES)
  await openMonth(2026, 10)
  staffId = (await createStaff('Finance')).id
})

beforeEach(() => setNowForTests(FROZEN_NOW))

afterAll(closeDatabase)

describe('attachProof', () => {
  it('hold masih hidup: bukti menempel, hold menjadi tanpa batas, masuk antrean verifikasi', async () => {
    const { bookingId, transactionId } = await bookCourt()

    await attachProof(transactionId, 'payment-proofs/uji/bukti.webp')

    const [booking] = await groupOf(bookingId)
    expect(booking.status).toBe('pending')
    expect(booking.holdExpiresAt).toBeNull()
    const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(transaction).toMatchObject({ proofPath: 'payment-proofs/uji/bukti.webp', verificationStatus: 'awaiting', paymentStatus: 'UNPAID' })
    expect(transaction.proofUploadedAt).not.toBeNull()
  })

  it('GATE: hold sudah lewat -> HOLD_LAPSED, dan tidak ada yang berubah', async () => {
    const { bookingId, transactionId } = await bookCourt('2026-10-07')
    const [before] = await groupOf(bookingId)

    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 1))
    const outcome = await settle([attachProof(transactionId, 'payment-proofs/uji/terlambat.webp')])

    expect(outcome.rejected[0]).toBeInstanceOf(ResponseError)
    expect(outcome.rejected[0]).toMatchObject({
      status: 409,
      code: 'HOLD_LAPSED',
      fields: { proof: [expect.stringContaining('slot telah dilepas')] }
    })

    const [after] = await groupOf(bookingId)
    expect(after.holdExpiresAt?.getTime()).toBe(before.holdExpiresAt?.getTime())
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).toMatchObject({
      proofPath: null,
      verificationStatus: null
    })
  })

  it('hold tepat di detik habisnya sudah dianggap lewat (hold > sekarang, bukan >=)', async () => {
    const { transactionId } = await bookCourt('2026-10-08')
    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES))
    await expect(attachProof(transactionId, 'payment-proofs/uji/tepat.webp')).rejects.toMatchObject({ code: 'HOLD_LAPSED' })
  })

  it('paket: satu sesi yang hold-nya lewat menggagalkan SELURUH grup, semua atau tidak sama sekali', async () => {
    const { bookingId, transactionId } = await bookPackage()
    const group = await groupOf(bookingId)
    expect(group).toHaveLength(3)

    // Satu anggota grup kehilangan hold-nya (mis. disentuh proses lain) — sisanya masih hidup.
    const follower = group.find((b) => b.id !== bookingId)!
    await prismaClient.booking.update({ where: { id: follower.id }, data: { holdExpiresAt: addMinutes(FROZEN_NOW, -1) } })

    await expect(attachProof(transactionId, 'payment-proofs/uji/paket.webp')).rejects.toMatchObject({ code: 'HOLD_LAPSED' })

    // Pemeriksaan di bawah kunci menolak SEBELUM menulis apa pun: tidak ada hold yang menjadi NULL.
    const after = await groupOf(bookingId)
    after.forEach((b) => expect(b.holdExpiresAt).not.toBeNull())
  })

  it('unggah ulang saat masih UNPAID menggantikan bukti lama', async () => {
    const { transactionId } = await bookCourt('2026-10-09')
    await attachProof(transactionId, 'payment-proofs/uji/pertama.webp')
    await attachProof(transactionId, 'payment-proofs/uji/kedua.webp')
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).toMatchObject({
      proofPath: 'payment-proofs/uji/kedua.webp'
    })
  })
})

describe('expire', () => {
  it('GATE: no-op bila bukti sudah ada — pelanggan yang sudah membayar tidak pernah dibatalkan', async () => {
    const { bookingId, transactionId } = await bookCourt('2026-10-10')
    await attachProof(transactionId, 'payment-proofs/uji/sudah-bayar.webp')

    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 30))
    expect(await expire(transactionId)).toBe(false)

    const [booking] = await groupOf(bookingId)
    expect(booking).toMatchObject({ status: 'pending', holdExpiresAt: null, cancelledReason: null })
    const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(transaction).toMatchObject({ paymentStatus: 'UNPAID', verificationStatus: 'awaiting' })
    expect(transaction.pendingTotal).not.toBeNull()
  })

  it('tanpa bukti: transaksi EXPIRED, seluruh grup dibatalkan, angka rupiah dibebaskan', async () => {
    const { bookingId, transactionId } = await bookPackage()

    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 1))
    expect(await expire(transactionId)).toBe(true)

    const group = await groupOf(bookingId)
    group.forEach((b) => expect(b).toMatchObject({ status: 'cancelled', cancelledReason: 'payment_expired', holdExpiresAt: null }))
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).toMatchObject({
      paymentStatus: 'EXPIRED',
      pendingTotal: null
    })
  })

  it('transaksi yang sudah PAID tidak bisa di-expire', async () => {
    const { transactionId } = await bookCourt('2026-10-11')
    await approve(transactionId, staffId)
    expect(await expire(transactionId)).toBe(false)
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).toMatchObject({ paymentStatus: 'PAID' })
  })
})

describe('approve & reject', () => {
  it('approve paket: SETIAP sesi terkonfirmasi, bukan hanya lead', async () => {
    const { bookingId, transactionId } = await bookPackage()
    await attachProof(transactionId, 'payment-proofs/uji/paket-lunas.webp')

    const decision = await approve(transactionId, staffId)

    expect(decision.booking?.id).toBe(bookingId)
    const group = await groupOf(bookingId)
    group.forEach((b) => expect(b).toMatchObject({ status: 'confirmed', holdExpiresAt: null }))
    const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })
    expect(transaction).toMatchObject({ paymentStatus: 'PAID', verificationStatus: null, pendingTotal: null, verifiedById: staffId })
    expect(transaction.paidAt).not.toBeNull()
  })

  it('CAS: approve kedua dan reject setelah approve ditolak 409, tidak menulis ulang apa pun', async () => {
    const { transactionId } = await bookCourt('2026-10-12')
    await approve(transactionId, staffId)
    const paidAt = (await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).paidAt

    setNowForTests(addMinutes(FROZEN_NOW, 10))
    await expect(approve(transactionId, staffId)).rejects.toMatchObject({ status: 409, message: 'Transaksi sudah diproses.' })
    await expect(reject(transactionId, staffId, 'coba tolak')).rejects.toMatchObject({ status: 409 })
    expect((await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).paidAt).toEqual(paidAt)
  })

  it('reject: grup dibatalkan dan slotnya langsung bisa dipesan orang lain', async () => {
    const { facility, bookingId, transactionId } = await bookCourt('2026-10-14', '15:00', '16:00')

    const decision = await reject(transactionId, staffId, 'Nominal transfer tidak sesuai')

    expect(decision.rejectionReason).toBe('Nominal transfer tidak sesuai')
    const [booking] = await groupOf(bookingId)
    expect(booking).toMatchObject({ status: 'cancelled', cancelledReason: 'proof_rejected' })
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })).toMatchObject({
      paymentStatus: 'FAILED',
      verificationStatus: 'rejected',
      pendingTotal: null
    })

    const other = await createCustomer()
    await expect(
      createBooking(other, { facilityId: facility.id, bookingDate: '2026-10-14', startTime: '15:00', endTime: '16:00' })
    ).resolves.toHaveProperty('bookingId')
  })

  it('transaksi yang tidak ada: 404', async () => {
    await expect(approve('00000000-0000-0000-0000-000000000000', staffId)).rejects.toMatchObject({ status: 404 })
  })
})

describe('balapan antar operasi pembayaran', () => {
  it('approve vs expire bersamaan: tepat satu yang menang, dan keadaan akhirnya konsisten', async () => {
    for (let round = 0; round < 8; round++) {
      setNowForTests(FROZEN_NOW)
      const { bookingId, transactionId } = await bookCourt(
        '2026-10-15',
        `${String(8 + round).padStart(2, '0')}:00`,
        `${String(9 + round).padStart(2, '0')}:00`
      )
      setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 1))

      const [approved, expired] = await Promise.allSettled([approve(transactionId, staffId), expire(transactionId)])
      const approveWon = approved.status === 'fulfilled'
      const expireWon = expired.status === 'fulfilled' && expired.value === true

      expect(Number(approveWon) + Number(expireWon)).toBe(1)
      const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })
      const [booking] = await groupOf(bookingId)
      if (approveWon) {
        expect(transaction.paymentStatus).toBe('PAID')
        expect(booking.status).toBe('confirmed')
      } else {
        expect(transaction.paymentStatus).toBe('EXPIRED')
        expect(booking.status).toBe('cancelled')
      }
    }
  })

  it('attachProof vs expire bersamaan: tidak pernah "bukti tersimpan tapi booking dibatalkan"', async () => {
    for (let round = 0; round < 8; round++) {
      setNowForTests(FROZEN_NOW)
      const { bookingId, transactionId } = await bookCourt(
        '2026-10-16',
        `${String(8 + round).padStart(2, '0')}:00`,
        `${String(9 + round).padStart(2, '0')}:00`
      )

      // Hold masih hidup menurut attachProof; sweep tetap dipanggil paksa, mewakili pemanggil yang
      // memilih baris sesaat sebelum bukti tiba.
      await Promise.allSettled([attachProof(transactionId, `payment-proofs/uji/balap-${round}.webp`), expire(transactionId)])

      const transaction = await prismaClient.transaction.findUniqueOrThrow({ where: { id: transactionId } })
      const [booking] = await groupOf(bookingId)
      if (transaction.proofPath) {
        expect(transaction).toMatchObject({ paymentStatus: 'UNPAID', verificationStatus: 'awaiting' })
        expect(booking).toMatchObject({ status: 'pending', holdExpiresAt: null })
      } else {
        expect(transaction.paymentStatus).toBe('EXPIRED')
        expect(booking.status).toBe('cancelled')
      }
    }
  })
})

describe('job payments:release-expired', () => {
  it('melepas hold yang habis, melewati yang sudah dibayar atau sudah berbukti, dan tidak memungut anggota paket', async () => {
    // Sapu sisa hold dari test sebelumnya lebih dulu — job ini global, hitungannya harus milik test ini saja.
    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 1))
    await releaseExpiredPayments()

    setNowForTests(FROZEN_NOW)
    const lapsedStandalone = await bookCourt('2026-10-20')
    const lapsedPackage = await bookPackage()
    const paidRace = await bookCourt('2026-10-21')
    const proofRace = await bookCourt('2026-10-22')
    const alive = await bookCourt('2026-10-23')

    // Booking lama tanpa transaksi: grup (lead + anggota) ikut dibatalkan.
    const legacyFacility = await createFacility({ capacity: 5 })
    const legacyLead = await insertBooking({
      facilityId: legacyFacility.id,
      date: '2026-10-24',
      startTime: '09:00',
      endTime: '10:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, 5)
    })
    await prismaClient.booking.update({ where: { id: legacyLead.id }, data: { bookingGroupId: legacyLead.id } })
    const legacyFollower = await insertBooking({
      facilityId: legacyFacility.id,
      date: '2026-10-25',
      startTime: '09:00',
      endTime: '10:00',
      status: 'pending',
      holdExpiresAt: addMinutes(FROZEN_NOW, 5)
    })
    await prismaClient.booking.update({ where: { id: legacyFollower.id }, data: { bookingGroupId: legacyLead.id } })

    // Balapan yang dibekukan di tengah jalan: hold masih tercatat habis, tapi pembayaran sudah maju.
    await prismaClient.transaction.update({ where: { id: paidRace.transactionId }, data: { paymentStatus: 'PAID' } })
    await prismaClient.transaction.update({
      where: { id: proofRace.transactionId },
      data: { verificationStatus: 'awaiting', proofPath: 'payment-proofs/uji/x.webp' }
    })
    // Hold yang masih hidup.
    await prismaClient.booking.update({ where: { id: alive.bookingId }, data: { holdExpiresAt: addMinutes(FROZEN_NOW, 600) } })

    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 1))
    const released = await releaseExpiredPayments()

    expect(released).toBe(3) // standalone, paket, legacy
    expect((await groupOf(lapsedStandalone.bookingId))[0]).toMatchObject({ status: 'cancelled', cancelledReason: 'payment_expired' })
    ;(await groupOf(lapsedPackage.bookingId)).forEach((b) => expect(b.status).toBe('cancelled'))
    ;(await groupOf(legacyLead.id)).forEach((b) => expect(b).toMatchObject({ status: 'cancelled', cancelledReason: 'payment_expired' }))
    expect((await groupOf(paidRace.bookingId))[0].status).toBe('pending')
    expect((await groupOf(proofRace.bookingId))[0].status).toBe('pending')
    expect((await groupOf(alive.bookingId))[0].status).toBe('pending')

    // Putaran kedua tidak menemukan apa pun yang baru.
    expect(await releaseExpiredPayments()).toBe(0)
  })

  it('anggota paket yang hold-nya lewat sendirian tidak dipungut — hanya lewat lead-nya', async () => {
    setNowForTests(FROZEN_NOW)
    const pkg = await bookPackage()
    const follower = (await groupOf(pkg.bookingId)).find((b) => b.id !== pkg.bookingId)!
    await prismaClient.booking.update({ where: { id: pkg.bookingId }, data: { holdExpiresAt: addMinutes(FROZEN_NOW, 10_000) } })
    await prismaClient.booking.update({ where: { id: follower.id }, data: { holdExpiresAt: addMinutes(FROZEN_NOW, 1) } })

    setNowForTests(addMinutes(FROZEN_NOW, HOLD_MINUTES + 1))
    await releaseExpiredPayments()

    ;(await groupOf(pkg.bookingId)).forEach((b) => expect(b.status).toBe('pending'))
  })
})

describe('biaya admin + kode unik (catatan client 2026-09)', () => {
  const setSetting = (key: string, value: string) => prismaClient.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
  const transactionOf = (id: string) => prismaClient.transaction.findUniqueOrThrow({ where: { id } })

  it('transfer web: harga + Rp500 + kode 1..500, dan paket N sesi kena biaya admin satu kali', async () => {
    setNowForTests(FROZEN_NOW)
    const court = await bookCourt('2026-10-26')
    const pkg = await bookPackage()

    for (const { transactionId } of [court, pkg]) {
      const t = await transactionOf(transactionId)
      expect(t.adminFee).toBe(500)
      expect(t.uniqueCode).toBeGreaterThanOrEqual(1)
      expect(t.uniqueCode).toBeLessThanOrEqual(500)
      expect(t.pendingTotal).toBe(t.amount + 500 + (t.uniqueCode as number))
    }
    const sessionIds = (await groupOf(pkg.bookingId)).map((b) => b.id)
    expect(await prismaClient.transaction.count({ where: { bookingId: { in: sessionIds } } })).toBe(1)
  })

  it('setting berlaku untuk transfer berikutnya saja; transfer yang sudah terbuka tidak berubah', async () => {
    setNowForTests(FROZEN_NOW)
    const before = await bookCourt('2026-10-27')
    await setSetting('payment_admin_fee', '0')
    await setSetting('payment_unique_code_max', '100')
    try {
      const after = await transactionOf((await bookCourt('2026-10-27')).transactionId)
      expect(after.adminFee).toBe(0)
      expect(after.uniqueCode).toBeLessThanOrEqual(100)
      expect(after.pendingTotal).toBe(after.amount + (after.uniqueCode as number))
      expect((await transactionOf(before.transactionId)).adminFee).toBe(500)
    } finally {
      await setSetting('payment_admin_fee', '500')
      await setSetting('payment_unique_code_max', '500')
    }
  })

  it('walk-in: ditahan sampai Tandai Lunas (approve), batal melepas kodenya, gratis tanpa biaya dan kode', async () => {
    setNowForTests(FROZEN_NOW)
    const facility = await createFacility({ capacity: 3 })
    const walkIn = (startTime: string, endTime: string, isFree = false) =>
      createAdminBooking({ customerName: 'Tamu Uji', facilityId: facility.id, bookingDate: '2026-10-28', startTime, endTime, isFree })

    const paid = await walkIn('10:00', '11:00')
    const open = await transactionOf(paid.transactionId)
    expect(open).toMatchObject({ paymentStatus: 'UNPAID', adminFee: 500, expiresAt: null })
    expect(open.pendingTotal).toBe(open.amount + 500 + (open.uniqueCode as number))

    const decision = await approve(paid.transactionId, staffId)
    expect(decision.total).toBe(open.pendingTotal)
    expect(await transactionOf(paid.transactionId)).toMatchObject({ paymentStatus: 'PAID', pendingTotal: null, verifiedById: staffId })
    expect((await groupOf(paid.bookingId))[0].status).toBe('confirmed')

    const cancelled = await walkIn('11:00', '12:00')
    await destroyBooking(cancelled.bookingId)
    expect(await transactionOf(cancelled.transactionId)).toMatchObject({ paymentStatus: 'FAILED', pendingTotal: null })

    const free = await walkIn('12:00', '13:00', true)
    expect(await transactionOf(free.transactionId)).toMatchObject({
      paymentStatus: 'PAID',
      amount: 0,
      adminFee: 0,
      uniqueCode: null,
      pendingTotal: null
    })
  })

  it('laporan keuangan: total pendapatan = harga + biaya admin + kode unik, dan rinciannya berjumlah total', async () => {
    setNowForTests(FROZEN_NOW)
    const court = await bookCourt('2026-10-29')
    const customer = await createCustomer()
    const plan = await prismaClient.membershipPlan.create({ data: { name: 'Bulanan Laporan', price: 300_000, durationMonths: 1 } })

    // Maret 2027: tidak ada transaksi lain di berkas ini yang dibuat atau dibayar pada bulan itu.
    setNowForTests(jakartaWallTimeToUtc('2027-03-10', '09:00'))
    await approve(court.transactionId, staffId)
    const membership = await createMembership({ userId: customer.id, membershipPlanId: plan.id, startDate: '2027-03-10' })
    // Membership meja depan menunggu pembayaran sampai FO menandai lunas.
    await approve((await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })).id, staffId)

    const paid = await prismaClient.transaction.findMany({ where: { OR: [{ id: court.transactionId }, { membershipId: membership.id }] } })
    const expected = paid.reduce((sum, t) => sum + t.amount + t.adminFee + (t.uniqueCode ?? 0), 0)

    const report = await getFinanceReport({ month: '3', year: '2027' })
    expect(report.stats).toMatchObject({ totalRevenue: expected, bookingRevenue: 100_000, membershipRevenue: 300_000, adminFeeRevenue: 1_000 })
    expect(report.typeBreakdown.reduce((sum, row) => sum + row.revenue, 0)).toBe(expected)
    expect(report.ledger.reduce((sum, row) => sum + row.total, 0)).toBe(expected)
    expect(report.dailyRevenue[9]).toBe(expected)
  })
})

// ============================================================================
// === Nomor invoice tahunan + QRIS statis (permintaan client 2026-10-01) ===
// ============================================================================

describe('nomor invoice', () => {
  it("format 'UBSC-<romawi>-<tahun>-<urut>', berurutan, dan urutannya mulai lagi dari 0001 di tahun baru", async () => {
    setNowForTests(FROZEN_NOW)
    const invoiceOf = async (startDate: string, endDate: string) => {
      const membership = await createMembership({ customerName: 'Tamu Invoice', startDate, endDate, amount: 100_000 })
      return (await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })).invoiceNumber
    }

    const first = await invoiceOf('2026-10-05', '2026-11-05')
    const second = await invoiceOf('2026-12-05', '2027-01-05')
    expect(first).toMatch(/^UBSC-X-2026-\d{4}$/)
    expect(Number(second.slice(-4))).toBe(Number(first.slice(-4)) + 1)

    // Tahun yang belum dipakai test lain: counter-nya mulai dari 1.
    setNowForTests(jakartaWallTimeToUtc('2028-01-02', '09:00'))
    try {
      expect(await invoiceOf('2028-01-05', '2028-02-05')).toBe('UBSC-I-2028-0001')
      expect(await invoiceOf('2028-03-05', '2028-04-05')).toBe('UBSC-I-2028-0002')
    } finally {
      setNowForTests(FROZEN_NOW)
    }
  })
})

describe('QRIS statis', () => {
  it('gambar QRIS tampil di detail bayar dan invoice, rekening boleh kosong; dihapus = kembali ke rekening', async () => {
    setNowForTests(FROZEN_NOW)
    const png = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer()
    const uploaded = await uploadQrisImage({ buffer: png, originalname: 'qris.png' })
    const imageUrl = uploaded.qris?.imageUrl as string
    expect(imageUrl).toMatch(/^\/uploads\/qris\/[0-9a-f-]+\.png$/)
    const file = resolve(process.cwd(), process.env.UPLOAD_DIR as string, imageUrl.slice('/uploads/'.length))
    expect(existsSync(file)).toBe(true)

    try {
      // Rekening dikosongkan: checkout tetap terbuka karena QRIS sudah ada.
      await updatePaymentSettings({
        bankName: '',
        accountNumber: '',
        accountHolder: '',
        qrisMerchantName: 'UB SPORT CENTER',
        holdMinutes: HOLD_MINUTES,
        adminFee: 500,
        uniqueCodeMax: 500
      })
      const court = await bookCourt('2026-10-07')
      expect(await paymentDetail(court.customer.id, court.bookingId)).toMatchObject({ qris: { imageUrl, merchantName: 'UB SPORT CENTER' } })

      const html = (await staffInvoice(court.transactionId)).html
      expect(html).toMatch(new RegExp(`<img src="https?://[^"]+${imageUrl}"`))
      expect(html).toContain('Scan QRIS')
      expect(html).not.toContain('Transfer <strong>tepat')

      const removed = await removeQrisImage()
      expect(removed.qris).toBeNull()
      expect(existsSync(file)).toBe(false)
    } finally {
      await configurePayments(HOLD_MINUTES)
    }
  })
})
