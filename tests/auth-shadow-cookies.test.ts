import bcrypt from 'bcryptjs'
import request, { Response } from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { MAX_SESSIONS } from '../src/config'
import { createRefreshToken, hashToken } from '../src/utils/token'
import { closeDatabase, createCustomer, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === Cookie bayangan ber-Domain + balasan rotasi yang hilang ===
// ============================================================================
// Produksi pernah berjalan dengan COOKIE_DOMAIN=.<apex>. Browser lama masih membawa cookie ber-Domain
// itu, bernama dan ber-Path sama dengan cookie host-only baru, dan mengirimnya LEBIH DULU. Selain itu
// landing merefresh di tiap muat penuh; navigasi bisa membatalkan fetch-nya setelah server merotasi.

// LANDING_URL ber-host bertitik supaya domain bayangan aktif (di .env.local nilainya localhost).
jest.mock('../src/config', () => ({ ...jest.requireActual('../src/config'), LANDING_URL: 'https://landing.test' }))

beforeAll(resetDatabase)
afterAll(closeDatabase)

const SHADOW = 'Domain=landing.test'

async function sessionFor(userId: string): Promise<string> {
  const plain = createRefreshToken()
  await prismaClient.refreshToken.create({
    data: {
      userId,
      audience: 'customer',
      tokenHash: hashToken(plain),
      familyId: `fam-${plain.slice(0, 8)}`,
      expiresAt: new Date(Date.now() + 3_600_000)
    }
  })
  return plain
}

const refresh = (...tokens: string[]) =>
  request(web)
    .post('/api/auth/customer/refresh')
    .set('Cookie', tokens.map((token) => `ubsc_c_refresh=${token}`).join('; '))

const setCookies = (res: Response): string[] => {
  const header = res.headers['set-cookie'] as unknown as string[] | string | undefined
  return header === undefined ? [] : ([] as string[]).concat(header)
}

/** Token refresh segar (host-only, tidak kosong) yang dipasang balasan ini. */
const issued = (res: Response): string | undefined =>
  setCookies(res)
    .map((cookie) => /^ubsc_c_refresh=([^;]+);/.exec(cookie))
    .find((match) => match !== null)?.[1]

const live = (userId: string) => prismaClient.refreshToken.count({ where: { userId, revoked: false } })
const row = (token: string) => prismaClient.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } })

/** Mundurkan waktu pencabutan token (createdAt penggantinya) melewati jendela toleransi 30 detik. */
async function ageRevocation(token: string) {
  const { replacedBy } = await row(token)
  await prismaClient.refreshToken.update({ where: { id: replacedBy! }, data: { createdAt: new Date(Date.now() - 60_000) } })
}

describe('cookie bayangan ber-Domain', () => {
  it('login menghapus ketiga cookie di domain induk SEBELUM memasang cookie host-only segar', async () => {
    const customer = await createCustomer()
    await prismaClient.user.update({ where: { id: customer.id }, data: { password: bcrypt.hashSync('rahasia123', 4) } })

    const res = await request(web).post('/api/auth/customer/login').send({ email: customer.email, password: 'rahasia123' }).expect(200)
    const cookies = setCookies(res)

    const clears = cookies.filter((cookie) => cookie.includes(SHADOW))
    expect(clears).toHaveLength(3)
    expect(clears).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ubsc_c_refresh=; Domain=landing\.test; Path=\/api\/auth; Expires=Thu, 01 Jan 1970/),
        expect.stringMatching(/^ubsc_c_role=; Domain=landing\.test; Path=\/; Expires=Thu, 01 Jan 1970/),
        expect.stringMatching(/^ubsc_c_permissions=; Domain=landing\.test; Path=\/; Expires=Thu, 01 Jan 1970/)
      ])
    )

    const fresh = cookies.findIndex((cookie) => /^ubsc_c_refresh=[0-9a-f]+;/.test(cookie))
    expect(cookies[fresh]).not.toContain('Domain=')
    expect(cookies[fresh]).toContain('Path=/api/auth')
    expect(fresh).toBeGreaterThan(Math.max(...clears.map((clear) => cookies.indexOf(clear))))
  })

  it('nilai tak dikenal + nilai hidup: nilai hidup dirotasi', async () => {
    const customer = await createCustomer()
    const valid = await sessionFor(customer.id)

    const res = await refresh(createRefreshToken(), valid).expect(200)
    expect(issued(res)).toEqual(expect.any(String))
    expect((await row(valid)).revoked).toBe(true)
    expect(setCookies(res).filter((cookie) => cookie.includes(SHADOW))).toHaveLength(3)
  })

  it('bayangan revoked lama + nilai hidup: 200, TIDAK ada reuse wipe', async () => {
    const customer = await createCustomer()
    const stale = await sessionFor(customer.id)
    await refresh(stale).expect(200)
    await ageRevocation(stale)
    const valid = await sessionFor(customer.id)

    const res = await refresh(stale, valid).expect(200)
    expect(issued(res)).toEqual(expect.any(String))
    // Dua family tetap hidup: pengganti `stale` (tak tersentuh) dan pengganti `valid`.
    expect(await live(customer.id)).toBe(2)
  })

  it('tanpa cookie refresh: 401 dan cookie penanda yatim ikut dihapus', async () => {
    const res = await request(web).post('/api/auth/customer/refresh').set('Cookie', 'ubsc_c_role=Customer').expect(401)
    const cookies = setCookies(res)
    expect(cookies).toEqual(expect.arrayContaining([expect.stringMatching(/^ubsc_c_role=; Path=\/; Expires=Thu, 01 Jan 1970/)]))
    expect(cookies.filter((cookie) => cookie.includes(SHADOW))).toHaveLength(3)
  })

  it('logout menghapus family semua nilai yang dikirim', async () => {
    const customer = await createCustomer()
    const a = await sessionFor(customer.id)
    const b = await sessionFor(customer.id)

    await request(web).post('/api/auth/customer/logout').set('Cookie', `ubsc_c_refresh=${a}; ubsc_c_refresh=${b}`).expect(200)
    expect(await prismaClient.refreshToken.count({ where: { userId: customer.id } })).toBe(0)
  })
})

