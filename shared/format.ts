// ===== Format Indonesia (SUMBER KEBENARAN) =====
//
// Satu implementasi untuk tiga repo. File ini disalin apa adanya ke ubsc-landing dan
// ubsc-admin lewat npm run sync:contracts — jangan menulis formatter Rupiah/tanggal
// kedua di repo mana pun (R13: timezone & locale melenceng di 3 proses + MySQL + Intl).
//
// Aturan zona waktu yang tidak boleh dilanggar:
//   UTC di database dan di kabel, Asia/Jakarta HANYA saat render.
// Karena itu setiap pemanggilan Intl di bawah menyertakan timeZone secara eksplisit dan
// tidak pernah bergantung pada zona waktu proses. Server dev di Windows, server produksi
// di Linux, dan browser user bisa berbeda-beda — hasil fungsi-fungsi ini tidak boleh ikut
// berbeda.
//
// Semua fungsi menerima string | number | Date, dan mengembalikan '-' untuk input tidak
// valid. Tidak ada yang melempar: formatter dipakai di dalam render, dan satu tanggal
// rusak dari DB tidak boleh menjatuhkan satu halaman penuh.

export const TIMEZONE = 'Asia/Jakarta'
export const LOCALE = 'id-ID'

/** Nilai yang dikembalikan untuk input kosong atau tidak valid. */
export const EMPTY_PLACEHOLDER = '-'

export type DateInput = string | number | Date | null | undefined
export type NumberInput = number | string | null | undefined

// ===== Helper internal =====

/** Ubah input jadi Date. Mengembalikan null bila kosong atau tidak valid. */
const toDate = (value: DateInput): Date | null => {
  if (value === null || value === undefined || value === '') return null

  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Ambil bagian-bagian tanggal dalam zona Asia/Jakarta sebagai peta.
 *
 * Sengaja memakai formatToParts lalu merangkai sendiri, bukan format() langsung: pola
 * locale id-ID bisa bergeser antar versi ICU (Node 24 di server, ICU browser di klien),
 * dan hasil render tidak boleh ikut bergeser. Nama bulan tetap datang dari ICU.
 */
const partsOf = (date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> => {
  const parts = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: TIMEZONE }).formatToParts(date)

  const result: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = part.value
  }

  return result
}

// ===== Uang =====

/**
 * Rupiah tanpa desimal: 1500000 -> "Rp 1.500.000".
 *
 * Memakai NumberFormat polos lalu menempelkan prefiks "Rp " sendiri, bukan
 * style: 'currency'. Alasannya dua: currency IDR di sebagian versi ICU menyisipkan
 * NBSP (U+00A0) setelah "Rp" sehingga string tidak pernah cocok saat dibandingkan, dan
 * bentuk di bawah persis sama dengan yang dipakai aplikasi Laravel lama ("Rp " + toLocaleString)
 * sehingga screenshot diff Fase 4-8 tidak ikut bergeser.
 *
 * Nilai negatif menghasilkan "Rp -1.500" — paritas dengan Laravel, bukan "-Rp 1.500".
 */
export const formatRupiah = (value: NumberInput): string => {
  if (value === null || value === undefined || value === '') return EMPTY_PLACEHOLDER

  // Kolom uang bisa tiba sebagai string (Prisma Decimal ter-serialisasi JSON).
  const amount = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(amount)) return EMPTY_PLACEHOLDER

  return `Rp ${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(amount)}`
}

/** Angka gaya Indonesia tanpa prefiks: 1500000 -> "1.500.000". Dipakai untuk kuota, jumlah kunjungan, dll. */
export const formatNumberID = (value: NumberInput): string => {
  if (value === null || value === undefined || value === '') return EMPTY_PLACEHOLDER

  const amount = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(amount)) return EMPTY_PLACEHOLDER

  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(amount)
}

// ===== Tanggal & jam =====

/** Jam gaya Indonesia: "14.30". Selalu 24 jam (hourCycle h23, supaya tengah malam jadi "00.00", bukan "24.00"). */
export const formatTimeID = (value: DateInput): string => {
  const date = toDate(value)
  if (!date) return EMPTY_PLACEHOLDER

  const parts = partsOf(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${parts.hour}.${parts.minute}`
}

/**
 * Tanggal panjang: "20 Maret 2025". Dengan withTime: "20 Maret 2025, 14.30".
 * Waktu selalu diterjemahkan ke Asia/Jakarta lebih dulu — booking 23.30 WIB yang disimpan
 * sebagai 16.30 UTC harus tetap terbaca tanggal 20, bukan 20 atau 21 tergantung server.
 */
export const formatDateID = (value: DateInput, withTime = false): string => {
  const date = toDate(value)
  if (!date) return EMPTY_PLACEHOLDER

  const parts = partsOf(date, { day: 'numeric', month: 'long', year: 'numeric' })
  const formatted = `${parts.day} ${parts.month} ${parts.year}`

  return withTime ? `${formatted}, ${formatTimeID(date)}` : formatted
}

/** Tanggal + jam: "20 Maret 2025, 14.30". */
export const formatDateTimeID = (value: DateInput): string => formatDateID(value, true)

/** Tanggal ringkas untuk tabel dan kartu: "20 Mar 2025". */
export const formatDateShortID = (value: DateInput): string => {
  const date = toDate(value)
  if (!date) return EMPTY_PLACEHOLDER

  const parts = partsOf(date, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${parts.day} ${parts.month} ${parts.year}`
}

/** Tanggal panjang berhari: "Kamis, 20 Maret 2025". Dipakai header jadwal dan detail booking. */
export const formatDateLongID = (value: DateInput): string => {
  const date = toDate(value)
  if (!date) return EMPTY_PLACEHOLDER

  const parts = partsOf(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`
}

/**
 * Kunci tanggal "YYYY-MM-DD" menurut Asia/Jakarta.
 *
 * BUKAN formatter tampilan — ini yang dipakai saat membandingkan sebuah DateTime UTC dengan
 * kolom tanggal booking, atau saat menyusun query grid jadwal. Jangan pakai
 * toISOString().slice(0, 10): itu memberi tanggal UTC dan menggeser hari untuk setiap jam
 * setelah 17.00 UTC.
 */
export const toJakartaDateKey = (value: DateInput): string => {
  const date = toDate(value)
  if (!date) return EMPTY_PLACEHOLDER

  const parts = partsOf(date, { day: '2-digit', month: '2-digit', year: 'numeric' })
  return `${parts.year}-${parts.month}-${parts.day}`
}
