# Fase 2 — Design system

Status: **LULUS — gate bersih (15 September 2026).** Fase 4 (landing slice) tidak lagi terblokir.

Gate menurut `Rewrite.md`:

> Route `/styleguide` sekali-pakai merender 33 keyframes + semua class `.ubsc-*`/`.entrance-*`/`.ah-*`/
> `.gym-traffic-*` + swatch, di-screenshot-diff lawan Laravel. **Jangan lanjut sebelum bersih.**

Yang diukur jauh lebih ketat dari bunyi gate itu — cara kerja dan cara menjalankan ulang ada di
[`ubsc-landing/tools/fidelity-harness`](../../ubsc-landing/tools/fidelity-harness/README.md), laporan mentahnya di
`tools/fidelity-harness/reference/`.

---

## Hasil gate

Setiap baris di bawah bernilai **nol** — bukan "di bawah ambang". Selisih computed style dihitung per properti setelah
aturan kesetaraan yang terdokumentasi satu per satu di `compare.html`; pixel diff adalah vonis visual.

| Pengukuran                                                                                                               | Cakupan                                                                   | Hasil                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Gate resmi `/styleguide`** — `next build` + `next start` ubsc-landing, `globals.css` asli                              | 8.251 sel × 11 lebar (360–1800px) · 473 properti per elemen · 38 keyframe | 0 selisih computed · 0 piksel · 0 tinggi halaman · 0 keyframe |
| Harness sel, kandidat Tailwind CLI (`reference/gate-cli.json`; isi CSS sama minus alias `-webkit-user-select`, temuan 8) | idem                                                                      | idem                                                          |
| Drift dokumen panjang (`drift.mjs`) atas CSS build Next                                                                  | prose LegalShell, prose-sm RichEditor, 400 string tipografi × 5 lebar     | 0,0000px pergeseran                                           |
| Cascade berkondisi state (`cascade-ties.mjs`)                                                                            | 576 pasangan deklarasi bespoke/utilitas di bawah `:hover`/`group-hover`/… | 0 berbalik                                                    |
| `cn()` — tailwind-merge 2.6.1 (Laravel) vs 3.6.0 (`cn-parity.mjs`)                                                       | 341 panggilan di 40 berkas, 642 kombinasi cabang runtime                  | 0 hasil berbeda                                               |
| Format angka & tanggal (`format-parity.mjs`)                                                                             | 44/44 pemanggilan Intl Laravel, 18 kelompok, 7 zona waktu                 | semua setara                                                  |

Sel harness: setiap utilitas yang ter-generate di CSS produksi Laravel (3.678), setiap class dan selector bespoke,
38 `@keyframes`, elemen polos (preflight + forms plugin), dan **4.251 string `className` asli** dari 155 berkas hidup
— sisi v4-nya diambil dari sumber hasil migrasi, teks yang benar-benar di-port di Fase 4–8.

## Yang dikirim

**ubsc-landing**

- `src/app/globals.css` — hanya urutan import. **Urutan itu adalah urutan cascade yang diukur**; jangan disisipi.
- `src/styles/tailwind-v3-compat.css` — plugin (`forms`, `typography`, `tailwindcss-animate`), varian `dark` & `hover`,
  palet v3 (hex), breakpoint px, default ring/drop-shadow, kompat preflight.
- `src/styles/ubsc-base.css` — token brand, 11 `@font-face`, base layer Laravel.
- `src/styles/ubsc-bespoke.css` — CSS bespoke `resources/css/app.css` Laravel, di-import `layer(utilities)`.
- `src/styles/tailwind-v3-utilities.css` — variabel prose bernilai v3, gradien `in srgb`, line-height `text-*` rem,
  `drop-shadow` dua lapis.
- `src/styles/boilerplate-tokens.css` — token baru untuk primitif boilerplate (sidebar, kartu statistik); tidak
  menimpa satu pun token Laravel.
- `postcss.config.mjs` — `@tailwindcss/postcss` dengan **`optimize: false`** (temuan 8).
- `src/app/layout.tsx` — tanpa `next/font`; `<body className="font-sans antialiased">` seperti `app.blade.php`.
- `package.json` — `tailwindcss`/`@tailwindcss/postcss` 4.3.3, `@tailwindcss/forms` 0.5.11, `@tailwindcss/typography`
  0.5.20, `tailwindcss-animate` 1.0.7, **dipin eksak**: versi inilah yang diukur gate.

