# ubsc-api

Backend UB Sport Center. **Satu-satunya** aplikasi yang menyentuh database — `ubsc-landing` dan `ubsc-admin` tidak pernah mengakses MySQL secara langsung, keduanya selalu lewat HTTP ke repo ini.

Repo ini juga memegang dua hal yang dipakai bersama oleh ketiga aplikasi:

- `shared/` — **sumber kebenaran kontrak** (DTO response, daftar permission, format Rupiah/tanggal). Disalin ke kedua repo Next lewat `npm run sync:contracts` di sana.
- `ops/` — konfigurasi deploy (nginx, PM2, skrip). Dipakai mulai Fase 10.

Aplikasi lama yang di-rewrite: `C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL` (Laravel 12 + Inertia). Dokumen rencana lengkap ada di `Rewrite.md` pada repo Laravel tersebut.

## Stack

| Bagian   | Versi / paket                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Runtime  | Node 24 (dipin lewat `.nvmrc` + `engines`)                                                                        |
| HTTP     | Express 5                                                                                                         |
| ORM      | Prisma 7 + `@prisma/adapter-mariadb` (driver adapter, bicara protokol MySQL)                                      |
| Database | MySQL 8 / MariaDB 11, `relationMode = "prisma"`                                                                   |
| Validasi | Zod 4 — dijalankan di service, bukan di middleware                                                                |
| Auth     | JWT access token (memori klien) + refresh token httpOnly dengan rotasi, **dua audience** (`customer` dan `staff`) |
| Mail     | Nodemailer, SMTP Hostinger port `465` implicit TLS                                                                |
| Upload   | Multer + disk lokal + tabel `media` polymorphic, re-encode lewat sharp                                            |
| Cron     | Proses worker terpisah (`src/worker.ts`) + `node-cron`, dikunci named lock MySQL                                  |
| Log      | Winston + `winston-daily-rotate-file`                                                                             |
| Bahasa   | TypeScript strict                                                                                                 |

## Prasyarat

- **Node 24** dan npm 11. Cek dengan `node -v`.
- **MySQL atau MariaDB lokal.** Di mesin pengembangan ini dipakai **Laragon** (MySQL 8). Database dibuat manual dalam keadaan kosong; nama dan kredensialnya mengikuti `DATABASE_URL` di `.env.example`.
- **Proyek ini TIDAK memakai Docker.** Tidak ada `docker-compose.yml`. Alasannya dicatat di `docs/fase-0.md` bagian "Penyimpangan dari dokumen rencana".
- Email saat pengembangan tidak dikirim ke SMTP sungguhan: `MAIL_TRANSPORT=log` menulis pratinjau `.html` ke `storage/mail-preview/`. Tidak perlu Mailpit.

## Setup

```bash
cp .env.example .env          # sesuaikan DATABASE_URL, semua *_SECRET, dan kredensial SMTP
npm ci                        # WAJIB npm ci, bukan npm install — lockfile ter-commit adalah kontraknya
npx prisma generate
npx prisma migrate dev        # membuat tabel di database yang ditunjuk DATABASE_URL
npm run seed                  # permission + matriks role + master data awal
```

Catatan:

- `npm ci` gagal kalau `package-lock.json` tidak ter-commit. Itu disengaja (R17) — build harus deterministik di ketiga repo.
- Seeder adalah **`prisma/seed.ts`** (TypeScript, dijalankan lewat `tsx`), bukan `prisma/seed.js`. Alasannya: matriks permission hanya boleh punya satu sumber di `shared/permissions.ts`, dan seed CommonJS tidak bisa mengimpor berkas TS itu tanpa menduplikasi daftarnya. Lihat `docs/fase-0.md`.
- `sharp` memasang binary per-platform. Kalau artefak dipindahkan antar OS (dev Windows ke server Linux), jalankan `npm rebuild sharp` (R16).

## Menjalankan

