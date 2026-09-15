import { FacilityPrice, FacilityUnitPrice, IdentityCategory, IdentityStatus, Prisma, UserCategory } from '@prisma/client'
import { weekdayOf, toMinutes } from '../utils/clock'

// ============================================================================
// === FacilityPriceResolver — port baris-per-baris dari app/Support ===
// ============================================================================
// Urutan tier yang TIDAK boleh berubah:
//   1. harga "special" (label bukan 'Reguler') pertama yang matches()
//   2. baris berlabel 'Reguler'
//   3. baris pertama kategori itu
// schedule_type 'regular' TIDAK PERNAH match — ia tier fallback, bukan rule.
// Harga unit menang HANYA jika useCustomPricing true DAN unit punya >= 1 baris harga.
//
// Catatan urutan: Laravel membaca `$facility->prices` dalam urutan alami PK auto-increment, lalu
// sortBy(sort_order) yang STABIL. PK di sini uuid (urutan acak), jadi urutan alami direproduksi
// dengan orderBy createdAt pada include (lihat FACILITY_WITH_PRICING), dan sortBySortOrder() di
// bawah adalah sort stabil yang sama. Beberapa fallback Laravel sengaja TIDAK diurutkan sort_order
// (`$prices->where(...)->first()`) — itu dipertahankan apa adanya.

export const FACILITY_WITH_PRICING = {
  prices: { orderBy: { createdAt: 'asc' } },
  units: { orderBy: { createdAt: 'asc' }, include: { prices: { orderBy: { createdAt: 'asc' } } } }
} as const satisfies Prisma.FacilityInclude

export type FacilityWithPricing = Prisma.FacilityGetPayload<{ include: typeof FACILITY_WITH_PRICING }>
export type UnitWithPrices = FacilityWithPricing['units'][number]
type PriceRow = FacilityPrice | FacilityUnitPrice

/** Kategori harga pengunjung anonim dan pelanggan belum terverifikasi. */
export const DEFAULT_PRICE_CATEGORY: UserCategory = 'umum'

/** Sort stabil menurut sortOrder (Array.prototype.sort stabil sejak ES2019). */
function sortBySortOrder<T extends PriceRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
}

function pickTier<T extends PriceRow>(categoryPrices: T[], dateStr: string, startTime: string, endTime: string): T | null {
  const special = categoryPrices.filter((p) => p.label !== 'Reguler').find((p) => matches(p, dateStr, startTime, endTime))
  if (special) return special
  return categoryPrices.find((p) => p.label === 'Reguler') ?? categoryPrices[0] ?? null
}

export function resolve(
  facility: FacilityWithPricing,
  userCategory: UserCategory,
  dateStr: string,
  startTime: string,
  endTime: string
): FacilityPrice | null {
  const categoryPrices = sortBySortOrder(facility.prices.filter((p) => p.userCategory === userCategory))
  return pickTier(categoryPrices, dateStr, startTime, endTime)
}

function unitHasUsableCustomPrices(unit: UnitWithPrices): boolean {
  return unit.useCustomPricing && unit.prices.length > 0
}

export function resolveForUnit(
  facility: FacilityWithPricing,
  unit: UnitWithPrices | null,
  userCategory: UserCategory,
  dateStr: string,
  startTime: string,
  endTime: string
): PriceRow | null {
  if (!unit || !unitHasUsableCustomPrices(unit)) return resolve(facility, userCategory, dateStr, startTime, endTime)

  const categoryPrices = sortBySortOrder(unit.prices.filter((p) => p.userCategory === userCategory))
  // Unit punya harga custom tapi tidak untuk kategori ini -> jatuh ke harga fasilitas.
  return pickTier(categoryPrices, dateStr, startTime, endTime) ?? resolve(facility, userCategory, dateStr, startTime, endTime)
}

export function priceForSlotForUnit(
  facility: FacilityWithPricing,
  unit: UnitWithPrices | null,
  userCategory: UserCategory,
  dateStr: string,
  startTime: string,
  endTime: string
): number {
  return resolveForUnit(facility, unit, userCategory, dateStr, startTime, endTime)?.price ?? 0
}

function durationFrom(prices: PriceRow[], userCategory: UserCategory): PriceRow | null {
  const inCategory = prices.filter((p) => p.userCategory === userCategory)
  return sortBySortOrder(inCategory).find((p) => p.label === 'Reguler') ?? inCategory[0] ?? sortBySortOrder(prices)[0] ?? null
}

