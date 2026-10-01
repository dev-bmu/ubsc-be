import { Prisma } from '@prisma/client'
import type {
  AdminFacilityDto,
  AdminFacilityFormDto,
  AdminFacilityIndexDto,
  AdminFacilityPricingDto,
  AdminFacilityUnitDto,
  AdminFacilityUnitsDto,
  FacilityCategoryDto,
  FacilityPriceRowDto,
  MediaRefDto,
  SlotQuotasDto,
  WeeklySlotsDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { dateOnly, dateOnlyToString } from '../utils/clock'
import { isUniqueViolation } from '../utils/prisma-errors'
import { humanizeDuration, normalizeQuotas, normalizeSlots } from '../utils/weekly-slots'
import { Validation } from '../validation/Validation'
import { FacilityPriceRowInput, FacilityValidation } from '../validation/facility-validation'
import { deleteForModel, firstUrlFor, listFor, MEDIA_SELECT, MediaMap, MediaRow, urlFor } from './media-services'
import { deleteMediaCollection, deleteMediaRow, storePublicMedia, unlinkMediaFiles } from './media-store-services'

// ============================================================================
// === Admin Facilities CRUD — port 4 controller Laravel (Fase 8A) ===
// ============================================================================
// FacilityController + FacilityUnitController + FacilityPriceController + FacilityCategoryController,
// plus closure GET facilities/{facility}/pricing. Perbedaan yang disengaja dari Laravel (camelCase di
// kabel, id uuid, PUT nyata tanpa _method, koersi multipart, media lewat foundation media-services)
// dijelaskan di titik masing-masing. Permission dicek di baris route, tidak pernah di sini.

// ===== Berkas unggahan (bentuk minimum dari multer memoryStorage) =====

export interface UploadedFile {
  buffer: Buffer
  originalname: string
}

/** req.files dari facilityMediaUpload (.fields hero+gallery). */
export interface FacilityUploadFiles {
  hero?: UploadedFile[]
  gallery?: UploadedFile[]
}

// ===== Helper JSON (kolom Json? Prisma) =====

/** Str::slug() untuk slug kategori — disalin dari media-store-services.slugify (R9, jangan impor seeder). */
const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Objek {hari: jam[]} apa adanya; null / skalar / array jatuh ke null (cast 'array' Laravel). */
function toWeeklySlots(value: Prisma.JsonValue): WeeklySlotsDto | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as WeeklySlotsDto) : null
}

function toSlotQuotas(value: Prisma.JsonValue): SlotQuotasDto | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SlotQuotasDto) : null
}

/** applicable_days apa adanya bila array, else null (sama dengan public-facility-services). */
function toApplicableDays(value: Prisma.JsonValue): string[] | null {
  return Array.isArray(value) ? (value as string[]) : null
}

/** Nilai untuk kolom Json? nullable: objek/array -> as-is, undefined/null -> SQL NULL (Prisma.DbNull). */
function jsonOrDbNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue)
}

/** Objek non-kosong -> as-is, objek kosong -> SQL NULL (keputusan 5: slot/kuota disimpan null saat kosong). */
function objectOrDbNull(value: Record<string, unknown>): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return Object.keys(value).length > 0 ? (value as Prisma.InputJsonValue) : Prisma.DbNull
}

// ===== Konflik slug (P2002) =====
// Prisma driver adapter tidak selalu membawa meta.target, jadi errorMiddleware tidak bisa memetakan
// P2002 slug ke field. Ditangkap di sini dan diubah jadi 422 dengan pesan yang menempel ke `slug`.
function rethrowSlugConflict(error: unknown): never {
  if (isUniqueViolation(error, 'slug')) {
    throw new ResponseError(422, 'Slug sudah dipakai.', 'VALIDATION_ERROR', { slug: ['Slug sudah dipakai.'] })
  }
  throw error
}

function rethrowCategorySlugConflict(error: unknown): never {
  if (isUniqueViolation(error, 'slug')) {
    throw new ResponseError(422, 'Nama kategori sudah dipakai.', 'VALIDATION_ERROR', { name: ['Nama kategori sudah dipakai.'] })
  }
  throw error
}