```bash
npm run dev             # API di http://localhost:4020 (tsx watch)
npm run worker:dev      # proses cron terpisah — kerangkanya disiapkan di Fase 0, isi job-nya di Fase 3
npm run build           # tsc ke dist/ + emit dist/shared/contract-hash.json
npm start               # menjalankan dist/src/app.js (produksi)
npm run worker          # menjalankan dist/src/worker.js (produksi)
npm run lint            # ESLint
npm test                # jest + supertest
npm run contract:hash   # cetak sha256 isi shared/ — pembanding manual untuk GET /api/meta/contract-hash
npm run check:orphans   # hitung dangling reference per relasi (kompensasi relationMode "prisma", R2)
```

Cek cepat bahwa API hidup:

```bash
curl http://localhost:4020/api/health
```

Kedua aplikasi Next mem-proxy `/api/*` dan `/uploads/*` ke port ini lewat `rewrites()` di `next.config.ts`, sehingga browser selalu bicara same-origin dan cookie httpOnly bekerja tanpa CORS. **Di produksi kedua path itu diterminasi di nginx, bukan diteruskan Next.**

## Struktur folder

```
ubsc-api/
├── prisma/
│   ├── schema.prisma            # model PascalCase singular, @@map snake_case plural, @@index manual di tiap FK
│   ├── seed.ts                  # TypeScript, mengimpor shared/permissions.ts
│   └── migrations/
├── shared/                      # SUMBER KEBENARAN kontrak — hanya di sini kontrak boleh ditulis
│   ├── contracts.ts             # DTO + tipe response
│   ├── permissions.ts           # daftar PERMISSIONS + matriks role
│   └── format.ts                # format Rupiah & tanggal Indonesia (satu implementasi untuk tiga repo)
├── src/
│   ├── app.ts                   # dotenv dulu, baru dynamic import ke application/web
│   ├── worker.ts                # proses cron terpisah, Prisma client sendiri dengan connectionLimit 1
│   ├── application/             # database.ts, web.ts
│   ├── config/                  # index.ts, env.ts (validasi Zod saat boot), permissions.ts, upload.ts
│   ├── controller/              # *-controller.ts — tipis, hanya try/catch lalu diteruskan ke next
│   ├── error/                   # response-error.ts
│   ├── jobs/                    # scheduler.ts, lock.ts, release-expired-payments.ts
│   ├── middleware/              # auth-, error-, permission-, upload-middleware.ts
│   ├── routes/
│   │   ├── public-api.ts        # /api/public/* dan /api/auth/*
│   │   ├── customer-api.ts      # audience customer → /api/customer/*
│   │   ├── private-api.ts       # audience staff    → /api/admin/*
│   │   └── details/<domain>.ts  # datar, tanpa sub-folder
│   ├── services/                # *-services.ts — memvalidasi dirinya sendiri di baris pertama
│   ├── type/                    # user-request.ts
│   ├── utils/                   # jwt, logger, token, image, mailer, respond
│   └── validation/              # Validation.ts + *-validation.ts
├── uploads/                     # dilayani sebagai /uploads — PUBLIK, tidak ikut git
├── storage/
│   ├── private/                 # payment-proofs/, identity/ — TIDAK pernah di-mount ke web
│   └── mail-preview/            # keluaran MAIL_TRANSPORT=log saat pengembangan
├── docs/                        # fase-0.md, media.md, (runbook.md menyusul di Fase 10)
└── ops/                         # nginx/, scripts/, ecosystem.config.js
```

Aturan yang tidak boleh dilanggar (diwarisi dari boilerplate `STARTER-BMU/BE`):

- **Route** — prefix penuh di titik mount, path relatif polos di berkas detail. Controller di-import sebagai namespace. Permission dideklarasikan **per baris route** lewat `requirePermission(PERMISSIONS.X)`, tidak pernah di dalam controller.
- **Controller tipis** — satu blok try yang memanggil service, satu catch yang meneruskan error ke `next`.
- **Service memvalidasi dirinya sendiri** — baris pertama memanggil `Validation.validate(...)`. Tidak ada validation middleware.
- **Error** — lempar `ResponseError` dengan status dan pesan bahasa Indonesia.
- Komentar dan semua string yang dilihat user **bahasa Indonesia**; identifier bahasa Inggris. Banner section memakai gaya `// ===== Judul =====`.
- Urutan route yang wajib dipertahankan: `memberships/plans/*` sebelum `memberships/:id`, `checkin` sebelum `checkin/:token`, `facilities/create` dan `facilities/reorder` sebelum `facilities/:id`.

