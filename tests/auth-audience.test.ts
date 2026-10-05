import request from 'supertest'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { createRefreshToken, hashToken } from '../src/utils/token'
import { bearer, closeDatabase, createCustomer, createStaff, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === Isolasi dua audience auth (R4) ===
// ============================================================================
// Token customer ditandatangani secret customer dengan aud=customer; token staff sebaliknya. Masing-
// masing HARUS ditolak di router audience lain, apa pun isi payload-nya.

beforeAll(resetDatabase)
afterAll(closeDatabase)

describe('token lintas audience', () => {
  it('token customer diterima /api/customer dan ditolak /api/admin', async () => {
    const customer = await createCustomer()
    const token = bearer(customer, 'customer')

    await request(web).get('/api/customer/me').set('Authorization', token).expect(200)
    const denied = await request(web).get('/api/admin/me').set('Authorization', token).expect(401)
    expect(denied.body).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } })
  })

  it('token staff diterima /api/admin dan ditolak /api/customer', async () => {
    const staff = await createStaff('Manager')
    const token = bearer(staff, 'staff')

    await request(web).get('/api/admin/me').set('Authorization', token).expect(200)
    await request(web).get('/api/customer/me').set('Authorization', token).expect(401)
  })

  it('akun customer tanpa role tidak bisa memakai panel staff walau tokennya diterbitkan untuk audience staff', async () => {
    const customer = await createCustomer()
    const res = await request(web).get('/api/admin/me').set('Authorization', bearer(customer, 'staff')).expect(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('endpoint publik dengan auth opsional: tanpa header lolos, header rusak 401 (bukan diam-diam anonim)', async () => {
    await request(web).get('/api/public/booking/slots').query({ facilityId: 'x', date: '2026-10-06' }).expect(422)
    await request(web)
      .get('/api/public/booking/slots')
      .set('Authorization', 'Bearer rusak')
      .query({ facilityId: 'x', date: '2026-10-06' })
      .expect(401)
    const staff = await createStaff('Finance')
    await request(web)
      .get('/api/public/booking/slots')
      .set('Authorization', bearer(staff, 'staff'))
      .query({ facilityId: 'x', date: '2026-10-06' })
      .expect(401)
  })
})

// ============================================================================
// === Rotasi refresh token: balapan antar tab vs pencurian ===
// ============================================================================
// Halaman landing dimuat ulang penuh tiap pindah halaman, jadi dua tab yang dibuka bersamaan
// mengirim refresh token yang SAMA. Yang kalah tidak boleh mencabut semua sesi (catatan client
// 2026-10-05: pelanggan "keluar sendiri"); token lama yang dipakai lagi setelah jendela toleransi
// tetap dianggap pencurian.

describe('refresh token', () => {
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
  const refresh = (token: string) => request(web).post('/api/auth/customer/refresh').set('Cookie', `ubsc_c_refresh=${token}`)

  it('dua refresh berurutan dengan token yang sama (dua tab) sama-sama berhasil, sesi tetap ada', async () => {
    const customer = await createCustomer()
    const token = await sessionFor(customer.id)

    const first = await refresh(token).expect(200)
    expect(String(first.headers['set-cookie'])).toContain('ubsc_c_refresh=')

    const second = await refresh(token).expect(200)
    expect(second.body.data.accessToken).toEqual(expect.any(String))
    // Tidak merotasi lagi dan tidak menimpa cookie pengganti yang sudah dipegang browser.
    expect(String(second.headers['set-cookie'] ?? '')).not.toContain('ubsc_c_refresh=')
    expect(await prismaClient.refreshToken.count({ where: { userId: customer.id, revoked: false } })).toBe(1)
  })

  it('token lama dipakai lagi setelah jendela toleransi = pencurian: semua sesi dicabut', async () => {
    const customer = await createCustomer()
    const token = await sessionFor(customer.id)
    await refresh(token).expect(200)
    await prismaClient.refreshToken.updateMany({ where: { userId: customer.id, revoked: false }, data: { createdAt: new Date(Date.now() - 60_000) } })

    await refresh(token).expect(401)
    expect(await prismaClient.refreshToken.count({ where: { userId: customer.id } })).toBe(0)
  })
})
