// ===== Named Lock (pengganti withoutOverlapping Laravel) =====
// MySQL GET_LOCK/RELEASE_LOCK. Satu proses worker bisa mati, di-restart, atau berjalan dobel
// sebentar saat deploy; lock inilah yang mencegah dua sweep berjalan di atas baris yang sama.

import type { PrismaClient } from '@prisma/client'

/**
 * Client worker, di-inject worker.ts lewat setLockClient().
 *
 * Sengaja di-inject, bukan di-import: jobs/ meng-import application/database.ts berarti proses
 * worker ikut membuka pool API (20 koneksi) sebagai efek samping modul. Inject juga memutus
 * lingkaran import worker -> scheduler -> job -> lock -> worker.
 */
let lockClient: PrismaClient | undefined

/** Dipanggil sekali dari worker.ts sebelum scheduler didaftarkan. */
export function setLockClient(client: PrismaClient): void {
  lockClient = client
}

/** MySQL membatasi nama lock 64 karakter; lebih dari itu error di server, bukan di sini. */
const MAX_LOCK_NAME_LENGTH = 64

/**
 * Menjalankan `fn` di bawah named lock MySQL.
 *
 * Mengembalikan hasil `fn`, atau `null` bila lock sedang dipegang proses lain — job dilewati,
 * TIDAK diantrekan. Itu semantik withoutOverlapping Laravel: sweep tiap 5 menit yang tertunda
 * lebih baik dilewati daripada menumpuk, karena jalan berikutnya tetap mengambil pekerjaan yang
 * sama. Karena itu timeout GET_LOCK-nya 0 detik (langsung menyerah), bukan menunggu.
 *
 * PENTING — acquire dan release WAJIB di koneksi yang sama. GET_LOCK bersifat per-sesi: lock yang
 * diambil koneksi A tidak bisa dilepas koneksi B, dan RELEASE_LOCK dari koneksi lain mengembalikan
 * 0 tanpa error, jadi kegagalannya diam. Inilah alasan client worker memakai connectionLimit 1
 * (R14) — dengan pool lebih dari 1, dua query berturut-turut bisa mendarat di koneksi berbeda dan
 * jaminan overlap mati tanpa satu pun pesan error. Jangan pernah mengoptimasi worker agar berbagi
 * pool API.
 *
 * Efek samping yang menguntungkan: kalau proses worker mati, koneksinya putus dan MySQL melepas
 * lock-nya sendiri. Tidak ada lock yatim yang harus dibersihkan manual.
 */
export async function withNamedLock<T>(lockName: string, fn: () => Promise<T>): Promise<T | null> {
  if (!lockClient) {
    throw new Error('Client lock belum di-set. Panggil setLockClient() dari worker.ts lebih dulu.')
  }
  if (lockName.length === 0 || lockName.length > MAX_LOCK_NAME_LENGTH) {
    throw new Error(`Nama lock tidak valid: "${lockName}" (harus 1-${MAX_LOCK_NAME_LENGTH} karakter)`)
  }

  const client = lockClient

  // GET_LOCK mengembalikan 1 (dapat), 0 (timeout), atau NULL (error). MariaDB memulangkannya
  // sebagai BIGINT, yang bisa tiba sebagai bigint maupun number tergantung driver — Number()
  // menyamakan keduanya.
  const acquireRows = await client.$queryRaw<Array<{ acquired: number | bigint | null }>>`SELECT GET_LOCK(${lockName}, 0) AS acquired`
  const acquired = Number(acquireRows[0]?.acquired ?? 0) === 1

  if (!acquired) {
    return null
  }

  try {
    return await fn()
  } finally {
    // Lock harus lepas walau fn melempar. RELEASE_LOCK sendiri tidak boleh menjatuhkan proses:
    // kalau koneksinya sudah putus, MySQL sudah melepas lock-nya untuk kita.
    await client.$queryRaw`SELECT RELEASE_LOCK(${lockName}) AS released`.catch(() => undefined)
  }
}
