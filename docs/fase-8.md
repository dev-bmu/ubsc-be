# Fase 8 — Admin CRUD

Padanan baris **Fase 8** di `Rewrite.md`: seluruh halaman CRUD admin (facilities, bookings, memberships,
finance, CMS, settings) + endpoint tulis `/api/admin/*`. Keputusan user: kerjakan Fase 8 dulu (sebelum
5-6) supaya panel admin berfungsi penuh. Dikerjakan **per-domain**: tiap domain = bangun API → port
halaman 1:1 → wire (ganti stub `ComingSoon`) → verifikasi (build + paritas className + tes API).

Peta batch: **8A** Facilities · 8B Booking/Check-in/Roster · 8C Membership · 8D Payment/Finance ·
8E Identity · 8F CMS (news/promo/sponsors/reels/testimonials + info-banner & gym-traffic dari Fase 7) ·
8G Settings (RBAC/Schedules/Users + profil staf & notifikasi).

## Fondasi lintas-domain: unggah media (dibangun di 8A, dipakai semua domain gambar)

`ubsc-api` sebelumnya hanya BACA media (landing Fase 4). Fase 8 menambah jalur TULIS:
- `src/services/media-store-services.ts` — `storePublicMedia({modelType, modelId, collectionName, buffer,
  originalName, ...})`: sharp `inspect` (validasi isi berkas, bukan ekstensi) + `encode` (webp, fallback
  png; `MAX_EDGE` 1600, `WEBP_QUALITY` 78, `.rotate()` buang EXIF) → tulis `uploads/media/<uuid>/<kebab>.<ext>`
  (tata letak PERSIS `attachMedia` seeder) → `Media.create(disk:'public')`. Plus `deleteMediaCollection`,
  `deleteMediaRow`, `unlinkMediaFiles` (hapus berkas fisik SETELAH commit — filesystem tak ikut rollback).
- `src/middleware/upload-middleware.ts` — `fieldsFileUpload([...])` (multer `.fields()`, hero+gallery satu
  submit), `facilityMediaUpload`, `unitImageUpload`. `CMS_IMAGE` config diberi `maxWidth/maxHeight` (pagar
  decompression bomb).
- URL media tetap RELATIF (`/uploads/media/...`) — konsisten dengan Fase 4 (proxy same-origin).

## 8A — Facilities (SELESAI)

### API (`ubsc-api`) — 16 endpoint, 3 router
`/api/admin/facilities` (index/create-form/store/reorder/edit-form/update/destroy/pricing/pricing-sync/
units-index/unit-store + `DELETE /gallery/:mediaId`), `/api/admin/facility-categories` (index/store/update/
destroy/reorder), `/api/admin/facility-units` (update/destroy). File: `src/services/facility-services.ts`,
`src/validation/facility-validation.ts`, `src/controller/facility-controller.ts`,
`src/routes/details/admin-facilities.ts` (+ categories/units), `src/utils/weekly-slots.ts`
(`normalizeSlots`/`normalizeQuotas`/`humanizeDuration`, port `WeeklySlots.php`). DTO admin di
`shared/contracts.ts` (`AdminFacilityDto`, `FacilityCategoryDto`, `FacilityPriceRowDto`,
`AdminFacilityUnitDto`, `MediaRefDto`, dst).

Keputusan yang beda dari Laravel (konsisten dipakai seluruh Fase 8):
- **camelCase di kabel** (input & output). FE kirim field camelCase + JSON string untuk
  activeSlots/slotQuotas/displayMetadata/prices; API `z.preprocess(JSON.parse)` + `z.coerce` untuk
  koersi multipart; boolean `'true'/'false'`.
- **id uuid string** (Laravel int). Reorder `{ids: string[]}`, `sortOrder = index+1`.
- **PUT sungguhan** (tanpa `_method` spoof) untuk update multipart.
- Harga (pricing sync + unit prices) **full-replace** dalam `$transaction`. Slot dinormalisasi
  server-side. slug unik → P2002 jadi 422 field error. `ensureClassHasAGroup` (mode class 0 unit → buat
  unit "Reguler" default). Gate: index `requireAny(READ|MANAGE|PRICING)`, tulis `requirePermission(MANAGE)`,
  pricing `requireAny(PRICING|MANAGE)`.

### Frontend (`ubsc-admin`)
- 9 komponen shared di-port + WeeklySlotEditor: `DataTable, Pagination, SlideOver, StatusBadge,
  ImageDropzone, SortableCard, StatCard, tokens, WeeklySlotEditor` (semua paritas className identik).
