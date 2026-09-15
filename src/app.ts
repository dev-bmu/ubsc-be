// ===== Entry Point API =====
// Urutan di file ini penting dan mudah dirusak tanpa sadar:
//   1. dotenv dijalankan sebelum modul apa pun dimuat;
//   2. config/env.ts memvalidasi seluruh environment;
//   3. baru modul lain di-import.
// Karena itu SEMUA import selain dotenv di sini bersifat dinamis. Satu import statis ke modul
// yang menyentuh database akan dihoisting ke atas config() dan membuka koneksi dengan
// DATABASE_URL yang belum divalidasi — persis kegagalan yang env.ts dibuat untuk mencegah.

import { config } from 'dotenv'
import type { Server } from 'http'
import type { Logger } from 'winston'

config({ quiet: true })

/** Diisi setelah bootstrap. Sebelum itu, handler proses jatuh ke console sebagai jaring pengaman. */
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
  // Validasi environment lebih dulu. Kalau ada yang salah, proses berhenti di sini dengan daftar
  // var yang bermasalah — sebelum satu pun koneksi database dibuka.
  const { env } = await import('./config/env.js')

  // R13: kunci zona waktu proses sebelum ada Date yang dibuat.
  process.env.TZ = env.TZ

  const loggerModule = await import('./utils/logger.js')
  logger = loggerModule.logger

  const { web } = await import('./application/web.js')
  const { disconnectDatabase } = await import('./application/database.js')
  const { waitForPendingMail } = await import('./utils/mailer.js')

  const server: Server = web.listen(env.PORT, () => {
    logger?.info(`API UBSC siap di port ${env.PORT} (${env.NODE_ENV}, TZ ${env.TZ})`)
  })

  server.on('error', (err: unknown) => {
    report('HTTP server gagal start:', err)
    process.exit(1)
  })

  registerShutdown(server, disconnectDatabase, waitForPendingMail, env.SHUTDOWN_TIMEOUT_MS)
}

/**
 * Shutdown yang benar-benar men-drain.
 *
 * Boilerplate memanggil process.exit(0) begitu SIGTERM datang, yang memutus setiap request yang
 * sedang berjalan — termasuk transaksi booking di tengah jalan. Urutan yang benar:
 *
 *   1. server.close()          -> berhenti menerima KONEKSI baru; koneksi yang ada tetap dilayani
 *   2. closeIdleConnections()  -> putus socket keep-alive yang tidak sedang memproses request,
 *                                 kalau tidak 'close' baru menyala setelah keep-alive timeout
 *   3. tunggu event 'close'    -> semua request in-flight selesai
 *   4. batas waktu terlampaui  -> closeAllConnections() memutus sisanya, daripada PM2 mengirim
 *                                 SIGKILL yang memutus semuanya tanpa menutup database
 *   5. waitForPendingMail()    -> email `void sendMailSafe()` sengaja hidup lebih lama dari request-nya
 *                                 (R8), jadi drain HTTP tidak menunggunya; tanpa langkah ini email
 *                                 keputusan pembayaran bisa terpotong dan email_logs-nya salah catat
 *   6. disconnectDatabase()    -> pool ditutup TERAKHIR, setelah tidak ada lagi yang memakainya
 */
function registerShutdown(
  server: Server,
  disconnectDatabase: () => Promise<void>,
  waitForPendingMail: (timeoutMs: number) => Promise<boolean>,
  timeoutMs: number
): void {
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    // Sinyal kedua saat shutdown berjalan diabaikan, bukan memicu jalur kedua.
    if (shuttingDown) return
    shuttingDown = true

    logger?.info(`Menerima ${signal}, mulai shutdown...`)

    const drained = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        logger?.warn(`Batas drain ${timeoutMs} ms terlampaui, sisa koneksi diputus paksa`)
        server.closeAllConnections()
        resolve(false)
      }, timeoutMs)

      server.close(() => {
        clearTimeout(timer)
        resolve(true)
      })

      server.closeIdleConnections()
    })

    if (!(await waitForPendingMail(timeoutMs))) {
      logger?.warn(`Batas ${timeoutMs} ms terlampaui, email yang masih terkirim ditinggalkan (lihat email_logs)`)
    }

    try {
      await disconnectDatabase()
    } catch (err) {
      report('Gagal menutup koneksi database:', err)
    }

    logger?.info(drained ? 'Shutdown bersih' : 'Shutdown selesai dengan koneksi yang diputus paksa')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Proses sengaja TIDAK dimatikan di sini: satu rejection yang lolos dari jalur kirim email tidak
// boleh menjatuhkan seluruh API (R8). Yang wajib adalah jejaknya masuk log, bukan hilang di stdout.
process.on('uncaughtException', (err) => {
  report('Uncaught exception:', err)
})

process.on('unhandledRejection', (reason) => {
  report('Unhandled promise rejection:', reason)
})

void bootstrap().catch((err: unknown) => {
  report('Bootstrap gagal sebelum server listen:', err)
  process.exit(1)
})
