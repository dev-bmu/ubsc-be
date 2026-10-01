# Fase 5 — Sisa halaman publik landing (SELESAI)

Cakupan sesuai Rewrite.md: `/about`, `/pricing`, `/facilities`, `/news`, `/branches/[slug]`, 3 halaman legal,
`/coming-soon`, `not-found`. 35 berkas (komponen + halaman), semuanya lolos paritas className.

## API — hampir tidak berubah

Dua temuan memangkas pekerjaan backend hampir habis:

1. **Prop `categories` adalah data mati.** `FacilityPage.tsx` dan `NewsPage.tsx` Laravel sama-sama MENERIMA
   `categories` dari controller tapi tidak pernah membacanya (keduanya hanya mendestrukturisasi `facilities` /
   `news`). Karena itu TIDAK ada endpoint kategori publik yang dibuat — menambahkannya berarti membangun
   jalur data yang tak seorang pun render.
2. **Satu-satunya perubahan: `GET /api/public/news` kini TANPA limit.** Endpoint itu sebelumnya mengoper
   `HOME_NEWS_LIMIT` (7) dan komentarnya sendiri menginstruksikan Fase 5 menumbuhkannya. Halaman `/news`
   Laravel memakai `News::published()->latest('published_at')->get()` — tanpa batas, tanpa paginasi.
   `listNews(limit?)` kini opsional; beranda tetap mengoper 7 lewat `/api/public/home`.
   **Terbukti:** dengan 8 berita terbit, `/api/public/news` mengembalikan 8 dan `/api/public/home` tetap 7.

Endpoint lain yang dipakai (`/membership-plans`, `/facilities`) sudah ada sejak Fase 4, dan `MembershipPlanDto`
sudah membawa `activeMembersCount` yang dibutuhkan halaman `/pricing`.

## Frontend (ubsc-landing)

**Data (Server Component).** `services/server.ts` bertambah `getMembershipPlans()`, `getFacilities()`, `getNews()`
di atas helper `getPublic<T>()` bersama. Semua melempar saat API gagal; tiap halaman membungkusnya try/catch dan
jatuh ke fallback statis komponen. `/pricing` memakai `Promise.allSettled` supaya kegagalan satu koleksi tidak
menjatuhkan yang lain. **Terbukti: `next build` SUKSES dengan API mati**, dan seluruh halaman tetap ter-prerender.

**Cache per halaman** sesuai Rewrite.md: `/about` + legal + `/coming-soon` statis, `/pricing` + `/facilities`
ISR 600s, `/news` ISR 120s, `/branches/[slug]` SSG penuh lewat `generateStaticParams` + `dynamicParams = false`.

**Data cabang dipindah ke `src/config/branches.ts`** (BRANCHES, BRANCH_SLUGS, otherBranches). Di Laravel ini
array hardcoded di dalam closure route dengan komentar "replace with Branch model when available" — tidak ada
tabel Branch, jadi API tidak perlu tumbuh. Slug tak dikenal → 404 sungguhan (terbukti).

**Berkas baru:** components/about (12), components/pricing (7), components/facility (3), components/news (3),
components/legal (1), components/branches (1), components/landing/CurvedLoop (1, ternyata belum pernah diport
padahal AboutHistory & FacilityMembership memakainya), 11 halaman + 11 route shell.

## Penyimpangan yang disengaja

1. **`NotFound` MENYIMPAN blok `<style>`-nya.** Landing tidak punya injeksi CSS di mana pun — kecuali halaman ini,
   yang mendefinisikan ±230 baris `.nf-*` di dalam berkasnya sendiri, bukan di `resources/css/app.css`. Karena
   `src/styles/ubsc-bespoke.css` DIHASILKAN `tools/fidelity-harness/assemble.mjs` dan berlabel jangan-disunting,
   blok itu dipertahankan verbatim di komponen. Tidak ada risiko bocor lintas halaman: prefiks `.nf-*` unik dan
   elemen `<style>` ikut hilang saat komponen unmount, sama seperti di Laravel.
