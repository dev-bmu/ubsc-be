import { existsSync } from 'fs'
import { resolve } from 'path'
import sharp from 'sharp'
import request from 'supertest'
import { SEO_PAGES } from '../shared/seo'
import { prismaClient } from '../src/application/database'
import { web } from '../src/application/web'
import { htmlToText, sanitizeArticleHtml } from '../src/utils/sanitize-html'
import { bearer, closeDatabase, createStaff, resetDatabase } from './helpers/fixtures'

// ============================================================================
// === Halaman artikel + SEO (PRD tambahan §7.7) ===
// ============================================================================
// Sanitasi isi editor, detail publik /news/:slug dengan fallback SEO, field SEO di admin berita,
// unggah gambar isi, dan SEO halaman statis (admin + publik).

let admin: string
let authorId: string
let artikelCategoryId: string
let beritaCategoryId: string

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 400, channels: 3, background: '#0f766e' } })
    .png()
    .toBuffer()
}

const LONG_TEXT = 'Latihan rutin di UB Sport Center membantu menjaga kebugaran mahasiswa dan warga Malang. '.repeat(6)

async function insertNews(data: { slug: string; status?: 'draft' | 'published'; content?: string; categoryId?: string | null; publishedAt?: Date }) {
  return prismaClient.news.create({
    data: {
      authorId,
      newsCategoryId: data.categoryId ?? null,
      title: `Judul ${data.slug}`,
      slug: data.slug,
      content: data.content ?? `<p>${LONG_TEXT}</p>`,
      status: data.status ?? 'published',
      publishedAt: data.publishedAt ?? new Date('2026-10-01T03:00:00Z')
    }
  })
}

beforeAll(async () => {
  await resetDatabase()
  const staff = await createStaff('Administrator')
  admin = bearer(staff, 'staff')
  authorId = staff.id
  artikelCategoryId = (await prismaClient.newsCategory.create({ data: { name: 'Artikel', slug: 'artikel' } })).id
  beritaCategoryId = (await prismaClient.newsCategory.create({ data: { name: 'Berita', slug: 'berita' } })).id
})

afterAll(closeDatabase)

describe('sanitizeArticleHtml', () => {
  it('membuang script, handler on*, link javascript:, gambar data:; mempertahankan text-align', () => {
    const html = sanitizeArticleHtml(
      '<h1 style="text-align: center; color: red">Judul</h1>' +
        '<p onclick="alert(1)" style="text-align: justify">Halo <script>alert(1)</script><b>dunia</b></p>' +
        '<a href="javascript:alert(1)">x</a><a href="https://ub.ac.id" target="_blank">y</a><a href="/z" target="_self">z</a>' +
        '<img src="data:image/png;base64,AAAA"><img src="/uploads/media/a/b.webp" alt="ok" onerror="alert(1)">'
    )

    expect(html).not.toMatch(/script|onclick|onerror|javascript:|data:|color/)
    expect(html).toContain('<h2 style="text-align:center">Judul</h2>')
    expect(html).toContain('<p style="text-align:justify">Halo <b>dunia</b></p>')
    expect(html).toContain('<a href="https://ub.ac.id" target="_blank" rel="noopener noreferrer">y</a>')
    expect(html).toContain('<a href="/z">z</a>')
    expect(html).toContain('<img src="/uploads/media/a/b.webp" alt="ok" />')
    expect(html.match(/<img/g)).toHaveLength(1)
  })

  it('htmlToText memisahkan blok dan mengembalikan entitas', () => {
    expect(htmlToText('<p>a &amp; b</p><p>c<br>d</p><ul><li>e</li></ul>')).toBe('a & b c d e')
  })
})

