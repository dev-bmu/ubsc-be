# Fase 3 — Booking engine

Status: **selesai, gate lulus.**

Ruang lingkup menurut `Rewrite.md`: `WeeklySchedule`, `WeeklySlots`, `FacilityPriceResolver`, `slots`, `month`,
`POST /booking` 12 langkah, `ManualPayment` lengkap, cron worker — ditambah test otomatis (jest + supertest) yang
menurut bagian Verifikasi wajib mendarat di Fase 1–3, bukan di akhir.

---

## Gate Fase 3

> "Test konkurensi lulus — dua booking bersamaan pada slot terakhir → tepat satu menang; bukti masuk saat hold
> lewat → `HoldLapsedException`; `expire()` no-op bila bukti sudah ada"

| Klausa                                      | Hasil     | Bukti                                                                                                                                                                                                         |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dua booking bersamaan pada slot terakhir    | **LULUS** | `tests/booking-concurrency.test.ts` — kursi terakhir (kapasitas 2, satu terisi), 8 pembeli vs kapasitas 1, rentang tumpang tindih sebagian, per unit, kelas 5 pembeli vs 3 kursi: selalu tepat sebanyak kursi |
| Kunci benar-benar menserialisasi            | **LULUS** | Test deterministik: pemegang kunci menahan `FOR UPDATE` 1,5 detik; pesaing terukur menunggu ≥ 1 detik lalu membaca booking yang baru di-commit dan ditolak                                                    |
| Bukti masuk saat hold lewat → HOLD_LAPSED   | **LULUS** | `tests/manual-payment.test.ts` — 409 `HOLD_LAPSED` + `fields.proof`, tidak ada kolom yang berubah; hold tepat di detik habisnya dianggap lewat; paket: satu sesi lewat menggagalkan seluruh grup              |
| `expire()` no-op bila bukti sudah ada       | **LULUS** | `tests/manual-payment.test.ts` — mengembalikan `false`, booking tetap `pending` dengan hold NULL, transaksi tetap `UNPAID/awaiting`                                                                           |
| Balapan antar operasi pembayaran (tambahan) | **LULUS** | approve vs expire ×8 dan attachProof vs expire ×8: tepat satu menang, keadaan akhir selalu konsisten. **Keduanya gagal sebelum perbaikan di bagian "Temuan besar" di bawah.**                                 |

Seluruh suite: **57 test di 7 berkas, ± 20 detik**, Jest keluar bersih.

```bash
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS ubsc_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"   # sekali
npm test
npm run typecheck
```

### Paritas dengan Laravel asli

Controller Laravel dipanggil langsung lewat `php artisan tinker` terhadap database `ubsc`, lalu dibandingkan dengan API
baru terhadap `ubsc_dev` untuk "Lapangan Tenis" (konfigurasi dan harganya identik di kedua database):

- `slots` tanggal 28 September (kosong), 15 September (hari ini — pemisahan `past`/`available` di jam sekarang),
  14 September (kemarin);
- `month` September 2026: amplop (`month_label`, `closed_dates`, `capacity`, `session_note`), seluruh `patterns`,
  dan grid lima hari terakhir.

Hasil setelah kunci snake_case → camelCase: **0 perbedaan**. Skrip pembandingnya sekali pakai, tidak di-commit.

### Worker

`tsx src/worker.ts` terhadap `ubsc_dev`: `Job terdaftar: payments:release-expired (*/5 * * * * Asia/Jakarta)`, cron
menyala pukul 09:40:00, selesai 134 ms di bawah named lock, dan MySQL mencatat **satu** koneksi dari proses itu — client
pool-1 worker yang dipakai service, pool API 20 koneksi tidak pernah dibuka.

---

## Temuan besar: `updateMany().count` BUKAN compare-and-swap

