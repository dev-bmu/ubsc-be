import { assertTestDatabase, TEST_DATABASE_URL } from './test-database'

// ===== Environment test =====
// Dijalankan Jest di setiap berkas test SEBELUM modul aplikasi dimuat. config/env.ts memanggil dotenv,
// dan dotenv tidak menimpa variabel yang sudah ter-set — jadi nilai di sini menang atas .env dev.

assertTestDatabase(TEST_DATABASE_URL)

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = TEST_DATABASE_URL

// SENGAJA UTC, bukan Asia/Jakarta. Domain booking wajib menghitung "hari ini" dan "jam sekarang" di
// Jakarta secara eksplisit (utils/clock.ts). Menjalankan test di TZ yang berbeda membuat kode yang diam-
// diam bergantung pada TZ proses gagal di sini, bukan di mesin dev yang kebetulan ber-TZ Jakarta.
process.env.TZ = 'UTC'

process.env.PRIVATE_STORAGE_DIR = 'storage/test-private'
process.env.MAIL_TRANSPORT = 'log'
process.env.MAIL_PREVIEW_DIR = 'storage/test-mail-preview'
process.env.LOG_DIR = 'logs/test'
