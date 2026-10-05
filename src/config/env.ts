// ===== Validasi Environment =====
// Satu-satunya tempat `process.env` dibaca. Modul lain memakai `env` di sini, atau konstanta
// bernama yang di-re-export `config/index.ts`.
//
// Alasan file ini ada: boilerplate men-destructure `process.env` mentah tanpa cek, sehingga
// produksi bisa boot dengan ACCESS_TOKEN_SECRET=undefined dan baru ketahuan lewat laporan
// keamanan. Di sini env yang hilang atau invalid menghentikan proses saat boot, dengan daftar
// var yang bermasalah — bukan stack trace Zod mentah.
//
// Nama var di file ini WAJIB sama persis dengan .env.example. Kalau menambah var, tambahkan di
// keduanya sekaligus.

import { z } from 'zod'
// Berkas env sudah dibaca paling awal di app.ts / worker.ts. Impor di sini jaring pengaman untuk entry
// point lain (jest, script) — modul hanya dievaluasi sekali, dan tidak menimpa var yang sudah ter-set.
import './load-env'

// ===== Helper schema =====

/** String kosong di .env (`PORT=`) sama artinya dengan tidak diisi, bukan angka 0. */
const isBlank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/** Angka wajib di-coerce karena semua env datang sebagai string. Default dipakai bila var kosong. */
const numberEnv = (fallback: number, min: number, max: number) =>
  z.preprocess((value) => (isBlank(value) ? fallback : value), z.coerce.number().int().min(min).max(max))

/** Hanya 1/true/yes/on yang dianggap menyala; sisanya mati. */
const booleanEnv = (fallback: boolean) =>
  z.preprocess((value) => {
    if (isBlank(value)) return fallback
    if (typeof value === 'boolean') return value
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
  }, z.boolean())

/** String opsional: kosong diperlakukan sebagai tidak diisi, bukan lolos sebagai string kosong. */
const optionalString = () => z.preprocess((value) => (isBlank(value) ? undefined : value), z.string().min(1).optional())

/** String dengan default bila tidak diisi. */
const stringEnv = (fallback: string) => z.preprocess((value) => (isBlank(value) ? fallback : value), z.string().min(1))

/** URL absolut. Dicek lewat konstruktor URL, bukan regex. */
const urlEnv = (fallback: string) =>
  z.preprocess(
    (value) => (isBlank(value) ? fallback : value),
    z
      .string()
      .min(1)
      .refine((value) => {
        try {
          const parsed = new URL(value)
          return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        } catch {
          return false
        }
      }, 'harus URL absolut http/https, contoh: https://ubsportcenter.co.id')
  )

/** Panjang minimum secret JWT di produksi. Di bawah ini brute force jadi murah. */
const MIN_SECRET_LENGTH = 32

// ===== Schema =====