**Koreksi terhadap `Rewrite.md`, "Konkurensi" mekanisme #3.** Rencana mengandalkan `updateMany()` sebagai conditional
UPDATE yang `count`-nya adalah hasil CAS. Log query Prisma 7.10 (`relationMode = "prisma"`, adapter MariaDB)
menunjukkan bentuk yang berbeda:

```sql
SELECT `transactions`.`id` FROM `transactions`
 WHERE (`transactions`.`id` = ? AND `transactions`.`paymentStatus` = ? AND `transactions`.`verificationStatus` IS NULL)
UPDATE `transactions` SET `paymentStatus` = ?, `pendingTotal` = ?, `updatedAt` = ?
 WHERE (`transactions`.`id` IN (?) AND 1=1)
```

Syaratnya hanya ada di SELECT yang **tidak mengunci**; UPDATE-nya memakai id saja. `count` adalah jumlah baris yang
ditemukan SELECT itu, dan `foundRows: true` tidak berpengaruh apa pun padanya. Pada `bookings` ada SELECT tambahan
(`... WHERE bookingGroupId IN (...)`) untuk relasi self-reference — besar kemungkinan bentuk ini memang lahir dari
emulasi referential action `relationMode = "prisma"`.

Akibatnya terukur di test: approve dan expire pada transaksi yang sama **dua-duanya menang**, dan attachProof yang
berbarengan dengan expire meninggalkan transaksi `EXPIRED` yang punya bukti — persis double-approve dan pembatalan
pelanggan yang sudah membayar yang ingin dicegah Rewrite.md.

Perbaikan (`src/services/manual-payment-services.ts`): **kunci dulu, baru baca dan tulis.** Setiap operasi —
`attachProof`, `approve`, `reject`, `expire`, pelepasan booking tanpa transaksi — mengambil
`SELECT ... FOR UPDATE` pada baris transaksi, lalu pada seluruh baris booking grupnya, baru membaca status dan menulis.
Pola baca-cek-tulis setelahnya aman hanya karena kunci dipegang sampai commit. Urutan kunci seragam (transaksi → booking)
sehingga tidak ada siklus deadlock.

Aturan untuk fase berikutnya:

- `updateMany().count` bukan bukti apa pun di codebase ini. Jangan dipakai sebagai syarat korektness.
- Siapa pun yang menulis status booking berbayar (panel admin Fase 8: edit/batal booking, check-in) wajib mengikuti
  urutan kunci yang sama: baris transaksi dulu, lalu booking.
- Komentar `foundRows` di `application/database.ts` sudah dikoreksi; pin-nya tetap dipertahankan untuk `$executeRaw`.

`POST booking` tidak terdampak: sejak awal ia mengunci baris fasilitas/unit sebelum membaca okupansi, dan hanya INSERT.
`membership-services` juga tidak: kuncinya baris `users` + `count`, bukan `updateMany`.

---

## Temuan lain saat porting

1. **`isUniqueViolation()` tidak mengenali P2002 dari driver adapter** (bug buatan saya sendiri di awal fase ini).
   Dengan adapter, nama indeks ada di `meta.driverAdapterError.cause.constraint.index`, bukan `meta.target`; versi awal
   men-JSON-kan error dengan replacer array yang diam-diam menyaring kunci bersarang. Akibatnya loop kode unik tidak
   pernah mencoba kode kedua — satu tabrakan langsung jadi 500. Ditangkap test "sembilan checkout berebut sembilan kode
   tersisa". `utils/prisma-errors.ts` kini membaca field terstruktur saja, tidak mencocokkan teks pesan (pesan Prisma
   memuat potongan kode sumber yang bisa menyebut kolom lain).
2. **Email `void` terpotong saat shutdown.** Email keputusan pembayaran sengaja hidup lebih lama dari request-nya (R8),
   jadi drain HTTP di `app.ts` tidak menunggunya; `$disconnect` memotongnya dan baris `email_logs` salah tercatat.
   Test menangkapnya sebagai Jest yang tidak pernah keluar. `mailer.ts` kini melacak kiriman in-flight
   (`waitForPendingMail`), dan `app.ts` menunggunya setelah drain HTTP, sebelum menutup pool.
