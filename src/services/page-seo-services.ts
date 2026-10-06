import { Prisma } from '@prisma/client'
import type { AdminPageSeoDto, PageSeoDto } from '../../shared/contracts'
import { SEO_PAGES } from '../../shared/seo'
import { prismaClient } from '../application/database'
import { ResponseError } from '../error/response-error'
import { now } from '../utils/clock'
import { NewsAdminValidation } from '../validation/news-admin-validation'
import { Validation } from '../validation/Validation'
import { timeAgoId } from './dashboard-services'
import { firstUrlFor, listFor, MediaMap } from './media-services'
import { assertImageAcceptable, replaceSingleMedia } from './media-store-services'
import { UploadedThumbnail } from './news-admin-services'

// ============================================================================
// === SEO halaman statis landing (PRD tambahan §7.7) ===
// ============================================================================
// Daftar halaman + default-nya hidup di shared/seo.ts (SEO_PAGES). Tabel page_seo hanya menyimpan
// TIMPAAN admin: baris lahir saat halaman pertama kali disimpan, kolom null = pakai default kode.
// OG image = Media modelType 'PageSeo' koleksi 'og_image'.

type Page = (typeof SEO_PAGES)[number]

const PAGE_SEO_SELECT = {
  id: true,
  key: true,
  title: true,
  description: true,
  noindex: true,
  updatedAt: true
} as const satisfies Prisma.PageSeoSelect

type PageSeoRow = Prisma.PageSeoGetPayload<{ select: typeof PAGE_SEO_SELECT }>

function toPageSeo(page: Page, row: PageSeoRow | undefined, ogImages: MediaMap): PageSeoDto {
  return {
    key: page.key,
    title: row?.title ?? null,
    description: row?.description ?? null,
    ogImage: (row && firstUrlFor(ogImages, row.id, 'og_image')) || null,
    noindex: row?.noindex ?? false
  }
}

function toAdminPageSeo(page: Page, row: PageSeoRow | undefined, ogImages: MediaMap, at: Date): AdminPageSeoDto {
  return {
    ...toPageSeo(page, row, ogImages),
    label: page.label,
    path: page.path,
    defaultTitle: page.defaultTitle,
    defaultDescription: page.defaultDescription,
    updatedAt: row ? timeAgoId(row.updatedAt, at) : null
  }
}

/** Baris page_seo per key + OG image-nya, dua query. Key yang tidak lagi ada di SEO_PAGES diabaikan pemanggil. */
async function loadRows(where: Prisma.PageSeoWhereInput = {}): Promise<{ rows: Map<string, PageSeoRow>; ogImages: MediaMap }> {
  const rows = await prismaClient.pageSeo.findMany({ where, select: PAGE_SEO_SELECT })
  const ogImages = await listFor(
    'PageSeo',
    rows.map((row) => row.id),
    'og_image'
  )
  return { rows: new Map(rows.map((row) => [row.key, row])), ogImages }
}

/** GET /api/public/seo — hanya halaman yang punya baris; landing menggabungkannya dengan SEO_PAGES. */
export async function listPageSeo(): Promise<PageSeoDto[]> {
  const { rows, ogImages } = await loadRows()
  return SEO_PAGES.flatMap((page) => {
    const row = rows.get(page.key)
    return row ? [toPageSeo(page, row, ogImages)] : []
  })
}

/** GET /api/admin/seo-pages — SELURUH SEO_PAGES, urutan yang sama, digabung dengan baris DB. */
export async function listAdminPageSeo(): Promise<AdminPageSeoDto[]> {
  const { rows, ogImages } = await loadRows()
  const at = now()
  return SEO_PAGES.map((page) => toAdminPageSeo(page, rows.get(page.key), ogImages, at))
}

/**
 * PUT /api/admin/seo-pages/:key — upsert per key. Teks kosong -> null (= default); field absen tidak
 * diubah. Berkas `ogImage` mengganti OG lama; `removeOgImage` tanpa berkas menghapusnya.
 */
export async function updatePageSeo(key: string, request: unknown, ogImage: UploadedThumbnail | undefined): Promise<AdminPageSeoDto> {
  const page = SEO_PAGES.find((candidate) => candidate.key === key)
  if (!page) throw new ResponseError(404, 'Halaman tidak ditemukan.')

  const data = Validation.validate(NewsAdminValidation.PAGE_SEO, request)
  const fields = { title: data.title, description: data.description, noindex: data.noindex }
  if (ogImage) await assertImageAcceptable(ogImage.buffer, 'ogImage')

  const { id } = await prismaClient.pageSeo.upsert({
    where: { key: page.key },
    create: { key: page.key, ...fields },
    update: fields,
    select: { id: true }
  })

  await replaceSingleMedia({ modelType: 'PageSeo', modelId: id, collectionName: 'og_image', field: 'ogImage' }, ogImage, data.removeOgImage ?? false)

  const { rows, ogImages } = await loadRows({ id })
  return toAdminPageSeo(page, rows.get(page.key), ogImages, now())
}
