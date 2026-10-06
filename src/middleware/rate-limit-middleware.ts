import { timingSafeEqual } from 'crypto'
import type { Request } from 'express'
import rateLimit, { Options } from 'express-rate-limit'
import { IS_TEST, LANDING_REVALIDATE_SECRET } from '../config'
import { ERROR_CODES } from '../utils/respond'
import { logger } from '../utils/logger'

// ============================================================================
// === Rate limit ===
// ============================================================================
// Boilerplate STARTER-BMU tidak punya rate limiting sama sekali. Batas di sini
// diambil dari Rewrite.md: login 5/menit, register 6/menit, password 5/menit,
// booking 10/menit, slots 120/menit, publik 60/menit.
//
// ⚠ R18 — BACA SEBELUM MENGAKTIFKAN DI PRODUKSI.
// Seluruh mekanisme ini bersandar pada `req.ip` yang benar. Express menurunkan
// req.ip dari X-Forwarded-For HANYA bila `trust proxy` di-set (sudah: ada di
// application/web.ts) DAN nginx memang meneruskan headernya. Bila nginx tidak
// mengirim X-Forwarded-For, SETIAP request terlihat datang dari 127.0.0.1 —
// limitnya menjadi global, dan lima percobaan login gagal dari satu orang
// mengunci seluruh situs untuk semua orang.
//
// Verifikasi di staging sebelum produksi:
//   curl -s https://<host>/api/health -H 'X-Debug: 1' dan periksa log akses
//   nginx, lalu pastikan req.ip di log winston BUKAN 127.0.0.1.
//
// Penyimpanan hitungannya in-memory per proses. Dengan satu proses API di satu
// VPS itu benar. Begitu ada proses kedua (PM2 cluster / VPS kedua), batasnya
// otomatis terbagi dua tanpa peringatan — saat itu pindahkan ke store bersama.

interface LimiterInput {
  /** Jumlah permintaan yang diizinkan dalam satu jendela. */
  max: number
  /** Panjang jendela dalam detik. */
  windowSeconds: number
  /** Pesan Indonesia yang dilihat user. */
  message: string
  /** Hanya hitung permintaan yang GAGAL — dipakai jalur login. */
  skipSuccessfulRequests?: boolean
  /** Lewati limiter untuk request tertentu (di luar mode test). */
  skip?: (req: Request) => boolean
}

function createLimiter(name: string, input: LimiterInput) {
  const options: Partial<Options> = {
    windowMs: input.windowSeconds * 1000,
    limit: input.max,
    skipSuccessfulRequests: input.skipSuccessfulRequests ?? false,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Test tidak boleh gagal hanya karena berjalan cepat.
    skip: (req) => IS_TEST || (input.skip?.(req) ?? false),
    handler: (req, res) => {
      logger.warn(`RATE_LIMIT ${name} ip=${req.ip ?? '-'} path=${req.originalUrl}`)
      res.status(429).json({
        success: false,
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: input.message,
          requestId: res.locals.requestId ?? null
        }
      })
    }
  }

  return rateLimit(options)
}

/**
 * Login: 5 per menit, dan HANYA percobaan yang gagal yang dihitung
 * (skipSuccessfulRequests). Tanpa itu, orang yang memang sedang bekerja —
 * login, logout, login lagi di beberapa tab — ikut terkena batas yang
 * sebenarnya ditujukan untuk penebak password.
 *
 * Ini lapisan kedua. Lapisan pertamanya MAX_FAILED_LOGINS=5 -> isLocked, yang
 * mengikat ke AKUN. Rate limit mengikat ke IP, jadi keduanya menutup sisi yang
 * berbeda: satu penyerang menebak banyak akun, dan banyak penyerang menebak
 * satu akun.
 *
 * ⚠ KONSEKUENSI YANG HARUS DIPANTAU DI PRODUKSI — UBSC ada di kampus.
 * Batas ini mengikat ke IP, dan jaringan kampus biasanya keluar lewat sedikit
 * IP NAT bersama. Artinya seluruh pengunjung yang datang dari wifi kampus
 * berbagi jatah 5/menit yang sama. skipSuccessfulRequests memperkecil dampaknya
 * — yang terhitung hanya percobaan gagal — tapi tidak menghilangkannya: begitu
 * jendelanya habis, login yang BENAR pun ikut kena 429, karena limiter berjalan
 * sebelum handler sempat tahu passwordnya benar.
 *
 * Angka 5/menit diambil dari Rewrite.md dan dipertahankan apa adanya. Yang
 * perlu dilakukan setelah rilis: pantau frekuensi baris RATE_LIMIT login di
 * log. Kalau sering muncul dari IP yang sama sementara akunnya berbeda-beda,
 * itu tanda NAT kampus, bukan serangan — naikkan batasnya dan sandarkan
 * pertahanan brute-force pada MAX_FAILED_LOGINS yang mengikat ke akun.
 */