3. **Seeder Fase 1 menggeser `startsAt`/`endsAt` 7 jam** (`combineDateTime` membaca jam Jakarta sebagai UTC) dan tidak
   memberi booking demo token check-in (hook `creating` Laravel memberinya). Diperbaiki; 20 baris di `ubsc_dev`
   dibetulkan dengan skrip baru `npm run check:booking-instants -- --fix`, yang juga berguna untuk impor data Fase 10.
4. **`Carbon::createFromFormat('Y-m', ...)` di `month()` Laravel meluap** pada tanggal 29–31: tanpa `!`, hari diisi
   dari tanggal hari ini, jadi meminta "2026-11" pada 31 Oktober menghasilkan Desember. Diperbaiki (penyimpangan
   disengaja), dikunci test.
5. `lang/` Laravel hanya berisi `en`, jadi pesan validasi bawaan (`exists`, `date_format`, `after_or_equal`) tampil
   berbahasa Inggris di Laravel. Di sini semuanya bahasa Indonesia.

---

## Endpoint

| Method | Path                                                | Auth / pagar                                     | Limit                     | Laravel                  |
| ------ | --------------------------------------------------- | ------------------------------------------------ | ------------------------- | ------------------------ |
| GET    | `/api/public/booking/slots`                         | customer **opsional**                            | 120/menit (bersama month) | `booking.slots`          |
| GET    | `/api/public/booking/month`                         | customer **opsional**                            | 120/menit (bersama slots) | `booking.month`          |
| GET    | `/api/customer/booking`                             | customer, bukan staff                            | —                         | `booking.history`        |
| POST   | `/api/customer/booking`                             | customer, bukan staff; email terverifikasi (422) | 10/menit                  | `booking.store`          |
| GET    | `/api/customer/booking/:bookingId/pembayaran`       | customer, bukan staff, email terverifikasi (403) | —                         | `booking.payment`        |
| POST   | `/api/customer/booking/:bookingId/pembayaran/bukti` | idem; multipart field `proof`, 10 MB             | 10/menit                  | `booking.payment.proof`  |
| GET    | `/api/customer/payments/:transactionId/bukti`       | customer pemilik transaksi                       | —                         | `payments.proof`         |
| GET    | `/api/admin/payments/:transactionId/bukti`          | staff `bookings.manage` \| `payments.manage`     | —                         | `payments.proof`         |
| POST   | `/api/admin/payments/:transactionId/approve`        | staff `bookings.manage` \| `payments.manage`     | —                         | `admin.payments.approve` |
| POST   | `/api/admin/payments/:transactionId/reject`         | idem; body `{ reason }` wajib, maks 300          | —                         | `admin.payments.reject`  |

Path mengikuti `docs/route-inventory.md`. Dua endpoint GET pelanggan (riwayat dan instruksi transfer) belum tercantum di
inventaris karena di Laravel keduanya halaman Inertia; data halamannya kini datang dari endpoint ini.

"Auth opsional": tanpa header `Authorization` → pengunjung anonim; header ada tapi tidak sah → **401**, bukan diam-diam
anonim. Kalau diabaikan, interceptor FE tidak pernah me-refresh token dan pelanggan warga UB melihat harga umum.

---

## Keputusan dan penyimpangan yang disengaja

