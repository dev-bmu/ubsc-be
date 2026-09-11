// ===== Emit hash kontrak saat build =====
//
// Dijalankan sebagai langkah kedua `npm run build`, SETELAH tsc:
//   tsc && node dist/scripts/write-contract-hash.js
//
// Sengaja dijalankan dari hasil kompilasi, bukan lewat tsx. Dua alasan:
//   1. yang dipakai adalah computeContractHash() yang sama persis dengan yang dipakai API,
//      jadi tidak ada salinan kedua algoritma yang bisa melenceng;
//   2. langkah build tidak lagi bergantung pada runner TypeScript apa pun — cukup node.
//
// Hasilnya ditulis ke dist/shared/contract-hash.json, bersebelahan dengan shared/*.js hasil
// kompilasi. Itulah yang dibaca src/utils/contract-hash.ts saat proses berjalan dari dist/,
// dan itulah yang membuat deploy dist-only tidak lagi bergantung pada folder sumber.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { CONTRACT_HASH_FILENAME, computeContractHash } from '../src/utils/contract-hash'

/**
 * Folder tujuan: shared/ yang bersebelahan dengan folder script ini.
 *
 * scripts/ dan shared/ bersaudara di bawah rootDir ".", dan tsc mempertahankan hubungan itu
 * (dist/scripts dan dist/shared). Jadi satu langkah naik dari __dirname sudah cukup, tanpa
 * menebak-nebak nama folder build.
 */
const targetDir = resolve(__dirname, '..', 'shared')

const main = (): void => {
  // Pagar: script ini TIDAK boleh menulis ke folder sumber. shared/contract-hash.json di sana
  // akan dibaca duluan oleh jalur dev dan membekukan hash pada nilai lama — persis kebalikan
  // dari tujuan berkas ini. Penandanya contracts.ts, yang hanya ada di folder sumber.
  if (existsSync(join(targetDir, 'contracts.ts'))) {
    throw new Error(
      `Menolak menulis ke folder sumber ${targetDir}. Script ini hanya untuk hasil build: jalankan \`npm run build\`, bukan langsung dari scripts/.`
    )
  }

  const info = computeContractHash()

  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, CONTRACT_HASH_FILENAME), `${JSON.stringify(info, null, 2)}\n`, 'utf8')

  // Daftar file ikut dicetak supaya kontrak yang tidak sengaja hilang dari build terlihat di
  // log CI, bukan baru ketahuan saat kedua app Next mengeluh hash-nya berbeda.
  const emitted = readdirSync(targetDir).filter((name) => name.endsWith('.js'))
  process.stdout.write(`Hash kontrak ${info.hash} ditulis ke ${join(targetDir, CONTRACT_HASH_FILENAME)}\n`)
  process.stdout.write(`  sumber di-hash : ${info.files.join(', ')}\n`)
  process.stdout.write(`  ikut ter-emit  : ${emitted.join(', ') || '(tidak ada .js)'}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`Gagal menulis hash kontrak: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
