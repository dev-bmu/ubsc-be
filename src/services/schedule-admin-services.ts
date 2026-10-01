import { Prisma } from '@prisma/client'
import type { AdminScheduleIndexDto, AdminScheduleMonthDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { ResponseError } from '../error/response-error'
import { addMonths, jakartaDate, now, translatedDate } from '../utils/clock'
import { CLOSED_DATE_MONTH_MESSAGE, ScheduleAdminValidation } from '../validation/schedule-admin-validation'
import { Validation } from '../validation/Validation'
import { cleanClosedDatesForMonth } from './schedule-services'

// ============================================================================
// === Pengaturan jadwal bulanan (staff) — port Admin\ScheduleController ===
// ============================================================================
// Keempat aksi Laravel (index / toggle / updateClosedDates / quickOpenNext) dipetakan satu-satu.
// Semuanya digerbangi `manage-booking-limits` = PERMISSIONS.BOOKINGS_LIMITS_MANAGE, dicek di baris
// route (details/admin-settings-schedules.ts), tidak pernah di sini.
//
// Tabel yang disentuh cuma satu: BookingSchedule, berkunci unik (month, year). Baris inilah yang
// dibaca sisi PELANGGAN untuk memutuskan bulan mana yang boleh dipesan, jadi setiap tulisan di file
// ini langsung mengubah apa yang bisa dibeli orang.
//
// Ketiga aksi tulis Laravel membalas `back()->with('success', ...)`; di sini ketiganya membalas
// BARIS BULAN YANG SUDAH DIPERBARUI dalam bentuk AdminScheduleMonthDto — transform yang sama dengan
// index — supaya panel bisa menambal satu kartu bulan tanpa memuat ulang ketujuh bulannya.

/** `range(0, 6)` di index(): bulan berjalan + 6 bulan berikutnya. */
const MONTHS_AHEAD = 7

const SCHEDULE_SELECT = {
  month: true,
  year: true,
  isOpen: true,
  closedDates: true
} satisfies Prisma.BookingScheduleSelect

type ScheduleRow = Prisma.BookingScheduleGetPayload<{ select: typeof SCHEDULE_SELECT }>

/**
 * `self::MONTH_NAMES[$month] . ' ' . $year`.
 *
 * Peta MONTH_NAMES di ScheduleController TIDAK disalin ke sini: translatedDate(..., 'F Y') di
 * utils/clock.ts sudah memuat dua belas nama bulan yang sama persis (ID_MONTHS, disalin dari
 * Lang/id.php Carbon) dan dipakai seluruh repo. Dua belas string yang sama di dua tempat hanya
 * menunggu salah satunya diperbaiki sendirian.
 */
function labelFor(month: number, year: number): string {
  return translatedDate(`${year}-${String(month).padStart(2, '0')}-01`, 'F Y')
}

/**
 * Satu entri array `$rows` milik index(). `row` null = bulan yang belum punya baris sama sekali.
 *
 * `is_open => (bool) ($schedule?->is_open ?? false)` — bulan tanpa baris dianggap TUTUP, bukan buka.
 * `closed_dates` wajib lewat cleanClosedDatesForMonth(): kolomnya bisa menyimpan tanggal milik bulan
 * lain (bug 6 Rewrite.md), dan pembaca yang membacanya mentah akan menampilkan tanggal tutup yang
 * tidak pernah benar-benar tutup bagi pelanggan.
 */
function presentMonth(month: number, year: number, row: ScheduleRow | null): AdminScheduleMonthDto {
  return {
    month,
    year,
    label: labelFor(month, year),
    isOpen: row?.isOpen ?? false,
    closedDates: cleanClosedDatesForMonth(row?.closedDates, month, year)
  }
}

// ===== 1. Index — tujuh bulan ke depan =====

/**
 * `collect(range(0, 6))->map(...)` dengan `Carbon::now()->startOfMonth()->addMonths($offset)`.
 *
 * startOfMonth() dipanggil LEBIH DULU, jadi tidak ada overflow Carbon di sini: tanggalnya selalu 01
 * sehingga +1 bulan selalu mendarat di bulan berikutnya. (Bandingkan quickOpenNext() di bawah, yang
 * urutannya terbalik dan memang overflow.) "Sekarang" dihitung di Asia/Jakarta lewat jakartaDate(),
 * bukan dari TZ proses — aturan utils/clock.ts.
 *
 * Laravel menembak satu SELECT per bulan (tujuh query). Di sini ketujuh bulan diambil dalam SATU
 * findMany lalu dipasangkan di memori: himpunan dan urutan hasilnya identik, jumlah round-trip-nya
 * tidak.
 */
export async function listAdminSchedules(): Promise<AdminScheduleIndexDto> {
  const startOfMonth = `${jakartaDate(now()).slice(0, 7)}-01`

  const wanted = Array.from({ length: MONTHS_AHEAD }, (_, offset) => {
    const date = addMonths(startOfMonth, offset)
    return { month: Number(date.slice(5, 7)), year: Number(date.slice(0, 4)) }
  })

  const rows = await prismaClient.bookingSchedule.findMany({
    where: { OR: wanted.map(({ month, year }) => ({ month, year })) },
    select: SCHEDULE_SELECT
  })

  const byKey = new Map(rows.map((row) => [`${row.year}-${row.month}`, row]))

  return {
    schedules: wanted.map(({ month, year }) => presentMonth(month, year, byKey.get(`${year}-${month}`) ?? null))
  }
}

// ===== 2. Toggle — buka/tutup satu bulan =====

/**
 * `firstOrNew([month, year])` lalu `is_open = !is_open` lalu `save()`.
 *
 * Perhatikan konsekuensi firstOrNew yang mudah terlewat: bulan yang BELUM punya baris berangkat dari
 * is_open = false (default kolom), jadi toggle pertama selalu MEMBUKA bulan itu dan sekaligus
 * membuat barisnya. Itu perilaku Laravel dan sengaja dipertahankan.
 *
 * upsert() Prisma di sini setara save() atas hasil firstOrNew, dan berjalan atomik terhadap kunci
 * unik (month, year) sehingga dua staff yang menekan tombol bersamaan tidak melahirkan baris ganda.
 * Yang TIDAK dijamin: nilai akhirnya bila keduanya menekan pada saat yang sama — sama seperti di
 * Laravel, pembacaan dan penulisannya bukan satu transaksi. Ini tombol idempoten di layar yang
 * dipegang satu orang, bukan penghitung.
 */
export async function toggleSchedule(request: unknown): Promise<AdminScheduleMonthDto> {
  const v = Validation.validate(ScheduleAdminValidation.TOGGLE, request)

  const existing = await prismaClient.bookingSchedule.findUnique({
    where: { month_year: { month: v.month, year: v.year } },
    select: { isOpen: true }
  })

  const isOpen = !(existing?.isOpen ?? false)

  const row = await prismaClient.bookingSchedule.upsert({
    where: { month_year: { month: v.month, year: v.year } },
    create: { month: v.month, year: v.year, isOpen },
    update: { isOpen },
    select: SCHEDULE_SELECT
  })

  return presentMonth(v.month, v.year, row)
}

// ===== 3. Update closed dates — tanggal tutup satu bulan =====

/**
 * Tiga langkah controller Laravel, dengan urutan yang dipertahankan karena urutannya menentukan
 * pesan error mana yang dilihat user:
 *
 *   1. tiap tanggal wajib benar-benar ada (ditegakkan schema, lihat closedDateField)
 *   2. unique + sort + values  -> daftar rapi, tanpa duplikat, terurut
 *   3. baru kemudian: adakah tanggal yang BUKAN milik bulan yang sedang diedit -> 422
 *
 * Langkah 3 bukan formalitas. Tanpa pagar itu, layar bulan September bisa menuliskan tanggal Oktober
 * ke baris September — dan pembaca mana pun yang lupa memanggil cleanClosedDatesForMonth() akan
 * menutup hari yang sebenarnya dijual (bug 6 Rewrite.md). Pagar ini menjaga kolomnya tetap bersih
 * SEJAK DITULIS, bukan hanya saat dibaca.
 *
 * `updateOrCreate` hanya menulis closed_dates: bulan yang barisnya baru dibuat di sini tetap
 * is_open = false (default kolom), persis Laravel.
 */
export async function updateScheduleClosedDates(request: unknown): Promise<AdminScheduleMonthDto> {
  const v = Validation.validate(ScheduleAdminValidation.CLOSED_DATES, request)

  // ->unique()->sort()->values() Laravel. Set + sort() JS: keduanya membandingkan string, dan
  // 'YYYY-MM-DD' memang terurut benar secara leksikografis.
  const closedDates = [...new Set(v.closedDates)].sort()

  const prefix = `${v.year}-${String(v.month).padStart(2, '0')}-`
  if (closedDates.some((date) => !date.startsWith(prefix))) {
    throw new ResponseError(422, CLOSED_DATE_MONTH_MESSAGE, 'VALIDATION_ERROR', { closedDates: [CLOSED_DATE_MONTH_MESSAGE] })
  }

  const row = await prismaClient.bookingSchedule.upsert({
    where: { month_year: { month: v.month, year: v.year } },
    create: { month: v.month, year: v.year, closedDates },
    update: { closedDates },
    select: SCHEDULE_SELECT
  })

  return presentMonth(v.month, v.year, row)
}

// ===== 4. Quick open next — buka bulan depan dengan satu klik =====

/**
 * `Carbon::now()->addMonth()->startOfMonth()`.
 *
 * URUTANNYA TERBALIK dari index() dan itu BUKAN salah ketik di sini: addMonth() dijalankan atas
 * tanggal hari ini, BARU kemudian dipotong ke awal bulan. Carbon (dan Date.setUTCMonth, karena itu
 * juga addMonths() di utils/clock.ts) meluap saat bulan tujuan lebih pendek — 31 Januari + 1 bulan
 * = 3 Maret, lalu startOfMonth menjadikannya MARET, bukan Februari.
 *
 * Artinya: bila staff menekan "buka bulan depan" pada tanggal 29/30/31 Januari, yang terbuka adalah
 * Maret dan Februari terlewat. Itu cacat yang sudah ada di Laravel dan TIDAK diperbaiki di sini
 * (1:1) — memperbaikinya diam-diam berarti dua sistem yang sama-sama berjalan memberi jawaban
 * berbeda untuk satu klik yang sama. Balasannya memuat month/year/label, jadi panel tetap bisa
 * menunjukkan bulan mana yang sebenarnya terbuka.
 */
export async function quickOpenNextSchedule(): Promise<AdminScheduleMonthDto> {
  const next = addMonths(jakartaDate(now()), 1)
  const month = Number(next.slice(5, 7))
  const year = Number(next.slice(0, 4))

  const row = await prismaClient.bookingSchedule.upsert({
    where: { month_year: { month, year } },
    create: { month, year, isOpen: true },
    update: { isOpen: true },
    select: SCHEDULE_SELECT
  })

  return presentMonth(month, year, row)
}
