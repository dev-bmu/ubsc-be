# Spike React 19 — hasil (R6)

Deliverable Fase 0 nomor 11, mitigasi risiko **R6** (`React 18→19 di seluruh dependency landing`) pada dokumen rencana
`C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL/Rewrite.md`.

Spike-nya sudah dijalankan, tetapi hasilnya tidak pernah dicatat di berkas mana pun. Berkas ini adalah catatan itu.
Spike tanpa catatan sama dengan spike yang tidak pernah dilakukan: enam bulan lagi tidak ada yang ingat paket mana
yang benar-benar dibuktikan jalan dan mana yang cuma "ter-install tanpa error".

## Status

**HIJAU.** Build Next 15 berhasil dengan seluruh set dependency landing terhadap React 19.

| Yang diukur                                     | Hasil                                  |
| ----------------------------------------------- | -------------------------------------- |
| Build Next 15 (`next build`)                    | Berhasil                               |
| Peringatan peer dependency saat install         | **Nol**                                |
| Pesan console browser saat halaman spike dibuka | **Nol** — tidak ada hydration mismatch |

Nol pesan console adalah angka yang penting di sini, bukan sekadar kerapian. Hydration mismatch pada React 19 tidak
selalu menggagalkan render; ia sering hanya membuang hasil SSR dan diam-diam merender ulang di klien. Kalau console
bersih, berarti pohon server dan pohon klien identik untuk seluruh library yang diuji.

## Bukti runtime per library

Syarat kelulusan spike ini bukan "paket berhasil di-resolve" atau "import tidak melempar". Yang dihitung hanya bukti
bahwa library benar-benar **mengerjakan sesuatu yang terlihat** di bawah React 19. Setiap baris di bawah adalah
observasi pada DOM atau pada nilai runtime, bukan pembacaan `package.json`.

| Library                                             | Bukti runtime yang diamati                                       |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `motion` 12                                         | Komponen ter-render dan animasinya berjalan                      |
| `lenis`                                             | Memasang class `lenis` pada elemen `<html>`                      |
| `embla-carousel-react`                              | Menghasilkan `transform` matrix pada 2 slide                     |
| `qrcode.react`                                      | Menghasilkan `<svg viewBox="0 0 21 21">`                         |
| `lucide-react`                                      | Merender ikon                                                    |
| `@tanstack/react-query`                             | `useQuery` resolve dan datanya sampai ke komponen                |
| `react-hook-form` + `@hookform/resolvers` + `zod` 4 | `zodResolver` memunculkan pesan validasi pada submit tidak valid |
| `@radix-ui/react-dialog`                            | Membuka portal `[role="dialog"][data-state="open"]`              |
| `maplibre-gl`                                       | Ter-import dan versinya tercetak dari `useEffect`                |

Baris `maplibre-gl` sengaja diuji lewat `useEffect`, bukan lewat import saja. Nilai versinya baru tercetak kalau efek
klien benar-benar dijalankan, jadi baris itu sekaligus membuktikan **hidrasi klien berhasil** — bukan hanya bahwa
modulnya bisa dimuat di server.

## Versi exact yang ter-resolve

Inilah angka yang di-pin. Kalau suatu hari build pecah, bandingkan dengan tabel ini lebih dulu sebelum menuduh kode.

| Paket                   | Versi ter-resolve |
| ----------------------- | ----------------- |
| `next`                  | 15.5.25           |
| `react`                 | 19.3.0            |
| `react-dom`             | 19.3.0            |
| `motion`                | 12.43.0           |
| `lenis`                 | 1.3.26            |
| `embla-carousel`        | 8.6.0             |
| `embla-carousel-react`  | 8.6.0             |
| `maplibre-gl`           | 5.24.0            |
| `qrcode.react`          | 4.2.0             |
| `lucide-react`          | 1.44.0            |
| `clsx`                  | 2.1.1             |
| `tailwind-merge`        | 3.6.0             |
| `@tanstack/react-query` | 5.102.8           |
| `react-hook-form`       | 7.87.0            |
| `@hookform/resolvers`   | 5.9.1             |
| `zod`                   | 4.6.2             |
| `axios`                 | 1.20.0            |
| `date-fns`              | 4.4.0             |
| `typescript`            | 5.9.3             |
| `@types/react`          | 19.3.0            |
| `tailwindcss`           | 4.3.3             |

## Hazard scan React 18 → 19 pada kode Laravel

Dipindai terhadap **181 berkas** di `C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL/resources/js` — yaitu kode React 18 yang
akan di-port ke landing dan admin.

