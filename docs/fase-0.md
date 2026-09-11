# Fase 0 — Skeleton

Catatan penyelesaian Fase 0 rewrite UBSC (Laravel monolith menjadi `ubsc-api` + `ubsc-landing` + `ubsc-admin`).
Dokumen rencana induk: `C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL/Rewrite.md`, baris **Fase 0** pada tabel
"Fase pengerjaan".

Fase 0 tidak membangun satu pun fitur bisnis. Isinya hanya pondasi: tiga repo yang bisa boot, konvensi yang dibekukan,
dan mekanisme yang mencegah tiga repo terpisah saling melenceng. Semua yang berbau booking, payment, membership, dan
CMS adalah Fase 1–8.

## Cara membaca dokumen ini

Versi sebelumnya dokumen ini menandai **10 dari 12 deliverable "Selesai"**. Angka itu tidak pernah diverifikasi — ia
disalin dari niat, bukan dari keadaan. Kritik kelengkapan lalu menjalankan perintahnya satu per satu dan menemukan
hanya **7 yang benar-benar lulus**, sementara **gate resmi gagal pada dua dari tiga klausanya**.

Dokumen ini menggantinya dengan aturan yang lebih keras:

> **Sebuah baris hanya boleh berstatus "Lulus" kalau ada perintah yang bisa disalin-tempel, dijalankan sekarang, dan
> keluarannya membuktikan baris itu.** Berkas yang "sudah ada" bukan bukti. Niat bukan bukti. Proses yang mencetak
> "Ready" bukan bukti.

Arti status:

