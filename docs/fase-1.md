# Fase 1 — Database + Auth

Status: **selesai, gate lulus.**

Ruang lingkup menurut `Rewrite.md`: `schema.prisma` lengkap (termasuk `receiptSequence`), migration,
seeder (15 seeder Laravel), auth dua audience lengkap, mailer + `email_log`, `requirePermission`,
envelope error baru.

---

## Gate Fase 1

> "Login staff & customer dari kedua app Next; reset password sampai ke Mailpit"

| Klausa                             | Hasil     | Bukti                                                                                                   |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| Login staff dari `ubsc-admin`      | **LULUS** | `POST :3001/api/auth/staff/login` → 200, klaim `aud: staff`, cookie `ubsc_s_{refresh,role,permissions}` |
| Login customer dari `ubsc-landing` | **LULUS** | `POST :3000/api/auth/customer/login` → 200, klaim `aud: customer`, cookie `ubsc_c_*`                    |
| Reset password sampai ke inbox     | **LULUS** | Berkas `.eml` tertulis di `storage/mail-preview/`, baris `email_logs` berstatus `sent`                  |

Mailpit diganti `MAIL_TRANSPORT=log` — lihat penyimpangan (a) di [fase-0.md](./fase-0.md).
Berkas `.eml`-nya RFC822 asli dan bisa dibuka klien mail apa pun.

Cara menjalankan ulang gate:

```bash
cd ubsc-api && npm run dev          # :4020
cd ubsc-landing && npm run dev      # :3000
cd ubsc-admin && npm run dev        # :3001

curl -s -H 'Content-Type: application/json' \
  -d '{"email":"admin@ubsc.id","password":"password123"}' \
  http://localhost:3001/api/auth/staff/login
```

---

## Skema

31 tabel domain, 8 enum. Sumber kebenaran saat porting adalah DDL hasil `mysqldump --no-data` dari
database `ubsc` yang sudah ter-migrate penuh — bukan pembacaan ulang 55 file migration, yang
menumpuk perubahan dan mudah salah baca.

Keputusan yang diminta `Rewrite.md`, semuanya terverifikasi jalan:

