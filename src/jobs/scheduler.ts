// ===== Registry Job Terjadwal =====
// Semua cron didaftarkan di satu tempat supaya "apa saja yang jalan otomatis di sistem ini"
// bisa dijawab dengan membaca satu array, bukan menyisir services.
//
// Dijalankan hanya oleh proses worker.ts, tidak pernah oleh proses API.

import { schedule as scheduleCron, type ScheduledTask } from 'node-cron'
import { withNamedLock } from './lock'
import { releaseExpiredPayments } from './release-expired-payments'
import { logError, logger } from '../utils/logger'

/**
 * R13: cron dijadwalkan dalam waktu Jakarta, bukan UTC dan bukan zona server. Tanpa ini, job
 * "tiap tengah malam" jalan jam 7 pagi WIB di server yang ber-TZ UTC.
 */
export const SCHEDULER_TIMEZONE = 'Asia/Jakarta'

export interface JobDefinition {
  /** Dipakai di log dan sebagai nama named lock. Maksimal 64 karakter setelah diberi prefix. */
  name: string
  /** Ekspresi cron standar 5 field. */
  schedule: string
  handler: () => Promise<void>
}

/** Prefix nama lock supaya tidak bentrok dengan lock lain di instance MySQL yang sama. */
const LOCK_PREFIX = 'ubsc:job:'

/** Daftar job. Menambah job = menambah satu baris di sini, tidak di tempat lain. */
const jobs: JobDefinition[] = [
  {
    // Hanya booking lead & standalone (anggota paket ikut lewat lead-nya), dan baris yang expire()-nya
    // mengembalikan false dilewati — bukti bayar sudah masuk duluan, memang tidak boleh di-expire.
    name: 'payments:release-expired',
    schedule: '*/5 * * * *',
    handler: async () => {
      await releaseExpiredPayments()
    }
  }
]

let tasks: ScheduledTask[] = []

/** Job yang sedang berjalan, supaya shutdown benar-benar menunggu — bukan sekadar berhenti menjadwalkan. */
const running = new Set<Promise<void>>()

/**
 * Menjalankan satu job di bawah named lock, dengan error yang ditangkap.
 *
 * Error job TIDAK boleh menjatuhkan proses worker: satu sweep gagal lebih baik daripada tidak ada
 * sweep sama sekali sampai ada yang menyadari PM2 me-restart worker berulang kali.
 */
async function runJob(job: JobDefinition): Promise<void> {
  const startedAt = Date.now()

  try {
    const result = await withNamedLock(`${LOCK_PREFIX}${job.name}`, job.handler)

    if (result === null) {
      logger.warn(`Job ${job.name} dilewati: jalan sebelumnya masih berlangsung`)
      return
    }

    logger.info(`Job ${job.name} selesai dalam ${Date.now() - startedAt} ms`)
  } catch (err) {
    logError(undefined, err)
    logger.error(`Job ${job.name} gagal setelah ${Date.now() - startedAt} ms`)
  }
}

/** Mencatat job yang sedang berjalan lalu melepasnya lagi setelah selesai. */
function track(promise: Promise<void>): void {
  running.add(promise)
  void promise.finally(() => running.delete(promise))
}

/**
 * Mendaftarkan seluruh job ke node-cron. Mengembalikan jumlah job yang aktif.
 *
 * Catatan: node-cron v4 punya opsi `noOverlap` sendiri, dan itu SENGAJA tidak dipakai. Opsi itu
 * hanya mencegah tumpang tindih di dalam satu proses; saat deploy, PM2 sempat menjalankan worker
 * lama dan baru bersamaan. Yang melindungi kasus itu adalah named lock MySQL di withNamedLock.
 */
export function registerJobs(): number {
  tasks = jobs.map((job) => {
    logger.info(`Job terdaftar: ${job.name} (${job.schedule} ${SCHEDULER_TIMEZONE})`)
    // Handler sengaja tidak di-await node-cron; runJob sudah menangkap semua error sendiri.
    return scheduleCron(job.schedule, () => track(runJob(job)), { name: job.name, timezone: SCHEDULER_TIMEZONE })
  })

  return tasks.length
}

/** Berhenti menjadwalkan job baru. Job yang sedang berjalan TIDAK diputus di tengah jalan. */
export async function stopJobs(): Promise<void> {
  await Promise.all(tasks.map(async (task) => task.stop()))
  tasks = []
}

/**
 * Menunggu job yang sedang berjalan selesai, dengan batas waktu.
 *
 * Mengembalikan true bila semua selesai, false bila batas waktu tercapai — dan false berarti
 * pemanggil harus tetap melanjutkan shutdown. Menggantung selamanya demi satu sweep yang macet
 * hanya membuat PM2 mengirim SIGKILL, yang justru memutus semuanya.
 */
export async function waitForRunningJobs(timeoutMs: number): Promise<boolean> {
  if (running.size === 0) return true

  const settled = Promise.allSettled(Array.from(running)).then(() => true)
  const timedOut = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    // unref supaya timer ini sendiri tidak menahan event loop tetap hidup.
    timer.unref()
  })

  return Promise.race([settled, timedOut])
}