// ===== Mapper baris harga -> DTO =====

/** durationMinutes: `?? 60` mengikuti transformUnit / closure pricing Laravel (kolom nullable, output 60). */
function toFacilityPriceRow(
  price: {
    id: string
    userCategory: 'warga_ub' | 'umum'
    priceType?: string
    label: string
    price: number
    durationMinutes: number | null
    scheduleType: string
    applicableDays: Prisma.JsonValue
    startsAt: string | null
    endsAt: string | null
    startsOn: Date | null
    endsOn: Date | null
    notes: string | null
    sortOrder: number
  },
  includePriceType: boolean
): FacilityPriceRowDto {
  const row: FacilityPriceRowDto = {
    id: price.id,
    userCategory: price.userCategory,
    label: price.label,
    price: price.price,
    durationMinutes: price.durationMinutes ?? 60,
    scheduleType: price.scheduleType,
    applicableDays: toApplicableDays(price.applicableDays),
    // substr(...,0,5): kolom sudah VarChar(5), slice adalah pagar untuk baris lama berdetik.
    startsAt: price.startsAt ? price.startsAt.slice(0, 5) : null,
    endsAt: price.endsAt ? price.endsAt.slice(0, 5) : null,
    startsOn: price.startsOn ? dateOnlyToString(price.startsOn) : null,
    endsOn: price.endsOn ? dateOnlyToString(price.endsOn) : null,
    notes: price.notes,
    sortOrder: price.sortOrder
  }
  // Closure pricing Laravel mengirim price_type; transformUnit TIDAK. FacilityPriceRowDto.priceType opsional.
  if (includePriceType) row.priceType = price.priceType ?? 'per_session'
  return row
}

/** Tulis satu baris harga (fasilitas / unit) dari input tervalidasi ke kolom Prisma. */
function priceCreateData(price: FacilityPriceRowInput, index: number, includePriceType: boolean) {
  const base = {
    userCategory: price.userCategory,
    label: price.label,
    price: price.price,
    // syncPrices Laravel: `$price['duration_minutes'] ?? 60`.
    durationMinutes: price.durationMinutes ?? 60,
    scheduleType: price.scheduleType ?? 'regular',
    applicableDays: jsonOrDbNull(price.applicableDays),
    startsAt: price.startsAt ?? null,
    endsAt: price.endsAt ?? null,
    startsOn: price.startsOn ? dateOnly(price.startsOn) : null,
    endsOn: price.endsOn ? dateOnly(price.endsOn) : null,
    notes: price.notes ?? null,
    // `$price['sort_order'] ?? $index`.
    sortOrder: price.sortOrder ?? index
  }
  return includePriceType ? { ...base, priceType: price.priceType ?? 'per_session' } : base
}

// ===== Mapper media =====

function toMediaRef(row: MediaRow): MediaRefDto {
  return { id: row.id, url: urlFor(row), name: row.name, orderColumn: row.orderColumn }
}

// ===== Fasilitas -> AdminFacilityDto =====

const ADMIN_FACILITY_INCLUDE = {
  facilityCategory: true,
  _count: { select: { prices: true, units: true } }
} as const satisfies Prisma.FacilityInclude

/** Bentuk minimum yang dibutuhkan transformFacility(); baris findMany/findUnique memenuhinya secara struktural. */
interface FacilityRowForDto {
  id: string
  name: string
  slug: string
  description: string | null
  location: string | null
  venueType: string | null
  capacity: number
  bookingMode: string
  activeSlots: Prisma.JsonValue
  slotQuotas: Prisma.JsonValue
  sessionNote: string | null
  classCode: string | null
  accurateItemNo: string | null
  accurateItemNoWarga: string | null
  rating: number
  displayMetadata: Prisma.JsonValue
  isActive: boolean
  sortOrder: number
  facilityCategory: { id: string; name: string; slug: string } | null
  _count: { prices: number; units: number }
}

