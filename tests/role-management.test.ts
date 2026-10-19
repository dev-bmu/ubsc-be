import request from 'supertest'
import { ALL_PERMISSIONS, PERMISSIONS } from '../shared/permissions'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { bearer, closeDatabase, createStaff, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === Kelola role dari panel (2026-10-20) + permission payments.settings.manage ===
// ============================================================================

const roles = '/api/admin/settings/roles'
let admin: string
let manager: string

beforeAll(async () => {
  await resetDatabase()
  // Katalog permission (resetDatabase mengosongkan semua tabel); seeder tidak dipakai supaya tidak membaca .env dev.
  await prismaClient.permission.createMany({ data: ALL_PERMISSIONS.map(({ code, name, description }) => ({ code, name, description })) })
  admin = bearer(await createStaff('Administrator'), 'staff')
  manager = bearer(await createStaff('Manager'), 'staff')
})

afterAll(async () => {
  await closeDatabase()
})

describe('role baru', () => {
  it('hanya Administrator; nama unik (tanpa beda huruf besar-kecil) dan bukan nama sistem', async () => {
    const body = { name: '  Staff   Gudang ', permissions: [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_READ] }

    // Manager memegang rbac.manage tapi bukan Administrator.
    await request(web).post(roles).set('Authorization', manager).send(body).expect(403)

    const created = await request(web).post(roles).set('Authorization', admin).send(body).expect(201)
    expect(created.body.data).toMatchObject({ name: 'Staff Gudang', permissions: [PERMISSIONS.BOOKINGS_READ], usersCount: 0 })

    const dup = await request(web)
      .post(roles)
      .set('Authorization', admin)
      .send({ ...body, name: 'staff gudang' })
      .expect(422)
    expect(dup.body.error.fields.name).toEqual(['Nama role sudah dipakai.'])

    for (const name of ['administrator', 'Customer']) {
      await request(web)
        .post(roles)
        .set('Authorization', admin)
        .send({ ...body, name })
        .expect(400)
    }
    await request(web).post(roles).set('Authorization', admin).send({ name: 'Kosong', permissions: [] }).expect(400)
    const unknown = await request(web)
      .post(roles)
      .set('Authorization', admin)
      .send({ name: 'Aneh', permissions: ['tidak.ada'] })
      .expect(422)
    expect(unknown.body.error.fields['permissions.0']).toBeDefined()

    const list = await request(web).get(roles).set('Authorization', admin).expect(200)
    expect(list.body.data.roles.map((role: { name: string }) => role.name)).toContain('Staff Gudang')
  })

  it('bisa diberikan ke akun staf, dan hak aksesnya ditegakkan per request', async () => {
    await request(web)
      .post(roles)
      .set('Authorization', admin)
      .send({ name: 'Kasir', permissions: [PERMISSIONS.BOOKINGS_READ] })
      .expect(201)

    const users = await request(web).get('/api/admin/settings/users').set('Authorization', admin).expect(200)
    expect(users.body.data.roles).toContain('Kasir')
    expect(users.body.data.roles).not.toContain('Administrator')

    const created = await request(web)
      .post('/api/admin/settings/users')
      .set('Authorization', admin)
      .send({ name: 'Kasir Satu', email: 'kasir1@test.ubsc.id', password: 'rahasia123', role: 'Kasir' })
      .expect(201)
    expect(created.body.data.role).toBe('Kasir')

    // Administrator tidak bisa diberikan dari halaman staf.
    await request(web)
      .post('/api/admin/settings/users')
      .set('Authorization', admin)
      .send({ name: 'X', email: 'x-admin@test.ubsc.id', password: 'rahasia123', role: 'Administrator' })
      .expect(422)

    const kasir = await prismaClient.user.findUniqueOrThrow({ where: { email: 'kasir1@test.ubsc.id' }, include: { role: true } })
    const token = bearer(kasir, 'staff')
    await request(web).get('/api/admin/bookings').set('Authorization', token).expect(200)
    await request(web).get('/api/admin/finance').set('Authorization', token).expect(403)

    // Akun ber-role baru tetap staf (bukan pelanggan) di daftar Pengguna Internal.
    const after = await request(web).get('/api/admin/settings/users').set('Authorization', admin).expect(200)
    expect(after.body.data.users.map((user: { email: string }) => user.email)).toContain('kasir1@test.ubsc.id')
  })
})

describe('ganti nama role', () => {
  it('memindahkan hak akses, akun tetap di role-nya, Administrator terkunci', async () => {
    await request(web)
      .post(roles)
      .set('Authorization', admin)
      .send({ name: 'Petugas Lama', permissions: [PERMISSIONS.MEMBERS_READ] })
      .expect(201)
    const staff = await createStaff('Petugas Lama')

    const renamed = await request(web)
      .patch(`${roles}/${encodeURIComponent('Petugas Lama')}`)
      .set('Authorization', admin)
      .send({ name: 'Petugas Baru' })
      .expect(200)
    expect(renamed.body.data).toMatchObject({ name: 'Petugas Baru', permissions: [PERMISSIONS.MEMBERS_READ], usersCount: 1 })
    expect(await prismaClient.rolePermission.count({ where: { roleName: 'Petugas Lama' } })).toBe(0)

    const moved = await prismaClient.user.findUniqueOrThrow({ where: { id: staff.id }, include: { role: true } })
    expect(moved.role?.name).toBe('Petugas Baru')

    await request(web).patch(`${roles}/Kasir`).set('Authorization', admin).send({ name: 'Petugas Baru' }).expect(422)
    await request(web).patch(`${roles}/Administrator`).set('Authorization', admin).send({ name: 'Bos' }).expect(403)
    await request(web).patch(`${roles}/Kasir`).set('Authorization', manager).send({ name: 'Kasir 2' }).expect(403)
    await request(web).patch(`${roles}/Tidak%20Ada`).set('Authorization', admin).send({ name: 'Apa Saja' }).expect(404)
  })

  it('role bawaan tanpa baris role_permissions membawa hak akses default-nya ke nama baru', async () => {
    const finance = await createStaff('Finance')
    expect(await prismaClient.rolePermission.count({ where: { roleName: 'Finance' } })).toBe(0)

    const renamed = await request(web).patch(`${roles}/Finance`).set('Authorization', admin).send({ name: 'Keuangan' }).expect(200)
    expect(renamed.body.data.permissions).toEqual(expect.arrayContaining([PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYMENTS_MANAGE]))

    const token = bearer(await prismaClient.user.findUniqueOrThrow({ where: { id: finance.id }, include: { role: true } }), 'staff')
    await request(web).get('/api/admin/finance').set('Authorization', token).expect(200)
  })
})

describe('hapus role', () => {
  it('hanya role tanpa akun; Administrator terkunci', async () => {
    await request(web)
      .post(roles)
      .set('Authorization', admin)
      .send({ name: 'Sementara', permissions: [PERMISSIONS.STATS_READ] })
      .expect(201)
    await request(web).delete(`${roles}/Sementara`).set('Authorization', manager).expect(403)
    expect((await request(web).delete(`${roles}/Sementara`).set('Authorization', admin).expect(200)).body.data).toEqual({ name: 'Sementara' })
    expect(await prismaClient.role.count({ where: { name: 'Sementara' } })).toBe(0)
    expect(await prismaClient.rolePermission.count({ where: { roleName: 'Sementara' } })).toBe(0)

    const used = await request(web).delete(`${roles}/Kasir`).set('Authorization', admin).expect(422)
    expect(used.body.error.message).toContain('masih dipakai 1 akun staf')
    await request(web).delete(`${roles}/Administrator`).set('Authorization', admin).expect(403)
  })
})

describe('payments.settings.manage', () => {
  const settings = { bankName: '', accountNumber: '', accountHolder: '', qrisMerchantName: '', holdMinutes: 15, uniqueCodeMax: 999 }

  it('pengaturan pembayaran default hanya Administrator; bisa diberikan ke role lain', async () => {
    const financeLike = bearer(await createStaff('Staff Bayar'), 'staff')
    await prismaClient.rolePermission.createMany({
      data: (await prismaClient.permission.findMany({ where: { code: PERMISSIONS.PAYMENTS_MANAGE } })).map((p) => ({
        roleName: 'Staff Bayar',
        permissionId: p.id
      }))
    })

    // Verifikasi tetap boleh; pengaturan tidak.
    await request(web).get('/api/admin/payments').set('Authorization', financeLike).expect(200)
    await request(web).post('/api/admin/payments/settings').set('Authorization', financeLike).send(settings).expect(403)
    await request(web).delete('/api/admin/payments/settings/qris').set('Authorization', financeLike).expect(403)
    // Manager default: semua kecuali pengaturan pembayaran.
    await request(web).post('/api/admin/payments/settings').set('Authorization', manager).send(settings).expect(403)

    expect(
      (await request(web).post('/api/admin/payments/settings').set('Authorization', admin).send(settings).expect(200)).body.data.holdMinutes
    ).toBe(15)

    await request(web)
      .post(roles)
      .set('Authorization', admin)
      .send({ name: 'Supervisor Bayar', permissions: [PERMISSIONS.PAYMENTS_MANAGE, PERMISSIONS.PAYMENTS_SETTINGS_MANAGE] })
      .expect(201)
    const supervisor = bearer(await createStaff('Supervisor Bayar'), 'staff')
    await request(web).post('/api/admin/payments/settings').set('Authorization', supervisor).send(settings).expect(200)
  })
})
