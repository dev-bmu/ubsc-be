// ===== Entry Point Worker (cron) =====
// Proses TERPISAH dari API, satu entri PM2 sendiri.
//
// Alasan dipisah: sweep 500 booking, masing-masing dengan transaksi interaktif, akan berebut pool
// koneksi dengan traffic request. Di proses sendiri, sweep yang lambat memperlambat sweep, bukan
// memperlambat orang yang sedang checkout.
//
// Urutan import sama ketatnya dengan app.ts: load-env, lalu validasi env, baru modul lain.

import './config/load-env'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'winston'

let logger: Logger | undefined

const report = (message: string, err?: unknown): void => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : err !== undefined ? String(err) : ''
  const line = detail ? `${message} ${detail}` : message

  if (logger) {
    logger.error(line)
  } else {
    console.error(line)
  }
}

async function bootstrap(): Promise<void> {
  const { env } = await import('./config/env.js')

  // R13: worker adalah proses yang paling sensitif terhadap zona waktu — job release hold
  // membandingkan waktu, dan salah zona berarti hold dilepas tujuh jam terlalu cepat atau lambat.
  process.env.TZ = env.TZ

  const loggerModule = await import('./utils/logger.js')
  logger = loggerModule.logger

  const { PrismaClient: PrismaClientCtor } = await import('@prisma/client')
  const { PrismaMariaDb } = await import('@prisma/adapter-mariadb')

  // Adapter sengaja dibangun di sini, BUKAN dengan mengimpor application/database.ts. Modul itu
  // membuat client API (pool 20 koneksi) sebagai efek samping saat di-import, jadi mengimpornya
  // di worker berarti proses worker diam-diam membuka pool kedua yang tidak pernah dipakai.
  const url = new URL(env.DATABASE_URL)
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || undefined,
    /**
     * R14 — JANGAN diubah jadi lebih dari 1, dan jangan "dioptimasi" jadi berbagi pool API.
     *
     * GET_LOCK/RELEASE_LOCK bersifat per-sesi: lock yang diambil satu koneksi hanya bisa dilepas
     * koneksi yang sama. Pool yang membagikan koneksi berbeda antar query akan diam-diam mematikan
     * jaminan withoutOverlapping — tanpa error, tanpa log, sampai dua sweep berjalan bersamaan di
     * atas baris yang sama dan hold yang sudah dibayar ikut dilepas.
     */
    connectionLimit: 1,
    idleTimeout: env.DB_POOL_IDLE_TIMEOUT,
    // Sama seperti client API — lihat catatan foundRows di application/database.ts.
    foundRows: true
  })

  const workerClient: PrismaClient = new PrismaClientCtor({ adapter, log: ['error'] })

  // Job memanggil service domain (expire() dll.) yang mengimpor prismaClient dari
  // application/database.ts. Modul itu memakai globalThis.prismaClient bila sudah ada, jadi client
  // worker dipasang DI SINI, SEBELUM scheduler (dan rantai importnya) dimuat: seluruh service di proses
  // ini ikut memakai pool 1 koneksi, dan pool API 20 koneksi tidak pernah dibuka. Satu koneksi juga yang
  // membuat GET_LOCK dan transaksi sweep berjalan di sesi MySQL yang sama (R14). Urutan ini wajib —
  // import statis scheduler di atas baris ini akan membuka pool API diam-diam.
  ;(globalThis as unknown as { prismaClient?: PrismaClient }).prismaClient = workerClient

  const { setLockClient } = await import('./jobs/lock.js')
  setLockClient(workerClient)

  const { registerJobs, stopJobs, waitForRunningJobs, SCHEDULER_TIMEZONE } = await import('./jobs/scheduler.js')
  const jobCount = registerJobs()

  logger.info(`Worker UBSC siap (${env.NODE_ENV}, TZ ${env.TZ}, scheduler ${SCHEDULER_TIMEZONE}) — ${jobCount} job terdaftar`)

  if (jobCount === 0) {
    // Log ini supaya worker yang diam tidak disangka mati.
    logger.warn('Tidak ada job terdaftar — periksa array jobs di jobs/scheduler.ts.')
  }

  registerShutdown(workerClient, stopJobs, waitForRunningJobs, env.SHUTDOWN_TIMEOUT_MS)
}

/**
 * Shutdown dengan urutan yang sama seperti app.ts, hanya "berhenti menerima koneksi baru" diganti
 * "berhenti menjadwalkan job baru":
 *
 *   1. stopJobs()             -> tidak ada job baru yang dipicu
 *   2. waitForRunningJobs()   -> job yang sedang jalan diberi kesempatan commit
 *   3. $disconnect()          -> koneksi ditutup TERAKHIR
 *
 * Memutus di tengah sweep berarti named lock dilepas MySQL saat koneksi putus, sementara transaksi
 * yang belum commit ter-rollback. Tidak merusak data, tapi pekerjaannya terbuang — dan kalau
 * shutdown-nya diam-diam, tidak ada yang tahu.
 */
function registerShutdown(
  workerClient: PrismaClient,
  stopJobs: () => Promise<void>,
  waitForRunningJobs: (timeoutMs: number) => Promise<boolean>,
  timeoutMs: number
): void {
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    logger?.info(`Menerima ${signal}, mulai shutdown worker...`)

    try {
      await stopJobs()
    } catch (err) {
      report('Gagal menghentikan scheduler:', err)
    }

    const drained = await waitForRunningJobs(timeoutMs)
    if (!drained) {
      logger?.warn(`Batas drain ${timeoutMs} ms terlampaui, job yang belum selesai ditinggalkan`)
    }

    try {
      await workerClient.$disconnect()
    } catch (err) {
      report('Gagal menutup koneksi database worker:', err)
    }

    logger?.info(drained ? 'Worker berhenti bersih' : 'Worker berhenti dengan job yang belum selesai')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Sama seperti app.ts: proses tidak dimatikan, tapi jejaknya wajib masuk log. Worker yang mati
// diam-diam berarti hold tidak pernah dilepas lagi, dan tidak ada yang menyadarinya sampai ada
// customer yang komplain slotnya tidak bisa dibeli.
process.on('uncaughtException', (err) => {
  report('Uncaught exception di worker:', err)
})

process.on('unhandledRejection', (reason) => {
  report('Unhandled promise rejection di worker:', reason)
})

void bootstrap().catch((err: unknown) => {
  report('Bootstrap worker gagal:', err)
  process.exit(1)
})