const envSchema = z.object({
  // ----- Server -----
  NODE_ENV: z.preprocess((value) => (isBlank(value) ? 'development' : value), z.enum(['development', 'test', 'production'])),
  PORT: numberEnv(4020, 1, 65535),
  /** R13: semua proses dipaksa Asia/Jakarta. DB dan kabel tetap UTC; zona ini untuk cron dan render. */
  TZ: stringEnv('Asia/Jakarta'),
  /** Dipakai menyusun URL absolut: tautan email, redirect OAuth, path upload. */
  API_BASE_URL: urlEnv('http://localhost:4020'),
  /** Origin ubsc-landing. Juga allowlist CORS. */
  LANDING_URL: urlEnv('http://localhost:3000'),
  /** Origin ubsc-admin. */
  ADMIN_URL: urlEnv('http://localhost:3001'),
  /**
   * Route revalidasi ubsc-landing (POST /revalidate), dipanggil setelah admin mengubah fasilitas, paket,
   * atau konten beranda supaya halaman ISR langsung segar. Kosong = nonaktif: halaman menyegarkan diri
   * sendiri dalam 2-10 menit. Di produksi arahkan ke port Next langsung, bukan lewat nginx.
   */
  LANDING_REVALIDATE_URL: optionalString(),
  /** Rahasia bersama dengan REVALIDATE_SECRET di ubsc-landing. */
  LANDING_REVALIDATE_SECRET: optionalString(),
  /** Batas waktu drain saat SIGTERM sebelum sisa koneksi/job diputus paksa. */
  SHUTDOWN_TIMEOUT_MS: numberEnv(10000, 1000, 60000),

  // ----- Database -----
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('mysql://') || value.startsWith('mariadb://'), 'harus berawalan mysql:// atau mariadb://'),
  /**
   * R5: boilerplate hardcode 5. Transaksi interaktif mem-pin koneksi selama durasinya, jadi lima
   * booking bersamaan memacetkan situs. Produksi 20; cek terhadap max_connections MySQL.
   * Worker cron TIDAK memakai nilai ini — dia punya client sendiri dengan connectionLimit 1 (R14).
   */
  DB_CONNECTION_LIMIT: numberEnv(20, 1, 200),
  /** Detik sebelum koneksi menganggur dilepas dari pool. */
  DB_POOL_IDLE_TIMEOUT: numberEnv(60, 0, 3600),

  // ----- Auth: secret per audience (R4) -----
  // Customer dan staff memakai SECRET BERBEDA, bukan sekadar klaim aud berbeda. Keduanya
  // opsional di dev/test karena utils/jwt.ts punya fallback turunan; di produksi superRefine di
  // bawah mewajibkan keduanya terisi, cukup panjang, dan berbeda satu sama lain.
  CUSTOMER_ACCESS_TOKEN_SECRET: optionalString(),
  STAFF_ACCESS_TOKEN_SECRET: optionalString(),
  /** Secret dasar untuk fallback dev di utils/jwt.ts. Tidak dipakai sama sekali di produksi. */
  ACCESS_TOKEN_SECRET: optionalString(),

  // ----- Auth: setelan bersama -----
  ACCESS_TOKEN_EXPIRES: stringEnv('15m'),
  /** Detik. Default 30 hari. */
  REFRESH_TOKEN_EXPIRES_SECONDS: numberEnv(60 * 60 * 24 * 30, 60, 60 * 60 * 24 * 365),
  /** Batas sesi aktif per user (multi-device). Yang terlama dicabut. */
  MAX_SESSIONS: numberEnv(5, 1, 50),
  /** Gagal login berturut-turut sebelum akun dikunci. */
  MAX_FAILED_LOGINS: numberEnv(5, 1, 50),
  // Nama cookie refresh TIDAK dibaca dari environment. Nama itu kontrak lintas-repo yang harus
  // cocok persis dengan middleware kedua app Next, jadi tempatnya di kode (services/auth-services.ts),
  // bukan di sini - var env yang bisa diubah diam-diam justru memutus kontrak itu tanpa jejak.

  /**
   * R4: SENGAJA boleh kosong, dan kosong memang default produksi. Cookie host-only inilah yang
   * memisahkan sesi customer (ubsportcenter.co.id) dari sesi staff (dash.ubsportcenter.co.id).
   * Mengisi .ubsportcenter.co.id membagikan seluruh cookie ke kedua subdomain dan membocorkan
   * sesi staff ke situs publik. Isi hanya untuk kebutuhan dev lokal yang spesifik.
   */
  COOKIE_DOMAIN: z.preprocess((value) => (isBlank(value) ? '' : value), z.string()),
  /** Bypass permission untuk panggilan service-to-service. Opsional; call site sudah cek non-kosong. */
  INTERNAL_SERVICE_KEY: optionalString(),

  // ----- Upload, storage, log (path relatif terhadap cwd proses) -----
  /** Di-mount publik lewat express.static('/uploads'). */
  UPLOAD_DIR: stringEnv('uploads'),
  /** TIDAK pernah di-mount. Bukti bayar dan dokumen identitas. */
  PRIVATE_STORAGE_DIR: stringEnv('storage/private'),
  /**
   * Direktori media bersama (R9) — video reel dan aset berat lain yang SENGAJA tidak ikut git.
   * Isinya dipindahkan dengan ops/scripts/sync-media.sh dan diverifikasi lewat ops/media-manifest.txt;
   * default-nya harus sama dengan default MEDIA_DIR di skrip itu, yaitu <root-repo>/../ubsc-media.
   * Di-mount publik lewat express.static('/media') untuk dev. Produksi: bucket R2 publik (reels/),
   * disajikan cdn.ubsportcenter.co.id.
   */
  MEDIA_DIR: stringEnv('../ubsc-media'),
  LOG_DIR: stringEnv('logs'),
  /**
   * Tempat berkas unggahan (src/utils/storage.ts): 'local' = UPLOAD_DIR + PRIVATE_STORAGE_DIR di disk
   * (dev/test), 'r2' = Cloudflare R2 (produksi). Mode r2 mewajibkan keenam var R2_* (cek silang di bawah).
   */
  STORAGE_DRIVER: z.preprocess((value) => (isBlank(value) ? 'local' : value), z.enum(['local', 'r2'])),
  R2_ACCOUNT_ID: optionalString(),
  R2_ACCESS_KEY_ID: optionalString(),
  R2_SECRET_ACCESS_KEY: optionalString(),
  /** Bucket berkas publik (CMS, foto member, avatar, QRIS) — yang terhubung ke custom domain R2_PUBLIC_URL. */
  R2_PUBLIC_BUCKET: optionalString(),
  /** Bucket bukti bayar + dokumen identitas. TANPA domain publik. */
  R2_PRIVATE_BUCKET: optionalString(),
  /** Custom domain bucket publik, mis. https://cdn.ubsportcenter.co.id (tanpa garis miring di akhir). */
  R2_PUBLIC_URL: optionalString(),

  // ----- Mail -----
  /** 'log' menulis .eml ke MAIL_PREVIEW_DIR (dev, tanpa Docker); 'smtp' mengirim sungguhan. */
  MAIL_TRANSPORT: z.preprocess((value) => (isBlank(value) ? 'log' : value), z.enum(['log', 'smtp'])),
  MAIL_PREVIEW_DIR: stringEnv('storage/mail-preview'),
  MAIL_HOST: optionalString(),
  // Port 465 (SMTPS implisit), bukan 587: di 587 handshake STARTTLS tidak dibatasi socket
  // timeout, dan handshake yang macet menggantung request sampai prosesnya dimatikan.
  MAIL_PORT: numberEnv(465, 1, 65535),
  MAIL_SECURE: booleanEnv(true),
  MAIL_USER: optionalString(),
  MAIL_PASSWORD: optionalString(),
  /** Opsional; bila kosong, mailer memakai MAIL_USER sebagai alamat pengirim. */
  MAIL_FROM_ADDRESS: optionalString(),
  MAIL_FROM_NAME: stringEnv('UB Sport Center'),
  /** R8: batas keras supaya SMTP yang menggantung tidak menahan proses. */
  MAIL_TIMEOUT_MS: numberEnv(10000, 1000, 60000),

  // ----- Google OAuth (Fase 1) -----
  // Kosong berarti tombol "Masuk dengan Google" dinonaktifkan.
  GOOGLE_CLIENT_ID: optionalString(),
  GOOGLE_CLIENT_SECRET: optionalString(),
  GOOGLE_REDIRECT_URI: optionalString(),

  // ----- Seeder -----
  SEED_PASSWORD: optionalString()
})