/** Port transformFacility() — pricesCount/unitsCount dari _count, hero+gallery dari MediaMap batch. */
function mapFacility(facility: FacilityRowForDto, media: MediaMap): AdminFacilityDto {
  const rows = media.get(facility.id) ?? []
  const heroRow = rows.find((row) => row.collectionName === 'hero')
  return {
    id: facility.id,
    name: facility.name,
    slug: facility.slug,
    description: facility.description,
    location: facility.location,
    venueType: facility.venueType,
    capacity: facility.capacity,
    bookingMode: facility.bookingMode,
    activeSlots: toWeeklySlots(facility.activeSlots),
    slotQuotas: toSlotQuotas(facility.slotQuotas),
    sessionNote: facility.sessionNote,
    classCode: facility.classCode,
    accurateItemNo: facility.accurateItemNo,
    accurateItemNoWarga: facility.accurateItemNoWarga,
    rating: facility.rating,
    displayMetadata: facility.displayMetadata ?? null,
    isActive: facility.isActive,
    sortOrder: facility.sortOrder,
    pricesCount: facility._count.prices,
    unitsCount: facility._count.units,
    category: facility.facilityCategory
      ? { id: facility.facilityCategory.id, name: facility.facilityCategory.name, slug: facility.facilityCategory.slug }
      : null,
    hero: heroRow ? toMediaRef(heroRow) : null,
    gallery: rows.filter((row) => row.collectionName === 'gallery').map(toMediaRef)
  }
}

async function loadAdminFacility(id: string): Promise<AdminFacilityDto> {
  const facility = await prismaClient.facility.findUnique({ where: { id }, include: ADMIN_FACILITY_INCLUDE })
  if (!facility) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')
  const media = await listFor('Facility', [id])
  return mapFacility(facility, media)
}

// ===== Unit -> AdminFacilityUnitDto =====

interface UnitRowForDto {
  id: string
  facilityId: string
  name: string
  capacity: number
  isActive: boolean
  useCustomSchedule: boolean
  activeSlots: Prisma.JsonValue
  slotQuotas: Prisma.JsonValue
  useCustomPricing: boolean
  createdAt: Date
  prices: Array<Parameters<typeof toFacilityPriceRow>[0]>
}

function mapUnit(unit: UnitRowForDto, media: MediaMap): AdminFacilityUnitDto {
  return {
    id: unit.id,
    facilityId: unit.facilityId,
    name: unit.name,
    capacity: unit.capacity,
    isActive: unit.isActive,
    useCustomSchedule: unit.useCustomSchedule,
    activeSlots: toWeeklySlots(unit.activeSlots),
    slotQuotas: toSlotQuotas(unit.slotQuotas),
    useCustomPricing: unit.useCustomPricing,
    // transformUnit tidak mengirim price_type untuk baris harga unit.
    prices: unit.prices.map((price) => toFacilityPriceRow(price, false)),
    imageUrl: firstUrlFor(media, unit.id, 'unit_image') || null,
    createdAt: unit.createdAt.toISOString()
  }
}

const UNIT_PRICES_INCLUDE = {
  prices: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }
} as const satisfies Prisma.FacilityUnitInclude

async function loadAdminUnit(id: string): Promise<AdminFacilityUnitDto> {
  const unit = await prismaClient.facilityUnit.findUnique({ where: { id }, include: UNIT_PRICES_INCLUDE })
  if (!unit) throw new ResponseError(404, 'Unit fasilitas tidak ditemukan.')
  const media = await listFor('FacilityUnit', [id], 'unit_image')
  return mapUnit(unit, media)
}

// ===== durationForCategory (port FacilityPriceResolver) =====

interface PriceForDuration {
  userCategory: string
  label: string
  durationMinutes: number | null
  sortOrder: number
}

/** Reguler kategori -> harga pertama kategori -> harga pertama apa pun; durasi 60 bila kosong. */
function durationForCategory(prices: PriceForDuration[], userCategory: string): number {
  const sorted = [...prices].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  const inCategory = sorted.filter((price) => price.userCategory === userCategory)
  const chosen = inCategory.find((price) => price.label === 'Reguler') ?? inCategory[0] ?? sorted[0]
  return chosen?.durationMinutes || 60
}