Berkas `tailwind-v3-*`/`ubsc-*` dihasilkan `assemble.mjs`, bukan ditulis tangan.

**ubsc-admin** — fondasi yang sama **tanpa** `ubsc-bespoke.css` (panel admin Laravel merujuk 0 class bespoke).
Salinannya dijaga identik: `npm run sync:design-system` / `npm run check:design-system`. PostCSS, layout, dan versi
paket sama dengan landing. `src/utils/text.ts` (formatter tanggal kedua warisan boilerplate, tanpa zona waktu, tidak
dipakai) dihapus — R13.

**ubsc-api** — `shared/format.ts` mendapat `formatNumberIntl`, `formatDateIntl`, `formatCalendarDateIntl` (tabel port
di bawah). Hash kontrak berubah; kedua repo Next sudah `sync:contracts`.

**Peta migrasi class** — `tools/fidelity-harness/reference/class-migration.json`: 669 string `className` yang berubah
(dengan berkas asalnya), 165 rename per class dari codemod, 61 token mati. **Porting Fase 4–8 mengambil string v4 dari
berkas ini**, bukan menjalankan codemod lagi.

---

## Temuan — hal yang TIDAK diantisipasi `Rewrite.md`

Semua terukur, bukan dugaan.

### 1. Bug codemod: `flex-shrink:` → `shrink:` di dalam `<style>` runtime

`@tailwindcss/upgrade@4.3.3` menulis ulang **properti CSS** `flex-shrink: 0;` menjadi `shrink: 0;` (tidak valid,
diabaikan browser tanpa error) di 11 deklarasi: `Pages/Admin/Dashboard.tsx` (5, termasuk style cetak laporan),
`Pages/Admin/Finance/Index.tsx` (5), `Pages/Admin/Identity/Index.tsx` (1). Dipulihkan di sumber migrasi; saat mem-port
tiga berkas itu, pertahankan `flex-shrink`.

### 2. Palet warna v4 bergeser dari v3

v4 memakai OKLCH: 104 utilitas warna UBSC keluar dari gamut sRGB (`amber-300` `rgb(252,211,77)` → `rgb(255,210,48)`),
checkbox forms plugin `rgb(37,99,235)` → `rgb(21,93,252)`. **Perbaikan**: seluruh palet v3 (hex) di `@theme`.

### 3. Urutan cascade v3 tidak bisa direproduksi persis oleh layer v4

Di CSS produksi Laravel: utilitas polos → CSS bespoke → **varian** (`hover:`, `xl:`). v4 mengeluarkan utilitas polos dan
varian dalam satu layer. **Keputusan**: bespoke di `@layer utilities` setelah utilitas inti — spesifisitas tetap
berlaku seperti v3; yang berbeda hanya seri spesifisitas bespoke vs varian, ditangani koreksi markup R3 (temuan 10).

### 4. Class yang mati di v3 tapi hidup di v4 — 61 token, 191 kemunculan

Ditulis developer tapi **tidak pernah menghasilkan CSS** di Laravel: modifier opasitas di luar skala v3 (`border-white/18`
×19, `bg-white/14` ×13, `bg-white/92` ×9, `from-slate-950/76`, …), `delay-400`, `z-100`, `perspective-[1000px]`, dan
class di `tokens.ts` (glob `content` v3 hanya `*.tsx`). Di v4 semuanya tiba-tiba tampil. Port yang setia **menghapusnya**
(koreksi R1); daftarnya di `class-migration.json` → `deadTokens`.

> **Keputusan produk yang tetap terbuka**: banyak di antaranya jelas efek kaca dan overlay foto yang _dimaksudkan_
> desainer. Port setia = tampilan Laravel sekarang (efeknya tidak ada). Menghidupkannya = perubahan desain, di luar
> rewrite.

### 5. Line-height `text-*` berubah semantik

v4 memakai rasio (`calc(1 / 0.75)`) dan membuat `leading-*` selalu menang lewat `--tw-leading`; di v3 rem absolut, dan
`sm:text-4xl` mengalahkan `leading-tight` karena ditulis belakangan. **Perbaikan**: `--text-*--line-height` rem v3 +
koreksi R2 pada 32 string tipografi responsif.

### 6. Hazard CSS lain yang terbukti dan diperbaiki

