// ===== Uang =====

/**
 * Setara `'Rp ' . number_format($amount, 0, ',', '.')` di Laravel — dipakai untuk string harga
 * yang dikirim API ke klien (slot, ringkasan bulan) supaya byte-nya identik dengan yang dirender
 * Laravel sekarang.
 *
 * Sengaja BUKAN formatRupiah() di shared/format.ts: Intl id-ID menaruh non-breaking space (U+00A0)
 * setelah "Rp", PHP menaruh spasi biasa. Perbedaan itu mengubah titik pemenggalan baris di kartu
 * harga yang sempit.
 */
export function rupiahPlain(amount: number): string {
  const rounded = Math.round(Math.abs(amount))
  const grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `Rp ${amount < 0 ? '-' : ''}${grouped}`
}

/** Label harga slot seperti Laravel: harga 0 berarti belum diatur -> "Hubungi Kami". */
export function slotPriceLabel(price: number): string {
  return price > 0 ? rupiahPlain(price) : 'Hubungi Kami'
}

/**
 * Yang benar-benar ditransfer pelanggan: harga + biaya admin + kode unik. Satu-satunya tempat rumus
 * ini ditulis — setiap tampilan nominal transfer dan setiap hitungan uang masuk lewat sini.
 */
export function transferTotal(t: { amount: number; adminFee: number; uniqueCode: number | null }): number {
  return t.amount + t.adminFee + (t.uniqueCode ?? 0)
}

const ROMAN_MONTHS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

/**
 * Nomor invoice: 'UBSC-<bulan romawi>-<tahun>-<urutan 4 digit>', mis. 'UBSC-X-2026-0001'. Urutannya
 * per tahun (invoice_counters); lebih dari 9999 setahun tetap bertambah digit. Tersimpan di
 * Transaction.invoiceNumber — fungsi ini hanya dipakai saat menerbitkannya.
 */
export function invoiceNumber(month: number, year: number, sequence: number): string {
  return `UBSC-${ROMAN_MONTHS[month - 1]}-${year}-${String(sequence).padStart(4, '0')}`
}

// ===== Nomor member =====
// Client minta nomor member tidak berurutan (2026-09-28): 'UB-000007' membocorkan jumlah akun dan
// nomor tetangganya mudah ditebak. customerSequence tetap jadi kunci di DB; yang tampil adalah hasil
// permutasi Feistel 40-bit darinya, ditulis 8 karakter Crockford base32 ('UB-7K3F-92QX'). Permutasi
// = bijeksi, jadi unik tanpa kolom baru dan tanpa retry tabrakan, dan bisa dibalik saat FO mengetik.
// Ini penyamaran, bukan rahasia: pengaman di meja gym tetap foto yang dicocokkan petugas.

/** Crockford base32: tanpa I, L, O, U supaya tidak tertukar dengan 1 dan 0 saat diketik. */
const MEMBER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const HALF = 2 ** 20
/** JANGAN DIUBAH: mengganti kunci mengganti nomor di setiap kartu member yang sudah beredar. */
const ROUND_KEYS = [0x5a3c1, 0xc7e29, 0x3b6d4, 0x91f0e]

function mix(x: number, key: number): number {
  let h = Math.imul(x ^ key, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return h & (HALF - 1)
}

function permute(n: number, inverse: boolean): number {
  let left = Math.floor(n / HALF)
  let right = n % HALF
  for (const key of inverse ? [...ROUND_KEYS].reverse() : ROUND_KEYS) {
    if (inverse) [left, right] = [right ^ mix(left, key), left]
    else [left, right] = [right, left ^ mix(right, key)]
  }
  return left * HALF + right
}

/** Nomor member: 'UB-' + 8 karakter acak-tampak dari customerSequence. Satu orang satu nomor, seumur akun. */
export function customerNumber(customerSequence: number): string {
  let n = permute(customerSequence, false)
  let code = ''
  for (let i = 0; i < 8; i++) {
    code = MEMBER_ALPHABET[n % 32] + code
    n = Math.floor(n / 32)
  }
  return `UB-${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * Kebalikan customerNumber() untuk nomor yang dipindai atau diketik FO: huruf kecil, tanpa 'UB', tanpa
 * strip, dan O/I/L yang tertukar dengan 0/1 tetap terbaca. null bila bukan nomor member.
 */
export function parseCustomerNumber(input: string): number | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '').replace(/^UB/, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(compact)) return null
  let n = 0
  for (const ch of compact) n = n * 32 + MEMBER_ALPHABET.indexOf(ch)
  const sequence = permute(n, true)
  return sequence >= 1 && sequence <= 2147483647 ? sequence : null
}

/** ID pelanggan di Accurate: 'WEB.' + 4 digit (lebih dari 9999 tetap bertambah digit). */
export function accurateCustomerId(accurateSequence: number): string {
  return `WEB.${String(accurateSequence).padStart(4, '0')}`
}