describe('balasan rotasi yang hilang', () => {
  it('token lama di dalam jendela toleransi mencetak token saudara dan memasang cookie baru', async () => {
    const customer = await createCustomer()
    const r1 = await sessionFor(customer.id)
    await refresh(r1).expect(200) // balasan ini "hilang": browser tetap memegang r1

    const healed = await refresh(r1).expect(200)
    const r3 = issued(healed)
    expect(r3).toEqual(expect.any(String))
    expect(r3).not.toBe(r1)
    expect(await live(customer.id)).toBe(2) // r2 (balasan hilang) + r3 saudaranya, satu family

    await refresh(r3!).expect(200)
    expect(await live(customer.id)).toBe(2)

    // r1 dipakai lagi setelah jendela toleransi = pencurian.
    await ageRevocation(r1)
    await refresh(r1).expect(401)
    expect(await prismaClient.refreshToken.count({ where: { userId: customer.id } })).toBe(0)
  })

  it('dua refresh paralel dengan token yang sama — hidup maupun baru dirotasi — sama-sama 200', async () => {
    const customer = await createCustomer()
    const token = await sessionFor(customer.id)

    const [a, b] = await Promise.all([refresh(token), refresh(token)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(await live(customer.id)).toBeGreaterThanOrEqual(1)

    const [c, d] = await Promise.all([refresh(token), refresh(token)])
    expect([c.status, d.status]).toEqual([200, 200])
    expect(issued(c)).toEqual(expect.any(String))
    expect(issued(d)).toEqual(expect.any(String))
    expect(await live(customer.id)).toBeGreaterThanOrEqual(1)
  })

  it('jalur toleransi tidak mencabut token yang sudah dipasang tab lain, walau balasan toleransinya hilang', async () => {
    const customer = await createCustomer()
    const r0 = await sessionFor(customer.id)
    const r1 = issued(await refresh(r0).expect(200))! // tab 1: balasan sampai
    await refresh(r0).expect(200) // tab 2: balasan hilang, browser tetap memegang r1
    expect((await row(r1)).revoked).toBe(false)

    await prismaClient.refreshToken.updateMany({ where: { userId: customer.id }, data: { createdAt: new Date(Date.now() - 60_000) } })
    await refresh(r1).expect(200)
  })

  it('belasan refresh dengan token baru-dirotasi yang sama di dalam jendela: semua 200, tanpa wipe', async () => {
    const customer = await createCustomer()
    const r1 = await sessionFor(customer.id)
    const statuses: number[] = []
    for (let i = 0; i < 14; i++) statuses.push((await refresh(r1)).status)
    expect(statuses).toEqual(Array(14).fill(200))
    expect(await live(customer.id)).toBeGreaterThanOrEqual(1)
  })
})

describe('batas MAX_SESSIONS per family', () => {
  it('fork paralel di satu family tidak menendang sesi device lain saat login', async () => {
    const customer = await createCustomer()
    await prismaClient.user.update({ where: { id: customer.id }, data: { password: bcrypt.hashSync('rahasia123', 4) } })
    const phone = await sessionFor(customer.id)
    await prismaClient.refreshToken.update({ where: { tokenHash: hashToken(phone) }, data: { createdAt: new Date(Date.now() - 60_000) } })
    const { familyId } = await row(await sessionFor(customer.id))
    for (let i = 1; i < MAX_SESSIONS; i++) {
      await prismaClient.refreshToken.create({
        data: {
          userId: customer.id,
          audience: 'customer',
          tokenHash: hashToken(createRefreshToken()),
          familyId,
          expiresAt: new Date(Date.now() + 3_600_000)
        }
      })
    }

    await request(web).post('/api/auth/customer/login').send({ email: customer.email, password: 'rahasia123' }).expect(200)
    expect((await row(phone)).revoked).toBe(false)
  })
})