- Data layer: `src/services/Facilities.ts` + `src/hooks/api/useFacilities.ts` (TanStack Query;
  mutasi meng-invalidate). `src/lib/apiError.ts` (`extractApiError`/`fieldErrorMap`) untuk 422.
- 4 halaman: `src/features/(protected)/facilities/{page,form,pricing,units}/...` + CSS co-located.
  Multipart via FormData manual (camelCase + JSON.stringify blob + file). Route shell di
  `app/(protected)/facilities/{,create,[id]/edit,[id]/pricing,[id]/units}/page.tsx`.

### Verifikasi
- `next build` **exit 0** (26 route). Paritas className **identik** 4 halaman + 9 komponen shared
  (selisih hanya token wrapper AdminLayout yang sengaja dipindah ke halaman).
- API diuji end-to-end vs DB nyata: index/form/edit/pricing/units 200 dengan data benar; kategori
  create→delete; reorder; **facility create dengan hero+gallery → webp tersaji `image/webp` → delete →
  berkas 404**. `/facilities` unauth → 307 `/login?returnUrl=/facilities`.
- Belum discreenshot render terautentikasi (aturan Claude: tak mengetik password) — user login untuk melihat.

## 8B — Booking / Check-in / Class roster (SELESAI)

### API (ubsc-api)
3 router baru: /api/admin/bookings (index full-list, POST staff-create, PATCH status, DELETE soft-cancel), /api/admin/checkin (index hari-ini+search, GET/POST /:token), /api/admin/classes (roster bulanan, POST cancel-session/restore-session). File: booking-admin-services.ts, checkin-services.ts, class-roster-services.ts, booking-admin-controller.ts, 3 route detail, + booking-admin-validation.ts. ME-REUSE service existing (bukan bangun ulang): blocking()/blockingForDay/paxOverlapping (okupansi), timeRangesFor/capacityFor/cancelledSessionKeys (jadwal), resolveForUnit (harga prorata), openTransfer + lock order (transaksi DULU lalu grup). openTransfer diperlebar userId:string|null + expiresAt:Date|null (booking tamu tanpa akun, ditahan selamanya).

Gate: bookings index requireAny(READ|MANAGE|PAYMENTS_MANAGE), tulis requirePermission(MANAGE); checkin requireAny(MANAGE|READ); classes requirePermission(MANAGE).

Penyimpangan sengaja (didokumentasikan): (1) customerPhone fallback ke booking.customerPhone (Laravel hanya user.phone) — lebih benar untuk walk-in. (2) roster taken = COUNT(pending|confirmed|completed) 1:1 Laravel; beda tipis dari invarian blocking() customer untuk pending hold-lewat (≤5 menit sampai sweep). (3) CheckIn/Show: banner flash.error+flash.success server dipulihkan sebagai banner inline (rose/emerald) yang disuapi hasil mutasi — 1:1 dengan Laravel (bukan toast).

### Frontend (ubsc-admin)
Data layer: services/Bookings.ts + useBookings hooks (Bookings auto-refetch 45s). lib/calendar.ts diport (dep Roster). lib/apiError.ts (extractApiError/fieldErrorMap). 4 halaman: bookings/page (grid+list+SlideOver create/detail), checkin/page (search debounce 300ms) + checkin/show/page (konfirmasi), classes/page (roster grid, filter router.get Laravel → state lokal client-side). Route shell: /bookings, /checkin, /checkin/[token], /classes.

### Verifikasi
- next build exit 0 (26 route). Paritas className identik 4 halaman (selisih hanya token wrapper AdminLayout).
- API diuji end-to-end vs DB: index/checkin/roster reads benar; staff-create 201 (schedule+collision+pricing) → check-in set checkedInAt+By, double check-in 409 → cancel soft + transaksi FAILED; PATCH status 200. cancel/restore-session tsc-clean tapi tak teruji seed (fasilitas kelas belum punya unit — teratasi otomatis saat fasilitas kelas di-edit+simpan, ensureClassHasAGroup buat unit default).
- /bookings //checkin //classes //checkin/:token unauth → 307 /login.

## 8C — Membership + Paket (SELESAI)

