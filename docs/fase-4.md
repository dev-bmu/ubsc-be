# Fase 4 — Landing slice

Status: **Fase 4a (data) SELESAI dan terverifikasi lawan database Laravel. Fase 4b (UI beranda) belum mulai.**

Ruang lingkup menurut `Rewrite.md`: `/` utuh — EntranceLoader → Hero → Navbar + AuthModal → SectionTwo..Eight
→ Footer, data nyata dari API, Lenis. Gate: bukti fidelity + baterai verifikasi.

Fase dipecah dua karena seluruh data beranda semula ditandai "Fase 5" di kode (`src/routes/public-api.ts`,
`shared/contracts.ts`) sementara gate Fase 4 mensyaratkan data nyata — dua sumber kebenaran yang bertabrakan.
Penomoran itu sudah diselaraskan: endpoint beranda kini Fase 4.

---

## 4a — Endpoint publik

### Yang dikirim

| Berkas                                                                   | Isi                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/contracts.ts`                                                    | 14 DTO beranda + `HomeDto` agregat + `PendingPaymentDto`. `FacilityDto` **tidak punya key `units`** sama sekali (bukan opsional) supaya service yang mencoba mengisinya ditolak compiler |
| `shared/format.ts`                                                       | `formatDateDotID` (`d.m.Y`), `formatDateSlashSpaceID` (`d/m Y`), `formatRupiahTight` (`Rp1.000`, tanpa spasi)                                                                            |
| `src/services/media-services.ts`                                         | batch loader media; satu query untuk seluruh koleksi, bukan per baris                                                                                                                    |
| `src/services/cms-services.ts`                                           | 9 koleksi konten                                                                                                                                                                         |
| `src/services/public-facility-services.ts`                               | fasilitas + harga + `priceRange`                                                                                                                                                         |
| `src/services/home-services.ts`                                          | komposer tipis, `Promise.all`                                                                                                                                                            |
| `src/controller/home-controller.ts`, `src/routes/details/public-home.ts` | 11 endpoint                                                                                                                                                                              |
| `src/application/web.ts`, `src/config/env.ts`                            | mount `/media` untuk direktori media bersama                                                                                                                                             |

11 endpoint, semuanya `GET /api/public/*`, `publicLimiter` 60/menit (paritas `throttle:60,1` di
`routes/web.php:48`), `Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=600`:
`home` (agregat, satu request untuk beranda) + `membership-plans`, `promos`, `sponsors`, `news`, `reels`,
`facilities`, `testimonials`, `reviews`, `announcements`, `gym-traffic`.

Service granular adalah sumbernya, `/home` hanya komposer — Fase 5 memakai service yang sama tanpa refactor.

### Bukti paritas

Dijalankan lawan `ubsc` (Laravel) dan `ubsc_dev` (baru) di mesin yang sama.

| Yang diukur                                      | Laravel                       | API baru     |
| ------------------------------------------------ | ----------------------------- | ------------ |
| Jumlah fasilitas aktif                           | 9                             | 9            |
| Nama + urutan fasilitas                          | `Lapangan Tenis … BMU Karate` | identik      |
| Urutan kategori 3 berita teratas                 | Berita → Artikel → Berita     | identik      |
| Urutan thumbnail reel                            | 1 → 5                         | identik      |
| `news.date`                                      | `26.02.2026`                  | `26.02.2026` |
| `reels.date`                                     | `11/09 2026`                  | `11/09 2026` |
| `priceRange`                                     | `Rp105.000 - Rp115.000 / Jam` | identik      |
| `category` fasilitas                             | `Lapangan & Arena`            | identik      |
| `units` di payload beranda                       | tidak ada                     | tidak ada    |
| `testimonials.authorLogo` kosong                 | `null`                        | `null`       |
| media kosong (promo/sponsor/news/reel/fasilitas) | `""`                          | `""`         |

---

## Temuan — hal yang TIDAK diantisipasi rencana

### 1. Tie-breaker urutan: `createdAt` MENAIK, bukan menurun, dan bukan `id`

Laravel hanya menulis `latest('published_at')` / `orderBy('sort_order')`. Yang tidak tertulis: pada nilai seri
MySQL mengembalikan baris dalam urutan **PK auto-increment menaik** — urutan penyisipan. Jadi aturan yang
sebenarnya berlaku adalah "satu kunci urut, seri dipecah urutan penyisipan menaik".

Tiga kesalahan yang sempat ada di kode, semuanya terukur:

| Ditulis                                       | Hasil untuk dua berita seri `2026-02-26` |
| --------------------------------------------- | ---------------------------------------- |
| `[publishedAt desc, createdAt desc, id desc]` | Artikel, Berita — **terbalik**           |
| `[publishedAt desc]` saja                     | tak tentu; filesort MySQL tidak stabil   |
| `[publishedAt desc, createdAt asc]`           | Berita, Artikel — **cocok Laravel**      |

Taruhannya bukan urutan judul: `NewsCard.tsx:5` memilih `layoutOverride` dari `category`, jadi yang tertukar
adalah **layout** dua kartu teratas SectionFive.

`id` uuid v4 tidak pernah sah sebagai tie-breaker — ia acak, bukan monoton, jadi ia mengarang urutan yang
tidak pernah ada di Laravel.

### 2. Presisi timestamp: DATETIME detik vs DATETIME(3) milidetik

`timestamps()` Laravel menulis presisi **detik**, jadi seluruh batch seeder jatuh pada detik yang sama, seri,
lalu terurut penyisipan. Prisma memetakan `DateTime` ke `DATETIME(3)`: tiap baris beda milidetik, tidak ada
seri, dan `ORDER BY createdAt DESC` **membalik** hasilnya.

Terukur di `ubsc`: kelima reel bernilai `2026-09-09 13:01:29` persis → Laravel merender 1,2,3,4,5. Di
`ubsc_dev` sebelum perbaikan: 5,4,3,2,1.

Tidak bisa diperbaiki di query — kunci primernya sendiri sudah `createdAt`. Diperbaiki di
`prisma/seeders/`: timestamp diberikan **menurun** sesuai urutan array, sehingga `DESC` memulihkan urutan
render Laravel secara deterministik. Menyamakan timestamp kelimanya TIDAK cukup: pada seri penuh urutan
jatuh ke PK, dan PK di sini uuid acak. Kena: `seedReels` (`cms.ts`), `seedReviews` (`demo.ts`).

### 3. `Zona Akurasi` aktif di seed, non-aktif di Laravel

`prisma/seeders/facilities.ts:49` menulis `isActive: true`; `ubsc`.facilities menulis `is_active=0`.
Akibatnya satu kartu fasilitas ekstra muncul di SectionFour dan SectionSix yang tidak pernah dirender
Laravel. Diperbaiki mengikuti database, bukan mengikuti ada-tidaknya berkas gambar.

### 4. `media.md` keliru soal thumbnail reel

`media.md` menandai `thumbnail 1..5.png` sebagai "Dihapus, Referensi: 0" dan `.avif` sebagai "yang dipakai".
Database Laravel berkata sebaliknya: `media.file_name` untuk koleksi `thumbnail` Reel adalah
`thumbnail-1.png` … `thumbnail-5.png`. Kolom "Referensi" di sana berasal dari grep atas `resources/`, yang
memang tidak bisa melihat aset yang disajikan lewat tabel `media`.

Kesimpulannya tetap benar (PNG itu tidak perlu ikut `public/` repo Next — ia disalin ke `uploads/` oleh
seeder dari `LEGACY_ASSETS_DIR`), tapi alasannya salah. **Jangan menghapus berkas sumbernya dari repo
Laravel.**

### 5. `gym_traffic` dan `membership_plans` memang kosong di Laravel

Sintesis rencana sempat menyarankan "tambahkan seed `gym_traffic`". Terukur: baris itu **tidak ada** di
`ubsc` maupun `ubsc_dev`, keduanya jatuh ke default `'Low Occupancy'`. `membership_plans` juga 0 baris di
kedua sisi, sehingga `SectionTwo` merender `FALLBACK_MEMBERSHIP_PLANS` di kedua stack. **Menambahkan seed
untuk keduanya akan MERUSAK paritas.**

### 6. `GymTrafficDto` harus `string`, bukan union

Mengetiknya sebagai union empat nilai memaksa service menjatuhkan nilai DB di luar union ke default —
mengubah **teks** badge. `SystemSetting::get` Laravel meneruskan isi kolom apa adanya. Union tetap hidup
sebagai `KnownGymTrafficDto` untuk dokumentasi dan jalur tulis admin, dan dilarang dipakai menyempitkan
nilai yang dikirim.

### 7. Media: `urlFor()` tidak boleh menyaring disk

`getFirstMediaUrl()` spatie tidak memfilter disk. Versi awal mengembalikan `''` untuk disk non-public, yang
membuat `ImageCarousel.tsx:19` **membuang** slide-nya — beda tampilan. Kekhawatiran aslinya (dokumen privat
bocor) tetap sah dan tertangani lewat mount publik yang hanya melayani `uploads/`: URL ke disk lain 404
persis seperti di Laravel. Endpoint publik juga selalu menyaring `modelType` + `collectionName`, jadi baris
media privat tidak pernah masuk payload.

### 8. LIMIT beranda sempat bocor ke endpoint granular

`listNews` menanam `take: 7` di dalam service, lalu service yang sama melayani `GET /api/public/news` dengan
komentar yang mengklaim ia melayani halaman `/news`. Di Laravel `/news` tidak dibatasi 7. Limit kini
parameter wajib tanpa default; `HOME_NEWS_LIMIT` / `HOME_REELS_LIMIT` / `HOME_REVIEWS_LIMIT` dioper
eksplisit oleh pemanggil beranda.

---

## Aset (keputusan C3)

| Tujuan                                   | Isi                 | Ukuran  |
| ---------------------------------------- | ------------------- | ------- |
| `UBSC/ubsc-media/reels/` (di luar git)   | 8 video             | 134 MB  |
| `ubsc-landing/public/` (ikut git)        | 57 gambar/ikon/logo | 21 MB   |
| `ubsc-landing/src/assets/` (impor modul) | 34 berkas           | 5,3 MB  |
| Dibuang                                  | 18 berkas           | 21,7 MB |

Rename mengikuti tabel `media.md`, bukan tebakan: `reels ubsc 1.mp4` → `reels-ubsc-1.mp4`,
`thumbnail 1.avif` → `thumbnail-1.avif`, `person map.avif` → `person-map.avif`, `UBSC PRO.png` →
`ubsc-pro.png`. Tidak ada lagi nama berspasi. Manifest `ops/media-manifest.txt` dibuat, `verify` cocok.

Empat PNG tambahan (6,36 MB) yang `media.md` minta "verifikasi sekali lagi" sudah diverifikasi nol referensi
**dan** nol `<picture>`/`srcset` di seluruh `resources/js` — dihapus.

`public/` landing kini 21 MB, sudah di bawah gate Fase 9 (25 MB). `BES.png` 5,1 MB sengaja disalin apa
adanya: `media.md` minta re-export ke ≤30 KB, tapi re-encode mengubah piksel dan itu urusan Fase 9, bukan
fase yang gate-nya justru membuktikan tidak ada perubahan visual.

### Jalur dev untuk video

Video tidak lagi di `public/`, jadi `/assets/reels/*.mp4` akan 404 tanpa jembatan. Pola yang dipakai sama
dengan `/uploads`: `express.static('/media')` di `src/application/web.ts` + rewrite
`/assets/reels/:path*` → `${API_BASE_URL}/media/reels/:path*` di `ubsc-landing/next.config.ts`.

Komponen tetap menulis `src="/assets/reels/..."` persis seperti Laravel. Array `rewrites()` polos berjalan
**setelah** filesystem, jadi thumbnail `.avif` tetap dilayani dari `public/` dan hanya `.mp4` yang jatuh ke
rewrite — **jangan pindahkan ke `beforeFiles`**. Terverifikasi: HTTP 206 dengan `Accept-Ranges: bytes`
(syarat seek video) dan `Cache-Control: public, max-age=31536000, immutable`.

---

## Yang MASIH terbuka sebelum 4b

1. **Kerja Fase 2 dan 4a belum di-commit** di ketiga repo, atas permintaan user. Termasuk
   `tools/fidelity-harness/reference/class-migration.json` (225 KB) — satu-satunya sumber string className
   v4 untuk Fase 4–8. Hilang = seluruh gate Fase 2 harus dijalankan ulang.
2. **Route `/styleguide` masih terpasang** di `ubsc-landing/src/app/`. `globals.css:19` hanya mengecualikan
   `@source not '../../tools'`, bukan `src/app/styleguide`, sehingga ribuan class uji di `_cells/classes.txt`
   ikut terpindai ke CSS aplikasi. **Pengukuran fidelity 4b tidak valid selama route ini ada.**
   Cabut dengan `node tools/fidelity-harness/styleguide-route.mjs remove ../..`.
3. Rantai fallback `testimonials.image` (media → aset statis per `author_name` → null) sengaja dipindahkan
   ke ubsc-landing dan **belum ada di sana**. Wajib dipasang di Batch F:
   `image ?? MAPPING[authorName.toLowerCase()] ?? null`.
4. Utang tipe Fase 1 yang belum dibayar di landing: `ApiEnvelope<T>` lokal ganda
   (`context/AuthContext.tsx:12-15`, `lib/axios.ts:16-19`), `types/api/auth.ts` `AuthUser` duplikat,
   `types/api/api.ts` paginasi snake_case yang bertentangan dengan `ApiMeta`, dan `services/Auth.ts:6-16`
   `toApiError` yang membaca `error` sebagai string sehingga membuang `fields`.

## 4b — urutan port komponen

Prinsip: dependensi teknis dulu, risiko tertinggi seawal mungkin, tiap batch bisa dirender dan diukur
sendiri. Untuk setiap className ambil string v4 dari `reference/class-migration.json`
(`.pairs` → cari `files`), jangan jalankan codemod pada kode port, jangan hidupkan 61 `.deadTokens`.

| Batch | Isi                                                                                                                     | Risiko utama                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A     | `ScrollTextReveal`, `FadeIn`, `ScrollStack`, `SectionDivider`, `FacilityBadge`, `InputError`, hooks                     | dipakai ~60× di 8 section; salah di sini membatalkan semua batch berikutnya                                                |
| B     | Hero chain: `EntranceLoader`, `Hero`, `HeroTitle`, `HeroContent`, `HeroBottomBar`, `GymTrafficBadge`, `ReservasiButton` | `Hero.avif` tetap `<img>` polos, bukan `next/image`; `group-hover:border-white!` (temuan 9 fase-2)                         |
| C     | `Navbar`, `InfoBanner`, `AuthModal`, 4 modal                                                                            | `Navbar.tsx:265-545` menyuntik CSS lewat `document.createElement('style')` → FOUC di SSR; pindahkan ke CSS berkas komponen |
| D     | `SectionTwo`, `ImageCarousel`, `LogoMarquee`                                                                            | rantai curtain; jangan tambah/hapus satu pun wrapper; ukur dengan DOM-structure diff, bukan pixel                          |
| E     | `SectionThree`, `SectionFour`, `Facility*`                                                                              | judul hardcoded meski prop dioper — port apa adanya, jangan "diperbaiki"                                                   |
| F     | `SectionFive`–`Seven`, `ReelsSection`, `NewsSection`, `PriceCard`                                                       | fallback testimonial; `reviews` adalah prop mati — jangan ditampilkan                                                      |
| G     | `SectionEight`, `LocationMapLazy` (`next/dynamic ssr:false`), `Footer`, `FlashToast`                                    | `.maplibregl-popup-*` tetap di-comment                                                                                     |

### Urutan JSX wajib (`HomePage.tsx:132-170`)

Catatan TODO di `src/app/page.tsx:24` ("EntranceLoader → Hero → Navbar") **menyesatkan**. Yang benar:

```
<main class="landing-page-canvas relative">
  <Navbar activeSection="Home"/>            ← Navbar DULU
  <div class="home-hero-section-reveal">
    <Hero/>                                  ← EntranceLoader dirender DI DALAM Hero (Hero.tsx:75-78), portal ke body
    <div class="home-section-two-curtain"><SectionTwo/></div>
  </div>
  <div class="home-post-section-two-flow">
    <FadeIn lightweight><SectionThree/></FadeIn>
    <SectionFour/>                           ← TIDAK dibungkus FadeIn
    <div class="home-post-section-four-flow">
      <FadeIn><SectionFive/></FadeIn> … <FadeIn><SectionEight/></FadeIn>
    </div>
  </div>
</main>
<Footer/>   ← DI LUAR <main>
<FlashToast/>
```

---

## 4b — Batch A + B (fondasi + Hero chain)

Status: **selesai, ter-build, render terverifikasi.**

### Fondasi

- `src/app/providers.tsx` — `AuthProvider` + `ReactLenis root { lerp:0.14, smoothWheel:true, syncTouch:false }` + `ScrollReset` (usePathname, bukan useSearchParams). Tidak impor `lenis/dist/lenis.css` (sudah di ubsc-bespoke.css). Tidak ada skeleton full-page.
- `src/services/server.ts` — `getHome()` RSC fetch (`import 'server-only'`, `next:{revalidate,tags}`).
- `src/features/home/page/Index.tsx` — komposisi Server Component; `app/page.tsx` jadi shell (metadata + `revalidate=300`, `export default HomePage`).

### Komponen (13 berkas)

Batch A: ScrollTextReveal, FadeIn, ScrollStack, SectionDivider, FacilityBadge, InputError, useNearViewport, useEmblaNav.
Batch B: EntranceLoader, Hero, HeroTitle, HeroContent, HeroBottomBar, GymTrafficBadge, ReservasiButton.

Verifikasi paritas className (script sendiri, bandingkan himpunan token className lawan Laravel setelah rename v3→v4): **13/13 identik**. `framer-motion`→`motion/react`, `usePage`→prop, string v4 dari `class-migration.json`. `next build` exit 0, static ISR revalidate 5m, 0 warning. Render live: hero bg, badge gymTraffic dari API, copy, judul, overlay — semua tampil.

### Temuan 4b

1. **Guard `img.complete` wajib untuk SSR — tidak ada di Laravel.** Hero terkunci di `.ubsc-hero-prep` (bg opacity 0) karena `onLoad` Hero.avif lewat: gambar di HTML awal + `preload fetchPriority=high` sudah `complete` sebelum React hydrate memasang handler. Laravel (Inertia CSR) tak kena karena img dibuat React. Perbaikan: `useEffect(() => { if (bgRef.current?.complete) setIsImageLoaded(true) }, [])`. **Pola ini berlaku untuk setiap komponen yang state-nya digerakkan onLoad gambar SSR** — akan berulang di batch berikutnya (ImageCarousel, dll).

2. **Dev harus di `localhost:3000`, bukan `127.0.0.1:3000`.** CORS API memakai `LANDING_URL=http://localhost:3000`; menjalankan Next di `127.0.0.1` membuat browser mengirim `Origin: http://127.0.0.1:3000` yang ditolak → `POST /api/auth/customer/refresh` jadi 500 (bukan 401). Bukan bug kode — curl langsung tanpa Origin tetap 401 benar. Pertimbangan Fase 9: izinkan kedua host di CORS dev agar tidak rapuh.

3. **CTA `<a href={routes.comingSoon()}>` tetap anchor, bukan next/link.** Laravel pakai anchor (full-reload); next/link akan mengubah perilaku DAN diblokir typedRoutes (route /coming-soon belum ada). CallExpression lolos aturan no-restricted-syntax.

4. **`perspective-[1000px]` dihapus dari GymTrafficBadge** (token mati R1) — port setia = efek 3D tidak ada, sesuai Laravel sekarang.

Batch berikutnya: C (Navbar + AuthModal + 4 modal) — memperkenalkan TanStack Query pending_payment (`enabled: !!user`) dan blok CSS `document.createElement('style')` Navbar yang harus dipindah ke CSS berkas komponen agar tidak FOUC di SSR.

---

## 4b — Batch C (Navbar + AuthModal + modal)

Status: **selesai, ter-build, render terverifikasi (guest + AuthModal login/register).**

Scope: **guest-complete** (keputusan user). Yang dilihat pengunjung (Navbar + AuthModal + InfoBanner) berfungsi penuh; modal login-only (Profile/PaymentHistory/pill) di-port faithful tapi INERT sampai endpoint customer Fase 6 dibangun.

### Berkas (7 + 1 CSS + 1 helper)

| Berkas                                   | Cara            | Catatan                                                    |
| ---------------------------------------- | --------------- | ---------------------------------------------------------- |
| `landing/InfoBanner.tsx`                 | subagen         | announcements jadi prop, motion/react                      |
| `landing/AuthModal.tsx`                  | ditulis sendiri | react-hook-form + TanStack useMutation, endpoint auth live |
| `landing/Navbar.tsx`                     | subagen         | integrator 1346→ port; useAuth, pending_payment→useQuery   |
| `landing/navbar.css`                     | diekstrak       | 258 baris CSS kinetik, dulu disuntik runtime               |
| `user-dashboard/ProfileModal.tsx`        | subagen         | 3 form→RHF+axios, INERT Fase 6                             |
| `user-dashboard/PaymentHistoryModal.tsx` | subagen         | fetch→/customer/transactions, INERT                        |
| `user-dashboard/GymMembershipModal.tsx`  | subagen         | dummy murni                                                |
| `lib/applyApiErrors.ts`                  | ditulis sendiri | extractApiError: envelope {code,message,fields}            |
| `config/api.ts`                          | +endpoint       | register/verify/resend/forgot/reset + GOOGLE_AUTH_URL      |

Metode: 4 modal + InfoBanner di-port subagen paralel dengan spec presisi (rules-batchC.md + spec-*.json class pairs); AuthModal + Navbar ditulis sendiri (inti auth + integrator). Diverifikasi sendiri.

### Bukti

- **Paritas className: 6/6 identik** dengan Laravel (Navbar 244=244, AuthModal 194=194, ProfileModal 131, PaymentHistory 87, GymMembership 77, InfoBanner 22) setelah rename v3→v4.
- `next build` exit 0, `/` route 214 kB First Load (naik dari 108 kB — Navbar+modal+auth+RHF+TanStack masuk bundle), static ISR revalidate 5m.
- tsc 0, eslint 0.
- Render: Navbar SSR (6 kinetic-nav-link, logo, hamburger di <1100px), InfoBanner menampilkan announcement NYATA dari API ("Jadwal Zumba..."), AuthModal via ?auth=login membuka panel dua kolom (visual + form), switch ke tab register bekerja (form remount + stagger).

### Temuan 4b Batch C

1. **Bug build yang diperbaiki (user melaporkannya).** `useSessionMutation` di AuthModal mengetik payload `Record<string, unknown>` → TS2345 menolak interface `LoginValues` (tak punya index signature). Dibuat generik `useSessionMutation<T>`. `next build` gagal karena ini; sekarang hijau.

2. **CSS injeksi runtime → berkas komponen (RISK #1 audit).** Navbar Laravel menyuntik 258 baris CSS lewat `document.createElement('style')` di useEffect → CSS absen saat SSR → FOUC navbar polos. Diekstrak ke `navbar.css` + `import './navbar.css'`. Class ini (.kinetic-nav-link, .ubsc-liquid-glass, dll) TIDAK ada di app.css Laravel — bukan bagian gate Fase 2, jadi CSS bespoke komponen (diizinkan aturan 2).

3. **`divide-y` PaymentHistoryModal — sengaja TIDAK dikoreksi R4.** Koreksi divide→border-arbitrary (temuan 6 fase-2) hanya untuk 3 berkas admin di corrections-applied.json; modal ini di luar korpus gate. Untuk daftar flush, posisi garis v3/v4 identik. String sumber dipertahankan. Verifikasi ulang saat Fase 6 membuat modal ini live & terukur.

4. **`setShowBg` tak terpakai — quirk sumber, dipertahankan.** Di Laravel pun setShowBg tak pernah dipanggil; opacity overlay digerakkan imperatif via getElementById. Di-port apa adanya + eslint-disable + komentar (jangan "diperbaiki").

5. **AuthUser belum punya `avatar`/field profil.** Navbar & ProfileModal membacanya via tipe lokal + cast + TODO Fase 6. AuthContext tidak disentuh. Perlu diperluas saat sync:contracts Fase 6 membawa field profil ke AuthUser.

6. **CORS dev: pakai localhost:3000, bukan 127.0.0.1** (dari 4b Batch B, masih berlaku) — kalau tidak, refresh & semua panggilan auth 500 karena Origin ditolak.

### Endpoint yang ditunggu Fase 6 (dipanggil UI, belum ada backend)

`GET /api/customer/pending-payment`, `GET /api/customer/transactions`, `POST /api/customer/profile`, `POST /api/customer/identity`, `PUT /api/customer/password`. Semua diberi komentar TODO Fase 6 di titik call; gagal anggun (pill tersembunyi / error state modal).

Batch berikutnya: D (SectionTwo + rantai curtain) — struktur paling rapuh, ukur dengan DOM-structure diff.

---

## 4b — Batch D (SectionTwo + rantai curtain)

Status: **selesai, ter-build, render terverifikasi (curtain chain + membership area).**

### Berkas (3)

| Berkas                      | Cara            | Catatan                                                                                                                          |
| --------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `landing/ImageCarousel.tsx` | ditulis sendiri | embla; `outline-none`→`outline-hidden`, buang token mati `ring-white/16`, `alt` dilonggarkan `string\|null` agar terima PromoDto |
| `landing/LogoMarquee.tsx`   | ditulis sendiri | 0 class berubah; rAF marquee + pointer drag + `<style>` inline 1:1                                                               |
| `landing/SectionTwo.tsx`    | subagen         | integrator curtain; 6 classPairs; field rename snake→camel; gymTraffic diteruskan                                                |

### Bukti

- **Paritas className: 3/3 identik** (SectionTwo 286=286, ImageCarousel 37, LogoMarquee 36) setelah rename v3→v4.
- `next build` exit 0, `/` route 230 kB First Load (naik dari 214 — SectionTwo+embla+marquee), static ISR revalidate 5m. tsc 0, eslint 0.
- Render: rantai curtain (siluet gelap hero melengkung ke section putih), "Gabung Member Sekarang", headline gym, ReservasiButton "Daftar Sekarang", GymTrafficBadge, kolom Jadwal/Maskulin, ImageCarousel (figure), LogoMarquee (sponsor-logo-rail ×3), heading "Jelajahi Program Kami". InfoBanner berotasi ke announcement ke-2.

### Temuan 4b Batch D

1. **DTO camelCase vs SectionTwo snake_case — perbaikan wajib.** MembershipPlanDto/PromoDto/SponsorDto camelCase, tapi sumber akses `plan.card_image_url`, `plan.public_badge`, `plan.savings_label`, `plan.cta_label`, `plan.duration_months`. Semua di-rename ke camelCase + FALLBACK_MEMBERSHIP_PLANS diubah ke MembershipPlanDto (id:'0'). Tanpa ini kartu membership kosong saat data nyata masuk. `MembershipPlanItem` (@/types) tidak dipakai lagi.

2. **`membership_plans` kosong = FALLBACK dirender (paritas benar).** Kartu menampilkan "Design Agencies & Team" dari FALLBACK_MEMBERSHIP_PLANS — sama seperti Laravel (DB 0 baris di kedua sisi, konfirmasi Fase 4a temuan 5).

3. **Curtain RISK #3 dijaga.** Wrapper `.section-two-curtain` / `-content` / `-edge` / `-edge__shape` dipertahankan persis; SectionTwoCurtainEdge rAF (clip-path polygon, query `.home-post-section-two-flow`/`footer` yang di-guard) 1:1; `'use client'` di level file, bukan wrapper baru. Query ke elemen batch berikutnya aman (di-guard).

4. **`ring-white/16` token mati (R1) dihapus** dari ImageCarousel (v3 tak menghasilkan CSS; port setia = tanpa ring), `ring-1 ring-inset` tetap.

5. **`usesStackedSectionLayout` dead var** — dihitung tak pernah dibaca di sumber Laravel; dipertahankan 1:1 + eslint-disable + komentar (seperti setShowBg Navbar).

6. **Tipe komponen dilonggarkan agar reusable:** CarouselImage.alt `string|null` (= PromoDto), SponsorItem.id `string|number` (SponsorDto assignable) — promos/sponsors dari HomeDto dioper langsung tanpa map.

Sisa Batch: E (SectionThree/Four + Facility*), F (SectionFive/Six/Seven), G (SectionEight + peta + Footer + FlashToast). Komposisi berikutnya masuk `.home-post-section-two-flow` (yang query curtain sudah antisipasi).

---

## 4b — Batch E, F, G (SectionThree–Eight + Facility + Footer + FlashToast)

Status: **SELESAI. Beranda utuh (Hero → SectionTwo → … → SectionEight → Footer) ter-build & render dengan data API nyata.**

### Berkas (22 komponen)

- **E** (6): SectionThree, SectionFour (curtain kedua), Facility/{ListSection, ListItem, ClassSection, OutdoorSection}
- **F** (11): SectionFive, NewsSection, NewsCard, ReelsSection, ReelCard, SectionActionLink, CarouselNavButtons, SectionSix, PriceCard, SectionSeven, news/AnimatedBookingLink
- **G** (5+1): SectionEight, LocationMapLazy, LocationMap, map (1485 baris), Footer, FlashToast (dipisah dari HomePage)

Metode: 17 subagen paralel (E 6 + F 11 + G 6) dengan spec presisi (rules-batchC + addendum per-batch + spec-*.json class pairs). Diverifikasi parent.

### Bukti

- **Paritas className: 22/22 identik** dengan Laravel (checker string-replace baru yang menangani koreksi R2 penambahan token; FlashToast tanpa sumber standalone → verifikasi manual + eslint).
- `next build` exit 0, `/` route 253 kB First Load (map.tsx code-split via next/dynamic ssr:false — TIDAK di bundle awal), static ISR revalidate 5m. tsc 0, eslint 0.
- Render live: SectionFour facility list dengan **gambar fasilitas NYATA dari API** + FacilityBadge (Veteran / Indoor Facility gradient); semua 8 section hadir dengan bg/dimensi benar (DOM-verified: SectionTwo putih, SectionFour #FAFAFA 7307px, Footer #252525); gambar `/uploads/media/*` termuat (naturalWidth>0); Footer "Ingin Menjalin Kemitraan?" render.
- Komposisi final HomePage.tsx:132-170 direplikasi persis: Navbar → home-hero-section-reveal(Hero + curtain SectionTwo) → home-post-section-two-flow(SectionThree FadeIn + SectionFour + home-post-section-four-flow(SectionFive–Eight FadeIn)) → Footer DI LUAR main → FlashToast.

### Temuan besar E/F/G

1. **BUG ARSITEKTUR yang diperbaiki — URL media harus RELATIF, bukan absolut.** `media-services.ts` membangun `API_BASE_URL + /uploads/...` (absolut ke :4020). Di dev, landing (:3000) dan API (:4020) beda origin; `<img>` cross-origin ke :4020 diblokir `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` (CORP helmet). next.config SENGAJA mem-proxy `/uploads` same-origin. Perbaikan: `urlFor()` mengembalikan RELATIF `/uploads/media/...` → dev lewat proxy Next, prod lewat nginx di domain landing. **Semua 27+ gambar CMS (promo/sponsor/fasilitas/news/reel) tadinya rusak; sekarang termuat.** Ini menyentuh SELURUH konsumen media (landing + admin Fase 8).

2. **Next Data Cache menyimpan respons getHome lama.** Setelah fix URL, rebuild pertama TETAP absolut karena Next men-cache fetch RSC di `.next/cache`. Wajib `rm -rf .next` untuk memaksa fetch ulang. Pelajaran: perubahan bentuk data API → hapus `.next` sebelum rebuild verifikasi.

3. **DTO camelCase vs sumber snake_case** (lanjutan Batch D): SectionFour `f.class_code`→`f.classCode`, `f.venue_type`→`f.venueType`; SectionSix `f.price_range`→`f.priceRange`. Tipe pakai FacilityDto/NewsDto/ReelDto/TestimonialDto kontrak.

4. **Testimonial fallback dipindah ke frontend** (keputusan Fase 4a): `TESTIMONIAL_IMAGE_FALLBACK` (3 authorName → /assets/icons) di SectionSeven, karena TestimonialDto.image `string|null` (API tak bisa cek public/ repo Next). `reviews` prop MATI (tak dirender), sesuai Laravel.

5. **DUMMY_REELS path aset stale** — subagen menyalin path spasi Laravel (`thumbnail 1.avif`, `reels ubsc 1.mp4`); diperbaiki ke kebab (`thumbnail-1.avif`, `reels-ubsc-1.mp4`) sesuai rename R9. `ReelItem.id` disempitkan ke string (= ReelDto).

6. **Dead code sumber dipertahankan 1:1 + eslint-disable**: `usesStackedSectionLayout` (SectionTwo/Four), `ScrollDotIndicator` + `total` (FacilityClassSection). Quirk Laravel, bukan bug.

7. **map.tsx (1485→1312 baris)** sudah named export + `"use client"` di sumber; 11 komponen map diekspor (Map, MapMarker, dst). LocationMapLazy: `lazy`+Suspense → `next/dynamic(ssr:false)`. Live WebGL canvas belum terkonfirmasi render di browser pane (kemungkinan keterbatasan WebGL/scroll-gate pane); port terverifikasi kode (paritas + build code-split + dynamic import).

### Insiden lingkungan (bukan bug kode)

Restart dev-server berulang sepanjang sesi menumpuk ~13 proses node; tiap API (tsx watch) membuka pool 20 koneksi → **MySQL laragon tumbang** (kehabisan koneksi, max_connections 151). Dipulihkan: `mysqld --datadir=C:/laragon/data/mysql-8` diluncurkan manual; `ubsc_dev` utuh (9 fasilitas, 7 news, 39 media). **Catatan untuk user: MySQL kini jalan lewat proses mysqld yang saya luncurkan, bukan service laragon — restart lewat laragon bila ingin dikelola normal.** Ke depan: hindari restart dev-server beruntun; hentikan proses lama sebelum start baru.

## Status Fase 4 keseluruhan

Fase 4a (11 endpoint publik) + 4b (beranda utuh, 48 komponen) SELESAI. Semua ter-build, tsc/eslint 0, paritas className penuh vs Laravel, render dengan data nyata. **Belum di-commit** (permintaan user) — 224 berkas landing, 19 api, 14 admin. `/styleguide` masih terpasang (pengukuran gate fidelity resmi belum bisa sampai dicabut).

Berikutnya: Fase 5 (sisa halaman publik) / 6 (area customer + endpoint /api/customer/* yang membuat modal Fase 4 hidup) / 7-8 (admin).
