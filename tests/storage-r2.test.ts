import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ===== Driver R2 utils/storage.ts — tanpa jaringan =====
// fetch dipalsukan, jadi yang diuji adalah bentuk request S3 yang dikirim (bucket, key, prefiks
// 'uploads/', header tanda tangan, Cache-Control) dan pemetaan URL publik. Driver lokal sudah
// teruji lewat seluruh test lain (STORAGE_DRIVER default 'local').

type Storage = typeof import('../src/utils/storage')

const R2_ENV = {
  STORAGE_DRIVER: 'r2',
  R2_ACCOUNT_ID: 'acc123',
  R2_ACCESS_KEY_ID: 'AKIDTEST',
  R2_SECRET_ACCESS_KEY: 'rahasia-test',
  R2_PUBLIC_BUCKET: 'ubsc',
  R2_PRIVATE_BUCKET: 'ubsc-private',
  R2_PUBLIC_URL: 'https://cdn.example.test'
}

describe('storage driver r2', () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  const requests: Request[] = []
  let storage: Storage

  beforeAll(() => {
    Object.assign(process.env, R2_ENV)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- modul harus dimuat ulang setelah env r2 dipasang
      storage = require('../src/utils/storage') as Storage
    })
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const request = input as Request
      requests.push(request)
      if (request.method === 'GET') return request.url.endsWith('/hilang.pdf') ? new Response(null, { status: 404 }) : new Response('isi berkas')
      return new Response(null, { status: request.method === 'DELETE' ? 204 : 200 })
    }) as typeof fetch
  })

  afterAll(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  beforeEach(() => {
    requests.length = 0
  })

  it('PUT publik ke bucket publik dengan prefiks uploads/, bertanda tangan SigV4, cache setahun', async () => {
    await storage.putObject('public', 'media/u1/foto lapangan.webp', Buffer.from('abc'), 'image/webp')

    const [request] = requests
    expect(request.method).toBe('PUT')
    expect(request.url).toBe('https://acc123.r2.cloudflarestorage.com/ubsc/uploads/media/u1/foto%20lapangan.webp')
    expect(request.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request/)
    expect(request.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD')
    expect(request.headers.get('content-type')).toBe('image/webp')
    expect(request.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(Buffer.from(await request.arrayBuffer()).toString()).toBe('abc')
  })

  it('PUT privat ke bucket privat, tanpa prefiks dan tanpa header cache', async () => {
    await storage.putObject('private', 'payment-proofs/t1/bukti.webp', Buffer.from('x'), 'image/webp')

    expect(requests[0].url).toBe('https://acc123.r2.cloudflarestorage.com/ubsc-private/payment-proofs/t1/bukti.webp')
    expect(requests[0].headers.get('cache-control')).toBeNull()
  })

  it('putFile mengirim isi berkas dari disk', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ubsc-r2-')), 'video.mp4')
    writeFileSync(path, 'isi video')

    await storage.putFile('public', 'media/u2/video.mp4', path, 'video/mp4')

    expect(requests[0].url).toBe('https://acc123.r2.cloudflarestorage.com/ubsc/uploads/media/u2/video.mp4')
    expect(Buffer.from(await requests[0].arrayBuffer()).toString()).toBe('isi video')
  })

  it('readObject: isi berkas, atau null bila 404', async () => {
    expect((await storage.readObject('private', 'identity/u1/ktm.pdf'))?.toString()).toBe('isi berkas')
    expect(await storage.readObject('private', 'identity/u1/hilang.pdf')).toBeNull()
  })

  it('menolak key traversal sebelum mengirim apa pun', async () => {
    await expect(storage.putObject('private', '../.env', Buffer.from('x'), 'text/plain')).rejects.toMatchObject({ status: 400 })
    await expect(storage.readObject('private', 'identity/../../x')).rejects.toMatchObject({ status: 400 })
    expect(requests).toHaveLength(0)
  })

  it('deleteObjects mengirim DELETE di latar dan tidak pernah melempar', async () => {
    storage.deleteObjects('public', ['qris/a.png', '../jahat'])
    // Penandatanganan SigV4 memakai crypto.subtle (async) — tunggu sampai request benar-benar terkirim.
    for (let i = 0; i < 100 && requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['DELETE https://acc123.r2.cloudflarestorage.com/ubsc/uploads/qris/a.png'])
  })

  it('publicUrl ke custom domain; ownedPublicKey mengenali bentuk baru dan lama, menolak yang asing', () => {
    expect(storage.publicUrl('avatars/a.webp')).toBe('https://cdn.example.test/uploads/avatars/a.webp')

    expect(storage.ownedPublicKey('https://cdn.example.test/uploads/avatars/a.webp', 'avatars')).toBe('avatars/a.webp')
    expect(storage.ownedPublicKey('/uploads/avatars/a.webp', 'avatars')).toBe('avatars/a.webp')
    expect(storage.ownedPublicKey('https://lh3.googleusercontent.com/a/xyz', 'avatars')).toBeNull()
    expect(storage.ownedPublicKey('/uploads/avatars/../media/x.webp', 'avatars')).toBeNull()
    expect(storage.ownedPublicKey('/uploads/qris/a.png', 'avatars')).toBeNull()
  })
})