| Hazard                                                 | v3                        | v4                                                           | Perbaikan                             |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Interpolasi gradien `bg-linear-to-*`                   | sRGB                      | `in oklab`                                                   | `@utility` 8 arah `in srgb`           |
| `ring` default                                         | 3px biru-500/50%          | currentColor                                                 | `--default-ring-width/color`          |
| `drop-shadow` sm/md/lg/xl                              | dua lapis                 | dua lapis → `drop-shadow(a, b)` tidak valid → `filter: none` | `@utility` rangkaian `drop-shadow()`  |
| Warna `prose`                                          | gray v3                   | plugin mengimpor palet OKLCH langsung                        | `--tw-prose-*` bernilai v3            |
| Varian `hover:`                                        | `:hover`                  | dibungkus `@media (hover: hover)`                            | `@custom-variant hover (&:hover)`     |
| Breakpoint (`sm:`…`2xl:`, `min-[1440px]:`)             | px                        | rem — urutan terhadap `min-[…px]` arbitrer bergeser          | `--breakpoint-*` px                   |
| `divide-*`                                             | `> :not([hidden]) ~ …`    | `:where(> :not(:last-child))` — garis di sisi lain           | koreksi R4 ke varian anak arbitrer v3 |
| Cursor `<button>`, warna placeholder, padding td/th    | pointer, gray-400, UA 1px | default, currentColor 50%, 0                                 | kompat preflight                      |
| `type="search"`, `::file-selector-button`, input range | UA                        | di-reset                                                     | kompat preflight                      |
| `.maplibregl-popup-*` `@apply ...!`                    | **mati** — 0 rule         | hidup                                                        | di-comment (sesuai `Rewrite.md`)      |

### 7. Klaim `Rewrite.md` yang perlu dikoreksi

- **"tailwindcss-animate dihapus"** — dipakai (`animate-in fade-in-0 zoom-in-95`, `Landing/map.tsx`). Dipertahankan.
- **`@tailwindcss/forms` tidak disebut** — aktif dan me-reset semua input. Dipertahankan.
- **"seluruh delta tercakup `npx @tailwindcss/upgrade`"** — tidak; lihat temuan 1–6 dan 8–10.

### 8. Lightning CSS di build produksi Next menumpukkan pergeseran sub-piksel

`@tailwindcss/postcss` menjalankan Lightning CSS saat `NODE_ENV=production`. Angka disimpan sebagai f32 dan ditulis
6 digit signifikan: `1.1428571em` → `1.14286em`. Setiap sel harness lolos piksel, tetapi margin/line-height prose
bergeser di bawah 1/64px **per elemen** dan menumpuk:

| Dokumen 40 bagian (1280px)         | Build Next bawaan                   | `optimize: false` |
| ---------------------------------- | ----------------------------------- | ----------------- |
| `prose prose-sm` (RichEditor)      | −4,98px, elemen ke-64 sudah ≥ 0,5px | 0,0000px          |
| `prose prose-slate …` (LegalShell) | −0,63px                             | 0,0000px          |

Lightning CSS juga menulis ulang `translate3d(x,0,0)` → `translate(x)` dan menghitung `color-mix()` menjadi `oklab()`
statis. **Perbaikan**: `optimize: false` di `postcss.config.mjs` kedua repo; Next tetap meminifikasi dengan
cssnano-simple. Konsekuensi yang disengaja:

- CSS nesting keluaran Tailwind dikirim apa adanya → butuh Chrome 112 / Safari 16.5 / Firefox 117 (Tailwind v4 sendiri
  sudah mensyaratkan Chrome 111 / Safari 16.4 / Firefox 128).
- Tidak ada prefiks vendor otomatis. Seluruh selisih prefiks terhadap autoprefixer Laravel diperiksa; satu-satunya yang
  masih bermakna bagi target Tailwind v4 adalah `-webkit-user-select` (Safari) — dipasang `assemble.mjs` pada 2 rule
  bespoke dan checkbox/radio forms plugin. Sisanya (`-moz-*`, `-o-*`, `-webkit-appearance`, `-webkit-print-color-adjust`)
  sudah didukung tanpa prefiks oleh browser target.

Transformasi cssnano-simple yang tersisa semuanya setara dan kini dinormalkan `compare.html` (didokumentasikan di sana):
panjang nol tanpa satuan (`0%` → `0`), `background-position: initial` → `0 0`, `inset(0 0%)` → `inset(0)`, posisi stop
gradien implisit/terjepit (color-stop fix-up), spasi fallback `var()`, `translate3d(0,0,0)` → `translateZ(0)`.