describe('publik: GET /api/public/news/:slug', () => {
  it('isi disanitasi saat baca, SEO jatuh ke judul + potongan isi, section artikel, related satu section', async () => {
    await insertNews({
      slug: 'artikel-lama',
      categoryId: artikelCategoryId,
      content: `<p onmouseover="x()">${LONG_TEXT}</p><script>alert(1)</script>`
    })
    await insertNews({ slug: 'artikel-lain', categoryId: artikelCategoryId, publishedAt: new Date('2026-09-30T03:00:00Z') })
    await insertNews({ slug: 'berita-lain', categoryId: beritaCategoryId })

    const res = await request(web).get('/api/public/news/artikel-lama').expect(200)
    const data = res.body.data

    expect(res.headers['cache-control']).toContain('s-maxage=300')
    expect(data.content).not.toMatch(/script|onmouseover/)
    expect(data).toMatchObject({
      slug: 'artikel-lama',
      section: 'artikel',
      category: 'Artikel',
      publishedAt: '2026-10-01T03:00:00.000Z',
      noindex: false
    })
    expect(data.readingMinutes).toBe(1)
    expect(data.seo.title).toBe('Judul artikel-lama')
    expect(data.seo.description.length).toBeLessThanOrEqual(160)
    expect(data.seo.description).toMatch(/^Latihan rutin .*…$/)
    expect(data.seo.ogImage).toBe('')
    expect(data.related.map((item: { slug: string }) => item.slug)).toEqual(['artikel-lain'])
  })

  it('tanpa kategori = section berita; draft dan slug asing 404', async () => {
    await insertNews({ slug: 'tanpa-kategori' })
    await insertNews({ slug: 'masih-draft', status: 'draft' })

    const plain = await request(web).get('/api/public/news/tanpa-kategori').expect(200)
    expect(plain.body.data.section).toBe('berita')
    expect(plain.body.data.related.map((item: { slug: string }) => item.slug)).toEqual(['berita-lain'])

    const draft = await request(web).get('/api/public/news/masih-draft').expect(404)
    expect(draft.body.error.code).toBe('NOT_FOUND')
    expect(draft.headers['cache-control'] ?? '').not.toContain('s-maxage')
    await request(web).get('/api/public/news/tidak-ada').expect(404)
  })

  it('daftar /news membawa section, publishedAt ISO, dan noindex', async () => {
    const res = await request(web).get('/api/public/news').expect(200)
    const item = res.body.data.find((news: { slug: string }) => news.slug === 'artikel-lama')
    expect(item).toMatchObject({ section: 'artikel', publishedAt: '2026-10-01T03:00:00.000Z', noindex: false })
    expect(item).not.toHaveProperty('content')
  })
})