export type Env = z.infer<typeof envSchema>

// ===== Cek silang antar-var =====

interface EnvProblem {
  name: string
  message: string
}

/**
 * Aturan yang melibatkan lebih dari satu var, dibaca dari env MENTAH.
 *
 * Sengaja bukan .superRefine(): Zod berhenti menjalankan refinement begitu parse dasar menemukan
 * masalah, jadi var yang hilang di sini baru ketahuan setelah masalah lain diperbaiki — tiga kali
 * siklus jalan-perbaiki-ulang untuk satu file .env. Membacanya terpisah membuat seluruh masalah
 * muncul dalam satu laporan, dan itu justru tujuan file ini.
 */
function crossFieldProblems(source: NodeJS.ProcessEnv): EnvProblem[] {
  const problems: EnvProblem[] = []
  const read = (key: string): string | undefined => (isBlank(source[key]) ? undefined : String(source[key]).trim())

  const nodeEnv = read('NODE_ENV') ?? 'development'
  const customerSecret = read('CUSTOMER_ACCESS_TOKEN_SECRET')
  const staffSecret = read('STAFF_ACCESS_TOKEN_SECRET')

  if (read('STORAGE_DRIVER') === 'r2') {
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BUCKET', 'R2_PRIVATE_BUCKET', 'R2_PUBLIC_URL']) {
      if (!read(name)) problems.push({ name, message: 'wajib diisi bila STORAGE_DRIVER=r2' })
    }
    const publicUrl = read('R2_PUBLIC_URL')
    if (publicUrl && !/^https:\/\/[^/]+\/?$/.test(publicUrl)) {
      problems.push({ name: 'R2_PUBLIC_URL', message: 'harus origin https tanpa path, mis. https://cdn.ubsportcenter.co.id' })
    }
    // Bukti bayar dan KTP tidak boleh ikut ke bucket yang punya domain publik.
    if (read('R2_PUBLIC_BUCKET') && read('R2_PUBLIC_BUCKET') === read('R2_PRIVATE_BUCKET')) {
      problems.push({ name: 'R2_PRIVATE_BUCKET', message: 'harus beda dengan R2_PUBLIC_BUCKET (bucket publik punya domain terbuka)' })
    }
  }

  if (nodeEnv === 'production') {
    // R4: di produksi dua audience WAJIB punya secret sendiri. Secret yang sama membuat token
    // customer tetap terverifikasi di route staff, dan klaim aud jadi satu-satunya penghalang.
    const pairs: Array<[string, string | undefined]> = [
      ['CUSTOMER_ACCESS_TOKEN_SECRET', customerSecret],
      ['STAFF_ACCESS_TOKEN_SECRET', staffSecret]
    ]

    for (const [name, secret] of pairs) {
      if (!secret) {
        problems.push({ name, message: 'wajib diisi di produksi (R4: secret terpisah per audience)' })
      } else if (secret.length < MIN_SECRET_LENGTH) {
        problems.push({ name, message: `minimal ${MIN_SECRET_LENGTH} karakter di produksi` })
      }
    }

    if (customerSecret && customerSecret === staffSecret) {
      problems.push({ name: 'STAFF_ACCESS_TOKEN_SECRET', message: 'tidak boleh sama dengan CUSTOMER_ACCESS_TOKEN_SECRET (R4)' })
    }

    return problems
  }

  // Dev/test boleh mengandalkan fallback turunan di utils/jwt.ts, tapi fallback itu merangkai
  // ACCESS_TOKEN_SECRET ke dalam string. Kalau var-nya sendiri kosong, token ditandatangani
  // dengan literal "undefined:staff" — persis kelas bug yang file ini dibuat untuk mencegah.
  if ((!customerSecret || !staffSecret) && !read('ACCESS_TOKEN_SECRET')) {
    problems.push({
      name: 'ACCESS_TOKEN_SECRET',
      message: 'wajib diisi selama CUSTOMER_/STAFF_ACCESS_TOKEN_SECRET belum diisi (dipakai utils/jwt.ts sebagai fallback dev)'
    })
  }

  return problems
}

// ===== Parse saat boot =====

const parsed = envSchema.safeParse(process.env)
const crossProblems = crossFieldProblems(process.env)

if (!parsed.success || crossProblems.length > 0) {
  const schemaProblems: EnvProblem[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ name: issue.path.map((segment) => String(segment)).join('.') || '(root)', message: issue.message }))

  const problems = [...schemaProblems, ...crossProblems]

  // Sengaja console, bukan winston: logger sendiri membaca LOG_DIR dari env, jadi memakainya di
  // sini berarti bergantung pada env yang justru sedang dinyatakan invalid.
  console.error('')
  console.error('Konfigurasi environment tidak valid. Proses dihentikan sebelum menyentuh database.')
  console.error(`Ditemukan ${problems.length} masalah:`)
  console.error(problems.map((problem) => `  - ${problem.name}: ${problem.message}`).join('\n'))
  console.error('')
  console.error('Perbaiki file .env (bandingkan dengan .env.example), lalu jalankan ulang.')
  console.error('')

  process.exit(1)
}

/** Environment yang sudah ter-parse dan bertipe. Aman dipakai tanpa cek null di seluruh app. */
export const env: Env = parsed.data