### 9. `group-hover:` di v4 lebih lemah dari v3

v3: `.group:hover .group-hover\:x` (0,3,0). v4: `.group-hover\:x:is(:where(.group):hover *)` (0,2,0). Satu string
Laravel terkena: `.hero-bottom-scroll:hover .hero-bottom-scroll-label` (bespoke, border `rgba(255,255,255,.95)`) seri
dengan `group-hover:border-white` di v3 dan varian menang; di v4 bespoke menang. Setelah transisi latar putih keduanya
tampak sama, selama 300ms `transition-colors` tidak. **Perbaikan**: R3 `group-hover:border-white!`
(`HeroBottomBar.tsx`).

### 10. Koreksi markup R0–R4 (total)

R0 rename di `.ts` yang tidak dipindai codemod (2) · R1 token mati (191 kemunculan) · R2 tipografi responsif (32
string) · R3 manual (4: `ah-panel-img` ×2, `rounded-b/r` Sponsors, `group-hover` HeroBottomBar) · R4 `divide-*` (3).
Semua tercatat per berkas di `reference/corrections-applied.json`.

### 11. Ditinjau manual, tidak perlu perubahan

- **6 rule bespoke bersubjek tag/atribut** (`.ubsc-hero-orbit img`, `.hero-bottom-bar video`, `.lenis.lenis-smooth
[data-lenis-prevent]`, …): hanya menulis `animation`, `animation-play-state`, `opacity`, `transform`,
  `overscroll-behavior`. Preflight tidak menulis properti itu, dan utilitas pesaing berada di layer yang sama dengan
  spesifisitas yang sama seperti v3 — hasil cascade identik.
- **Atribut HTML `hidden`**: preflight v4 `display: none !important`, v3 tanpa `!important`. Laravel tidak memakai
  atribut `hidden` di TSX mana pun, jadi inert.
- **Figtree** dari fonts.bunny.net di `app.blade.php` dimuat tetapi tidak pernah dipakai (`font-sans` Laravel = BDO
  Grotesk) — tidak di-port.
- **Font**: 9 `.woff2` di `public/fonts` kedua repo identik byte (sha256) dengan `public/fonts` Laravel.

### 12. Format angka & tanggal — helper Fase 1 tidak cukup

`format.ts` Fase 1 hanya setara dengan pola `"Rp " + n.toLocaleString("id-ID")` untuk bilangan bulat. Laravel punya 44
pemanggilan dengan opsi berbeda-beda: `style: 'currency'` IDR menyisipkan NBSP (`Rp⍽1.500`), `day: '2-digit'` menulis
"05", dan tanggal kalender dibentuk dari `new Date(y, m, d)` lokal. Port yang lewat helper instan akan bergeser sehari
di browser WIT dan menghasilkan teks SSR ≠ klien. Tiga helper eksak ditambahkan; tabelnya di bawah.

---

## Aturan untuk Fase 4–9

1. **Class**: string v4 dari `reference/class-migration.json`. Jangan menghidupkan token mati; jangan menjalankan codemod
   pada kode port.
2. **CSS**: jangan menyunting `src/styles/tailwind-v3-*`/`ubsc-*` dengan tangan dan jangan mengubah urutan import. CSS
   bespoke baru untuk halaman baru boleh ditulis di berkas komponen, bukan di berkas hasil harness.
3. **Seri bespoke vs varian state**: bila menulis `hover:`/`group-hover:` pada elemen yang juga punya class bespoke
   ber-`:hover`, periksa spesifisitas (temuan 9) — jalankan `cascade-ties.mjs` bila ragu.
4. **`cn()`**: 341 panggilan Laravel terbukti setara di tailwind-merge 3. Panggilan baru dengan class yang bertabrakan
   diperiksa dengan `cn-parity.mjs`.
5. **Format**: hanya lewat `format.ts`, sesuai tabel di bawah.
6. **Screenshot-diff Fase 4+**: bandingkan **build produksi** (`next build && next start`), bukan `next dev --turbopack`
   — gate ini tidak mengukur pipeline CSS Turbopack. Kedua sisi dengan locale `id-ID` dan zona `Asia/Jakarta`.
7. **Upgrade Tailwind/plugin** atau perubahan `postcss.config.mjs` = jalankan ulang gate (harness + `/styleguide` +
   `drift.mjs`). Jangan menghapus `optimize: false`.
8. **ubsc-admin**: setelah sinkronisasi, `npm run check:design-system` harus hijau.