2. **`/coming-soon` dan `not-found` adalah client component di level halaman**, menyimpang dari aturan
   "halaman = Server Component". Keduanya satu unit animasi utuh (`useReducedMotion` di akar NotFound, 15
   partikel motion di ComingSoon); memecahnya hanya menyisakan wrapper kosong di server.
3. **next/image TIDAK dipakai untuk thumbnail berita.** `next.config.ts` mengunci `images.localPatterns` ke
   `/uploads/**`, sedangkan `NewsDto.image` bisa berisi `/uploads/...`, `/assets/images/comingsoon.avif`
   (fallback), atau aset bundel — dua terakhir akan 400 lewat optimizer. `NewsCard.tsx` dari Fase 4 sudah
   memakai `<img>` polos untuk field yang sama; preseden itu diikuti.
4. **`PricingFacilityList` mendapat satu guard `{activeFacility && …}`** pada kartu desktop, meniru guard yang
   sudah ada di kartu mobile. Tanpa itu SSR melempar saat API mati. DOM saat data ada identik — yang berubah
   hanya kasus yang di Laravel (CSR, tanpa SSR) berakhir crash.
5. **Sitemap TIDAK dibuat.** Rewrite.md mencantumkannya, tetapi `src/app/robots.ts` yang sudah ada memblokir
   SELURUH crawler ("Sistem internal PT BMU — larang SEMUA crawler"). Menambah sitemap akan bertentangan dengan
   keputusan itu. Perlu keputusan produk lebih dulu: kalau situs memang akan diindeks, robots DAN sitemap
   diubah bersamaan.
6. **Bug/quirk Laravel dipertahankan apa adanya:** typo `tracking-[-0.017em]text-black` di AboutVisionMission
   (satu token tak dikenal, jadi tracking DAN text-black sama-sama mati); nomor section ganda `07` di halaman
   about; `id="news-content"` kembar di NewsPage; `{...standard}` menyebar `undefined` bila kategori "Berita"
   hanya berisi 1 item; `exit={{opacity:0}}` tanpa `<AnimatePresence>` di PricingAccordionItem.
7. **`suppressHydrationWarning`** dipasang pada 15 partikel ComingSoon: `Math.random()` dipertahankan verbatim,
   tetapi komponen klien tetap di-SSR di Next sehingga nilai server ≠ klien. React menahan nilai server saat
   hidrasi, jadi tidak ada lompatan visual — posisinya memang acak.

## Verifikasi

- **Paritas className: 35/35 IDENTIK** lewat `verifyClass.js` (About 13 berkas, Pricing 8, Facility+News 8,
  Legal/ComingSoon/Branches/NotFound 6). Berbeda dari admin, landing tidak punya token pembungkus, jadi
  selisihnya benar-benar nol. Branches diverifikasi sebagai gabungan dua berkas (halaman + BranchHero).
- Seluruh class bespoke yang dipakai komponen Fase 5 dipindai lebih dulu dan sudah tersedia di
  `src/styles/ubsc-bespoke.css` — nol class hilang, nol berkas `.css` baru.
- tsc 0, eslint 0 error, `next build` exit 0 (semua rute Fase 5 ter-prerender, `/branches` menghasilkan
  2 halaman statis).
- Uji rute dengan API hidup: `/`, `/about`, `/pricing`, `/facilities`, `/news`, kedua `/branches/*`,
  `/coming-soon`, 3 legal → 200; `/branches/tidak-ada` → 404.
- Render diperiksa di browser: judul dokumen benar di semua halaman (404 memakai `404 | UB Sport Center`
  persis `<Head>` Laravel), peta cabang ter-embed, nol gambar rusak (satu temuan awal ternyata lazy-load
  di bawah layar, berkasnya 200).
- Data uji (1 berita kedelapan untuk membuktikan endpoint tanpa limit) sudah dihapus; DB kembali 7 berita.

## Status

Fase 5 selesai. Tersisa **Fase 6** (area customer: `/riwayat-booking`, `/booking/[id]/pembayaran`, grid booking
+ `Class/*`, identity, review, profil) yang akan menghidupkan modal inert dari Fase 4, lalu Fase 9 (hardening)
dan 10 (deploy). Git belum disentuh.
