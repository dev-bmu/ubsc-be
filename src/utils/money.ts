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

/** Nomor kuitansi: 'UBSC-' + receiptSequence 6 digit (R3). */
export function receiptNumber(receiptSequence: number): string {
  return `UBSC-${String(receiptSequence).padStart(6, '0')}`
}