export function durationForCategory(facility: FacilityWithPricing, userCategory: UserCategory): number {
  // `?: 60` di PHP: null DAN 0 sama-sama jatuh ke 60.
  return durationFrom(facility.prices, userCategory)?.durationMinutes || 60
}

export function durationForCategoryForUnit(facility: FacilityWithPricing, unit: UnitWithPrices | null, userCategory: UserCategory): number {
  if (!unit || !unitHasUsableCustomPrices(unit)) return durationForCategory(facility, userCategory)
  return durationFrom(unit.prices, userCategory)?.durationMinutes || durationForCategory(facility, userCategory)
}

/**
 * Harga paket sebulan penuh untuk kelas, atau null bila staff belum mengaturnya.
 *
 * Paket adalah angkanya sendiri — bukan jumlah sesi dan bukan persen diskon. Baris unit menang atas
 * baris fasilitas. Perhatikan: Laravel TIDAK memeriksa useCustomPricing di sini (berbeda dari harga
 * per sesi) — dipertahankan apa adanya.
 */
export function packagePrice(facility: FacilityWithPricing, unit: UnitWithPrices | null, userCategory: UserCategory): number | null {
  const isPackage = (p: PriceRow) => p.userCategory === userCategory && p.priceType === 'monthly_package'
  const fromUnit = unit?.prices.find(isPackage)
  if (fromUnit) return fromUnit.price
  return facility.prices.find(isPackage)?.price ?? null
}

/** Harga untuk rentang [start, end] berdasarkan durasi baris harga (prorata per durasi). */
export function calculateSubtotal(
  facility: FacilityWithPricing,
  unit: UnitWithPrices | null,
  userCategory: UserCategory,
  dateStr: string,
  startTime: string,
  endTime: string
): number {
  const price = resolveForUnit(facility, unit, userCategory, dateStr, startTime, endTime)
  if (!price) return 0
  const durationMinutes = toMinutes(endTime) - toMinutes(startTime)
  // PHP round() membulatkan menjauhi nol; untuk bilangan positif identik dengan Math.round.
  return price.durationMinutes ? Math.round((durationMinutes / price.durationMinutes) * price.price) : price.price
}

function matches(price: PriceRow, dateStr: string, startTime: string, endTime: string): boolean {
  const scheduleType = price.scheduleType || 'always'

  if (scheduleType === 'regular') return false

  if (scheduleType === 'weekly') {
    const days = Array.isArray(price.applicableDays) ? (price.applicableDays as string[]) : []
    if (days.length > 0 && !days.includes(weekdayOf(dateStr))) return false
  }

  if (scheduleType === 'date_range') {
    const startsOn = price.startsOn ? price.startsOn.toISOString().slice(0, 10) : null
    const endsOn = price.endsOn ? price.endsOn.toISOString().slice(0, 10) : null
    if (startsOn && dateStr < startsOn) return false
    if (endsOn && dateStr > endsOn) return false
  }

  return matchesTimeRange(price, startTime, endTime)
}

function matchesTimeRange(price: PriceRow, startTime: string, endTime: string): boolean {
  if (!price.startsAt && !price.endsAt) return true

  const slotStart = toMinutes(startTime)
  const slotEnd = toMinutes(endTime)
  const rangeStart = toMinutes(price.startsAt ?? '00:00')
  const rangeEnd = toMinutes(price.endsAt ?? '23:59')

  // Rentang melewati tengah malam (mis. 22:00-02:00).
  if (rangeEnd <= rangeStart) return slotStart >= rangeStart || slotEnd <= rangeEnd

  return slotStart >= rangeStart && slotEnd <= rangeEnd
}

interface PricedUser {
  identityCategory: IdentityCategory | null
  identityStatus: IdentityStatus
}

/**
 * Kategori harga warga kampus butuh identitas yang SUDAH DIVERIFIKASI.
 *
 * Bug 2 Rewrite.md: panel admin Laravel hanya mengecek `warga_kampus` (tanpa verified), sehingga
 * antrean verifikasi identitas tidak menentukan apa pun di sisi admin. Satu fungsi ini dipakai
 * kedua jalur — publik dan admin — dengan aturan yang ketat.
 */
export function priceCategoryFor(user: PricedUser | null | undefined): UserCategory {
  return user && user.identityCategory === 'warga_kampus' && user.identityStatus === 'verified' ? 'warga_ub' : 'umum'
}
