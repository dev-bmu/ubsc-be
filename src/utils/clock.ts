// ============================================================================
// === Waktu & tanggal (R13) ===
// ============================================================================
// Aturan tunggal untuk seluruh domain booking:
//
//  - Di DB dan di kabel: UTC. Kolom @db.Date (bookingDate, startDate, ...) disimpan sebagai
//    tengah malam UTC dari tanggal kalender Jakarta-nya — "2026-09-15" = 2026-09-15T00:00:00Z.
//  - Jam dinding (startTime "08:00") selalu jam Jakarta.
//  - "Hari ini" dan "jam sekarang" SELALU dihitung di Asia/Jakarta secara eksplisit, tidak pernah
//    bergantung pada TZ proses. PM2 memang mematok TZ=Asia/Jakarta, tapi test dan mesin dev tidak
//    boleh diam-diam menghasilkan hari yang berbeda.
//  - JANGAN NOW() di SQL. Waktu dikirim sebagai parameter dari now() di bawah, supaya test bisa
//    memajukan jam dan supaya job release hold tidak bergantung jam server DB.
//
// Asia/Jakarta adalah UTC+7 tetap (tanpa DST sejak 1964), jadi offset konstan aman dipakai.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000

let frozenNow: Date | null = null

/** Waktu sekarang. Satu-satunya sumber "sekarang" di domain booking. */
export function now(): Date {
  return frozenNow ? new Date(frozenNow.getTime()) : new Date()
}

/** Khusus test: bekukan jam. `null` mengembalikan jam sungguhan. */
export function setNowForTests(value: Date | null): void {
  frozenNow = value ? new Date(value.getTime()) : null
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/** Komponen kalender Jakarta dari sebuah instan. */
function jakartaParts(instant: Date) {
  const shifted = new Date(instant.getTime() + JAKARTA_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  }
}

/** "YYYY-MM-DD" hari ini (atau instan tertentu) di Jakarta. */
export function jakartaDate(instant: Date = now()): string {
  const p = jakartaParts(instant)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** "HH:mm" sekarang (atau instan tertentu) di Jakarta. */
export function jakartaHm(instant: Date = now()): string {
  const p = jakartaParts(instant)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * Tanggal kalender + jam dinding Jakarta -> instan UTC.
 * "2026-09-15" + "08:00" -> 2026-09-15T01:00:00Z. Dipakai untuk Booking.startsAt / endsAt.
 */
export function jakartaWallTimeToUtc(dateStr: string, hm: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, h, mi) - JAKARTA_OFFSET_MS)
}

/** "YYYY-MM-DD" -> Date tengah malam UTC, bentuk yang disimpan kolom @db.Date. */
export function dateOnly(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Kebalikan dateOnly(): nilai kolom @db.Date -> "YYYY-MM-DD". */
export function dateOnlyToString(value: Date): string {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
}

/** Validasi ketat "YYYY-MM-DD" yang benar-benar tanggal (2026-02-30 ditolak). */
export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return dateOnlyToString(dateOnly(value)) === value
}

/** Tanggal kalender + n hari. */
export function addDays(dateStr: string, days: number): string {
  const d = dateOnly(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return dateOnlyToString(d)
}

/**
 * Tanggal kalender + n bulan, dengan OVERFLOW seperti Carbon::addMonths():
 * 2026-01-31 + 1 bulan = 2026-03-03. Date.setUTCMonth berperilaku persis sama.
 */
export function addMonths(dateStr: string, months: number): string {
  const d = dateOnly(dateStr)
  d.setUTCMonth(d.getUTCMonth() + months)
  return dateOnlyToString(d)
}

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export type WeekdayName = (typeof WEEKDAYS_EN)[number]

/** Nama hari Inggris — kunci yang dipakai kolom activeSlots / slotQuotas ("Wednesday"). */
export function weekdayOf(dateStr: string): WeekdayName {
  return WEEKDAYS_EN[dateOnly(dateStr).getUTCDay()]
}

/** Jumlah hari dalam bulan. month 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** "08:30" -> 510 */
export function toMinutes(hm: string): number {
  const [h, m] = hm.slice(0, 5).split(':').map(Number)
  return h * 60 + m
}

/** 510 -> "08:30" (tanpa wrap 24 jam, sama seperti sprintf di WeeklySchedule Laravel). */
export function fromMinutes(total: number): string {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

// ===== Format tanggal berparitas Carbon (locale id) =====
// Intl id-ID TIDAK dipakai untuk teks yang dikirim ke klien: Intl menulis Agustus pendek "Agu",
// Carbon menulis "Agt" (terverifikasi dari PHP: translatedFormat('D, d M Y') -> "Sen, 17 Agt 2026").
// Array di bawah disalin dari vendor/nesbot/carbon/src/Carbon/Lang/id.php.

const ID_MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember']
const ID_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des']
const ID_WEEKDAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const ID_WEEKDAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']
const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

function render(parts: Parts, pattern: string, translated: boolean): string {
  let out = ''
  for (const ch of pattern) {
    switch (ch) {
      case 'Y':
        out += String(parts.year)
        break
      case 'm':
        out += pad(parts.month)
        break
      case 'd':
        out += pad(parts.day)
        break
      case 'H':
        out += pad(parts.hour)
        break
      case 'i':
        out += pad(parts.minute)
        break
      case 'F':
        out += ID_MONTHS[parts.month - 1]
        break
      case 'M':
        out += (translated ? ID_MONTHS_SHORT : EN_MONTHS_SHORT)[parts.month - 1]
        break
      case 'l':
        out += ID_WEEKDAYS[parts.weekday]
        break
      case 'D':
        out += ID_WEEKDAYS_SHORT[parts.weekday]
        break
      default:
        out += ch
    }
  }
  return out
}

/**
 * Setara `$carbonDate->translatedFormat($pattern)` untuk tanggal kalender (tanpa jam).
 * Token yang didukung: Y m d F M l D.
 */
export function translatedDate(dateStr: string, pattern: string): string {
  const d = dateOnly(dateStr)
  return render(
    { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, weekday: d.getUTCDay() },
    pattern,
    true
  )
}

/**
 * Setara `$carbonDateTime->format($pattern)` (TIDAK diterjemahkan — "M" bahasa Inggris) untuk
 * sebuah instan, di jam Jakarta. Laravel memakai ini untuk created_at / checked_in_at.
 */
export function formatInstant(instant: Date, pattern: string): string {
  return render(jakartaParts(instant), pattern, false)
}