| Hazard React 19                                              | Temuan       |
| ------------------------------------------------------------ | ------------ |
| `defaultProps` pada function component (dihapus di React 19) | **0**        |
| `propTypes` (dihapus di React 19)                            | **0**        |
| `useLayoutEffect` di jalur SSR                               | **0**        |
| String ref (`ref="nama"`, dihapus di React 19)               | **0**        |
| `forwardRef` (tidak lagi perlu di React 19, tetap jalan)     | **2 berkas** |

Dua berkas `forwardRef` itu: `Components/Landing/map.tsx` dan `Components/TextInput.tsx`.

**Klaim dokumen 0/0/0/0/2 terbukti benar.**

### Jebakan perintahnya — baca sebelum mengulang scan ini

Perintah naif untuk mencari string ref memberi hasil yang salah total:

```bash
# SALAH — 54 hit palsu
grep -rnE 'ref="' resources/js

# BENAR — 0 hit
grep -rnE '\bref="' resources/js
```

Sebabnya sepele dan justru karena itu berbahaya: `ref="` adalah substring dari `href="`. Seluruh 54 "temuan" pola
pertama adalah atribut `href` biasa pada `<a>` dan `<Link>`. Siapa pun yang mengulang perintah naif itu akan
menyimpulkan ada 54 hazard string ref yang harus diperbaiki, lalu membuang waktu memeriksa 54 tautan yang sehat —
atau lebih buruk, menunda migrasi React 19 karena angka yang tidak pernah nyata. Selalu pakai `\b`.

## Koreksi atas klaim `@react-three/fiber@8` di dokumen rencana

Dokumen rencana (`Rewrite.md`, tabel dependency baris `three` + `@react-three/*` + `maath`, dan baris R6) menyebut
`@react-three/fiber@8` sebagai **"hard blocker React 19"**. **Kesimpulan membuangnya tetap benar**, tetapi
**mekanismenya salah** — dan mekanisme yang salah itu berbahaya, karena membuat orang mengira npm akan menghentikan
mereka. npm tidak akan.

Fakta terukur:

- **`peerDependencies` R3F 8.17.10 adalah `react ">=18.0"`.** React 19 **memenuhi** syarat itu. Jadi
  `npm install @react-three/fiber@8` **berhasil** di atas React 19. Ini bukan blocker install.
- **Konflik sebenarnya satu lapis lebih dalam.** R3F 8 menarik `react-reconciler@0.27.0`, yang peer-nya
  `react ^18.0.0`. npm 11 **tidak menggagalkan** install karena konflik itu — ia hanya menimpanya diam-diam dan
  tetap memasang.
- **Jadi ini ranjau runtime yang senyap, bukan blocker install.** Dan itu **lebih berbahaya** daripada blocker
  install, karena npm nyaris tidak memberi sinyal apa pun lalu aplikasinya pecah saat render: React 19 membutuhkan
  `react-reconciler@0.34`, bukan `0.27`.
- **Blocker yang nyata hari ini justru kebalikannya.** `@react-three/fiber@9` membatasi `react ">=19 <19.3"`,
  sementara `react ^19` resolve ke **19.3.0**. Versi 9 inilah yang gagal install, bukan versi 8.

**Peringatan untuk developer berikutnya:** tanpa catatan ini, orang akan menjalankan
`npm install @react-three/fiber`, melihat npm bilang "sukses", dan mendapat build yang rusak tanpa penjelasan apa pun
di log install.

**Bila 3D pernah dibutuhkan lagi**, resepnya:

1. Pin `react` dan `react-dom` ke **19.2.x** (turun dari 19.3.0).
2. Pakai `@react-three/fiber` **^9**.
3. Pakai `@react-three/drei` **^10**.

Untuk sekarang tidak ada yang perlu dilakukan: `three` + `@react-three/*` + `maath` memang sudah dibuang bersama
`FluidGlass.tsx` yang tidak diimpor siapa pun.

## Paket admin — diperiksa peer-nya, BELUM terbukti runtime

Paket berikut **tidak ikut di-render** dalam spike. Yang diperiksa hanya `peerDependencies`-nya, dan hasilnya
ter-resolve tanpa konflik. Itu bukti yang lebih lemah daripada tabel bukti runtime di atas, dan kejujuran itu ditulis
di sini supaya tidak ada yang mengira paket-paket ini sudah lulus dengan standar yang sama.

