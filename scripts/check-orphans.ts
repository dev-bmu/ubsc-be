// ===== Pemeriksa dangling reference (R2) =====
//
// relationMode = "prisma" menghapus SELURUH foreign key dan cascade di level database.
// Integritas hanya ditegakkan Prisma, dan hanya untuk operasi yang benar-benar lewat Prisma.
// Artinya: satu perbaikan manual lewat phpMyAdmin, satu import yang meleset, atau satu jalur
// delete yang lupa memanggil media-services.deleteForModel() akan meninggalkan baris yatim
// yang tidak ditolak siapa pun. Tidak ada yang gagal saat itu juga — baris itu baru muncul
// berbulan-bulan kemudian sebagai halaman error atau angka laporan yang salah.
//
// Script ini yang membuat kerusakan seperti itu terlihat. Jadwal: MINGGUAN (cron di server,
// atau job terjadwal CI). Keluar dengan exit code 1 bila ada dangling reference, sehingga
// runner-nya berisik dan tidak bisa diabaikan diam-diam.
//
// Pemakaian:
//   npm run check:orphans

import { prismaClient, disconnectDatabase } from '../src/application/database'

interface OrphanCheck {
  /** Kalimat yang dibaca manusia di output, misal: 'bookings.facilityId -> facilities.id' */
  label: string
  /**
   * SQL yang mengembalikan TEPAT satu baris dengan satu kolom bernama `total`, berisi jumlah
   * baris yatim. Bentuk yang dipakai:
   *   SELECT COUNT(*) AS total FROM anak a LEFT JOIN induk i ON i.id = a.induk_id
   *   WHERE a.induk_id IS NOT NULL AND i.id IS NULL
   */
  sql: string
}

// TODO Fase 1: isi setelah schema.prisma lengkap. Satu entri untuk SETIAP relasi, termasuk
// yang polymorphic (media.modelType + media.modelId) dan self-reference bookings.bookingGroupId.
// Daftar ini sengaja kosong di Fase 0 supaya kerangkanya sudah bisa dijalankan dan dijadwalkan
// sejak awal — bukan ditunda sampai "nanti kalau sempat", yang pada praktiknya berarti tidak
// pernah.
const ORPHAN_CHECKS: OrphanCheck[] = []

interface OrphanResult {
  label: string
  total: number
}

/** Jalankan satu pemeriksaan dan kembalikan jumlah baris yatimnya. */
const runCheck = async (check: OrphanCheck): Promise<OrphanResult> => {
  const rows = await prismaClient.$queryRawUnsafe<Array<{ total: bigint | number }>>(check.sql)
  const raw = rows[0]?.total ?? 0

  // COUNT(*) MySQL tiba sebagai BigInt lewat driver adapter; Number aman karena jumlah baris
  // yatim yang realistis jauh di bawah batas aman integer.
  return { label: check.label, total: Number(raw) }
}

const main = async (): Promise<number> => {
  if (ORPHAN_CHECKS.length === 0) {
    process.stdout.write('Belum ada pemeriksaan yang terdaftar (ORPHAN_CHECKS kosong). Isi di Fase 1 setelah schema.prisma lengkap.\n')
    return 0
  }

  const results: OrphanResult[] = []
  for (const check of ORPHAN_CHECKS) {
    results.push(await runCheck(check))
  }

  const dangling = results.filter((result) => result.total > 0)

  for (const result of results) {
    const status = result.total > 0 ? `YATIM ${result.total}` : 'bersih'
    process.stdout.write(`  ${status.padEnd(14)} ${result.label}\n`)
  }

  if (dangling.length === 0) {
    process.stdout.write(`\n${results.length} relasi diperiksa, semuanya bersih.\n`)
    return 0
  }

  const totalRows = dangling.reduce((sum, result) => sum + result.total, 0)
  process.stderr.write(`\nDitemukan ${totalRows} baris yatim di ${dangling.length} relasi. Perbaiki sebelum melanjutkan deploy berikutnya.\n`)
  return 1
}

main()
  .then(async (exitCode) => {
    await disconnectDatabase()
    process.exit(exitCode)
  })
  .catch(async (error) => {
    process.stderr.write(`Pemeriksaan gagal dijalankan: ${error instanceof Error ? error.message : String(error)}\n`)
    await disconnectDatabase()
    process.exit(1)
  })
