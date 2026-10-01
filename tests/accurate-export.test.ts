import request from 'supertest'
import { inflateRawSync } from 'zlib'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { accurateCustomerExport, accurateInvoiceExport, ACCURATE_BRANCH } from '../src/services/accurate-export-services'
import { createMembership } from '../src/services/membership-services'
import { createCustomerAccount } from '../src/services/membership-admin-services'
import {
  forgotPasswordAuth,
  issueVerification,
  MAIL_RESEND_MAX_PER_DAY,
  resetPasswordAuth,
  verifyEmailAuth
} from '../src/services/registration-services'
import { addDays, jakartaDate, setNowForTests } from '../src/utils/clock'
import { customerNumber } from '../src/utils/money'
import { createRefreshToken, hashToken } from '../src/utils/token'
import { bearer, closeDatabase, createCustomer, createStaff, FROZEN_NOW, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === Export Accurate (.xlsx) + jeda kirim ulang verifikasi — catatan client 2026-09-28 ===
// ============================================================================

/** Baca balik sheet pertama .xlsx buatan buildXlsx(): { 'A1': 'nilai', ... }. */
function readSheet(buffer: Buffer): Record<string, string> {
  const files = new Map<string, string>()
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let at = buffer.readUInt32LE(end + 16)
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const nameLength = buffer.readUInt16LE(at + 28)
    const offset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    files.set(name, inflateRawSync(buffer.subarray(start, start + buffer.readUInt32LE(at + 20))).toString('utf8'))
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32)
  }
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
  const strings = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]))
  const cells: Record<string, string> = {}
  for (const m of (files.get('xl/worksheets/sheet1.xml') ?? '').matchAll(/<c r="([A-Z]+\d+)"([^>]*)><v>([^<]*)<\/v><\/c>/g)) {
    cells[m[1]] = m[2].includes('t="s"') ? strings[Number(m[3])] : m[3]
  }
  return cells
}

let planId: string
/** Hari transaksi dibuat (WIB), diisi test pertama. */
let day: string

beforeAll(async () => {
  await resetDatabase()
  setNowForTests(FROZEN_NOW)
  planId = (
    await prismaClient.membershipPlan.create({
      data: {
        name: 'Gym Accurate',
        price: 200_000,
        wargaPrice: 150_000,
        durationMonths: 1,
        accurateItemNo: 'GYM-1B',
        accurateItemNoWarga: 'GYM-1B-W'
      }
    })
  ).id
})

afterAll(closeDatabase)