| Keputusan                                    | Bukti                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receiptSequence` (R3)                       | DDL: `receiptSequence int NOT NULL AUTO_INCREMENT` + `UNIQUE KEY` berdampingan `PRIMARY KEY (id)` uuid. Seed menghasilkan `UBSC-000001`, `UBSC-000002`, … — format identik Laravel |
| Polymorphic → dua FK                         | `bookingId` / `membershipId`, masing-masing `@unique`. Terverifikasi: tepat satu terisi per transaksi                                                                              |
| `startsAt` / `endsAt` (bug 11)               | Terisi bersamaan dengan `bookingDate`+`startTime`; 0 baris NULL setelah seed; `@@index([endsAt])` terpasang                                                                        |
| `pendingTotal @unique`                       | Terpasang — mekanisme korektness untuk retry loop Fase 3                                                                                                                           |
| 8 Prisma enum                                | Hanya set yang di Laravel berupa DB `enum()`; `bookingMode`/`scheduleType`/`priceType` tetap String                                                                                |
| Cluster/Unit/Division dibuang                | Tidak ada di schema                                                                                                                                                                |
| `@@unique([roleName, permissionId])` (bug 7) | Tanpa `divisionId`, jadi benar-benar ditegakkan indeks                                                                                                                             |

### Keputusan tambahan yang saya ambil (tidak diatur eksplisit di `Rewrite.md`)

1. **Uang disimpan `Int`, bukan `BigInt`.** Laravel memakai `bigint unsigned`, tapi tidak satu pun
   nominal UBSC mendekati plafon `Int` (Rp 2.147.483.647), sementara `BigInt` melempar di
   `JSON.stringify` dan menuntut replacer khusus di ketiga repo. Kalau suatu saat ada nominal
   mendekati plafon itu, naikkan ke `BigInt` **sekaligus** dengan serializer-nya.
2. **`rating` disimpan `Float`, bukan `Decimal`.** Prisma `Decimal` mengembalikan objek decimal.js
   yang menular ke setiap jalur serialisasi; untuk nilai 0..5 satu angka desimal, `Double` sudah eksak.
3. **`startTime`/`endTime` disimpan `String "HH:mm"`, bukan `DateTime @db.Time`.** Kolom
   `activeSlots`/`slotQuotas` menyimpan jam dalam bentuk itu (`{"Wednesday":["15:51","16:55"]}`),
   jadi String membuat perbandingan slot langsung cocok — dan menghindari `DateTime @db.Time` yang
   mengembalikan 1970-01-01 di bagian tanggalnya.
4. **`IdentityCategory` dan `UserCategory` jadi dua enum terpisah.** Nilainya memang berbeda di
   Laravel (`warga_kampus` pada user, `warga_ub` pada baris harga) dan dipetakan dengan
   `identity_category === 'warga_kampus' ? 'warga_ub' : 'umum'`. Dua enum membuat pemetaan itu
   eksplisit alih-alih tersembunyi di string.

---

## Seeder

15 seeder Laravel → `prisma/seed.ts` + `prisma/seeders/*.ts`, urutannya mengikuti `DatabaseSeeder.php`.
Idempoten: dijalankan dua kali menghasilkan nol perubahan.

Hasil seed master data: 16 permission · 5 role · 44 tautan role-permission · 5 akun staff ·
2 kategori fasilitas · 11 fasilitas · 18 baris harga · 7 berita · 39 berkas media · 4 pengaturan sistem ·
2 jadwal booking.

Matriks role cocok persis dengan `RoleAndPermissionSeeder.php`:
Administrator 16 · Manager 16 · Finance 5 · Staff Central 5 · Staff Front Office 2.

### Dua tambahan di luar Laravel

- **`SystemSetting` dan `BookingSchedule` ikut di-seed.** Laravel membiarkan keduanya kosong sampai
  diisi dari panel. Tapi tanpa rekening tujuan, halaman pembayaran transfer manual tidak punya nomor
  untuk ditampilkan; tanpa jadwal terbuka, tidak ada satu pun tanggal yang bisa di-booking.
  Nomor rekeningnya placeholder (`UB Sport Center (DUMMY)`) dan **wajib diganti sebelum produksi**.
- **Data demo digerbangi `SEED_DEMO=true`.** Laravel selalu menjalankan `BookingSeeder` lewat
  `DatabaseSeeder`, sehingga 20 booking palsu ikut tertanam ke database mana pun yang kebetulan
  di-seed — termasuk produksi.

### Temuan saat porting

`SC-Mart.png` tidak pernah ada di repo Laravel, dan database lamanya memang hanya punya 4 dari 5 logo
sponsor. Seeder di sini memperlakukannya sama: berkas sumber tidak ada → **baris `Media` tidak dibuat
sama sekali**, dan alasannya dicetak tiap kali seeder jalan. Baris Media yang menunjuk berkas tidak ada
lebih buruk daripada tidak ada baris — ia lolos semua pemeriksaan lalu merender gambar rusak.

---

## Auth dua audience

Yang membedakan customer dan staff hanya lima hal: nama cookie, secret JWT, klaim `aud`, kolom
`audience` di `refresh_tokens`, dan keharusan punya role staff.

### Terverifikasi jalan

| Uji                                                  | Hasil                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| Access token staff → `/api/admin/me`                 | 200                                                                |
| Access token customer → `/api/admin/me`              | 401                                                                |
| Access token customer → `/api/customer/me`           | 200                                                                |
| Access token staff → `/api/customer/me`              | 401                                                                |
| Refresh token customer → `/api/auth/staff/refresh`   | 401, `AUDIENCE_MISMATCH` tercatat di log, **dan tokennya dicabut** |
| Register → verifikasi email → token dipakai dua kali | Penggunaan kedua ditolak                                           |
| Forgot password: email terdaftar vs tidak            | Balasan **identik**; hanya satu email benar-benar terkirim         |
| Reset password → login password baru / lama          | Baru: 200. Lama: 401                                               |
| Rate limit login                                     | Percobaan 1–5: 401. Ke-6 dan seterusnya: 429 dengan envelope benar |

### Endpoint baru (customer saja)

`POST /api/auth/customer/register` · `/verify-email` · `/resend-verification` · `/forgot-password` ·
`/reset-password` · `GET /google` · `GET /google/callback`

Tidak ada padanannya di sisi staff, dan itu disengaja: akun staff dibuat administrator lewat panel
(Fase 8). Membuka `/staff/register` berarti siapa pun bisa membuat akun di origin panel.

Token verifikasi dan reset dikirim lewat **body**, bukan path — token di URL ikut tercatat di log akses
nginx, riwayat browser, dan header `Referer` ke pihak ketiga.

---

## Mailer

`nodemailer`, SMTP Hostinger `:465` TLS implisit. Empat sifat yang di-port dari Laravel:
kirim setelah commit · kirim di luar `$transaction` · kegagalan tidak dilempar (`void sendMailSafe()`,
dijaga ESLint `no-floating-promises`) · timeout 10 detik di tiga titik (koneksi, greeting, socket).

Tambahan di luar Laravel: tabel `email_logs` (status, attempts, lastError) supaya staff bisa melihat
dan memicu ulang kiriman gagal dari panel admin (Fase 8). Empat template: verifikasi email, reset
password, pembayaran disetujui, pembayaran ditolak — dua terakhir dipakai `ManualPayment` di Fase 3.

---

## Perubahan kontrak (R12)

`ErrorCode` bertambah satu: **`SERVICE_UNAVAILABLE`** (502/503/504). Sebelumnya seluruh 5xx jatuh ke
`INTERNAL_ERROR`, sehingga FE tidak bisa membedakan "dependensi sedang mati, boleh coba lagi" dari
"ada bug" — padahal seluruh desain envelope justru mengarahkan FE bercabang pada `code`.

Hash kontrak berubah `6881e107…` → `1a84381c…`. `npm run sync:contracts` sudah dijalankan di kedua repo
Next dan ketiganya kembali cocok.

---

## Risiko yang perlu dipantau

1. **Rate limit login 5/menit mengikat ke IP, dan UBSC ada di kampus.** Jaringan kampus biasanya
   keluar lewat sedikit IP NAT bersama, jadi seluruh pengunjung dari wifi kampus berbagi jatah yang
   sama. `skipSuccessfulRequests` memperkecil dampaknya, tapi begitu jendelanya habis, login yang
   benar pun ikut kena 429. Angkanya diambil apa adanya dari `Rewrite.md`; **pantau frekuensi baris
   `RATE_LIMIT login` di log setelah rilis**. Kalau sering muncul dari IP sama dengan akun
   berbeda-beda, itu NAT kampus, bukan serangan.
2. **R18 belum bisa diverifikasi di sini.** Seluruh mekanisme rate limit bersandar pada `req.ip` yang
   benar, yang bergantung pada nginx meneruskan `X-Forwarded-For`. Wajib dicek di staging sebelum
   produksi — kalau tidak, limitnya jadi global dan lima percobaan gagal mengunci seluruh situs.
3. **`/api/health/deep` menggantung saat DB mati** — ping DB belum punya timeout, jadi monitoring
   melihat request menggantung alih-alih status down. Utang Fase 10 (R15).
4. **Google OAuth belum diuji end-to-end** — butuh kredensial `GOOGLE_CLIENT_ID`/`SECRET` yang belum
   ada. Jalur kodenya lengkap (state anti-CSRF, account linking by email, normalisasi avatar
   `=s\d+(-c)?` → `=s256-c`, email terverifikasi hanya bila `email_verified` true), tapi belum pernah
   benar-benar menempuh perjalanan ke Google.

---

## Belum dikerjakan (bukan ruang lingkup Fase 1)

- Test otomatis jest + supertest. `Rewrite.md` menjadwalkan ~8 berkas test mendarat di Fase 1–3, dan
  jalur konkurensi booking adalah **gate Fase 3**. Folder `tests/` masih kosong — ini utang yang paling
  perlu dibayar lebih dulu di Fase 3.
- `scripts/check-orphans.ts` masih kerangka: `ORPHAN_CHECKS` kosong. Sekarang schema-nya sudah lengkap,
  isinya bisa ditulis (R2).
- Upload (Multer + sharp) dan `media-services` — Fase 1 hanya membuat baris `Media`; pipeline unggah
  sungguhan ada di Fase 6/8.
