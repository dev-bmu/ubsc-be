// ===== Hash kontrak =====
//
// Menghitung sha256 deterministik atas isi folder shared/. Nilainya disajikan lewat
// GET /api/meta/contract-hash dan dibandingkan kedua app Next saat boot dev dengan hash
// salinannya sendiri di src/types/contracts/.
//
// Determinisme lintas OS adalah inti gunanya, bukan detail. Dev berjalan di Windows dan
// produksi di Linux; kalau hash berubah hanya karena CRLF atau urutan baca direktori, alat
// ini justru menjadi sumber alarm palsu dan akan diabaikan orang dalam seminggu. Tiga hal
// yang menjaganya:
//   1. daftar file diurutkan sendiri dengan perbandingan kode unit, bukan localeCompare
//      (localeCompare bergantung ICU dan bisa berbeda antar mesin)
//   2. setiap newline dinormalisasi ke LF, dan BOM dibuang
//   3. nama file ikut di-hash, sehingga menambah file kosong pun mengubah hash
//
// ===== Kenapa hash-nya dihasilkan saat BUILD, bukan dihitung ulang saat runtime =====
//
// Yang di-hash adalah isi shared/*.ts. Di dist/ file itu sudah menjadi shared/*.js dengan
// isi yang sama sekali berbeda — tipe murni bahkan menguap jadi file nyaris kosong. Jadi
// runtime di produksi TIDAK punya bahan untuk menghitung hash yang sama, dan versi lama
// file ini menutupinya dengan menaiki direktori sampai menemukan folder sumber di luar
// dist/. Itu bekerja di mesin dev (yang kebetulan punya keduanya) dan melempar di deploy
// yang hanya mengirim dist/ + node_modules — kegagalan yang baru muncul di server.
//
// Perbaikannya: `npm run build` menulis shared/contract-hash.json ke dalam dist/ (lihat
// scripts/write-contract-hash.ts), dihitung dari shared/*.ts yang sama persis dengan yang
// baru saja dikompilasi. Runtime membaca berkas itu; kalau tidak ada — yaitu saat dev
// dengan tsx, di mana shared/*.ts memang tersedia — barulah dihitung langsung dari sumber.
// Nilai yang dihasilkan kedua jalur identik karena bahannya sama: isi shared/*.ts.
//
// Alternatif yang DITOLAK: menerima contracts.js sebagai penanda lalu mem-hash .js bila .ts
// tidak ada. Itu menghasilkan angka yang berbeda antara dev dan produksi untuk kontrak yang
// sama, dan angka itulah satu-satunya hal yang diperiksa alat ini.

import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { ContractHashDto } from '../../shared/contracts'

/** Hanya file *.ts yang dihitung. README.md sengaja dikecualikan: dokumentasi bukan kontrak. */
const CONTRACT_FILE_PATTERN = /\.ts$/

/** Batas naik direktori saat mencari folder shared/. Cukup untuk layout src/ maupun dist/src/. */
const MAX_LOOKUP_DEPTH = 6

/** Penanda folder shared/ versi SUMBER: satu-satunya bentuk yang bisa di-hash. */
const SOURCE_MARKER = 'contracts.ts'

/** Nama berkas hash yang di-emit saat build ke dalam folder shared/ hasil kompilasi. */
export const CONTRACT_HASH_FILENAME = 'contract-hash.json'

let cached: ContractHashDto | null = null

/**
 * Cari folder shared/ dengan menaiki direktori dari lokasi file ini, berhenti pada folder
 * pertama yang berisi `marker`.
 *
 * Path relatif tetap tidak dipakai karena __dirname berbeda antara tsx (src/utils) dan hasil
 * build (dist/src/utils). Yang membedakan pencarian ini dari versi lama: penanda ditentukan
 * pemanggil, sehingga pencarian sumber dan pencarian berkas hasil build tidak pernah saling
 * tertukar. Pencarian berkas hasil build berhenti di dist/shared dan tidak pernah keluar dari
 * dist/ — itu yang membuat deploy dist-only memakai angka yang benar, bukan angka tetangga.
 */