| Status           | Artinya                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Lulus**        | Perintah pembuktinya dijalankan dan hasilnya benar                                                                  |
| **Sebagian**     | Sebagian mekanismenya terbukti, sisanya masih merah — kolom bukti menyebutkan bagian mana                           |
| **Belum**        | Tidak lulus, atau belum bisa diverifikasi sama sekali                                                               |
| **Penyimpangan** | Sengaja dikerjakan berbeda dari dokumen rencana — lihat [Penyimpangan yang disengaja](#penyimpangan-yang-disengaja) |

### Riwayat verifikasi

Seluruh angka di bawah berasal dari menjalankan perintahnya, bukan dari membaca kode. Dua putaran dicatat karena
keduanya benar pada waktunya masing-masing, dan selisihnya adalah informasi:

| Putaran                                                   | Deliverable lulus | Gate                | Catatan                                                          |
| --------------------------------------------------------- | ----------------- | ------------------- | ---------------------------------------------------------------- |
| Kritik kelengkapan (11 Sep 2026, pagi)                    | 7 dari 12         | 1 dari 3 klausa     | Yang gagal: klausa "ketiga app boot" dan klausa `sync:contracts` |
| Verifikasi ulang (11 Sep 2026, setelah perbaikan paralel) | **9 dari 12**     | **3 dari 3 klausa** | Sisa merah semuanya bermuara pada satu hal: belum ada repo git   |

Kalau Anda membaca ini jauh setelah tanggal tersebut, jangan percaya tabelnya — **jalankan ulang perintah di kolom
bukti**. Itulah gunanya kolom itu ada.

## Deliverable

**Sembilan dari dua belas lulus.** Satu adalah penyimpangan yang disengaja, dan dua sisanya tertahan oleh hal yang
sama: belum ada repo git.

| #   | Deliverable (baris Fase 0 dokumen rencana)            | Bukti — jalankan dari akar repo yang disebut                                                                                                                                                                                                                               | Status               |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | Tiga repo di-bootstrap dari boilerplate `BE/` + `FE/` | `ls "C:/IT BMU/BMU-SYSTEM/UBSC"` → `ubsc-api ubsc-landing ubsc-admin`, masing-masing punya `package.json` dan `package-lock.json` sendiri                                                                                                                                  | **Lulus**            |
| 2   | Docker Compose (MariaDB 11 + Mailpit) di repo API     | Tidak ada `docker-compose.yml` di mana pun — disengaja                                                                                                                                                                                                                     | **Penyimpangan (a)** |
| 3   | Pin Node 24 di ketiganya                              | `cat .nvmrc` → `24` di ketiganya; `node -p "require('./package.json').engines.node"` → `>=24 <25` di ketiganya                                                                                                                                                             | **Lulus**            |
| 4   | Config ESLint API yang hilang di boilerplate          | `ubsc-api/eslint.config.mjs` ada; `npm run lint` keluar bersih                                                                                                                                                                                                             | **Lulus**            |
| 5   | `config/env.ts` validasi Zod saat boot                | `ubsc-api/src/config/env.ts`; dibuktikan oleh boot API pada gate klausa 1 — proses berhenti kalau ada variabel wajib yang hilang                                                                                                                                           | **Lulus**            |
| 6   | `.gitattributes` `eol=lf`                             | Berkasnya ada di ketiga repo dengan `* text=auto eol=lf` dan `*.sh text eol=lf`, **tetapi belum bisa diverifikasi**: `git ls-files --eol` mustahil dijalankan karena belum ada satu pun repo git                                                                           | **Belum**            |
| 7   | Commit reformat Prettier + `.git-blame-ignore-revs`   | Isi reformatnya **sudah beres** — `npm run format:check` bersih di ketiga repo. Yang belum: commit-nya sendiri belum ada (belum ada repo git), sehingga baris SHA di `.git-blame-ignore-revs` ketiga repo masih placeholder `# <sha-40-karakter-commit-reformat-prettier>` | **Belum**            |
| 8   | `shared/` sebagai sumber kebenaran kontrak            | `ls ubsc-api/shared` → `contracts.ts format.ts permissions.ts README.md`; ketiga berkas `.ts` itu yang disalin `sync:contracts`                                                                                                                                            | **Lulus**            |
| 9   | `sync:contracts` di kedua repo Next                   | `npm run sync:contracts` keluar dengan **kode 0** di `ubsc-landing` dan `ubsc-admin`; lihat gate klausa 3                                                                                                                                                                  | **Lulus**            |
| 10  | `GET /api/meta/contract-hash`                         | `curl http://localhost:4020/api/meta/contract-hash` → `200`, hash `6881e107…5f1f`, **sama persis** dengan keluaran `npm run contract:hash` dan dengan hash yang dicetak `sync:contracts` di kedua repo Next                                                                | **Lulus**            |
| 11  | Spike React 19 satu hari (R6)                         | Hasilnya tercatat di `ubsc-api/docs/spike-react-19.md`: status build, bukti runtime per library, tabel versi ter-resolve, hazard scan, dan koreksi atas klaim `@react-three/fiber@8`                                                                                       | **Lulus**            |
| 12  | Route builder diekstrak dari nama route Laravel (R10) | `ubsc-api/docs/route-inventory.md` + `src/config/routes.ts` di kedua repo Next, ditegakkan ESLint rule `no-restricted-syntax` yang menolak `href` literal; `npm run lint` bersih di keduanya                                                                               | **Lulus**            |

Tambahan Fase 0 yang berasal dari tabel Risiko, bukan dari kolom "Isi":

| Risiko | Deliverable                                                                                   | Bukti                                                                                                                                                                                                                                                               | Status       |
| ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| R5     | `connectionLimit` boilerplate `5` menjadi variabel lingkungan (`20` di produksi)              | `grep -n DB_CONNECTION_LIMIT .env.example src/config/env.ts src/application/database.ts` — default `20`, divalidasi di rentang `1..200`; `src/worker.ts` memakai `connectionLimit: 1` sendiri (R14)                                                                 | **Lulus**    |
| R9     | Media keluar dari git: direktori bersama + rsync + manifest sha256                            | `ubsc-api/docs/media.md` dan `ubsc-api/ops/scripts/sync-media.sh` ada. Diet aset 170 MB → di bawah 8 MB baru dikerjakan di Fase 9                                                                                                                                   | **Sebagian** |
| R13    | `TZ=Asia/Jakarta` di setiap proses                                                            | `grep -n TZ .env.example ops/ecosystem.config.js` — `TZ: 'Asia/Jakarta'` disetel eksplisit per app di ecosystem, bukan diwarisi shell                                                                                                                               | **Lulus**    |
| R16    | `sharp` dipin dan `npm rebuild sharp` masuk langkah deploy                                    | `node -p "require('./package.json').dependencies.sharp"` → `0.35.4` (pin exact, tanpa `^`). Langkah deploy-nya belum ada: `docs/runbook.md` belum dibuat                                                                                                            | **Sebagian** |
| R17    | Baris `package-lock.json` dihapus dari `.gitignore` FE di **ketiga** repo, lockfile di-commit | `.gitignore` ketiga repo sudah bersih (API dan landing menuliskan alasannya sebagai komentar), `package-lock.json` ada di disk ketiganya, `.gitattributes` menandainya `linguist-generated=true`. **Bagian "di-commit" belum bisa dibuktikan** — belum ada repo git | **Sebagian** |

## Gate Fase 0

Kalimat gate resmi dari dokumen rencana (`Rewrite.md`, tabel "Fase pengerjaan", baris **0. Skeleton**) berisi **tiga
klausa**, dan ketiganya harus hijau:

> Ketiga app boot; `curl localhost:3000/api/health` menembus API; `sync:contracts` jalan di kedua repo Next.

**Hasil verifikasi ulang: 3 dari 3 lulus.** Pada putaran pertama klausa 1 dan 3 gagal; keduanya sudah diperbaiki.

| #   | Klausa gate                                   | Hasil                                                            |
| --- | --------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Ketiga app boot                               | **Lulus** — api `200`, landing `/` `200`, admin `/` `307`        |
| 2   | `curl localhost:3000/api/health` menembus API | **Lulus** — `200`, badan identik dengan jawaban langsung `:4020` |
| 3   | `sync:contracts` jalan di kedua repo Next     | **Lulus** — keluar dengan kode `0` di keduanya                   |

### Persiapan

Ketiga repo harus berada dalam satu folder induk yang sama (`UBSC/ubsc-api`, `UBSC/ubsc-landing`, `UBSC/ubsc-admin`)
karena `sync:contracts` membaca `UBSC_API_LOCAL_PATH` yang default-nya `../ubsc-api`. MySQL Laragon harus hidup, dan
`ubsc-api/.env` sudah terisi (`cp .env.example .env`, lalu sesuaikan `DATABASE_URL`).

```bash
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-api"
cp .env.example .env
npx prisma generate
npx prisma migrate dev
npm run seed
```

### Klausa 1 — ketiga app boot

```bash
# terminal 1
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-api"     && npm run dev     # port 4020
# terminal 2
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-landing" && npm run dev     # port 3000
# terminal 3
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-admin"   && npm run dev     # port 3001

# terminal 4 — "boot" berarti MELAYANI HALAMAN, bukan sekadar mencetak "Ready"
curl -o /dev/null -w "api     %{http_code}\n" http://localhost:4020/api/health
curl -o /dev/null -w "landing %{http_code}\n" http://localhost:3000/
curl -o /dev/null -w "admin   %{http_code}\n" http://localhost:3001/
```

Yang benar: `200`, `200`, `307`. Angka `307` pada admin bukan kegagalan — itu middleware memantulkan pengunjung tanpa
sesi ke `/login`, persis seperti yang diharapkan.

**Kenapa klausa ini wajib diuji dengan `curl ke /`, bukan dengan membaca terminal.** Pada putaran pertama klausa ini
gagal justru karena cara lamanya: `ubsc-landing` mencetak `✓ Ready in 1342ms` sementara `GET /` menjawab `500`,
karena `src/middleware.ts` mengimpor `@/config/permissions` yang tidak ada. Next tetap menyatakan dirinya siap
walaupun middleware-nya gagal di-resolve. Terminal yang hijau tidak membuktikan app-nya hidup.

Satu jebakan lagi saat mengulang pemeriksaan ini: kalau sebuah berkas berubah di bawah server dev yang sudah lama
hidup, cache `.next` bisa basi dan memunculkan `500` palsu berupa
`ENOENT: .next/server/pages/_app/build-manifest.json`. Kalau `500` muncul, hentikan server, `rm -rf .next`, jalankan
lagi — baru simpulkan.

### Klausa 2 — `curl localhost:3000/api/health` menembus API

```bash
curl http://localhost:3000/api/health     # gate resmi: lewat rewrites() Next, bukan langsung ke 4020
curl http://localhost:3001/api/health
```

Keduanya `200` dengan badan yang identik dengan jawaban langsung dari `:4020`:

```json
{ "success": true, "data": { "status": "ok", "service": "ubsc-api", "version": "1.0.0", "uptime": 254 } }
```

Kalau `4020` menjawab tetapi `3000` tidak, masalahnya ada di `rewrites()` atau `API_BASE_URL`, bukan di API.

Perhatikan bahwa klausa ini bisa lulus walaupun klausa 1 gagal — dan pada putaran pertama itulah yang terjadi.
`/api/*` diteruskan `rewrites()` dan tidak melewati halaman mana pun, jadi middleware yang rusak tidak terlihat di
sini sama sekali. Dua klausa ini mengukur hal yang berbeda; jangan pakai yang satu untuk menyimpulkan yang lain.

### Klausa 3 — `sync:contracts` jalan di kedua repo Next

```bash
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-landing" && npm run sync:contracts ; echo "exit=$?"
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-admin"   && npm run sync:contracts ; echo "exit=$?"
```

**"Jalan" berarti keluar dengan `exit=0`**, bukan "mencetak sesuatu lalu berhenti". Script ini menyalin
`ubsc-api/shared/*.ts` ke `src/types/contracts/` **lalu menjalankan `tsc --noEmit`**; penyalinan yang berhasil diikuti
typecheck yang gagal tetap dihitung gagal, karena artinya kode di repo itu belum mengikuti kontrak terbarunya. Pada
putaran pertama keduanya gagal di langkah typecheck ini.

Verifikasi tambahan yang harus ikut hijau:

```bash
# hash kontrak harus sama di ketiga tempat
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-api" && npm run contract:hash
curl http://localhost:4020/api/meta/contract-hash
cat "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-admin/.contract-hash"
```

Ketiganya `6881e107eb899a7f3a2d13169718586fd9d483409f58745bdfbdf638261d5f1f`. Salinan di `src/types/contracts/` juga
membawa penanda `// AUTO-GENERATED — jangan edit tangan`; kalau seseorang mengeditnya dengan tangan, `sync:contracts`
berikutnya menimpanya tanpa peringatan. Perhatikan juga terminal dev kedua app Next: peringatan hash kontrak tidak
boleh muncul setelah langkah ini.

### Pemeriksaan pendukung

Bukan klausa gate, tapi tidak boleh merah saat Fase 0 ditutup.

```bash
# lint dan format di ketiga repo — ketiganya BERSIH per verifikasi ulang
npm run lint
npm run format:check

# worker API
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-api" && npm run worker:dev   # boot tanpa error; isi job-nya baru di Fase 3

# akhir baris — BARU BISA dijalankan setelah repo git ada
git ls-files --eol        # tidak boleh ada w/crlf, khususnya ops/scripts/*.sh
```

Urutan yang benar untuk format: jalankan `npm run format:write` sebagai **bagian dari commit reformat**, baru
`format:check`. Glob `format:*` di `ubsc-api` ikut mencakup `docs/**/*.md`, dan Prettier merapikan tabel Markdown
(padding pipa), jadi berkas dokumentasi yang ditulis tangan — termasuk `fase-0.md` dan `spike-react-19.md` ini —
memang ikut berubah sekali pada commit itu. Isinya tidak berubah, hanya perataannya.

Skrip dengan CRLF tiba di server dan gagal dengan `bad interpreter: /bin/bash^M`; itulah gunanya `git ls-files --eol`.

## Perbaikan boilerplate yang menjadi tanggungan Fase 0

Dari bagian "Catatan eksekusi" dokumen rencana. Karena kedua repo Next di-bootstrap dari `FE/` yang sama, perbaikan
sisi Next **dikerjakan sekali lalu disalin** — bukan dua kali secara terpisah.

| Masalah bawaan boilerplate                                                    | Perbaikan                                                                                                                                                                                                       | Status                                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| BE tidak punya config ESLint sehingga script `lint` pasti gagal               | `eslint.config.mjs` di `ubsc-api`                                                                                                                                                                               | **Lulus**                                                        |
| `prettier-plugin-tailwindcss` terpasang tapi tidak terdaftar di `.prettierrc` | Didaftarkan di `.prettierrc` kedua repo Next + `tailwindStylesheet`                                                                                                                                             | **Lulus**                                                        |
| `AuthGuard` mendorong ke `/unauthorized` yang halamannya tidak pernah dibuat  | `src/app/unauthorized/page.tsx` dibuat di kedua repo Next (chrome-nya di Fase 7)                                                                                                                                | **Lulus**                                                        |
| `globals.css` membawa sekitar 80 baris CSS TipTap mati                        | Dihapus                                                                                                                                                                                                         | **Lulus**                                                        |
| `logger.ts` memakai `path.join` yang seharusnya `path.resolve`                | Diperbaiki                                                                                                                                                                                                      | **Lulus**                                                        |
| SIGTERM handler tidak men-drain koneksi                                       | Handler men-drain sebelum exit                                                                                                                                                                                  | **Lulus**                                                        |
| `.gitignore` FE mengabaikan `package-lock.json` (R17)                         | Baris dihapus di ketiga repo                                                                                                                                                                                    | **Sebagian** — lockfile belum bisa di-commit, belum ada repo git |
| `errorMiddleware` membocorkan `error.message` mentah pada 500                 | Envelope error baru; pesan internal hanya masuk log winston bersama `requestId`                                                                                                                                 | **Lulus**                                                        |
| `ThemeProvider`/`next-themes` terpasang padahal UBSC hanya punya satu tema    | Paket dibuang; cabang yang membacanya diganti nilai tetap, dan alasannya ditulis sebagai komentar di `AdminSidebar.tsx`, `Navbar.tsx`, `ui/sonner.tsx`, `layout.tsx`, `globals.css` supaya tidak dipasang ulang | **Lulus**                                                        |

## Penyimpangan yang disengaja

Empat hal dikerjakan berbeda dari dokumen rencana. Semuanya dicatat di sini supaya tidak terbaca sebagai kelalaian di
kemudian hari, dan supaya tidak ada yang "memperbaikinya" kembali ke bentuk rencana tanpa membaca alasannya.

### (a) Tidak ada `docker-compose.yml`

**Dokumen rencana menyebut** Docker Compose berisi MariaDB 11 + Mailpit di repo API.

**Yang dikerjakan:** tidak ada `docker-compose.yml` sama sekali.

**Alasan:** Docker tidak dipakai pada mesin pengembangan ini. Memaksakannya berarti menambah satu lapis yang harus
dipasang, dijalankan, dan di-debug oleh setiap orang yang menyentuh repo, demi dua layanan yang sudah tersedia secara
lokal. Penggantinya:

| Yang direncanakan          | Penggantinya sekarang                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MariaDB 11 dalam container | **MySQL lokal lewat Laragon.** `DATABASE_URL` menunjuk ke sana. Prisma tetap memakai `@prisma/adapter-mariadb` — adapter itu bicara protokol MySQL, jadi tidak ada perubahan kode |
| Mailpit dalam container    | **`MAIL_TRANSPORT=log`.** Mailer menulis satu berkas **`.eml`** per email ke `storage/mail-preview/` alih-alih membuka koneksi SMTP                                               |

**Kenapa `.eml`, bukan `.html`.** Versi sebelumnya dokumen ini menulis `.html`, sementara `.env.example` dan
`src/config/env.ts` menulis `.eml`. Yang benar adalah **`.eml`**, dan ini bukan sekadar menyeragamkan ejaan: berkas
`.eml` adalah pesan MIME utuh, sehingga bisa dibuka langsung oleh klien mail (Outlook, Thunderbird, Mail) **berikut
header aslinya** — `From`, `To`, `Subject`, `Message-ID`, `Reply-To`, dan daftar lampiran. Itu persis bagian yang
perlu diperiksa saat mendebug email, dan persis bagian yang disembunyikan pratinjau `.html`, yang hanya menampilkan
badan pesan.

**Konsekuensi yang harus disadari:**

- Zona waktu server MySQL adalah tanggung jawab mesin lokal, bukan container. Dokumen rencana menyebut
  `--default-time-zone=+07:00` sebagai bagian mitigasi R13; pada Laragon setelan itu ditaruh di `my.ini`. Aturan yang
  lebih penting tetap berlaku dan tidak bergantung Docker: **UTC di database dan di kabel, `Asia/Jakarta` hanya saat
  render**, dan **jangan pernah memakai `NOW()` SQL di business logic** — kirim `Date` sebagai bound parameter,
  terutama di job release hold.
- Versi MySQL lokal dan MariaDB produksi bisa berbeda. Perbedaan yang relevan untuk proyek ini hanya perilaku
  `GET_LOCK`/`RELEASE_LOCK` dan `FOR UPDATE`; keduanya **wajib** diuji ulang di staging sebelum Fase 3 ditutup, bukan
  diasumsikan sama karena lulus di lokal.
- Gate "reset password sampai ke Mailpit" pada Fase 1 berubah menjadi "reset password menghasilkan berkas `.eml` di
  `storage/mail-preview/` dengan tautan yang benar-benar bisa diklik".

**Bila nanti Docker dipakai:**

1. Tambahkan `docker-compose.yml` di root `ubsc-api` berisi dua service: MariaDB 11 dan Mailpit.
2. Jalankan MariaDB dengan `--default-time-zone=+07:00`, dan mount volume bernama supaya data tidak hilang tiap
   `docker compose down`.
3. Ganti `DATABASE_URL` di `.env` ke host dan port container. **Jangan ubah kode apa pun** — inilah gunanya
   `DATABASE_URL` tunggal.
4. Ganti `MAIL_TRANSPORT=log` menjadi `smtp` dengan host Mailpit dan port `1025`, `secure: false`. Perhatikan bahwa
   produksi tetap `465` implicit TLS; jangan sampai setelan dev ikut terbawa ke `.env` produksi.
5. Tambahkan `storage/mail-preview/` ke `.gitignore` bila belum, dan jelaskan di README bahwa jalur pratinjau sudah
   digantikan Mailpit.
6. Jalankan ulang seluruh [Gate Fase 0](#gate-fase-0) — memindahkan database adalah perubahan infrastruktur, bukan
   perubahan konfigurasi kecil.

### (b) `prisma/seed.ts`, bukan `prisma/seed.js`

**Dokumen rencana menyebut** `prisma/seed.js` (mengikuti boilerplate `STARTER-BMU/BE`, dan pada resep "menambah
fitur" langkah 1 juga tertulis `prisma/seed.js`).

**Yang dikerjakan:** seeder ditulis TypeScript di `prisma/seed.ts`. `prisma.config.ts` menyetel `migrations.seed` ke
perintah itu, dan `npm run seed` memanggil hal yang sama.

**Alasan:** matriks permission harus punya **satu** sumber kebenaran di `shared/permissions.ts` — 16 permission
dikali 5 role staff, direproduksi verbatim dari `RoleAndPermissionSeeder.php`. Seeder wajib mengimpor daftar itu,
bukan menyalinnya. Seed `.js` CommonJS tidak bisa mengimpor berkas TypeScript tanpa langkah build tersendiri, dan
jalan pintas yang pasti diambil orang adalah menyalin ulang daftar permission ke dalam seeder. **Salinan kedua itu
persis yang R12 coba cegah**: dua daftar yang awalnya sama, lalu satu berubah, dan matriks role yang salah tidak
memunculkan error apa pun — hanya tombol yang diam-diam tidak muncul untuk role tertentu.

**Akibat untuk dokumen lain:** setiap kali dokumen rencana menulis `prisma/seed.js` — termasuk resep "menambah fitur"
langkah 1 dan baris Fase 1 ("15 seeder Laravel menjadi `prisma/seed.js`") — bacalah sebagai `prisma/seed.ts`. README
ketiga repo sudah memakai ejaan yang benar.

### (c) Runner dev memakai `tsx`, bukan `ts-node-dev`

**Boilerplate `STARTER-BMU/BE` memakai** `ts-node-dev --respawn --transpile-only` untuk `dev` dan `worker:dev`, serta
`ts-node` untuk `seed`.

**Yang dikerjakan:** ketiganya memakai `tsx` — `tsx watch src/app.ts`, `tsx watch src/worker.ts`,
`tsx prisma/seed.ts`. `ts-node` dan `ts-node-dev` dihapus dari `devDependencies`.

**Alasan — ini bukan soal selera, tapi soal dev yang mati sementara produksi jalan.** Proyek ini memakai
`"module": "Node16"` dan `"moduleResolution": "Node16"` di `tsconfig.json`. Di bawah setelan itu, TypeScript
meng-emit `await import('./x.js')` sebagai **import ESM native**. Import ESM native **melewati require-hook** milik
`ts-node-dev`, sehingga berkas `.ts` yang dituju tidak pernah dikompilasi dan prosesnya gagal saat berjalan — padahal
`npm run build` diikuti `npm start` baik-baik saja, karena di sana yang dijalankan sudah `.js` hasil `tsc`.
Kegagalan yang hanya muncul di dev sementara produksi hijau adalah jenis kegagalan yang paling lama didiagnosis.

Ada tiga jalan keluar, dan dua di antaranya lebih buruk:

| Opsi                                        | Kenapa tidak dipakai                                                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubah semua spesifier `./x.js` menjadi `./x` | Melanggar aturan Node16 dan hanya memindahkan masalah ke `tsc`                                                                                                                                                                                              |
| Turunkan project ke `"module": "commonjs"`  | CommonJS **mengabaikan peta `"exports"`** milik paket. Prisma 7 dan zod 4 mengandalkan peta itu untuk menentukan entry point yang benar; mengabaikannya berarti menerima resolusi yang tidak dijamin siapa pun dan berisiko pecah di rilis minor berikutnya |
| **`tsx`**                                   | **Dipakai.** `tsx` memetakan `.js` → `.ts` di dalam resolver-nya sendiri, jadi `tsconfig.json` **dan** spesifier `.js` di kode sama sekali tidak perlu diubah                                                                                               |

Dengan `tsx`, kode sumber tetap ditulis persis seperti yang diinginkan `tsc` untuk produksi, dan dev menjalankan kode
yang sama. Tidak ada dua dialek yang harus dijaga sinkron.

### (d) Nama cookie hidup di kode, bukan di environment

**Boilerplatenya** menaruh nama cookie refresh di variabel lingkungan. `.env.example` sempat memuat
`CUSTOMER_REFRESH_COOKIE=ubsc_c_refresh` dan `STAFF_REFRESH_COOKIE=ubsc_s_refresh`, dan `src/config/env.ts`
membacanya.

**Yang dikerjakan:** kedua variabel itu **dihapus** dari `.env.example` dan dari `src/config/env.ts`. Nilainya
sekarang hardcode di satu tempat — konstanta `COOKIES` di `src/services/auth-services.ts` — beserta penjelasannya.

**Alasan: nama cookie adalah kontrak lintas-repo, bukan konfigurasi.** Nama itu ditulis API saat login dan **dibaca
middleware kedua repo Next** untuk memutuskan halaman mana yang boleh dirender sebelum ada satu pun request ke API:

| Repo           | Berkas                          | Nilai                                                                      |
| -------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `ubsc-api`     | `src/services/auth-services.ts` | `ubsc_c_*` (customer) dan `ubsc_s_*` (staff)                               |
| `ubsc-landing` | `src/config/api.ts`             | `CUSTOMER_SESSION_COOKIE = 'ubsc_c_role'`                                  |
| `ubsc-admin`   | `src/config/auth.ts`            | `ROLE_COOKIE = 'ubsc_s_role'`, `PERMISSIONS_COOKIE = 'ubsc_s_permissions'` |

Nilainya harus sama di tiga repo sekaligus. Variabel lingkungan memberi satu kemampuan saja pada situasi seperti ini:
**mengubah salah satu sisi kontrak secara diam-diam, tanpa jejak di repo mana pun.** Akibatnya bukan error, melainkan
middleware yang menyimpulkan "tidak ada sesi" lalu memantulkan user yang sebenarnya sudah login kembali ke halaman
masuk — tanpa pesan error, tanpa baris log, dan tanpa satu pun diff yang bisa ditunjuk saat mencari penyebabnya.
Konstanta di kode memaksa perubahan itu melewati commit yang bisa di-review, dan di commit yang sama orang bisa
diingatkan untuk mengubah kedua repo Next.

Verifikasi:

```bash
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-api"
grep -rn "REFRESH_COOKIE" .env.example src/     # harus kosong
grep -rn "ubsc_c_refresh\|ubsc_s_refresh" src/  # hanya src/services/auth-services.ts
```

## Utang yang dibawa ke fase berikutnya

Daftar terurut: yang masih menahan penutupan Fase 0 lebih dulu, lalu yang memang sengaja diserahkan ke fase
pemiliknya. Setiap butir menyebut **path berkasnya** dan **fase penanggungnya**.

### Masih menahan penutupan Fase 0

| #   | Utang                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Path                                          | Penanggung |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- |
| 1   | **Belum ada repo git di satu pun dari tiga repo.** Ini akar dari tiga baris merah sekaligus: commit reformat Prettier belum ada, SHA di `.git-blame-ignore-revs` masih placeholder, lockfile belum bisa di-commit (R17), dan `git ls-files --eol` mustahil dijalankan. Setelah `git init` + commit reformat, jalankan `git log -1 --format=%H`, tempel hasilnya menggantikan baris `# <sha-40-karakter-commit-reformat-prettier>`, hapus baris `TODO Fase 0` di atasnya, lalu commit perubahan itu sebagai commit kecil terpisah | akar `ubsc-api`, `ubsc-landing`, `ubsc-admin` | **Fase 0** |
| 2   | `storage/mail-preview/` belum ada, padahal `MAIL_TRANSPORT=log` menulis berkas `.eml` ke sana                                                                                                                                                                                                                                                                                                                                                                                                                                    | `ubsc-api/storage/mail-preview/`              | **Fase 0** |
| 3   | `README.md` API masih menulis pratinjau email `.html`; yang benar `.eml` — lihat penyimpangan (a)                                                                                                                                                                                                                                                                                                                                                                                                                                | `ubsc-api/README.md:33`                       | **Fase 0** |

Setiap developer juga menjalankan sekali per clone, setelah repo git ada:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

### Sengaja diserahkan ke fase pemiliknya

| #   | Utang                                                                                                                                                                                                                                                                                                                                         | Path                                                                                         | Penanggung                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 4   | `middleware.ts` kedua repo Next baru menjawab satu pertanyaan: "pengunjung ini punya sesi atau belum?". Nama cookie-nya sudah benar, tapi peta route terlindungi, penanganan `returnUrl`, dan gate per-permission masih harus disesuaikan lagi saat area customer dan staff yang sungguhan dibangun                                           | `ubsc-landing/src/middleware.ts`, `ubsc-admin/src/middleware.ts`                             | **Fase 6** (customer) dan **Fase 7** (staff) |
| 5   | Komponen chrome masih boilerplate `STARTER-BMU/FE` apa adanya dan akan **diganti port 1:1** dari Laravel, bukan ditambal sedikit demi sedikit                                                                                                                                                                                                 | `ubsc-admin/src/components/layout/AdminSidebar.tsx`, `Navbar.tsx`, `PageContainer.tsx`       | **Fase 7**                                   |
| 6   | `DataTable` dan `calendar` masih boilerplate, belum di-port ke desain UBSC                                                                                                                                                                                                                                                                    | `ubsc-admin/src/components/table/DataTable.tsx`, `ubsc-admin/src/components/ui/calendar.tsx` | **Fase 8**                                   |
| 7   | Kerentanan `postcss` yang ter-bundle di dalam `next`. `npm audit` hanya melaporkan ini — `maplibre-gl` bersih, lihat `docs/spike-react-19.md`. Perbaikannya `next@16`, yang breaking, jadi ditunda                                                                                                                                            | `ubsc-landing/package.json`, `ubsc-admin/package.json`                                       | **Fase 9**                                   |
| 8   | Diet aset 170 MB menjadi di bawah 8 MB dan pemindahan reel ke CDN (R9)                                                                                                                                                                                                                                                                        | `docs/media.md`                                                                              | **Fase 9**                                   |
| 9   | `npm rebuild sharp` belum masuk langkah deploy (R16). `sharp` sudah dipin exact `0.35.4`, tapi binary-nya platform-spesifik: lockfile yang dibuat di Windows tidak membawa binary Linux, jadi tanpa rebuild di server upload gagal **saat runtime**, bukan saat deploy — kegagalannya muncul pada request user pertama yang mengunggah gambar | `ubsc-api/package.json`, `ubsc-api/docs/runbook.md` (belum dibuat)                           | **Fase 10**                                  |

## Yang belum dikerjakan dan menunggu fase berikutnya

Fase 0 sengaja berhenti di pondasi. Berikut yang **belum** ada dan fase pemiliknya, mengacu pada tabel "Fase
pengerjaan" dokumen rencana.

| Fase                   | Yang menyusul di sana                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. DB + auth**       | `schema.prisma` lengkap (termasuk `receiptSequence`, R3), migration, 15 seeder Laravel, auth dua audience lengkap dengan cookie terpisah (R4), `customer-api.ts` sebagai router ketiga, mailer + tabel `email_log` (R8), `requirePermission`, envelope error baru |
| **2. Design system**   | Font + `@font-face`, `@tailwindcss/upgrade` di salinan scratch, `globals.css` + blok kompatibilitas v3 (R7), `cn()`, `format.ts` versi final. **Gate: route `/styleguide` sekali-pakai** yang di-screenshot-diff lawan Laravel                                    |
| **3. Booking engine**  | `WeeklySchedule`, `WeeklySlots`, `FacilityPriceResolver`, `slots`, `month`, `POST /booking` 12 langkah, `ManualPayment` lengkap, isi cron worker (R1, R11, R14). **Gate: test konkurensi**                                                                        |
| **4. Landing slice**   | `/` utuh: EntranceLoader sampai Footer dengan data nyata dari API, Lenis. Baterai verifikasi fidelity                                                                                                                                                             |
| **5. Landing sisanya** | `/about`, `/pricing`, `/facilities`, `/news`, `/branches/[slug]`, tiga halaman legal, `/coming-soon`, `not-found`, sitemap, robots                                                                                                                                |
| **6. Customer area**   | `/riwayat-booking`, `/booking/[id]/pembayaran`, grid booking + `Class/*`, identity, review, profil (R10 bagian endpoint)                                                                                                                                          |
| **7. Admin chrome**    | Sidebar + Topbar + AuthGuard + `config/permissions.ts` + `/login` + `/unauthorized` + Dashboard                                                                                                                                                                   |
| **8. Admin CRUD**      | Facilities, Bookings, CheckIn, Classes, Memberships, Plans, Payments, Finance, Identity, CMS, Settings — berurutan, termasuk pemecahan halaman berat (R19)                                                                                                        |
| **9. Hardening**       | Diet aset 170 MB menjadi di bawah 8 MB dan pemindahan reel ke CDN (R9, lihat `docs/media.md`), rate limiting (R18), paginasi semua list admin, JSON-LD, audit `prefers-reduced-motion`, Lighthouse                                                                |
| **10. Deploy**         | VPS, nginx dua vhost (`/api` dan `/uploads` diterminasi di nginx), PM2 empat proses dari `ops/ecosystem.config.js`, MariaDB, Let's Encrypt, `pm2-logrotate`, UptimeRobot, dump harian, `docs/runbook.md` (R15)                                                    |

Dua catatan urutan dari dokumen rencana yang berlaku segera setelah Fase 0:

- **Fase 1 dan 2 berjalan paralel.**
- **Fase 3 dan 4 berjalan paralel setelah isi `ubsc-api/shared/contracts.ts` disepakati.** Dengan tiga repo,
  menyepakati kontrak lebih dulu bukan sekadar kerapian — itu syarat supaya kedua repo Next tidak menunggu API.

## Dokumen terkait

- `docs/spike-react-19.md` — hasil spike React 19 (R6): bukti runtime per library, versi exact ter-resolve, hazard
  scan React 18→19, dan koreksi atas klaim `@react-three/fiber@8` di dokumen rencana.
- `docs/media.md` — kebijakan aset berat (R9) dan daftar aset yang dihapus.
- `docs/route-inventory.md` — inventaris route Laravel dan pembagiannya menjadi URL halaman versus endpoint API (R10).
- `ops/ecosystem.config.js` — empat proses PM2, dipakai mulai Fase 10.
- `shared/README.md` — aturan menulis kontrak.
