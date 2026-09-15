import { fromMinutes, isValidDateString, toMinutes, weekdayOf, WeekdayName } from '../utils/clock'
import { durationForCategoryForUnit, FacilityWithPricing, UnitWithPrices } from './pricing-services'

// ============================================================================
// === WeeklySchedule + WeeklySlots + kapasitas — port dari app/Support & model Facility ===
// ============================================================================
// Sesi TIDAK PERNAH disimpan. Setiap baris booking membawa tanggal, jam, dan harganya sendiri,
// sehingga mengubah jadwal tidak bisa menulis ulang apa pun yang sudah terjual. Ini SATU-SATUNYA
// tempat activeSlots diubah menjadi rentang jam konkret — dipakai tampilan bulan pelanggan,
// validasi POST booking, dan roster admin, supaya ketiganya tidak pernah berbeda pendapat.

const DAYS: WeekdayName[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

type SlotMap = Record<string, string[]>
type QuotaMap = Record<string, Record<string, number>>

/** Rentang [mulai, selesai] yang berlaku untuk fasilitas/unit pada satu tanggal. */
export function timeRangesFor(facility: FacilityWithPricing, unit: UnitWithPrices | null, dateStr: string): Array<[string, string]> {
  const duration = durationForCategoryForUnit(facility, unit, 'umum')
  // Unit berjadwal sendiri SELALU memakai jadwalnya (kosong pun), fasilitas bisa belum punya jadwal (null).
  const activeSlots = unit?.useCustomSchedule ? ((unit.activeSlots as SlotMap | null) ?? {}) : (facility.activeSlots as SlotMap | null)

  if (activeSlots !== null) {
    // Urutan jam mengikuti yang tersimpan — tidak diurutkan, sama seperti Laravel.
    return (activeSlots[weekdayOf(dateStr)] ?? []).map((start) => [start, fromMinutes(toMinutes(start) + duration)] as [string, string])
  }

  // Belum ada jadwal mingguan: dianggap buka 06:00-22:00 dengan kelipatan durasi.
  const ranges: Array<[string, string]> = []
  for (let current = 6 * 60; current + duration <= 22 * 60; current += duration) {
    ranges.push([fromMinutes(current), fromMinutes(current + duration)])
  }
  return ranges
}

/**
 * Kursi untuk satu sesi.
 *
 * Tanpa weekday/startTime: angka grup (headline bulan, lapangan). Dengan keduanya: kuota per slot
 * bisa menimpa angka grup (Rabu 18:00 muat 15 sementara grupnya 30). Kuota diambil dari tempat
 * yang sama dengan jam-jamnya — grup berjadwal sendiri tidak mewarisi kuota fasilitas.
 */
export function capacityFor(facility: FacilityWithPricing, unit: UnitWithPrices | null, weekday?: string, startTime?: string): number {
  let capacity = unit ? unit.capacity : (facility.capacity ?? 1)

  if (weekday !== undefined && startTime !== undefined) {
    const quotas = (unit?.useCustomSchedule ? unit.slotQuotas : facility.slotQuotas) as QuotaMap | null
    const override = quotas?.[weekday]?.[startTime.slice(0, 5)]
    if (override !== undefined && override !== null && Math.trunc(Number(override)) > 0) capacity = Math.trunc(Number(override))
  }

  return Math.max(1, capacity)
}

export function isClassMode(facility: { bookingMode: string }): boolean {
  return facility.bookingMode === 'class'
}

export function humanizeDuration(minutes: number): string {
  const safe = Math.max(1, minutes)
  const hours = Math.floor(safe / 60)
  const rest = safe % 60
  if (hours > 0 && rest > 0) return `${hours} jam ${rest} menit per sesi`
  if (hours > 0) return `${hours} jam per sesi`
  return `${rest} menit per sesi`
}

/** Catatan durasi: tulisan staff bila ada, kalau tidak dari durasi baris harga. */
export function sessionNoteFor(facility: { sessionNote: string | null }, durationMinutes: number): string {
  return facility.sessionNote || humanizeDuration(durationMinutes)
}

/**
 * closedDates yang benar-benar milik bulan ini.
 * Bug 6 Rewrite.md: roster admin Laravel membaca kolom ini MENTAH, sehingga tanggal dari bulan
 * lain tampil tertutup di roster padahal bookable bagi pelanggan. Setiap pembaca wajib lewat sini.
 */
export function cleanClosedDatesForMonth(dates: unknown, month: number, year: number): string[] {
  if (!Array.isArray(dates)) return []
  const prefix = `${year}-${String(month).padStart(2, '0')}-`
  const valid = dates.filter((d): d is string => typeof d === 'string' && isValidDateString(d) && d.startsWith(prefix))
  return [...new Set(valid)].sort()
}

// ===== WeeklySlots — pembersih bentuk mingguan dari form (dipakai panel admin, Fase 8) =====

export function normalizeSlots(slots: unknown): SlotMap {
  const normalized: SlotMap = {}
  if (!slots || typeof slots !== 'object') return normalized

  for (const [day, times] of Object.entries(slots as Record<string, unknown>)) {
    if (!DAYS.includes(day as WeekdayName)) continue
    const list = Array.isArray(times) ? times : []
    normalized[day] = [...new Set(list.filter((t): t is string => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)))].sort()
  }
  return normalized
}

/**
 * Kuota tidak boleh hidup lebih lama dari sesinya: hapus Rabu 18:00 dan "15 kursi"-nya ikut hilang,
 * alih-alih tersimpan di JSON menunggu muncul lagi saat jam itu ditambahkan kembali.
 * Batas 1..9999 (bug 8: kapasitas tanpa batas atas).
 */
export function normalizeQuotas(quotas: unknown, slots: SlotMap): QuotaMap {
  const normalized: QuotaMap = {}
  if (!quotas || typeof quotas !== 'object') return normalized

  for (const [day, byTime] of Object.entries(quotas as Record<string, unknown>)) {
    if (!byTime || typeof byTime !== 'object' || Array.isArray(byTime) || !DAYS.includes(day as WeekdayName)) continue
    for (const [time, quota] of Object.entries(byTime as Record<string, unknown>)) {
      if (!(slots[day] ?? []).includes(time)) continue
      if (quota === null || quota === '' || !Number.isFinite(Number(quota))) continue
      const value = Math.trunc(Number(quota))
      if (value >= 1 && value <= 9999) (normalized[day] ??= {})[time] = value
    }
  }
  return normalized
}
