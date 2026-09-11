// ===== Konfigurasi Aplikasi =====
// Re-export konstanta bernama dari env.ts supaya call-site tetap seperti boilerplate:
//
//   import { PORT, NODE_ENV } from '../config'
//
// Bedanya, nilainya sekarang sudah lewat validasi Zod dan bertipe — number tetap number, boolean
// tetap boolean, dan yang wajib dijamin tidak undefined. Tidak ada lagi destructuring
// `process.env` langsung di mana pun.

import { env } from './env'

export { env }
export type { Env } from './env'

// ===== Server =====
export const { NODE_ENV, PORT, TZ, API_BASE_URL, LANDING_URL, ADMIN_URL, SHUTDOWN_TIMEOUT_MS } = env

/** Shortcut yang dipakai di banyak tempat; lebih sulit salah ketik daripada perbandingan string. */
export const IS_PRODUCTION = env.NODE_ENV === 'production'
export const IS_DEVELOPMENT = env.NODE_ENV === 'development'
export const IS_TEST = env.NODE_ENV === 'test'

// ===== Database =====
export const { DATABASE_URL, DB_CONNECTION_LIMIT, DB_POOL_IDLE_TIMEOUT } = env

// ===== Auth =====
export const {
  CUSTOMER_ACCESS_TOKEN_SECRET,
  STAFF_ACCESS_TOKEN_SECRET,
  ACCESS_TOKEN_SECRET,
  ACCESS_TOKEN_EXPIRES,
  REFRESH_TOKEN_EXPIRES_SECONDS,
  MAX_SESSIONS,
  MAX_FAILED_LOGINS,
  COOKIE_DOMAIN,
  INTERNAL_SERVICE_KEY
} = env

// ===== Upload, storage, log =====
export const { UPLOAD_DIR, PRIVATE_STORAGE_DIR, LOG_DIR } = env

// ===== Mail =====
export const {
  MAIL_TRANSPORT,
  MAIL_PREVIEW_DIR,
  MAIL_HOST,
  MAIL_PORT,
  MAIL_SECURE,
  MAIL_USER,
  MAIL_PASSWORD,
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  MAIL_TIMEOUT_MS
} = env

// ===== Google OAuth =====
export const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = env

// ===== Seeder =====
export const { SEED_PASSWORD } = env

// ===== Batas upload =====
export { UPLOAD_LIMITS, IMAGE_PIPELINE } from './upload'
export type { UploadKind } from './upload'