| Paket                      | Peer terhadap React             | Status bukti                        |
| -------------------------- | ------------------------------- | ----------------------------------- |
| `@dnd-kit/core` 6.3.1      | `react >=16.8.0`                | Ter-resolve, belum terbukti runtime |
| `@dnd-kit/sortable` 10.0.0 | mengikuti `@dnd-kit/core`       | Ter-resolve, belum terbukti runtime |
| `@dnd-kit/utilities` 3.2.2 | mengikuti `@dnd-kit/core`       | Ter-resolve, belum terbukti runtime |
| `@tiptap/react` 2.27.3     | peer **sudah memuat `^19.0.0`** | Ter-resolve, belum terbukti runtime |

Temuan penting pada baris terakhir: **TipTap 2 tidak memblokir React 19.** `@tiptap/react@2.27.3` sudah mencantumkan
`^19.0.0` di peer-nya, jadi **tidak ada major bump TipTap yang dipaksakan** oleh migrasi React 19. Jangan naikkan
TipTap ke major berikutnya dengan alasan React 19 — alasan itu tidak ada.

Pembuktian runtime untuk keempat paket ini menjadi bagian dari **Fase 7** (chrome admin) dan **Fase 8** (CRUD admin),
saat komponen yang memakainya sungguhan di-port.

## Keputusan pin

Laporan spike ini sempat dipakai untuk hal yang **bukan** kesimpulannya: menaikkan beberapa paket ke major terbaru
yang **tidak pernah diuji dalam spike**. Akibatnya `ubsc-admin` pecah.

| Paket                   | Sempat dinaikkan ke | Nilai yang benar |
| ----------------------- | ------------------- | ---------------- |
| `@tanstack/react-table` | 9                   | `^8.21.3`        |
| `react-day-picker`      | 10                  | `^9.14.0`        |
| `react-dropzone`        | 20                  | `^14.4.1`        |
| `maplibre-gl`           | 6                   | `^5.24.0`        |

**Pelajarannya:** _"versi latest" bukan jawaban yang sama dengan "versi yang kodenya sudah di-port"._ Spike ini
menjawab satu pertanyaan saja — apakah set dependency landing jalan di React 19 — dan angka yang sah dari spike ini
hanyalah yang ada di tabel [Versi exact yang ter-resolve](#versi-exact-yang-ter-resolve). Paket di luar tabel itu
belum diuji apa pun. Menaikkan major karena "sekalian saja" berarti mengganti API library di bawah kode yang ditulis
untuk API lama, dan itu pekerjaan port — bukan pekerjaan pin.

Aturan yang berlaku sejak sekarang: **naikkan major hanya bersama commit yang memport pemakaiannya**, dan sebutkan di
pesan commit-nya apa yang diport.

## Klaim CVE `maplibre-gl` 5.24.0 — TIDAK TERBUKTI

Laporan spike sempat menyebut ada **CVE kritis pada `maplibre-gl` 5.24.0**. Klaim itu **tidak terbukti**.

`npm audit` di `ubsc-landing` tidak melaporkan satu pun temuan pada `maplibre-gl`. Yang dilaporkan hanya **`postcss`
yang ter-bundle di dalam `next`** — bukan dependency langsung proyek ini, dan tidak bisa diperbaiki tanpa menaikkan
`next` ke **16**, yang breaking.

Kenaikan `next@16` **ditunda ke Fase 9** (hardening) dan dicatat sebagai utang di `docs/fase-0.md`.

Jangan pakai klaim CVE ini sebagai alasan menaikkan `maplibre-gl` ke major 6 — lihat bagian
[Keputusan pin](#keputusan-pin).

## Cara mengulang spike ini

Kalau suatu saat perlu diulang (misalnya saat React 20 muncul):

```bash
# 1. Hazard scan pada kode Laravel — ingat \b pada pola ref
cd "C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL/resources/js"
grep -rn 'defaultProps' .
grep -rn 'propTypes' .
grep -rn 'useLayoutEffect' .
grep -rnE '\bref="' .
grep -rlE 'forwardRef' .

# 2. Versi exact yang benar-benar ter-resolve (bukan range di package.json)
cd "C:/IT BMU/BMU-SYSTEM/UBSC/ubsc-landing"
npm ls --depth=0

# 3. Konflik peer yang disembunyikan npm pada lapisan transitif
npm ls react react-dom react-reconciler

# 4. Kerentanan
npm audit
```

Langkah 3 adalah yang menangkap kasus `react-reconciler` di atas. `npm install` yang "sukses" tidak membuktikan apa
pun tentang lapisan transitif.

## Dokumen terkait

- `docs/fase-0.md` — status deliverable Fase 0, gate, penyimpangan yang disengaja, dan daftar utang.
- `C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL/Rewrite.md` — dokumen rencana induk (baris R6 dan tabel dependency).