describe('export Accurate', () => {
  it('faktur + pelanggan untuk transaksi hari itu: ID WEB berurutan, walk-in ke pelanggan umum, satu baris seharga total', async () => {
    const early = await createCustomer()
    await prismaClient.user.update({ where: { id: early.id }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } })
    const late = await createCustomer()
    // Yang daftar lebih dulu mendapat nomor lebih kecil, apa pun urutan transaksinya.
    const second = await createMembership({ userId: late.id, membershipPlanId: planId, startDate: '2026-10-05' })
    const first = await createMembership({ userId: early.id, membershipPlanId: planId, startDate: '2026-10-05' })
    const walkIn = await createMembership({ customerName: 'Pak Andi', startDate: '2026-10-05', endDate: '2026-11-05', amount: 150_000 })
    // Dibatalkan = tidak dijual; nominal 0 = tidak ada yang ditagih.
    const cancelled = await createMembership({ userId: (await createCustomer()).id, membershipPlanId: planId, startDate: '2026-10-05' })
    await prismaClient.transaction.update({ where: { membershipId: cancelled.id }, data: { paymentStatus: 'FAILED', pendingTotal: null } })
    await createMembership({ userId: (await createCustomer()).id, startDate: '2026-10-05', endDate: '2026-10-06', amount: 0 })
    // Warga UB terverifikasi membayar harga warga → nomor item tarif Warga UB.
    const warga = await createCustomer({ identityCategory: 'warga_kampus', identityStatus: 'verified' })
    const wargaMembership = await createMembership({ userId: warga.id, membershipPlanId: planId, startDate: '2026-10-05' })
    expect(await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: wargaMembership.id } })).toMatchObject({
      amount: 150_000,
      priceCategory: 'warga_ub'
    })

    // createdAt transaksi = jam dinding sungguhan (default DB), bukan jam beku test.
    const transactionOf = (membershipId: string) => prismaClient.transaction.findUniqueOrThrow({ where: { membershipId } })
    const t2 = await transactionOf(second.id)
    day = jakartaDate(t2.createdAt)

    // Walk-in tanpa paket memakai item membership umum.
    const invoices = await accurateInvoiceExport({ from: day })
    expect(invoices.filename).toBe(`accurate-faktur-${day}.xlsx`)
    const sheet = readSheet(invoices.buffer)
    expect([sheet.A1, sheet.B1, sheet.C1, sheet.D1, sheet.AU1, sheet.AY1]).toEqual([
      'CUSTOMER NO',
      'NUMBER',
      'BRANCH',
      'DATE',
      'ITEM:ITEM NO',
      'ITEM:WAREHOUSE NAME '
    ])

    const [y, m, d] = day.split('-').map(Number)
    const totalOf = async (membershipId: string) => {
      const t = await transactionOf(membershipId)
      return String(t.amount + t.adminFee + (t.uniqueCode ?? 0))
    }
    // Satu baris per faktur seharga total transfer (harga + admin + kode unik), tanpa baris terpisah.
    expect(sheet).toMatchObject({
      A2: 'WEB.0002',
      B2: `UBSC-${String(t2.receiptSequence).padStart(6, '0')}`,
      C2: ACCURATE_BRANCH,
      D2: String((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000), // nomor seri tanggal Excel
      AU2: 'GYM-1B',
      AV2: '1',
      AW2: await totalOf(second.id)
    })
    expect(sheet.BC2).toContain(`kode unik Rp ${t2.uniqueCode}`)
    expect(sheet.L2).toContain('(belum lunas)')
    expect(sheet).toMatchObject({ A3: 'WEB.0001', AW3: await totalOf(first.id) })
    // Walk-in tanpa paket: pelanggan umum + item membership umum.
    expect(sheet).toMatchObject({ A4: 'WEB.0000', AU4: 'UBSC-MEMBERSHIP', AW4: await totalOf(walkIn.id) })
    expect(sheet.L4).toContain('Pak Andi')
    expect(sheet).toMatchObject({ A5: 'WEB.0003', AU5: 'GYM-1B-W', AW5: await totalOf(wargaMembership.id) })
    expect(sheet.A6).toBeUndefined()
    expect(sheet.AU6).toBeUndefined()

    const customers = readSheet((await accurateCustomerExport({ from: day, to: day })).buffer)
    expect([customers.A1, customers.B1, customers.C1, customers.CL1]).toEqual(['Kategori', 'ID Pelanggan', 'Nama', 'Gudang Default'])
    expect(customers).toMatchObject({ B2: 'WEB.0002', H2: late.email, B3: 'WEB.0001', H3: early.email, B4: 'WEB.0000', J4: 'IDR' })
    expect(customers.CI3).toBe(`No. member ${customerNumber(early.customerSequence)}`)
    expect(customers.B5).toBe('WEB.0003')
    expect(customers.B6).toBeUndefined()

    // Stabil: export ulang tidak menerbitkan nomor baru.
    expect((await prismaClient.user.findUniqueOrThrow({ where: { id: early.id } })).accurateSequence).toBe(1)
    await accurateInvoiceExport({ from: day })
    expect(await prismaClient.user.count({ where: { accurateSequence: { not: null } } })).toBe(3)
  })

  it('nomor item Accurate yang belum diisi menghentikan export dengan daftar yang harus dilengkapi', async () => {
    const plan = await prismaClient.membershipPlan.create({ data: { name: 'Paket Tanpa Item', price: 100_000, durationMonths: 1 } })
    await createMembership({ userId: (await createCustomer()).id, membershipPlanId: plan.id, startDate: '2026-10-05' })
    await expect(accurateInvoiceExport({ from: day })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Paket membership Paket Tanpa Item')
    })
    await expect(accurateInvoiceExport({ from: day, to: addDays(day, 31) })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ['to'], message: 'Rentang export maksimal 31 hari.' })]
    })
  })
})

