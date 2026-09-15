// ===== Koneksi Database =====
// Prisma 7 + driver adapter MariaDB. Modul ini menyiapkan client untuk proses API.
// Proses worker memasang client pool-1 miliknya di globalThis.prismaClient SEBELUM modul ini
// termuat (lihat worker.ts), sehingga service yang mengimpor prismaClient di proses itu memakai
// client worker dan pool 20 koneksi di bawah tidak pernah dibuat.

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
     * Di-pin eksplisit: arti affectedRows `$executeRaw` UPDATE tidak boleh bergantung pada default
     * driver. `true` (CLIENT_FOUND_ROWS) = baris yang COCOK dengan WHERE; `false` = baris yang
     * nilainya benar-benar BERUBAH.
     *
     * JANGAN mengira ini membuat `updateMany().count` menjadi compare-and-swap. Dengan
     * relationMode = "prisma", Prisma 7 mengompilasi updateMany menjadi SELECT id tanpa kunci lalu
     * UPDATE ... WHERE id IN (...) tanpa syarat aslinya — count berasal dari SELECT itu (terverifikasi
     * Fase 3, lihat manual-payment-services.ts). Korektness pembayaran dijaga SELECT ... FOR UPDATE.
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
