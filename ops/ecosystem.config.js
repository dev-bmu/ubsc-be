// ===== PM2 — empat proses UBSC dari satu berkas =====
//
// Dipakai di Fase 10 (Deploy, docs/fase-10.md). Di Fase 0 keberadaannya hanya membekukan bentuknya:
// nama proses, urutan, dan variabel lingkungan yang wajib ada di setiap proses. Jangan jalankan di
// mesin pengembangan — di dev setiap aplikasi dijalankan sendiri lewat `npm run dev`.
//
// Empat proses, sengaja dari satu berkas di repo API meskipun ketiga aplikasi punya repo terpisah:
// urutan start, variabel lingkungan, dan aturan restart adalah satu keputusan operasional, bukan tiga.
//
//   api      Express 5, melayani /api dan /uploads                       :4020
//   worker   proses cron terpisah (node-cron + GET_LOCK MySQL)           tanpa port
//   landing  Next 15, situs publik ubsportcenter.co.id                   :3000
//   admin    Next 15, panel staff dash.ubsportcenter.co.id               :3001
//
// Lokasi checkout di VPS (docs/fase-10.md): /var/www/ubsc/<nama-repo>. Ubah ketiga `cwd` bila berbeda.
//
// Catatan nginx: /api dan /uploads DITERMINASI DI NGINX, bukan diteruskan Next. Proses landing dan
// admin tidak pernah menerima request ke kedua path itu di produksi — `rewrites()` di next.config.ts
// adalah jalur dev saja. Konsekuensinya: setiap byte gambar hemat satu hop Node, dan proses Next tidak
// ikut mati bersama API kalau API sedang di-restart.
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
      cwd: '/var/www/ubsc/ubsc-api',
      script: 'dist/src/app.js',
      ...sharedProcess,
      // Keluar dari Express butuh waktu: SIGTERM men-drain koneksi dulu sebelum proses berhenti.
      kill_timeout: 10000,
      max_memory_restart: '500M',
      env: {
        ...sharedEnv,
        PORT: 4020
      }
    },

    // ===== Worker cron =====
    {
      name: 'ubsc-worker',
      cwd: '/var/www/ubsc/ubsc-api',
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
      cwd: '/var/www/ubsc/ubsc-landing',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      ...sharedProcess,
      max_memory_restart: '600M',
      env: {
        ...sharedEnv,
        PORT: 3000,
        // Dibaca next.config.ts. Di produksi nilainya praktis tidak terpakai untuk /api dan /uploads
        // karena nginx yang menerminasi keduanya, tetapi tetap diisi supaya tidak ada jalur kode yang
        // jatuh ke default localhost saat ada yang memanggilnya dari sisi server.
        API_BASE_URL: 'http://127.0.0.1:4020',
        NEXT_PUBLIC_SITE_URL: 'https://ubsportcenter.co.id'
      }
    },

    // ===== Admin (panel staff) =====
    {
      name: 'ubsc-admin',
      cwd: '/var/www/ubsc/ubsc-admin',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001',
      ...sharedProcess,
      max_memory_restart: '600M',
      env: {
        ...sharedEnv,
        PORT: 3001,
        API_BASE_URL: 'http://127.0.0.1:4020',
        NEXT_PUBLIC_ADMIN_URL: 'https://dash.ubsportcenter.co.id'
      }
    }
  ]
}