export const loginLimiter = createLimiter('login', {
  max: 5,
  windowSeconds: 60,
  message: 'Terlalu banyak percobaan masuk. Coba lagi dalam satu menit.',
  skipSuccessfulRequests: true
})

export const registerLimiter = createLimiter('register', {
  max: 6,
  windowSeconds: 60,
  message: 'Terlalu banyak percobaan pendaftaran. Coba lagi dalam satu menit.'
})

/**
 * Semua jalur password dan verifikasi email: 5 per menit. Masing-masing
 * memicu pengiriman email, jadi batas ini sekaligus mencegah endpoint kita
 * dipakai membanjiri kotak masuk orang lain.
 */
export const passwordLimiter = createLimiter('password', {
  max: 5,
  windowSeconds: 60,
  message: 'Terlalu banyak permintaan. Coba lagi dalam satu menit.'
})

/** Checkout booking — Fase 3. */
export const bookingLimiter = createLimiter('booking', {
  max: 10,
  windowSeconds: 60,
  message: 'Terlalu banyak permintaan booking. Coba lagi dalam satu menit.'
})

/**
 * Grid ketersediaan slot — Fase 3. Batasnya jauh lebih longgar karena satu
 * orang yang sedang memilih jadwal memang memicu banyak pemanggilan.
 */
export const slotsLimiter = createLimiter('slots', {
  max: 120,
  windowSeconds: 60,
  message: 'Terlalu banyak permintaan. Mohon tunggu sebentar.'
})

/**
 * Fetch RSC/ISR landing membawa `x-landing-secret` (= LANDING_REVALIDATE_SECRET). Tanpanya SEMUA fetch
 * server landing berbagi satu ember 127.0.0.1, dan slug acak /berita/<x> (404 tidak di-cache Next) cukup
 * untuk mengurasnya. Sengaja BUKAN skip berdasar IP loopback: port landing terbuka di 0.0.0.0 dan
 * rewrites Next meneruskan header klien apa adanya, jadi IP / X-Forwarded-For bisa dipalsukan.
 */
const isLandingServer = (req: Request): boolean => {
  const given = req.header('x-landing-secret')
  if (!given || !LANDING_REVALIDATE_SECRET) return false
  const a = Buffer.from(given)
  const b = Buffer.from(LANDING_REVALIDATE_SECRET)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Selimut untuk sisa endpoint publik. Fetch server landing (isLandingServer) tidak dihitung. */
export const publicLimiter = createLimiter('public', {
  max: 60,
  windowSeconds: 60,
  message: 'Terlalu banyak permintaan. Mohon tunggu sebentar.',
  skip: isLandingServer
})

/**
 * Unggah bukti transfer: 10 per menit (throttle:10,1 Laravel). Instance sendiri, BUKAN bookingLimiter:
 * express-rate-limit menghitung per instance, jadi berbagi instance berarti unggahan bukti ikut
 * menghabiskan jatah checkout.
 */
export const proofUploadLimiter = createLimiter('proof-upload', {
  max: 10,
  windowSeconds: 60,
  message: 'Terlalu banyak unggahan. Coba lagi dalam satu menit.'
})

/**
 * Pengajuan identitas warga kampus — `throttle:5,1` Laravel (routes/web.php:250).
 *
 * Instance TERSENDIRI, bukan passwordLimiter yang kebetulan juga 5/menit: express-rate-limit
 * menghitung per instance, jadi berbagi instance berarti pengajuan identitas ikut menghabiskan
 * jatah lupa-password dan kirim-ulang-verifikasi milik orang yang sama.
 */
export const identityLimiter = createLimiter('identity', {
  max: 5,
  windowSeconds: 60,
  message: 'Terlalu banyak pengajuan identitas. Coba lagi dalam satu menit.'
})

/** Unggah foto member — instance sendiri dengan alasan yang sama seperti identityLimiter. */
export const memberPhotoLimiter = createLimiter('member-photo', {
  max: 5,
  windowSeconds: 60,
  message: 'Terlalu banyak unggahan foto. Coba lagi dalam satu menit.'
})
