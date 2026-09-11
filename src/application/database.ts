// ===== Koneksi Database =====
// Prisma 7 + driver adapter MariaDB. Modul ini hanya menyiapkan client untuk proses API.
// worker.ts SENGAJA tidak mengimpor file ini (lihat komentar di sana).

import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { DATABASE_URL, DB_CONNECTION_LIMIT, DB_POOL_IDLE_TIMEOUT, IS_DEVELOPMENT, IS_PRODUCTION } from '../config'

/**
 * Membuat adapter MariaDB dari DATABASE_URL.
 *
 * `connectionLimit` bisa ditimpa karena proses worker memakai 1 koneksi (R14), sementara API
 * memakai DB_CONNECTION_LIMIT (default 20, R5 — boilerplate hardcode 5 dan transaksi interaktif
 * mem-pin koneksi selama durasinya).
 */
export function createAdapter(urlString: string, connectionLimit: number = DB_CONNECTION_LIMIT, idleTimeout: number = DB_POOL_IDLE_TIMEOUT) {
  const url = new URL(urlString)
  const host = url.hostname
  const port = url.port ? Number(url.port) : 3306
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const database = url.pathname.replace(/^\//, '') || undefined

  return new PrismaMariaDb({
    host,
    port,
    user,
    password,
    database,
    connectionLimit,
    idleTimeout,
    /**
     * WAJIB eksplisit, jangan pernah dihapus.
     *
     * Di Fase 3, `updateMany().count` dipakai sebagai compare-and-swap: attachProof dan expire
     * melakukan conditional UPDATE lalu meng-assert `count === groupSize`. Arti angka itu
     * bergantung pada foundRows: dengan `true` (perilaku CLIENT_FOUND_ROWS) count = baris yang
     * COCOK dengan WHERE; dengan `false` count = baris yang nilainya benar-benar BERUBAH.
     *
     * Kalau default driver berubah atau berbeda antar versi, assert CAS akan gagal atau — lebih
     * buruk — lolos padahal tidak seharusnya. Korektness booking tidak boleh bergantung pada
     * default siapa pun, jadi di-pin di sini.
     */
    foundRows: true
  })
}

// Hot reload tsx watch membuat modul ini dieksekusi ulang; tanpa cache global, tiap reload
// membuka pool baru sampai MySQL menolak koneksi.
const globalForPrisma = globalThis as unknown as { prismaClient?: PrismaClient }

export const prismaClient =
  globalForPrisma.prismaClient ??
  new PrismaClient({
    adapter: createAdapter(DATABASE_URL),
    log: IS_DEVELOPMENT ? ['warn', 'error'] : ['error']
  })

if (!IS_PRODUCTION) {
  globalForPrisma.prismaClient = prismaClient
}

/**
 * Menutup pool. HANYA $disconnect — tidak ada process.exit dan tidak ada handler sinyal di sini.
 *
 * Boilerplate mendaftarkan SIGTERM/SIGINT di file ini dan langsung process.exit(0), sehingga
 * request yang sedang berjalan diputus di tengah jalan. Urutan drain (berhenti menerima koneksi
 * baru, tunggu in-flight, baru tutup DB) adalah urusan app.ts dan worker.ts.
 */
export async function disconnectDatabase(): Promise<void> {
  await prismaClient.$disconnect()
}
