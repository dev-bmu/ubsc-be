import request from 'supertest'
import { web } from '../src/application/web'
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
