// ===== Normalisasi jadwal mingguan =====
// Port dari app/Support/WeeklySlots.php. Baik form fasilitas maupun form unit mem-post dua struktur
// yang sama (activeSlots + slotQuotas); aturan pembersihannya dikunci di sini supaya kuota tidak
// pernah hidup lebih lama dari slot pemiliknya (hapus Rabu 18:00 -> kuotanya ikut hilang).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const HHMM = /^\d{2}:\d{2}$/

export type WeeklySlots = Record<string, string[]>
export type SlotQuotas = Record<string, Record<string, number>>

/** Buang hari tak dikenal, waktu non-"HH:mm", duplikat; urutkan tiap hari. */
export function normalizeSlots(slots: unknown): WeeklySlots {
  const normalized: WeeklySlots = {}
  if (!slots || typeof slots !== 'object') return normalized

  for (const day of DAYS) {
    const times = (slots as Record<string, unknown>)[day]
    if (!Array.isArray(times)) continue
    const clean = [...new Set(times.filter((time): time is string => typeof time === 'string' && HHMM.test(time)))].sort()
    if (clean.length > 0) normalized[day] = clean
  }

  return normalized
}

/** Simpan kuota HANYA untuk slot yang ada di jadwal dan bernilai integer 1..9999. */
export function normalizeQuotas(quotas: unknown, slots: WeeklySlots): SlotQuotas {
  const normalized: SlotQuotas = {}
  if (!quotas || typeof quotas !== 'object') return normalized

  for (const day of DAYS) {
    const byTime = (quotas as Record<string, unknown>)[day]
    if (!byTime || typeof byTime !== 'object') continue

    for (const [time, raw] of Object.entries(byTime as Record<string, unknown>)) {
      if (!(slots[day] ?? []).includes(time)) continue
      if (raw === null || raw === '' || raw === undefined) continue
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      const int = Math.trunc(value)
      if (int >= 1 && int <= 9999) {
        if (!normalized[day]) normalized[day] = {}
        normalized[day][time] = int
      }
    }
  }

  return normalized
}

/** Port Facility::humanizeDuration(). "90" -> "1 jam 30 menit per sesi". */
export function humanizeDuration(minutes: number): string {
  const total = Math.max(1, Math.trunc(minutes))
  const hours = Math.trunc(total / 60)
  const rest = total % 60
  if (hours > 0 && rest > 0) return `${hours} jam ${rest} menit per sesi`
  if (hours > 0) return `${hours} jam per sesi`
  return `${rest} menit per sesi`
}