describe('lewat HTTP', () => {
  it('Finance mengunduh .xlsx; invoice hanya untuk pemilik (pelanggan) dan staff yang berwenang', async () => {
    const finance = bearer(await createStaff('Finance'), 'staff')
    const file = await request(web)
      .get('/api/admin/finance/accurate/pelanggan')
      .query({ from: day, to: day })
      .set('Authorization', finance)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => done(null, Buffer.concat(chunks)))
      })
      .expect(200)
    expect(file.headers['content-type']).toContain('spreadsheetml.sheet')
    expect(file.headers['content-disposition']).toBe(`attachment; filename="accurate-pelanggan-${day}.xlsx"`)
    expect(readSheet(file.body as Buffer).B1).toBe('ID Pelanggan')
    await request(web)
      .get('/api/admin/finance/accurate/faktur')
      .set('Authorization', bearer(await createStaff('Staff Central'), 'staff'))
      .expect(403)

    const owner = await createCustomer()
    const membership = await createMembership({ userId: owner.id, membershipPlanId: planId, startDate: '2026-10-05' })
    const { id } = await prismaClient.transaction.findUniqueOrThrow({ where: { membershipId: membership.id } })
    const mine = await request(web).get(`/api/customer/transactions/${id}/invoice`).set('Authorization', bearer(owner, 'customer')).expect(200)
    expect(mine.body.data.html).toContain('Membership Gym Accurate')
    await request(web)
      .get(`/api/customer/transactions/${id}/invoice`)
      .set('Authorization', bearer(await createCustomer(), 'customer'))
      .expect(404)
    await request(web).get(`/api/admin/payments/${id}/invoice`).set('Authorization', finance).expect(200)
  })
})

describe('kirim ulang verifikasi email', () => {
  it('jeda 60 detik dan batas harian per akun; akun terverifikasi tidak dikirimi', async () => {
    const user = await createCustomer({ verified: false })
    const first = await issueVerification(user.id)
    expect(first).toEqual({ sent: true, retryAfterSeconds: 60, alreadyVerified: false })
    const blocked = await issueVerification(user.id)
    expect(blocked.sent).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)

    // Geser jejak kiriman ke belakang supaya jeda sudah lewat, lalu habiskan kuota harian.
    const age = async () =>
      prismaClient.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 61_000) } })
    for (let i = 1; i < MAIL_RESEND_MAX_PER_DAY; i++) {
      await age()
      expect((await issueVerification(user.id)).sent).toBe(true)
    }
    await age()
    const capped = await issueVerification(user.id)
    expect(capped.sent).toBe(false)
    expect(capped.retryAfterSeconds).toBeGreaterThan(3600)

    const verified = await createCustomer()
    expect(await issueVerification(verified.id)).toEqual({ sent: false, retryAfterSeconds: 0, alreadyVerified: true })
  })

  it('akun buatan FO yang masuk lewat Lupa password otomatis terverifikasi', async () => {
    const account = await createCustomerAccount({ name: 'Tamu Reset', email: 'tamu.reset@test.ubsc.id', phoneNumber: null })
    const token = createRefreshToken()
    await prismaClient.passwordResetToken.create({
      data: { userId: account.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) }
    })
    await resetPasswordAuth({ token, password: 'rahasia-baru-123', passwordConfirmation: 'rahasia-baru-123' })
    expect((await prismaClient.user.findUniqueOrThrow({ where: { id: account.id } })).emailVerifiedAt).not.toBeNull()
  })
})

describe('tautan verifikasi + lupa password', () => {
  const tokenFor = async (userId: string, usedAt: Date | null = null) => {
    const token = createRefreshToken()
    await prismaClient.emailVerificationToken.create({
      data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000), usedAt }
    })
    return token
  }

  it('tautan terbaru memverifikasi; tautan lama/terpakai tetap sukses setelah terverifikasi, dan ditolak jelas sebelumnya', async () => {
    const user = await createCustomer({ verified: false })
    const revoked = await tokenFor(user.id, new Date())
    await expect(verifyEmailAuth({ token: revoked })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('email terbaru') })

    const latest = await tokenFor(user.id)
    expect(await verifyEmailAuth({ token: latest })).toEqual({ verified: true, email: user.email })
    // Diklik lagi, atau tautan dari email lama: sudah terverifikasi = sukses, bukan error.
    expect(await verifyEmailAuth({ token: latest })).toEqual({ verified: true, email: user.email })
    expect(await verifyEmailAuth({ token: revoked })).toEqual({ verified: true, email: user.email })
  })

  it('lupa password dibatasi jeda per akun, balasannya tetap generik', async () => {
    const user = await createCustomer()
    const first = await forgotPasswordAuth({ email: user.email })
    const second = await forgotPasswordAuth({ email: user.email })
    expect(second).toEqual(first)
    expect(await prismaClient.passwordResetToken.count({ where: { userId: user.id } })).toBe(1)
    expect(await forgotPasswordAuth({ email: 'tidak-terdaftar@test.ubsc.id' })).toEqual(first)
  })
})
