// ===== Cetak hash kontrak =====
//
// Pemakaian:
//   npm run contract:hash            -> cetak hash saja, satu baris
//   npm run contract:hash -- --json  -> cetak ContractHashDto lengkap
//
// Bentuk satu baris itu disengaja supaya bisa dipipa di CI dan di script sync:contracts
// kedua repo Next:
//   test "$(npm run --silent contract:hash)" = "$(cat src/types/contracts/.hash)"
//
// Memanggil computeContractHash() langsung, BUKAN getContractHash(): script ini harus
// selalu mencerminkan isi shared/*.ts saat ini, tanpa cache proses dan tanpa membaca
// contract-hash.json hasil build yang bisa saja tertinggal satu commit di belakang.

import { computeContractHash } from '../src/utils/contract-hash'

const main = (): void => {
  const info = computeContractHash()

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
    return
  }

  process.stdout.write(`${info.hash}\n`)
}

try {
  main()
} catch (error) {
  // stderr, supaya stdout tetap bersih untuk pipa di atas.
  process.stderr.write(`Gagal menghitung hash kontrak: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