// ===== Kategori -> DTO =====

async function loadCategory(id: string): Promise<FacilityCategoryDto> {
  const category = await prismaClient.facilityCategory.findUnique({ where: { id }, include: { _count: { select: { facilities: true } } } })
  if (!category) throw new ResponseError(404, 'Kategori fasilitas tidak ditemukan.')
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    sortOrder: category.sortOrder,
    facilitiesCount: category._count.facilities
  }
}

export async function listFacilityCategories(): Promise<FacilityCategoryDto[]> {
  const categories = await prismaClient.facilityCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { facilities: true } } }
  })
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    sortOrder: category.sortOrder,
    facilitiesCount: category._count.facilities
  }))
}

// ===== Media fasilitas (mirror addMediaFromRequest SETELAH create) =====

/**
 * Hero: berkas baru -> hapus koleksi lama lalu simpan; removeHero tanpa berkas -> hapus. Gallery:
 * tiap berkas disimpan dengan orderColumn = indeks (keputusan 7). Berkas fisik yang terhapus di-unlink
 * SETELAH tulisan DB, mengikuti kontrak media-store-services.
 */
async function attachFacilityMedia(facilityId: string, files: FacilityUploadFiles, removeHero: boolean): Promise<void> {
  const removed: MediaRow[] = []
  const hero = files.hero?.[0]

  if (hero) {
    removed.push(...(await deleteMediaCollection('Facility', facilityId, 'hero')))
    await storePublicMedia({
      modelType: 'Facility',
      modelId: facilityId,
      collectionName: 'hero',
      buffer: hero.buffer,
      originalName: hero.originalname,
      field: 'hero'
    })
  } else if (removeHero) {
    removed.push(...(await deleteMediaCollection('Facility', facilityId, 'hero')))
  }

  const gallery = files.gallery ?? []
  for (let index = 0; index < gallery.length; index++) {
    await storePublicMedia({
      modelType: 'Facility',
      modelId: facilityId,
      collectionName: 'gallery',
      buffer: gallery[index].buffer,
      originalName: gallery[index].originalname,
      field: 'gallery',
      orderColumn: index
    })
  }

  unlinkMediaFiles(removed)
}

async function attachUnitImage(unitId: string, image: UploadedFile | undefined, removeImage: boolean): Promise<void> {
  const removed: MediaRow[] = []
  if (image) {
    removed.push(...(await deleteMediaCollection('FacilityUnit', unitId, 'unit_image')))
    await storePublicMedia({
      modelType: 'FacilityUnit',
      modelId: unitId,
      collectionName: 'unit_image',
      buffer: image.buffer,
      originalName: image.originalname,
      field: 'unit_image'
    })
  } else if (removeImage) {
    removed.push(...(await deleteMediaCollection('FacilityUnit', unitId, 'unit_image')))
  }
  unlinkMediaFiles(removed)
}

// ===== ensureClassHasAGroup =====

/**
 * Mode class butuh minimal satu unit (kapasitas/jadwal/pembatalan hidup di unit). Unit default dibuat
 * TANPA jadwal sendiri supaya WeeklySchedule jatuh ke jadwal fasilitas — menyalin slot ke sini malah
 * membekukannya (komentar FacilityController::ensureClassHasAGroup).
 */
async function ensureClassHasAGroup(facilityId: string, bookingMode: string, capacity: number): Promise<void> {
  if (bookingMode !== 'class') return
  const count = await prismaClient.facilityUnit.count({ where: { facilityId } })
  if (count > 0) return
  await prismaClient.facilityUnit.create({
    data: { facilityId, name: 'Reguler', capacity: Math.max(1, capacity), isActive: true, useCustomSchedule: false, useCustomPricing: false }
  })
}

async function assertCategoryExists(facilityCategoryId: string): Promise<void> {
  const category = await prismaClient.facilityCategory.findUnique({ where: { id: facilityCategoryId }, select: { id: true } })
  if (!category) {
    throw new ResponseError(422, 'Kategori fasilitas tidak ditemukan.', 'VALIDATION_ERROR', {
      facilityCategoryId: ['Kategori fasilitas tidak valid.']
    })
  }
}