describe('admin berita: SEO + gambar isi', () => {
  it('unggah gambar isi, simpan artikel dengan metaTitle/metaDescription/noindex/ogImage; detail publik memakainya', async () => {
    const upload = await request(web)
      .post('/api/admin/news/content-images')
      .set('Authorization', admin)
      .attach('image', await png(), 'isi.png')
      .expect(201)
    const imageUrl: string = upload.body.data.url
    expect(imageUrl).toMatch(/media\/[0-9a-f-]{36}\/isi\.(webp|png)$/)

    const res = await request(web)
      .post('/api/admin/news')
      .set('Authorization', admin)
      .field('title', 'Turnamen Futsal')
      .field('slug', 'turnamen-futsal')
      .field('newsCategoryId', beritaCategoryId)
      .field('content', `<p>Pendaftaran dibuka.</p><img src="${imageUrl}" alt="poster"><script>alert(1)</script>`)
      .field('status', 'published')
      .field('metaTitle', '  Turnamen Futsal UB Sport Center 2026  ')
      .field('metaDescription', 'Daftarkan tim futsal Anda di turnamen tahunan UB Sport Center.')
      .field('noindex', '1')
      .attach('thumbnail', await png(), 'thumb.png')
      .attach('ogImage', await png(), 'og.png')
      .expect(201)

    const article = res.body.data
    expect(article).toMatchObject({
      section: 'berita',
      metaTitle: 'Turnamen Futsal UB Sport Center 2026',
      metaDescription: 'Daftarkan tim futsal Anda di turnamen tahunan UB Sport Center.',
      noindex: true
    })
    expect(article.content).not.toContain('script')
    expect(article.ogImage).toMatch(/og\.(webp|png)$/)

    const claimed = await prismaClient.media.findFirstOrThrow({ where: { modelType: 'News', collectionName: 'content' } })
    expect(claimed.modelId).toBe(article.id)

    const detail = (await request(web).get('/api/public/news/turnamen-futsal').expect(200)).body.data
    expect(detail.seo).toEqual({
      title: 'Turnamen Futsal UB Sport Center 2026',
      description: 'Daftarkan tim futsal Anda di turnamen tahunan UB Sport Center.',
      ogImage: article.ogImage,
      noindex: true
    })
    expect(detail.image).toBe(article.thumbnail)

    // Kosongkan meta + hapus OG: fallback kembali ke judul dan thumbnail.
    const updated = await request(web)
      .put(`/api/admin/news/${article.id}`)
      .set('Authorization', admin)
      .field('title', 'Turnamen Futsal')
      .field('slug', 'turnamen-futsal')
      .field('content', '<p>Pendaftaran dibuka.</p>')
      .field('status', 'published')
      .field('metaTitle', '')
      .field('removeOgImage', '1')
      .expect(200)
    expect(updated.body.data).toMatchObject({ metaTitle: null, ogImage: null, noindex: true })

    const after = (await request(web).get('/api/public/news/turnamen-futsal').expect(200)).body.data
    expect(after.seo).toMatchObject({ title: 'Turnamen Futsal', ogImage: article.thumbnail })
  })

  it('isi yang kosong setelah sanitasi ditolak 422 pada field content', async () => {
    const res = await request(web)
      .post('/api/admin/news')
      .set('Authorization', admin)
      .field('title', 'Kosong')
      .field('slug', 'kosong')
      .field('content', '<p><script>alert(1)</script></p>')
      .field('status', 'draft')
      .expect(422)
    expect(res.body.error.fields).toHaveProperty('content')
  })

  it('hapus artikel: gambar isi yang masih dirujuk artikel lain dipindah, berkasnya tetap ada', async () => {
    const upload = await request(web)
      .post('/api/admin/news/content-images')
      .set('Authorization', admin)
      .attach('image', await png(), 'bersama.png')
      .expect(201)
    const imageUrl: string = upload.body.data.url
    const content = `<p>Isi.</p><img src="${imageUrl}" alt="bersama">`

    const create = (slug: string) =>
      request(web)
        .post('/api/admin/news')
        .set('Authorization', admin)
        .field('title', slug)
        .field('slug', slug)
        .field('content', content)
        .field('status', 'draft')
        .expect(201)
    const a = (await create('pemilik-gambar')).body.data
    const b = (await create('penyalin-gambar')).body.data

    const uuid = imageUrl.match(/media\/([0-9a-f-]{36})\//)![1]
    expect((await prismaClient.media.findUniqueOrThrow({ where: { uuid } })).modelId).toBe(a.id)

    await request(web).delete(`/api/admin/news/${a.id}`).set('Authorization', admin).expect(200)

    expect((await prismaClient.media.findUniqueOrThrow({ where: { uuid } })).modelId).toBe(b.id)
    expect(existsSync(resolve(process.cwd(), process.env.UPLOAD_DIR as string, imageUrl.replace('/uploads/', '')))).toBe(true)
  })
})

describe('SEO halaman statis', () => {
  it('PUT menyimpan timpaan + OG image; GET admin memuat seluruh SEO_PAGES; publik hanya yang tersimpan', async () => {
    const put = await request(web)
      .put('/api/admin/seo-pages/about')
      .set('Authorization', admin)
      .field('title', 'Tentang UB Sport Center')
      .field('description', '')
      .field('noindex', 'true')
      .attach('ogImage', await png(), 'about.png')
      .expect(200)

    expect(put.body.data).toMatchObject({
      key: 'about',
      path: '/about',
      title: 'Tentang UB Sport Center',
      description: null,
      noindex: true,
      defaultTitle: 'Tentang Kami'
    })
    expect(put.body.data.ogImage).toMatch(/about\.(webp|png)$/)
    expect(put.body.data.updatedAt).not.toBeNull()

    const list = (await request(web).get('/api/admin/seo-pages').set('Authorization', admin).expect(200)).body.data
    expect(list.map((page: { key: string }) => page.key)).toEqual(SEO_PAGES.map((page) => page.key))
    expect(list.find((page: { key: string }) => page.key === 'home')).toMatchObject({ title: null, ogImage: null, updatedAt: null })

    const pub = await request(web).get('/api/public/seo').expect(200)
    expect(pub.body.data).toEqual([
      { key: 'about', title: 'Tentang UB Sport Center', description: null, ogImage: put.body.data.ogImage, noindex: true }
    ])

    // Hapus OG image; field yang tidak dikirim tidak berubah.
    const removed = await request(web).put('/api/admin/seo-pages/about').set('Authorization', admin).field('removeOgImage', '1').expect(200)
    expect(removed.body.data).toMatchObject({ title: 'Tentang UB Sport Center', ogImage: null, noindex: true })
  })

  it('key asing 404, judul kepanjangan ditolak validasi', async () => {
    await request(web).put('/api/admin/seo-pages/tidak-ada').set('Authorization', admin).field('title', 'x').expect(404)
    const res = await request(web).put('/api/admin/seo-pages/home').set('Authorization', admin).field('title', 'x'.repeat(121)).expect(400)
    expect(res.body.error.fields).toHaveProperty('title')
  })
})
