// ===== PM2 — empat proses UBSC dari satu berkas =====
//
// Dipakai di Fase 10 (Deploy, docs/fase-10.md). Di Fase 0 keberadaannya hanya membekukan bentuknya:
// nama proses, urutan, dan variabel lingkungan yang wajib ada di setiap proses. Jangan jalankan di
// mesin pengembangan — di dev setiap aplikasi dijalankan sendiri lewat `npm run dev`.
//
// Empat proses, sengaja dari satu berkas di repo API meskipun ketiga aplikasi punya repo terpisah:
// urutan start, variabel lingkungan, dan aturan restart adalah satu keputusan operasional, bukan tiga.
//
//   api      Express 5, melayani /api dan /uploads                       :4010
//   worker   proses cron terpisah (node-cron + GET_LOCK MySQL)           tanpa port
//   landing  Next 15, situs publik ubsportcenter.co.id                   :3737
//   admin    Next 15, panel staff dash.ubsportcenter.co.id               :3010
//
// Lokasi checkout di VPS (docs/fase-10.md): api /var/www/ubsc/be, admin /var/www/ubsc/fe, landing
// /var/www/apps/ubsc-landing. Video ubsc-media di /var/www/ubsc/media, disajikan nginx sebagai
// cdn.ubsportcenter.co.id (tanpa proses Node).
//
// Catatan nginx (docs/fase-10.md §4): tiap domain hanya `location /` ke proses Next-nya, gaya sama
// dengan aplikasi lain di VPS. /api dan /uploads diteruskan `rewrites()` di next.config.ts ke
// API_BASE_URL (:4010), jadi browser tetap same-origin dan cookie sesi tetap jalan.
//
// Catatan zona waktu (R13): TZ WAJIB ada di env SETIAP proses, dan harus disetel di level proses
// seperti di sini — bukan lewat .env yang dibaca dotenv atau Next. Node membaca zona waktu sekali saat
// runtime-nya start; TZ yang baru muncul setelah itu tidak mengubah apa pun, dan bug khasnya adalah
// booking jam 23:30 WIB yang mendarat di hari yang salah.
//
// Perintah Fase 10:
//   pm2 start ops/ecosystem.config.js
//   pm2 save && pm2 startup
//   pm2 install pm2-logrotate
//   pm2 restart ecosystem.config.js --update-env    # setelah mengubah env di berkas ini

// ===== Default bersama =====
// Bukan warisan objek — PM2 tidak menggabungkan `env` antar app. Konstanta ini disebar ulang secara
// eksplisit di tiap app supaya tidak ada satu pun proses yang kehilangan TZ karena lupa disalin.
const sharedEnv = {
  NODE_ENV: 'production',
  TZ: 'Asia/Jakarta'
}

// Fork mode dengan satu instance untuk keempatnya, disengaja:
// - worker WAJIB satu instance; dua penjadwal berarti dua sweep berjalan bersamaan, dan jaminan
//   withoutOverlapping lewat GET_LOCK memang mengandalkan satu koneksi per sesi (R14)
// - api memakai transaksi interaktif yang mem-pin koneksi; menambah instance berarti membagi
//   connectionLimit yang sama tanpa menambah kapasitas database (R5)
// - VPS tunggal, jadi cluster mode hanya menambah permukaan kegagalan tanpa menambah throughput (R15)
const sharedProcess = {
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_restarts: 10,
  min_uptime: '30s',
  restart_delay: 2000,
  time: true,
  merge_logs: true
}

module.exports = {
  apps: [
    // ===== API =====
    {
      name: 'ubsc-api',
      cwd: '/var/www/ubsc/be',
      script: 'dist/src/app.js',
      ...sharedProcess,
      // Keluar dari Express butuh waktu: SIGTERM men-drain koneksi dulu sebelum proses berhenti.
      kill_timeout: 10000,
      max_memory_restart: '500M',
      env: {
        ...sharedEnv,
        PORT: 4010
      }
    },

    // ===== Worker cron =====
    {
      name: 'ubsc-worker',
      cwd: '/var/www/ubsc/be',
      script: 'dist/src/worker.js',
      ...sharedProcess,
      // Beri kesempatan job yang sedang jalan untuk selesai dan melepas named lock sebelum dibunuh.
      kill_timeout: 15000,
      max_memory_restart: '300M',
      env: {
        ...sharedEnv
        // Tidak ada PORT: worker tidak mendengarkan HTTP sama sekali.
        // Prisma client-nya memakai connectionLimit 1 — lihat src/worker.ts, jangan dinaikkan.
      }
    },

    // ===== Landing (situs publik) =====
    {
      name: 'ubsc-landing',
      cwd: '/var/www/apps/ubsc-landing',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3737',
      ...sharedProcess,
      max_memory_restart: '600M',
      env: {
        ...sharedEnv,
        PORT: 3737,
        // Tujuan rewrites() /api dan /uploads. Rewrites dibekukan saat BUILD, jadi nilai yang
        // menentukan adalah API_BASE_URL di .env.local saat `npm run build`; ini cadangan untuk sisi server.
        API_BASE_URL: 'http://127.0.0.1:4010',
        NEXT_PUBLIC_SITE_URL: 'https://ubsportcenter.co.id'
      }
    },

    // ===== Admin (panel staff) =====
    {
      name: 'ubsc-admin',
      cwd: '/var/www/ubsc/fe',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3010',
      ...sharedProcess,
      max_memory_restart: '600M',
      env: {
        ...sharedEnv,
        PORT: 3010,
        API_BASE_URL: 'http://127.0.0.1:4010',
        NEXT_PUBLIC_ADMIN_URL: 'https://dash.ubsportcenter.co.id'
      }
    }
  ]
}