// ===== Harga unit (full-replace, mirror syncPrices) =====

async function syncUnitPrices(unitId: string, prices: FacilityPriceRowInput[]): Promise<void> {
  await prismaClient.$transaction(async (tx) => {
    await tx.facilityUnitPrice.deleteMany({ where: { facilityUnitId: unitId } })
    for (let index = 0; index < prices.length; index++) {
      await tx.facilityUnitPrice.create({ data: { facilityUnitId: unitId, ...priceCreateData(prices[index], index, false) } })
    }
  }, TX_OPTIONS)
}

// ============================================================================
// === Endpoint fasilitas ===
// ============================================================================

/** GET /api/admin/facilities — daftar penuh + kategori (tanpa paginasi, mirip .get() Laravel). */
export async function listAdminFacilities(): Promise<AdminFacilityIndexDto> {
  const facilities = await prismaClient.facility.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: ADMIN_FACILITY_INCLUDE
  })
  const media = await listFor(
    'Facility',
    facilities.map((facility) => facility.id)
  )
  const categories = await listFacilityCategories()
  return { facilities: facilities.map((facility) => mapFacility(facility, media)), categories }
}

/** GET /api/admin/facilities/create — payload form kosong. */
export async function facilityCreateForm(): Promise<AdminFacilityFormDto> {
  const categories = await prismaClient.facilityCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true }
  })
  return { facility: null, categories, customScheduleGroups: [], sessionNoteDefault: humanizeDuration(60) }
}

/** GET /api/admin/facilities/:id/edit — form terisi + grup berjadwal custom + default catatan sesi. */
export async function facilityEditForm(id: string): Promise<AdminFacilityFormDto> {
  const facility = await prismaClient.facility.findUnique({
    where: { id },
    include: {
      facilityCategory: true,
      _count: { select: { prices: true, units: true } },
      prices: true,
      units: { where: { useCustomSchedule: true }, orderBy: { name: 'asc' }, select: { name: true } }
    }
  })
  if (!facility) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')

  const categories = await prismaClient.facilityCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true }
  })
  const media = await listFor('Facility', [id])

  return {
    facility: mapFacility(facility, media),
    categories,
    customScheduleGroups: facility.units.map((unit) => unit.name),
    sessionNoteDefault: humanizeDuration(durationForCategory(facility.prices, 'umum'))
  }
}

/** POST /api/admin/facilities. */
export async function storeFacility(body: unknown, files: FacilityUploadFiles): Promise<AdminFacilityDto> {
  const data = Validation.validate(FacilityValidation.FACILITY, body)
  await assertCategoryExists(data.facilityCategoryId)

  const slots = normalizeSlots(data.activeSlots)
  const quotas = normalizeQuotas(data.slotQuotas, slots)
  const capacity = data.capacity ?? 1
  const bookingMode = data.bookingMode ?? 'court'

  const facility = await prismaClient.facility
    .create({
      data: {
        facilityCategoryId: data.facilityCategoryId,
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        location: data.location ?? null,
        venueType: data.venueType ?? null,
        capacity,
        bookingMode,
        activeSlots: objectOrDbNull(slots),
        slotQuotas: objectOrDbNull(quotas),
        sessionNote: data.sessionNote ?? null,
        classCode: data.classCode ?? null,
        accurateItemNo: data.accurateItemNo ?? null,
        accurateItemNoWarga: data.accurateItemNoWarga ?? null,
        rating: data.rating ?? 5.0,
        displayMetadata: jsonOrDbNull(data.displayMetadata),
        isActive: data.isActive,
        sortOrder: data.sortOrder ?? 0
      }
    })
    .catch(rethrowSlugConflict)

  await ensureClassHasAGroup(facility.id, bookingMode, capacity)
  await attachFacilityMedia(facility.id, files, false)
  return loadAdminFacility(facility.id)
}

