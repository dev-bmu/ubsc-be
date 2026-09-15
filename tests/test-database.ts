// ===== Database test =====
// Satu sumber untuk URL database test, dipakai global-setup (proses induk Jest) dan setup-env
// (setiap berkas test).

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'mysql://root@localhost:3306/ubsc_test'

/**
 * Test MENGOSONGKAN tabel. Salah arah DATABASE_URL — misalnya .env dev yang terbaca — berarti data
 * dev atau produksi hilang. Nama database WAJIB berakhiran _test; selain itu suite berhenti sebelum
 * menyentuh apa pun.
 */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '')
  if (!name.endsWith('_test')) {
    throw new Error(`Database test harus bernama *_test, didapat "${name}". Set TEST_DATABASE_URL ke database khusus test.`)
  }
}