| #   | Laravel                                                           | Sistem baru                                                    | Alasan                                                                                                |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| a   | Bukti saat hold lewat → 422 validasi                              | 409 `HOLD_LAPSED`, tetap membawa `fields.proof`                | Kontrak kode error Fase 0; FE tetap bisa menempelkan pesan ke input                                   |
| b   | Booking/transaksi orang lain → 403                                | 404                                                            | "Tidak ada" dan "bukan milikmu" dijawab sama (kontrak `NOT_FOUND`)                                    |
| c   | Approve/reject yang sudah diproses → 403                          | 409 `CONFLICT`                                                 | Bentrok status, bukan kurang izin                                                                     |
| d   | Email keputusan dikirim inline; flash "terkirim"/"GAGAL terkirim" | `void sendMailSafe()` setelah commit; DTO `mailQueued`         | Rewrite.md R8. **Fase 8:** teks flash admin tidak bisa lagi mengklaim "terkirim" — rujuk `email_logs` |
| e   | Isi email payment approved/rejected                               | Disalin kata per kata dari Mailable + blade Laravel            | Template Fase 1 sebelumnya karangan sendiri; subjek, kalimat, tombol, dan URL kini sama               |
| f   | `RedirectStaffFromPublic` → 403 untuk request JSON/non-GET        | `denyStaffAccounts` 403 di riwayat, POST booking, pembayaran   | Staff boleh login di situs publik (Fase 1) tapi tidak bertransaksi sebagai pelanggan                  |
| g   | Satu route bukti untuk pemilik dan staff (satu sesi web)          | Dua route, satu per audience                                   | Token staff tidak pernah sah di router customer                                                       |
| h   | `<img src>` ke route bukti (cookie sesi)                          | FE wajib mengambil bukti sebagai blob lewat axios              | Access token hidup di memori JS; `<img>` tidak bisa mengirim Bearer                                   |
| i   | Aturan `image\|mimes` membaca isi berkas                          | Tanpa filter mimetype di multer; decoder sharp yang memutuskan | Content-Type multipart ditulis klien; sebagian aplikasi m-banking mengirim `octet-stream`             |
| j   | Unggah bukti → redirect back + flash                              | 200 dengan `PaymentDetailDto` terbaru                          | FE tidak perlu request kedua                                                                          |
| k   | `days: []` saat kosong (array PHP)                                | Selalu objek `{}`                                              | Satu bentuk untuk FE                                                                                  |
| l   | `openTransfer` menghitung `expires_at` dengan `now()` sendiri     | Sama dengan `holdExpiresAt` booking                            | Selisih milidetik tanpa arti; satu sumber waktu                                                       |
| m   | Riwayat: tiebreak `id desc` (auto-increment)                      | `createdAt desc, id desc`                                      | PK uuid tidak berurutan                                                                               |
| n   | Harga dan tanggal diformat Carbon/PHP                             | `utils/money.ts` + `utils/clock.ts` meniru byte-per-byte       | "Rp 1.500.000" dengan spasi biasa (bukan NBSP Intl), "Agt" (bukan "Agu" Intl)                         |

### Kejanggalan Laravel yang sengaja dipertahankan demi paritas

- `month()` menandai `hasPast` untuk sesi lewat yang dibatalkan/tutup, sementara `monthSessionKeys()` (dipakai POST)
  melewatinya lebih dulu. Pada kasus tepi keduanya bisa berbeda pendapat soal paket.
- Pemeriksaan kapasitas POST menjumlahkan pax **semua** booking yang tumpang tindih dengan rentang yang diminta, bukan
  maksimum per saat — konservatif untuk rentang multi-slot pada kapasitas > 1.
- `packagePrice` tidak memeriksa `useCustomPricing` (berbeda dari harga per sesi).
- "Sesi milik sendiri" di `month()` mencocokkan unit persis, tanpa `OR facilityUnitId IS NULL`.
- Slot berakhir 24:00 tidak pernah bisa dipesan: `date_format:H:i` menolak "24:00".

---

## Infrastruktur test

- `jest.config.js`: ts-jest dengan `tsconfig.test.json` (`isolatedModules`, transpile per berkas — module Node16 tidak
  didukung ts-jest tanpanya, dan tipe paket dual ESM/CJS seperti sharp bisa ter-resolve berbeda dari tsc). Error tipe
  diperiksa `npm run typecheck`, yang kini mencakup `tests/`.