## Envelope API

Menyimpang dari boilerplate dan itu disengaja — boilerplate tidak punya peta error per field, sementara aplikasi ini punya sekitar 40 form.

```jsonc
// sukses
{ "success": true, "data": ..., "meta": { "page": 1, "perPage": 25, "total": 130, "lastPage": 6 } }
// gagal
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Data tidak valid",
    "fields": { "email": ["Email sudah terdaftar"] }, "requestId": "..." } }
```

`requestId` ikut masuk log winston, sehingga satu keluhan user bisa ditelusuri ke satu baris log.

## Variabel lingkungan penting

Semua variabel di-parse `src/config/env.ts` lewat schema Zod **saat boot**; proses keluar sambil menyebut variabel yang hilang, bukan berjalan dengan nilai `undefined`.

| Variabel              | Catatan                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                | `4020`                                                                                                                                |
| `DATABASE_URL`        | MySQL lokal (Laragon) saat pengembangan                                                                                               |
| `DB_CONNECTION_LIMIT` | `20` di produksi, bukan `5` seperti boilerplate — transaksi interaktif mem-pin koneksi selama durasinya (R5)                          |
| `TZ`                  | **`Asia/Jakarta` wajib di setiap proses** (R13). UTC di DB dan di kabel, Asia/Jakarta hanya saat render                               |
| `COOKIE_DOMAIN`       | **dikosongkan di produksi.** Cookie host-only inilah yang memisahkan sesi customer dari sesi staff (R4)                               |
| `MAIL_TRANSPORT`      | `log` saat pengembangan (menulis ke `storage/mail-preview/`), `smtp` di produksi                                                      |
| `SMTP_PORT`           | `465` implicit TLS. Bukan 587 — handshake STARTTLS tidak dibatasi socket timeout dan bisa menggantung request sampai proses dimatikan |

## Resep menambah fitur

Ikuti persis dan berurutan. Langkah 4 ada karena ini tiga repo terpisah — melewatinya adalah cara paling umum melahirkan drift kontrak (R12).

1. **Permission** — tambah di `shared/permissions.ts`, `src/config/permissions.ts`, dan `prisma/seed.ts`.
2. **Domain** — buat model Prisma, route di `routes/details/`, controller, dan service; tambahkan DTO-nya di `shared/contracts.ts`.
3. **Daftarkan route** di `private-api.ts` / `customer-api.ts` / `public-api.ts` sesuai audience-nya.
4. **Di repo Next terkait: `npm run sync:contracts` lebih dulu.** Perintah itu menyalin `shared/` ke `src/types/contracts/` lalu menjalankan `tsc --noEmit`. Kalau dilewati, tipe di repo Next tetap hijau karena memakai salinan usang, dan kesalahannya baru muncul saat runtime.
5. **Halaman** — tambah prefix di `src/config/permissions.ts` repo Next (`PROTECTED_ROUTE_PREFIXES` + `getRequiredPermissionsForPath`), buat halaman di `app/(protected)/`, lalu tambahkan menu di `Sidebar.tsx`.

## Dokumen terkait

- `docs/fase-0.md` — deliverable Fase 0, gate penerimaan, dan dua penyimpangan dari dokumen rencana beserta alasannya.
- `docs/media.md` — kebijakan aset berat (170 MB `public/` Laravel): di luar git, rsync ke direktori bersama, manifest sha256 ter-commit.
- `ops/ecosystem.config.js` — empat proses PM2 (api, worker, landing, admin). Dipakai mulai Fase 10.
- `ops/scripts/sync-media.sh` — sub-perintah `manifest`, `verify`, `push`, dan `pull` untuk direktori media bersama.