/** PUT /api/admin/facilities/:id. */
export async function updateFacility(id: string, body: unknown, files: FacilityUploadFiles): Promise<AdminFacilityDto> {
  const data = Validation.validate(FacilityValidation.FACILITY, body)
  const existing = await prismaClient.facility.findUnique({ where: { id } })
  if (!existing) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')
  await assertCategoryExists(data.facilityCategoryId)

  const slots = normalizeSlots(data.activeSlots)
  const quotas = normalizeQuotas(data.slotQuotas, slots)
  const capacity = data.capacity ?? existing.capacity
  const bookingMode = data.bookingMode ?? existing.bookingMode

  await prismaClient.facility
    .update({
      where: { id },
      data: {
        facilityCategoryId: data.facilityCategoryId,
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        location: data.location ?? null,
        venueType: data.venueType ?? null,
        capacity,
        bookingMode,
        activeSlots: objectOrDbNull(slots),
        slotQuotas: objectOrDbNull(quotas),
        sessionNote: data.sessionNote ?? null,
        classCode: data.classCode ?? null,
        accurateItemNo: data.accurateItemNo ?? null,
        accurateItemNoWarga: data.accurateItemNoWarga ?? null,
        rating: data.rating ?? existing.rating,
        displayMetadata: jsonOrDbNull(data.displayMetadata),
        isActive: data.isActive,
        sortOrder: data.sortOrder ?? 0
      }
    })
    .catch(rethrowSlugConflict)

  await ensureClassHasAGroup(id, bookingMode, capacity)
  await attachFacilityMedia(id, files, data.removeHero)
  return loadAdminFacility(id)
}