### API (ubsc-api)
3 router baru, dipasang di private-api.ts dengan urutan WAJIB `/api/admin/memberships/plans` SEBELUM `/api/admin/memberships` (kalau terbalik, 'plans' tertelan sebagai :id): /api/admin/memberships/plans (GET semua paket termasuk nonaktif, POST, PATCH /:id, DELETE /:id), /api/admin/memberships (GET index full-list + opsi paket, POST create, POST /:id/renew, PATCH /:id status, DELETE /:id soft-cancel), /api/admin/customers/search?q= (akun roleId null, min 2 karakter). File: membership-admin-validation.ts, membership-admin-services.ts, membership-admin-controller.ts, 3 route detail. ME-REUSE lifecycle existing `membership-services.ts` (createMembership/renewMembership/writeStatusHistory, source 'admin' + actorId) dan `toFeatures()` dari cms-services (kini di-export).

Gate: plans requirePermission(MEMBERS_MANAGE); memberships index requireAny(MEMBERS_READ|MEMBERS_MANAGE|BOOKINGS_MANAGE|PAYMENTS_MANAGE), tulis requireAny(MEMBERS_MANAGE|BOOKINGS_MANAGE); customer search requireAny(MEMBERS_MANAGE|BOOKINGS_MANAGE).

Hapus paket meniru FK Laravel `nullOnDelete` (relationMode prisma tanpa cascade): satu $transaction → lock paket → 422 `{plan}` bila masih ada anggota aktif → null-kan membershipPlanId di memberships + membership_histories → hapus. Riwayat tetap menampilkan nama paket lewat metadata.plan_name.

Penyimpangan sengaja: (1) renewedFromLabel `#<8 hex uuid UPPER> - <paket>` (Laravel `#00042`); tampilan `#`+padStart di tabel/detail dipertahankan verbatim → menampilkan uuid penuh (konsisten 8B). (2) userId/membershipPlanId tak dikenal → 422 per-field (setara `exists:*`). (3) Update status/cancel mengunci baris transaksi sebelum UNPAID→FAILED (Laravel tanpa lock).

### Frontend (ubsc-admin)
Data layer: services/Memberships.ts + hooks/api/useMemberships.ts (mutasi paket juga invalidate query memberships). 2 halaman: memberships/page (DataTable + SlideOver create/detail/renew, CustomerPicker debounce 220ms via useCustomerSearch; umpan balik toast karena sumber tak punya banner) dan memberships/plans/page (kartu paket + SlideOver form; banner inline hijau/rose PERSIS sumber, disuapi hasil mutasi, termasuk 422 `plan` saat hapus diblok). CSS injeksi → memberships.css / plans.css. Route shell: /memberships, /memberships/plans (menggantikan ComingSoon).

Penyimpangan ATAS PERMINTAAN USER: error lifecycle `membership` (periode bentrok saat create; membership batal saat renew) tidak dirender halaman Laravel sehingga form diam. Kini dirender sebagai teks rose (gaya slot error yang sama) di bawah pilihan customer (create) dan di bawah pilihan paket (renew).

Perbaikan susulan 8A: WeeklySlotEditor (jadwal kelas di form fasilitas) memakai `.slot-time-input`/`.slot-quota-input` dari app.css Laravel yang belum terbawa → input tampil sebagai kotak border bawaan. Diport verbatim ke `components/admin/weekly-slot-editor.css`. Pemindaian seluruh `src` admin: tidak ada class bespoke app.css lain yang dipakai tanpa CSS.

### Verifikasi
- tsc api + admin 0, eslint file 8C bersih, `next build` exit 0 (/memberships 12 kB, /memberships/plans 11 kB). Paritas className identik 2 halaman (selisih hanya token wrapper AdminLayout).
- API diuji end-to-end vs DB: plans create 201/update 200/invalid 400; search q<2 → [], "bu" → Budi Tester; create walk-in dengan paket 201 (endDate +1 bulan, transaksi PAID UBSC-xxxxxx, history created); tanpa customer 400 field customerName; create akun 201; overlap 422 `membership`; userId palsu 422; hapus paket diblok 422 (1 anggota aktif); renew 201 (mulai H+1 setelah end, label renewedFrom); PATCH expired 200 (history status_changed); cancel 200; hapus paket 200 → membership planId null, histories tetap bernama paket. Data uji dibersihkan (6 history, 3 transaksi, 3 membership).
- /memberships dan /memberships/plans unauth → 307 /login.

## 8D — Verifikasi Pembayaran + Laporan Keuangan (SELESAI)