- `tests/global-setup.ts`: tolak database yang tidak berakhiran `_test`, lalu `prisma migrate deploy`.
- `tests/setup-env.ts`: `DATABASE_URL` test, folder penyimpanan test, dan **`TZ=UTC` dengan sengaja** — kode yang diam-diam
  bergantung pada TZ proses gagal di test, bukan di mesin dev yang kebetulan ber-TZ Jakarta.
- `tests/helpers/fixtures.ts`: setiap test membuat fasilitas dan pelanggannya sendiri; database dikosongkan (TRUNCATE)
  sekali per berkas. Jam dibekukan dengan `setNowForTests()` — satu-satunya sumber "sekarang" di domain booking.

---

## Perubahan kontrak (R12)

Hash `1a84381c…` → **`67ecc8e6d8aaabbb15f894f69d9938a6904b1193f720274c852c2821e42e2a2e`**; `npm run sync:contracts` sudah
dijalankan di `ubsc-landing` dan `ubsc-admin` (tsc kedua repo lulus).

DTO baru di `shared/contracts.ts`: `SlotDto`, `SlotsDto`, `MonthDto` (+ `MonthDayDto`, `MonthSessionDto`,
`MonthPatternDto`, `MonthSummaryDto`, `MonthPackageDto`), `CreateBookingRequest`, `BookingCreatedDto`,
`BookingSessionDto`, `PaymentDetailDto`, `PaymentRedirectDto`, `BookingHistoryItemDto`, `PaymentDecisionDto`, serta union
status `BookingStatus`, `PaymentStatus`, `VerificationStatus`, `SlotStatus`, `SessionStatus`, `ClosedReason`.

---

## Catatan untuk Fase 4 (landing)

- Field camelCase. String harga dan tanggal sudah terformat persis Laravel — tampilkan apa adanya; hitung dengan `...Raw`.
- `holdExpiresAt` dan `proofUploadedAt` ISO-8601 UTC; tanggal kalender "YYYY-MM-DD" dan jam "HH:mm" selalu Jakarta.
- `GET .../pembayaran` bisa membalas `{ redirectToBookingId }` untuk anggota paket — ganti URL lalu minta ulang.
- Error per sesi paket menempel di `sessions.<index>` (indeks setelah dedup + urut), rentang lapangan di `startTime`.
- Kode yang perlu ditangani khusus: `HOLD_LAPSED`, `PENDING_TOTAL_EXHAUSTED`, `RATE_LIMITED`, 403 akun staff.
- Grid slot dan kalender dipanggil DENGAN token bila pelanggan login (kategori harga + "sudah Anda pesan").

---

## Belum dikerjakan / tindak lanjut

- **Panel admin (Fase 8):** antrean verifikasi + pengaturan rekening, check-in, roster kelas (bug 1: wajib memakai
  `blocking()`), edit/batal booking — semuanya wajib mengikuti urutan kunci di atas.
- **Sisa Fase 1 yang tertemukan saat meninjau ulang `updateMany`:** rotasi refresh token dan pemakaian token reset password
  adalah baca-lalu-tulis tanpa kunci. Dari membaca kodenya (belum diuji), dua refresh bersamaan dengan token yang sama
  berpotensi sama-sama lolos, dan deteksi reuse bisa terlewat pada balapan itu. Risiko rendah, tapi polanya sama dengan
  yang diperbaiki di sini — kunci baris token dengan `FOR UPDATE`.
- `scripts/check-orphans.ts`: daftar `ORPHAN_CHECKS` masih kosong (TODO Fase 1 yang tertinggal).
- `errorMiddleware` memetakan P2002 lewat `meta.target`, yang tidak ada pada driver adapter — pesan 409 generik tetap
  benar, tapi `fields` kosong.
- `scripts/sync-contracts` di kedua repo Next memicu peringatan Node `DEP0190` (spawn dengan `shell: true` + argumen).
- **Gate Fase 2 (fidelity CSS) masih belum bersih** dan tetap memblokir Fase 4 — lihat `docs/fase-2.md`.