/** DELETE /api/admin/facilities/:id — hapus prices + units (+ harga unit) + facility + semua media. */
export async function destroyFacility(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.facility.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')

  const removed: MediaRow[] = []
  await prismaClient.$transaction(async (tx) => {
    const units = await tx.facilityUnit.findMany({ where: { facilityId: id }, select: { id: true } })
    const unitIds = units.map((unit) => unit.id)

    // relationMode="prisma": tidak ada cascade DB, jadi anak dihapus manual sebelum induknya.
    if (unitIds.length > 0) await tx.facilityUnitPrice.deleteMany({ where: { facilityUnitId: { in: unitIds } } })
    await tx.facilityUnit.deleteMany({ where: { facilityId: id } })
    await tx.facilityPrice.deleteMany({ where: { facilityId: id } })
    await tx.facility.delete({ where: { id } })

    removed.push(...(await deleteForModel('Facility', id, tx)))
    for (const unitId of unitIds) removed.push(...(await deleteForModel('FacilityUnit', unitId, tx)))
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

/** POST /api/admin/facilities/reorder — sortOrder = index + 1. updateMany diam saat id tak ada (mirror Laravel). */
export async function reorderFacilities(body: unknown): Promise<{ ids: string[] }> {
  const { ids } = Validation.validate(FacilityValidation.REORDER, body)
  await prismaClient.$transaction(ids.map((id, index) => prismaClient.facility.updateMany({ where: { id }, data: { sortOrder: index + 1 } })))
  return { ids }
}

/** DELETE /api/admin/facilities/gallery/:mediaId — hanya koleksi gallery (hero ditolak 403). */
export async function destroyGalleryMedia(mediaId: string): Promise<{ id: string }> {
  const media = await prismaClient.media.findUnique({ where: { id: mediaId }, select: MEDIA_SELECT })
  if (!media) throw new ResponseError(404, 'Media tidak ditemukan.')
  if (media.collectionName !== 'gallery') throw new ResponseError(403, 'Tidak bisa menghapus gambar hero lewat endpoint ini.')

  const deleted = await deleteMediaRow(mediaId)
  if (deleted) unlinkMediaFiles([deleted])
  return { id: mediaId }
}

// ============================================================================
// === Endpoint harga fasilitas ===
// ============================================================================

/** GET /api/admin/facilities/:id/pricing. */
export async function getFacilityPricing(id: string): Promise<AdminFacilityPricingDto> {
  const facility = await prismaClient.facility.findUnique({
    where: { id },
    select: { id: true, name: true, bookingMode: true, prices: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] } }
  })
  if (!facility) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')

  return {
    facility: { id: facility.id, name: facility.name, bookingMode: facility.bookingMode },
    prices: facility.prices.map((price) => toFacilityPriceRow(price, true))
  }
}

/** POST /api/admin/facilities/:id/pricing/sync — full-replace daftar harga fasilitas dalam satu transaksi. */
export async function syncFacilityPricing(id: string, body: unknown): Promise<AdminFacilityPricingDto> {
  const data = Validation.validate(FacilityValidation.PRICING_SYNC, body)
  const facility = await prismaClient.facility.findUnique({ where: { id }, select: { id: true } })
  if (!facility) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')

  await prismaClient.$transaction(async (tx) => {
    await tx.facilityPrice.deleteMany({ where: { facilityId: id } })
    for (let index = 0; index < data.prices.length; index++) {
      await tx.facilityPrice.create({ data: { facilityId: id, ...priceCreateData(data.prices[index], index, true) } })
    }
  }, TX_OPTIONS)

  return getFacilityPricing(id)
}

// ============================================================================
// === Endpoint unit fasilitas ===
// ============================================================================

/** GET /api/admin/facilities/:id/units. */
export async function listFacilityUnits(facilityId: string): Promise<AdminFacilityUnitsDto> {
  const facility = await prismaClient.facility.findUnique({
    where: { id: facilityId },
    select: {
      id: true,
      name: true,
      slug: true,
      bookingMode: true,
      facilityCategory: { select: { name: true } },
      units: { orderBy: { createdAt: 'asc' }, include: UNIT_PRICES_INCLUDE }
    }
  })
  if (!facility) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')

  const heroMedia = await listFor('Facility', [facility.id], 'hero')
  const unitMedia = await listFor(
    'FacilityUnit',
    facility.units.map((unit) => unit.id),
    'unit_image'
  )

  return {
    facility: {
      id: facility.id,
      name: facility.name,
      slug: facility.slug,
      bookingMode: facility.bookingMode,
      category: facility.facilityCategory?.name ?? null,
      image: firstUrlFor(heroMedia, facility.id, 'hero') || null
    },
    units: facility.units.map((unit) => mapUnit(unit, unitMedia))
  }
}

/** POST /api/admin/facilities/:id/units. */
export async function storeFacilityUnit(facilityId: string, body: unknown, image: UploadedFile | undefined): Promise<AdminFacilityUnitDto> {
  const data = Validation.validate(FacilityValidation.UNIT_CREATE, body)
  const facility = await prismaClient.facility.findUnique({ where: { id: facilityId }, select: { id: true } })
  if (!facility) throw new ResponseError(404, 'Fasilitas tidak ditemukan.')

  const slots = normalizeSlots(data.activeSlots)
  const quotas = normalizeQuotas(data.slotQuotas, slots)
  const useSchedule = data.useCustomSchedule

  const unit = await prismaClient.facilityUnit.create({
    data: {
      facilityId,
      name: data.name,
      capacity: data.capacity ?? 1,
      isActive: data.isActive,
      useCustomSchedule: useSchedule,
      // Slot/kuota hanya disimpan saat unit berjadwal sendiri; kalau tidak, null (jatuh ke jadwal fasilitas).
      activeSlots: useSchedule ? objectOrDbNull(slots) : Prisma.DbNull,
      slotQuotas: useSchedule ? objectOrDbNull(quotas) : Prisma.DbNull,
      useCustomPricing: data.useCustomPricing
    }
  })

  if (data.useCustomPricing) await syncUnitPrices(unit.id, data.prices ?? [])
  if (image) await attachUnitImage(unit.id, image, false)
  return loadAdminUnit(unit.id)
}

/** PUT /api/admin/facility-units/:id. */
export async function updateFacilityUnit(id: string, body: unknown, image: UploadedFile | undefined): Promise<AdminFacilityUnitDto> {
  const data = Validation.validate(FacilityValidation.UNIT_UPDATE, body)
  const existing = await prismaClient.facilityUnit.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Unit fasilitas tidak ditemukan.')

  const slots = normalizeSlots(data.activeSlots)
  const quotas = normalizeQuotas(data.slotQuotas, slots)
  const useSchedule = data.useCustomSchedule

  await prismaClient.facilityUnit.update({
    where: { id },
    data: {
      name: data.name,
      capacity: data.capacity ?? 1,
      isActive: data.isActive,
      useCustomSchedule: useSchedule,
      activeSlots: useSchedule ? objectOrDbNull(slots) : Prisma.DbNull,
      slotQuotas: useSchedule ? objectOrDbNull(quotas) : Prisma.DbNull,
      useCustomPricing: data.useCustomPricing
    }
  })

  // Harga custom di-full-replace hanya saat aktif; menonaktifkannya membiarkan baris lama (diabaikan resolver).
  if (data.useCustomPricing) await syncUnitPrices(id, data.prices ?? [])
  await attachUnitImage(id, image, data.removeUnitImage)
  return loadAdminUnit(id)
}

/** DELETE /api/admin/facility-units/:id — diblokir bila unit punya riwayat booking. */
export async function destroyFacilityUnit(id: string): Promise<{ id: string }> {
  const existing = await prismaClient.facilityUnit.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Unit fasilitas tidak ditemukan.')

  const bookings = await prismaClient.booking.count({ where: { facilityUnitId: id } })
  if (bookings > 0) {
    throw new ResponseError(422, 'Unit sudah memiliki riwayat booking. Nonaktifkan unit jika tidak ingin dipakai lagi.')
  }

  const removed: MediaRow[] = []
  await prismaClient.$transaction(async (tx) => {
    await tx.facilityUnitPrice.deleteMany({ where: { facilityUnitId: id } })
    await tx.facilityUnit.delete({ where: { id } })
    removed.push(...(await deleteForModel('FacilityUnit', id, tx)))
  }, TX_OPTIONS)

  unlinkMediaFiles(removed)
  return { id }
}

// ============================================================================
// === Endpoint kategori fasilitas ===
// ============================================================================

/** POST /api/admin/facility-categories — slug diturunkan dari name. */
export async function storeFacilityCategory(body: unknown): Promise<FacilityCategoryDto> {
  const data = Validation.validate(FacilityValidation.CATEGORY, body)
  const created = await prismaClient.facilityCategory
    .create({ data: { name: data.name, slug: slugify(data.name), description: data.description ?? null, sortOrder: data.sortOrder ?? 0 } })
    .catch(rethrowCategorySlugConflict)
  return loadCategory(created.id)
}

/** PUT /api/admin/facility-categories/:id. */
export async function updateFacilityCategory(id: string, body: unknown): Promise<FacilityCategoryDto> {
  const data = Validation.validate(FacilityValidation.CATEGORY, body)
  const existing = await prismaClient.facilityCategory.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Kategori fasilitas tidak ditemukan.')

  await prismaClient.facilityCategory
    .update({
      where: { id },
      data: { name: data.name, slug: slugify(data.name), description: data.description ?? null, sortOrder: data.sortOrder ?? 0 }
    })
    .catch(rethrowCategorySlugConflict)
  return loadCategory(id)
}

/** POST /api/admin/facility-categories/reorder. */
export async function reorderFacilityCategories(body: unknown): Promise<{ ids: string[] }> {
  const { ids } = Validation.validate(FacilityValidation.REORDER, body)
  await prismaClient.$transaction(ids.map((id, index) => prismaClient.facilityCategory.updateMany({ where: { id }, data: { sortOrder: index + 1 } })))
  return { ids }
}

/** DELETE /api/admin/facility-categories/:id — ditolak bila kategori masih punya fasilitas. */
export async function destroyFacilityCategory(id: string): Promise<{ id: string }> {
  const category = await prismaClient.facilityCategory.findUnique({ where: { id }, select: { id: true, _count: { select: { facilities: true } } } })
  if (!category) throw new ResponseError(404, 'Kategori fasilitas tidak ditemukan.')
  if (category._count.facilities > 0) throw new ResponseError(422, 'Tidak bisa menghapus kategori yang masih memiliki fasilitas.')

  await prismaClient.facilityCategory.delete({ where: { id } })
  return { id }
}