### API (ubsc-api)
- `GET /api/admin/payments?tab=awaiting|rejected|paid` (requireAny BOOKINGS_MANAGE|PAYMENTS_MANAGE) — antrean metode manual, maks 100; awaiting = UNPAID+awaiting urut proofUploadedAt asc, rejected, paid urut paidAt desc; counts tidak difilter method (1:1). Kunci urut kedua receiptSequence (padanan PK Laravel).
- `POST /api/admin/payments/settings` (PAYMENTS_MANAGE) — upsert 4 SystemSetting dalam satu $transaction; membalas `{bank, holdMinutes}`.
- `GET /api/admin/finance?month=&year=` (REPORTS_READ) — port penuh FinanceReportController. Bulan = rentang WIB [tgl 1 00:00, bulan+1) dikonversi ke UTC; DAY()/MONTH() → bucket WIB di JS (pola dashboard). Parsing month/year meniru `(int)` PHP + clamp. Pembulatan `phpRound` (half away from zero). `invoiceId`/`checkoutUrl` null (Xendit tidak ada). `recentTransactions` tidak dikirim (tak dipakai halaman).
- File: payment-admin-services.ts, finance-report-services.ts, finance-report-controller.ts, routes/details/admin-finance.ts; payment-verification-controller (+index, +updateSettings), payment-validation (+SETTINGS), admin-payments.ts (GET / + POST /settings di atas /:transactionId/*). approve/reject/bukti Fase 3 dipakai ulang.

### Frontend (ubsc-admin)
services/Payments.ts + hooks/api/usePayments.ts (keputusan invalidate payments/finance/bookings/memberships/dashboard). 2 halaman: payments/page (tab → state lokal; approve/reject/settings → toast berisi pesan flash Laravel termasuk varian email GAGAL; "Lihat Bukti" → `openPaymentProof` membuka blob via Bearer) dan finance/page (periode → state lokal, konten di-remount per periode = preserveState:false; CSV + print verbatim). Route shell /payments, /finance.

### Perbaikan lintas-fase yang ditemukan saat 8D
1. **CSS halaman di-scope** (10 file features/**.css): App Router tidak membuang stylesheet halaman sebelumnya, sehingga class sama-nama dengan nilai berbeda (Dashboard↔Finance 14 selector, Dashboard↔Form 8, dst.), aturan cetak `body *`, dan `* {margin:0;padding:0}` login.css bocor ke halaman lain (login → router.replace → seluruh admin kehilangan padding sampai refresh). Kini setiap selector `:where(body:has(.ubsc-page-<x>)) …` (specificity tidak berubah) + keyframes berprefix `ubsc-page-<x>--`; penanda class di `<main>` tiap halaman / `.u-page` login. Diverifikasi: tak ada halaman/komponen yang bergantung pada CSS halaman lain (WeeklySlotEditor `input-field` hanya di Form — sama seperti Laravel, di mana <style> Form hilang saat pindah halaman).
2. **delay-250/delay-400 dipulihkan** (Dashboard, Form fasilitas, Finance): harness menandainya "dead" (tak ada di v3) padahal CSS halaman mendefinisikannya (animation-delay). Token dikembalikan; di CSS halaman `.delay-{50,250,350,400,600}` diberi `transition-delay:0s` karena v4 menghasilkan transition-delay untuk token itu sedangkan v3 tidak. Generator spec kini memindahkan token seperti itu ke `keepDefinedInPageCss`.
3. **Link bukti Bookings (8B)** rusak (href `/api/admin/...` tanpa Bearer → 401): proofUrl diseragamkan `/admin/payments/:id/bukti` + `openPaymentProof`.
4. **Middleware admin** mencegat berkas public/ (logo, /fonts, /BES.png): tamu di /login dialihkan (logo & font login tidak termuat), staff bisa terlempar ke /unauthorized. Matcher kini mengecualikan path berekstensi.

### Verifikasi
- tsc api + admin 0; eslint 0 error; `next build` exit 0 (/payments 5.6 kB, /finance 18.6 kB). Paritas className identik Payments/Finance/Form/Dashboard (selisih hanya wrapper + penanda scope). CSS build dicek: selector ter-scope & print ter-scope utuh setelah minify.
- API vs DB: tab awaiting/rejected (0 baris di DB dev) / paid (13) / tab asal → awaiting; settings invalid 400 per-field → update → dipulihkan persis (backup system_settings); finance default/9-2026 konsisten (Σ harian = bulanan = booking+membership = 1.005.000), clamp month=0/year=1999 → 1/2020, month=abc → 1. Bukti transfer tak teruji (tak ada baris ber-bukti di DB dev); approve/reject teruji di Fase 3.
- /payments, /finance, /checkin/:token unauth → 307; /login render terverifikasi di browser (logo + font termuat, animasi keyframes ber-scope jalan).

## 8E — Antrean Verifikasi Identitas (SELESAI)

### API (ubsc-api)
Router baru `/api/admin/identity`, ketiganya requirePermission(IDENTITY_VERIFY) (= `verify-identity` Laravel):
- `GET /` → `AdminIdentityIndexDto`: user dengan identityStatus != unverified, urut updatedAt desc, tanpa paginasi. `hasDocument`/`documentUrl` meniru `filled()` (null, `''`, spasi-saja = tidak ada berkas); `documentUrl` relatif `/admin/identity/:id/document` (konvensi sama dengan proofUrl).
- `PATCH /:userId/verify` — body `{status, identityCategory?}`; kategori HANYA ditulis bila terisi (meniru `filled()` Laravel), jadi kirim status saja tidak mengubah kategori. Membalas baris terbaru (Laravel redirect+flash).
- `GET /:userId/document` — stream berkas privat, `inline` + `no-store`; 404 terpisah untuk "belum diunggah" vs "tidak ada di disk".
File: identity-admin-validation.ts, identity-admin-services.ts, identity-admin-controller.ts, routes/details/admin-identity.ts. Dipakai ulang: `timeAgoId()` dari dashboard-services (kini di-export; `updatedAt` = diffForHumans Bahasa Indonesia, APP_LOCALE=id), `resolvePrivate()`/`privateFileExists()` dari payment-proof-services (pagar path-traversal wajib), `sendProofFile()` dari payment-controller. Helper MIME lokal `identityMimeFor()` (jpg/jpeg/png/webp/pdf + fallback) karena `proofMimeFor()` hanya tahu png/webp dan jalur unggah identitas belum diport (Fase 6).

**Catatan untuk Fase 6:** `identityFilePath` di sini diasumsikan relatif terhadap `storage/private` (sesuai komentar schema), sedangkan Laravel menyimpannya relatif terhadap disk `identity-documents`. Kalau data lama diimpor, path wajib dinormalisasi saat migrasi.

### Frontend (ubsc-admin)
services/Identity.ts + hooks/api/useIdentity.ts (verify meng-invalidate identity + dashboard, karena keputusan mengubah kategori harga user). 1 halaman: identity/page (port penuh 1031 baris; header slot + `<main>`), CSS di identity.css (di-scope). Umpan balik toast dengan pesan flash Laravel (`Identitas <nama> berhasil diverifikasi./ditolak.`). Route shell /identity.

**`<img src>` tidak bisa membawa Bearer** (Laravel pakai cookie sesi): `useIdentityDocument(documentUrl)` mengambil blob → object URL (di-revoke saat ganti/unmount). Cabang error sumber dipertahankan: `imgError || failed ? 'Gagal memuat dokumen.' : 'Tidak ada dokumen diunggah.'`.

Temuan kecil: `animate-fade-in-up` di div header TIDAK terdefinisi di mana pun yang terjangkau halaman Identity Laravel (app.css, tailwind.config, maupun GLOBAL_STYLES-nya — halaman ini memakai `.identity-fade-in` sendiri), jadi no-op di kedua repo. Disalin verbatim. Justru SEBELUM scoping 8D, class ini akan ikut teranimasi karena bocor dari CSS dashboard/finance — scoping membuatnya lebih setia, bukan kurang.

### Verifikasi
- tsc api + admin 0, eslint bersih, prettier check lolos, `next build` exit 0 (/identity 9.86 kB). Paritas className identik (selisih hanya wrapper + penanda scope). CSS: 25 selector ter-scope + 10 keyframes ber-prefix; scopecheck hanya menandai `animate-fade-in-up` (dead di Laravel juga, lihat di atas).
- API vs DB (2 user uji di-seed lalu dihapus bersih): index 2 baris urut benar + `updatedAt` "13 detik yang lalu"; document 200 image/png; 404 tanpa berkas / user tak ada; validasi status & kategori 400 per-field; verify + koreksi kategori umum→warga_kampus; **status-saja TIDAK mengubah kategori** (aturan `filled()` terbukti); `identityCategory: null` juga tidak mengubah.
- /identity unauth → 307.

## 8F — CMS (SELESAI)

### API (ubsc-api)
9 router baru, semua digerbangi `cms.manage` (= `manage-cms`), KECUALI satu gate imperatif (lihat bawah):
- **News** `/api/admin/news` — GET index (news + categories + infoBanners, tiga panel satu halaman), GET `/create`, POST (multipart `thumbnail`), GET `/:id/edit`, PUT `/:id`, DELETE `/:id`.
- **Kategori** `/api/admin/news-categories` — POST/PUT/DELETE; delete melepas `newsCategoryId` artikelnya dulu (dalam `$transaction`, karena relationMode prisma tanpa FK SET NULL).
- **Info banner** `/api/admin/info-banners` — POST/PUT/DELETE/POST `/reorder`; keempatnya menjalankan normalizeSortOrder dan membalas SELURUH daftar (satu baris saja akan basi karena semua nomor berubah).
- **Gym traffic** `PUT /api/admin/settings/gym-traffic`.
- **Promo / Sponsors / Reels / Testimonials / Reviews** — index + CRUD + reorder (reels tanpa reorder); review hanya toggle-approve + delete.
File: news-admin-{validation,services,controller}.ts, cms-card-admin-{validation,services,controller}.ts, 9 route detail. Dipakai ulang: `timeAgoId` (dashboard-services), `listFor`/`firstUrlFor`/`deleteForModel`, `storePublicMedia`/`deleteMediaCollection`/`unlinkMediaFiles`, `jakartaWallTimeToUtc`/`formatInstant`, `TX_OPTIONS`, `isUniqueViolation`.

**Gate imperatif `news.publish`**: Laravel memanggil `authorize('publish-news')` DI TENGAH store/update — hanya saat status 'published' (store) atau saat naik ke published (update). Tidak bisa dipasang di baris route tanpa ikut memblokir simpan draft. Controller mengumpulkan permission efektif + `isBypassed()` (kini DI-EXPORT dari permission-middleware, satu sumber kebenaran) dan service menolak dengan `FORBIDDEN_MESSAGE` yang sama.

**Kemampuan baru — unggah video** (`storePublicVideo` di media-store-services): tidak lewat sharp; multer diskStorage (badan multipart campuran: video ke disk, field lain ke memori), **sniff magic bytes** (whitelist major brand MP4 — HEIC/AVIF/MOV ditolak; EBML + DocType `webm` — .mkv ditolak), ekstensi diturunkan dari hasil sniff BUKAN dari nama klien, berkas dipindah (rename, fallback salin streaming saat EXDEV), temp dibersihkan di tiga lapis. Batas efektif **50 MB** (Laravel `max:51200`); `UPLOAD_LIMITS.VIDEO_REEL` 100 MB kini diberi komentar bahwa itu pagar infra, bukan batas yang berlaku.

### Frontend (ubsc-admin)
Data layer: services/News.ts + services/Cms.ts, hooks/api/useNews.ts + useCms.ts (mutasi info banner & gym traffic ikut invalidate dashboard). Komponen baru: `RichEditor` (TipTap, port 1:1, `immediatelyRender: false` wajib untuk App Router). 6 halaman: news/page, news/form/page (SATU komponen untuk /news/create dan /news/[id]/edit, mode dibaca dari `useParams`), promo, reels, sponsors, testimonials. Semua CSS di-scope. Route shell: /news, /news/create, /news/[id]/edit, /promo, /reels, /sponsors, /testimonials.

**Dashboard (sisa Fase 7) kini hidup**: GymTrafficWidget dan panel info banner yang dulu "write inert (no-op)" disambungkan ke hooks — create/update/delete/reorder tersimpan dan menyegarkan cache. Reorder & gym traffic tanpa toast sukses (Laravel `back()` tanpa flash), sisanya memakai teks flash Laravel.

### Dua bug yang ditemukan & diperbaiki saat pengujian 8F
1. **Reel yatim.** Video palsu ditolak saat penyimpanan (sniff) — SETELAH baris reel + thumbnail terlanjur dibuat, menyisakan reel tanpa video. Di Laravel validasi `mimes:mp4,webm` selesai sebelum `Reel::create()`. Diperbaiki: `assertVideoAcceptable()` di-export dan dipanggil di store/update SEBELUM baris disentuh (fungsi yang sama dipakai storePublicVideo, tanpa duplikasi). Terbukti: 422 dan jumlah reel tidak berubah.
2. **Direktori media kosong menumpuk.** `unlinkMediaFiles` menghapus berkas tapi meninggalkan direktori `uploads/media/<uuid>/` selamanya. Ditambah `rmdirSync` non-rekursif (ENOTEMPTY/ENOENT diabaikan) — aman karena tiap media punya direktori uuid sendiri.

### Perbaikan harness
Generator spec hanya memeriksa `<style>` di dalam .tsx dan app.css, TIDAK memeriksa berkas `.css` bersebelahan yang di-import halaman (`Pages/Admin/{News,Promo,Facilities}/Index.css`). Akibatnya `delay-250` milik News/Index salah ditandai mati lalu terhapus. Generator kini membaca `import './Index.css'` juga; token dikembalikan dan dinetralkan `transition-delay: 0s` seperti kasus finance.

### Verifikasi
- tsc api + admin 0, eslint 0 error, `next build` exit 0 (27 route; /news 12.1 kB, /testimonials 10.2 kB, /sponsors 8.73 kB, /reels 7.95 kB, /promo 7.77 kB). Paritas className identik 6 halaman + Dashboard tidak berubah (selisih hanya wrapper + penanda scope).
- API vs DB nyata (7 berita, 2 kategori, 3 banner, 4 promo, 5 sponsor, 5 reel, 3 testimoni, 3 review): semua read benar; kategori create/update (slug ikut berubah)/invalid 400; news multipart create (thumbnail tersimpan, author = staf login), slug duplikat 422, publish mengisi publishedAt otomatis, **kembali ke draft MEMPERTAHANKAN publishedAt**; info banner normalize → 1..n rapat + reorder; gym traffic invalid 400 / valid tersimpan; promo/sponsor/testimoni create + **update TANPA berkas mempertahankan media lama** + reorder; reel video palsu 422 tanpa menyisakan baris; review toggle. Semua data uji dibersihkan, urutan banner & setelan gym traffic dipulihkan ke keadaan semula, dan direktori media kembali sinkron persis dengan DB (39 = 39, nol yatim).
- /news, /news/create, /promo, /reels, /sponsors, /testimonials unauth → 307.

## 8G — Settings: RBAC, Jadwal, Pengguna, Notifikasi, Profil staf (SELESAI)

### API (ubsc-api)
- **Roles** `/api/admin/settings/roles` — GET (tanpa permission, lihat GATE di bawah), PUT `/:name` (rbac.manage + Administrator saja). Kunci role adalah NAMA (RolePermission.roleName), bukan uuid. `permissions` = `Permission.code` (kunci mesin), BUKAN `name` (label Indonesia) — mengirim label akan membuat matriks RBAC tidak bisa mencocokkan satu kotak pun. `onlineUsersCount`: Laravel menghitung tabel `sessions` (last_activity ≤15 menit); padanan di sini RefreshToken staff belum dicabut dengan lastUsedAt ≤15 menit, distinct userId.
- **Schedules** `/api/admin/settings/schedules` — GET (7 bulan dari bulan berjalan WIB) + POST toggle / update-dates / quick-open-next, semua `bookings.limits.manage`. `cleanClosedDatesForMonth` dipakai ulang dari `schedule-services.ts`.
- **Users** `/api/admin/settings/users` — GET (tanpa permission), POST/PUT/DELETE (users.manage + Administrator saja). Urutan: nama asc lalu rank role `[Manager, Administrator, Finance, Staff Central, Staff Front Office]`.
- **Notifikasi** `/api/admin/notifications` + POST `/read` + `/clear-read` — port penuh `AdminNotificationCenter` (6 builder operasional + visibleItems/canSee/fingerprint).
- **Profil staf** `/api/admin/profile` GET/PATCH(multipart avatar)/DELETE, PUT `/password`, POST `/api/admin/email/verification-notification` — autentikasi saja, tanpa permission (akun milik pemanggil sendiri).

**GATE baca dikembalikan ke Laravel.** Agen sempat memasang `rbac.manage`/`users.manage` pada kedua GET. Itu dibatalkan: Laravel tidak punya gate baca di sana (Roles index justru punya cabang "non-Administrator hanya melihat ROLE-NYA SENDIRI", dan Users index hanya `hasAnyRole(STAFF_ROLES)`), dan Sidebar menampilkan kedua menu ke SEMUA role tanpa gate — memasang permission akan membuat Finance/Staff menekan menu yang terlihat lalu mendarat di 403, jalan buntu yang tidak ada di Laravel, sekaligus mematikan cabang "lihat role sendiri". Gate TULIS tetap ketat (permission di baris route + Administrator-only imperatif). **Terbukti di uji:** akun Finance membaca roles → 200 melihat 1 role (miliknya), membaca users → 200 dengan `canManageUsers:false`, menulis → 403.

**Perubahan skema (satu-satunya di Fase 8).** Notifikasi Laravel menyimpan status read/dismissed di SESSION; API ini stateless. Model `NotificationState` memang sudah disiapkan sejak Fase 1 untuk ini, tapi kurang pembeda read vs dismissed. Ditambahkan kolom `state` + unique `(userId, notificationId, state)` lewat migrasi `20260923090713_notification_state_pisahkan_read_dan_dismissed` (tabel masih kosong saat itu, jadi aman). **Konsekuensi yang disengaja: status baca kini BERTAHAN lintas logout**, sedangkan milik Laravel mati bersama session. Tidak bisa disamakan tanpa menghidupkan kembali server session.

**Tidak diport:** `flashItems()` (2 item notifikasi dari flash session) — tidak ada session/flash, dan hasil aksi sudah tampil sebagai toast. Konsekuensinya `source: 'System'` tidak pernah muncul.

**Hapus akun ditolak bila masih tertaut data.** `News.authorId` NOT NULL (Restrict) dan 10 kolom audit opsional akan di-SetNull diam-diam (verifiedBy, checkedInBy, createdBy, actor…). Laravel akan melempar QueryException 500; di sini referensi dihitung lebih dulu lalu dibalas 422 berisi rinciannya. Membuatnya benar-benar aman butuh perubahan skema (soft delete / akun sistem penampung) — dicatat sebagai pekerjaan terpisah, bukan diam-diam merusak jejak audit.

### Frontend (ubsc-admin)
services/Settings.ts + hooks/api/useSettings.ts. 3 halaman: settings/roles, settings/schedules, settings/users (semua CSS di-scope).

**Sisa Fase 7 kini hidup:** `ProfileModal` (6 tombol yang dulu inert) tersambung ke PATCH profil (+avatar), PUT password, DELETE akun, dan kirim ulang verifikasi email; field password dinamai camelCase mengikuti kontrak; `_method` dibuang (API menerima PATCH sungguhan); sumber avatar & status verifikasi email dari GET /admin/profile. `Topbar` lonceng notifikasi tersambung: envelope di-unwrap, field camelCase, dan payload diambil sekali saat chrome mount (Laravel menerimanya lewat props Inertia tiap page load).

**Grup permission "Sistem" ditambahkan ke halaman Roles** (letter G, 2 item). Ini TIDAK ada di Laravel karena `rbac.manage`/`users.manage` memang permission baru. Wajib ada: tanpa grup itu keduanya tak terlihat DAN tak bisa di-toggle, sementara tombol "Aktifkan semua" mengirim seluruh himpunan dari grid — sekali klik akan diam-diam MENCABUT keduanya dari role yang memilikinya (Manager punya keduanya; terbukti di uji). Konsekuensi lain yang memang tak terhindarkan: kode kecil di bawah label izin kini dot-code (`stats.read`) karena sistem baru memang memakai kode itu, bukan kebab Laravel (`view-stats`).

### Verifikasi
- tsc api + admin 0, eslint 0 error, `next build` exit 0 (30 route; /settings/roles 8 kB, /settings/schedules 8.35 kB, /settings/users 7.15 kB). Paritas className identik 3 halaman; Dashboard/Topbar/ProfileModal tidak bergeser.
- API vs DB nyata: roles (Manager 16 izin, 4 role tampil, Administrator dikecualikan) + tolak ubah Administrator 403 + kode tak dikenal 422 + update & pulihkan persis; schedules 7 bulan label Indonesia + toggle + dedupe tanggal + tolak tanggal bulan lain + pulihkan; users urutan role benar + create (akun baru BISA login → password ter-hash & email ter-normalisasi) + email dobel 422 + role Administrator ditolak + **update tanpa password mempertahankan password lama** + tolak hapus diri sendiri; gate baca/tulis staf non-Administrator seperti di atas; notifikasi (2 item, `source`+`actionLabel`+`generatedAt` terisi) + readAll + clearRead; profil + password salah 422 + hapus akun ditolak 422 berisi rincian referensi.
- Seluruh data uji dibersihkan; `notification_states` dikosongkan lagi (lonceng kembali menampilkan 2 notifikasi asli); `role_permissions` dicek cocok persis dengan seeder (Administrator 16, Manager 16, Finance 5, Staff Central 5, Staff Front Office 2).
- /settings/roles, /settings/schedules, /settings/users unauth → 307.

## Status
**FASE 8 SELESAI SELURUHNYA (8A–8G)** — seluruh fitur admin jalan. Git belum disentuh.
Berikutnya (menunggu user): **Fase 5** (sisa halaman publik) dan **Fase 6** (area customer + `/api/customer/*` yang membuat modal inert Fase 4 hidup).

Pekerjaan terpisah yang tercatat dari 8G: skema belum punya jalan aman untuk MENGHAPUS akun staf yang sudah meninggalkan jejak (butuh soft delete atau akun sistem penampung); sekarang ditolak 422.