const findSharedDir = (marker: string): string | null => {
  let current = __dirname

  for (let depth = 0; depth < MAX_LOOKUP_DEPTH; depth++) {
    const candidate = join(current, 'shared')
    if (existsSync(join(candidate, marker))) return resolve(candidate)

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}

/** Normalisasi isi file: buang BOM, ubah CRLF dan CR tunggal jadi LF. */
const normalize = (content: string): string => content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/** Pastikan berkas hasil build benar-benar berbentuk ContractHashDto sebelum dipercaya. */
const isContractHashDto = (value: unknown): value is ContractHashDto => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.hash === 'string' &&
    candidate.hash.length > 0 &&
    Array.isArray(candidate.files) &&
    candidate.files.every((name: unknown) => typeof name === 'string') &&
    typeof candidate.generatedAt === 'string'
  )
}

/**
 * Hitung ulang hash dari shared/*.ts, mengabaikan cache maupun berkas hasil build.
 * Dipakai script build, script CLI `npm run contract:hash`, dan test.
 *
 * Bentuk yang di-hash, berurutan per file: "<nama file>\n" lalu isinya yang sudah
 * dinormalisasi, lalu "\n". Nama file ikut masuk supaya rename terdeteksi.
 */
export const computeContractHash = (): ContractHashDto => {
  const sharedDir = findSharedDir(SOURCE_MARKER)

  if (!sharedDir) {
    throw new Error(
      `Folder sumber shared/ (penanda ${SOURCE_MARKER}) tidak ditemukan. Jalankan dari repo, atau pastikan build menulis ${CONTRACT_HASH_FILENAME}.`
    )
  }

  const files = readdirSync(sharedDir)
    .filter((name) => CONTRACT_FILE_PATTERN.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  if (files.length === 0) {
    throw new Error(`Tidak ada file kontrak *.ts di ${sharedDir}.`)
  }

  const hash = createHash('sha256')
  for (const name of files) {
    hash.update(`${name}\n`, 'utf8')
    hash.update(normalize(readFileSync(join(sharedDir, name), 'utf8')), 'utf8')
    hash.update('\n', 'utf8')
  }

  return { hash: hash.digest('hex'), files, generatedAt: new Date().toISOString() }
}

/**
 * Baca hash yang di-emit saat build. `null` bila tidak ada — itu kondisi normal saat dev,
 * bukan kesalahan.
 *
 * Berkas yang ADA tapi rusak justru dilempar: diam-diam jatuh ke perhitungan dari sumber di
 * situasi itu akan menyembunyikan build yang cacat, dan di server sumbernya memang tidak ada
 * sehingga yang muncul hanyalah pesan "folder shared tidak ditemukan" yang menyesatkan.
 */
export const readGeneratedContractHash = (): ContractHashDto | null => {
  const sharedDir = findSharedDir(CONTRACT_HASH_FILENAME)
  if (!sharedDir) return null

  const file = join(sharedDir, CONTRACT_HASH_FILENAME)
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))

  if (!isContractHashDto(parsed)) {
    throw new Error(`${file} tidak berbentuk ContractHashDto. Jalankan ulang \`npm run build\`.`)
  }

  return parsed
}

/**
 * Hash kontrak, di-cache di memori.
 *
 * Urutan: berkas hasil build lebih dulu (satu-satunya yang tersedia di produksi), lalu
 * perhitungan langsung dari shared/*.ts (jalur dev). Isi shared/ tidak bisa berubah selama
 * proses hidup — ia bagian dari build — jadi membaca ulang di setiap request hanya menambah
 * I/O. Restart proses setelah deploy sudah cukup untuk menyegarkannya.
 */
export const getContractHash = (): ContractHashDto => {
  if (!cached) cached = readGeneratedContractHash() ?? computeContractHash()
  return cached
}

/** Kosongkan cache. Hanya untuk test. */
export const resetContractHashCache = (): void => {
  cached = null
}