## Tabel port format (`format.ts`)

Diverifikasi `format-parity.mjs` (setiap pemanggilan Laravel wajib ada di tabel — pemanggilan baru membuat script gagal).
"Kalender" = kunci `"YYYY-MM-DD"`; "instan" = ISO UTC dari API.

| Pola Laravel                                                                                                          | Port                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `"Rp " + n.toLocaleString("id-ID")` (12×), `"Rp " + Intl.NumberFormat("id-ID").format(n)`                             | `formatRupiah(n)` — bilangan bulat (semua kolom uang `Int`)                                         |
| `n.toLocaleString("id-ID")`, `Intl.NumberFormat("id-ID").format(n)` pada bilangan bulat                               | `formatNumberID(n)`                                                                                 |
| `x.toLocaleString("id-ID", { maximumFractionDigits: 0 })`                                                             | `formatNumberID(x)`                                                                                 |
| `x.toLocaleString("id-ID", { maximumFractionDigits: 1 })` (ringkas JT/M, tren %)                                      | `formatNumberIntl(x, { maximumFractionDigits: 1 })`                                                 |
| `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })`                        | `formatNumberIntl(n, { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })` — NBSP ikut |
| `place.reviews.toLocaleString()` (tanpa locale, LocationMap)                                                          | `formatNumberID(place.reviews)` — Laravel bergantung locale browser; port mengunci id-ID            |
| `new Date(y, m-1, d).toLocaleDateString("id-ID", opsi)`, `LONG_DATE/SHORT_DATE` `${tgl}T12:00:00`, `ClassMonthPicker` | `formatCalendarDateIntl(kunci, opsi)` — opsi disalin apa adanya                                     |
| `new Date().toLocaleDateString("id-ID", opsi)` (cetak laporan Dashboard/Finance)                                      | `formatDateIntl(new Date(), opsi)`                                                                  |
| `PaymentHistoryModal`: `created_at` / `booking_date`                                                                  | `formatDateIntl(createdAt, opsi)` / `formatCalendarDateIntl(bookingDate, opsi)`                     |
| `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` (`todayStr`, nomor LPR)                               | `toJakartaDateKey(new Date())`                                                                      |
| `$this->published_at?->format('d.m.Y') ?? ''` (Carbon, `NewsResource.php:15`)                                         | `formatDateDotID(publishedAt)` — guard `: ''` di pemanggil, lihat di bawah                          |
| `$this->created_at->format('d/m Y')` (Carbon, `ReelResource.php:15`)                                                  | `formatDateSlashSpaceID(createdAt)` — garis miring hanya hari/bulan, tahun dipisah spasi            |
| `'Rp' . number_format($n, 0, ',', '.')` (`FacilityResource.php:50`, `price_range`)                                    | `formatRupiahTight(n)` — "Rp1.000", TANPA spasi                                                     |

Jebakan yang terbukti TIDAK setara: `formatRupiah` untuk pola currency (spasi vs NBSP), `formatRupiah` untuk `priceRange`
(`Rp 1.000` vs `Rp1.000` — pakai `formatRupiahTight`), `formatNumberID` untuk pecahan (`1.235` vs `1.234,5`),
`formatDateID` untuk `day: '2-digit'`, `formatDateIntl(new Date(y, m-1, d))` di browser WIT (hari sebelumnya),
`toISOString().slice(0, 10)` sebagai kunci hari ini (tanggal UTC).

Satu guard yang tidak ada di `format.ts` dan wajib dipegang pemanggil: `NewsDto.date`. Laravel mengirim **string kosong**
untuk berita ber-`published_at` null (`?? ''`), sedangkan seluruh helper di `format.ts` mengembalikan `'-'` untuk input
kosong — invarian file itu sengaja tidak dilanggar. Karena itu service menulis
`date: news.publishedAt ? formatDateDotID(news.publishedAt) : ''` (`src/services/cms-services.ts`, `listNews`). Tanpa
guard itu kartu berita tanpa tanggal menampilkan `-`, bukan kosong. `ReelDto.date` tidak butuh guard: `created_at` NOT NULL.

## Menjalankan ulang

Lihat [README harness](../../ubsc-landing/tools/fidelity-harness/README.md): `bootstrap.sh` → `pipeline.sh` → analisis
statis → route `/styleguide` + `next build` + `walk.mjs` mode `--next` + `drift.mjs` → cabut route.
