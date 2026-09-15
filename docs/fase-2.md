# Fase 2 — Design system

Status: **SEDANG BERJALAN — gate BELUM bersih.** Fase 3 dimulai lebih dulu (API murni, tidak bergantung
design system — `Rewrite.md` mengizinkan keduanya paralel). **Fase 4 (landing slice) terblokir sampai
gate ini bersih.**

Gate menurut `Rewrite.md`:

> Route `/styleguide` sekali-pakai merender 33 keyframes + semua class `.ubsc-*`/`.entrance-*`/`.ah-*`/
> `.gym-traffic-*` + swatch, di-screenshot-diff lawan Laravel. **Jangan lanjut sebelum bersih.**

Harness yang dibangun jauh lebih ketat dari bunyi gate itu — lihat
[`ubsc-landing/tools/fidelity-harness`](../../ubsc-landing/tools/fidelity-harness/README.md).

---

## Yang sudah selesai

- **Font**: 9 berkas `.woff2` yang benar-benar dirujuk `@font-face` disalin ke `public/fonts/` kedua repo
  Next (396 KB). Tetap `@font-face` mentah, bukan `next/font` (21 berkas men-hardcode nama family).
- **Codemod `@tailwindcss/upgrade@4.3.3`** dijalankan di salinan scratch (repo Laravel tidak disentuh):
  config → CSS, `app.css` dimigrasi, 118 berkas TSX diubah.
- **Harness fidelity** (vonis pixel diff, diagnosis computed style) — 8.323 sel.
- **Kandidat CSS c2** — diukur di 1280px saja. Codemod apa adanya (c0, 3.979 sel tanpa korpus): 36 sel
  beda piksel. c2 dengan korpus nyata (8.592 sel): 69 sel beda piksel — angkanya naik karena korpus
  membuka permukaan yang tidak terlihat sebelumnya, dan sisa selisihnya kini hampir seluruhnya level
  markup (temuan 3–5), bukan CSS.

## Temuan — hal yang TIDAK diantisipasi `Rewrite.md`

Semua terukur di harness, bukan dugaan.

### 1. Bug codemod: `flex-shrink:` → `shrink:` di dalam `<style>` runtime

`@tailwindcss/upgrade` menulis ulang **properti CSS** `flex-shrink: 0;` menjadi `shrink: 0;` (tidak valid,
diabaikan browser tanpa error) di 11 deklarasi: `Pages/Admin/Dashboard.tsx` (5, termasuk style cetak
laporan), `Pages/Admin/Finance/Index.tsx` (5), `Pages/Admin/Identity/Index.tsx` (1). Tidak konsisten —
`Login.tsx`/`DaftarButton.tsx` dengan pola sama tidak disentuh. Sudah dipulihkan di sumber scratch.

### 2. Palet warna v4 bergeser dari v3

v4 mengganti nilai palet bawaan ke OKLCH. 104 utilitas warna UBSC keluar dari gamut sRGB (mis.
`amber-300` `rgb(252,211,77)` → `rgb(255,210,48)`), checkbox forms plugin `rgb(37,99,235)` → `rgb(21,93,252)`.
**Perbaikan**: seluruh palet v3 (hex) ditimpakan di `@theme`.

### 3. Urutan cascade v3 tidak bisa direproduksi persis oleh layer v4

Di CSS produksi Laravel: utilitas polos (baris 9.293) → CSS bespoke (13.300) → **varian** (`hover:`
14.275, `xl:` 18.716). v3 menaruh semua varian di akhir stylesheet, setelah CSS kustom. v4 mengeluarkan
utilitas polos dan varian dalam satu layer, jadi tidak ada penempatan yang menaruh bespoke _di antara_
keduanya.

**Keputusan**: CSS bespoke di `@layer utilities` setelah utilitas inti — spesifisitas tetap berlaku
seperti v3; yang berbeda hanya kasus seri spesifisitas bespoke vs **varian** (terukur: `ah-panel-img`),
ditangani koreksi markup.

### 4. Class yang mati di v3 tapi hidup di v4 — 61 token, 191 kemunculan

Ditulis developer tapi **tidak pernah menghasilkan CSS** di Laravel, sehingga efeknya tidak pernah tampil:

- Modifier opasitas di luar skala v3 (v3 hanya kelipatan 5): `border-white/18` ×19, `bg-white/14` ×13,
  `border-white/22` ×10, `bg-white/92` ×9, `text-white/78` ×7, `from-slate-950/76` (overlay gradien foto),
  dst.
- `delay-400` (skala v3: 75/100/150/200/300/500/700/1000), `z-100`, `perspective-[1000px]` (v3 tidak punya
  utilitas perspective).
- Class di `tokens.ts`: glob `content` v3 hanya memindai `*.tsx`.

Di v4 semuanya **tiba-tiba tampil**. Port yang setia menghapusnya (mesin koreksi R1).

> **Keputusan produk untuk Anda**: banyak di antaranya jelas efek kaca semi-transparan dan overlay foto
> yang _dimaksudkan_ desainer. Port setia = tampilan Laravel sekarang (efek tetap tidak ada). Kalau ingin
> efeknya tampil, cukup jangan terapkan R1 untuk token tertentu — tapi itu mengubah tampilan dari Laravel.

### 5. Line-height `text-*` berubah semantik

v4 memakai rasio tanpa satuan (`calc(1 / 0.75)`) dan membuat `leading-*` **selalu** menang lewat
`--tw-leading`. Di v3 rem absolut, dan varian `sm:text-4xl` mengalahkan `leading-tight` karena ditulis
belakangan. **Perbaikan**: `--text-*--line-height` bernilai rem v3 di `@theme` + koreksi markup R2 untuk
32 string tipografi responsif. (`@utility text-*` tidak bisa dipakai: v4 menggabungkannya dengan utilitas
inti dan menaruh deklarasi `--tw-leading` terakhir.)

### 6. Hazard lain yang terbukti dan diperbaiki di CSS

| Hazard                                       | v3                                 | v4                                                                           | Perbaikan                            |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Interpolasi gradien `bg-linear-to-*`         | sRGB                               | `in oklab`                                                                   | `@utility` 8 arah `in srgb`          |
| `ring` default                               | 3px biru-500/50%                   | currentColor                                                                 | `--default-ring-width/color`         |
| `drop-shadow` sm/md/lg/xl                    | dua lapis                          | nilai lain; dua lapis → `drop-shadow(a, b)` tidak valid → **`filter: none`** | `@utility` rangkaian `drop-shadow()` |
| Warna `prose`                                | gray-700 v3                        | plugin impor `tailwindcss/colors` v4 langsung, melewati `@theme`             | `--tw-prose-*` bernilai v3           |
| Cursor `<button>`, warna placeholder         | pointer, gray-400                  | default, currentColor 50%                                                    | kompat preflight                     |
| Padding `td`/`th`                            | UA 1px                             | 0 (reset universal v4)                                                       | kompat preflight                     |
| `type="search"` (DataTable, Topbar, CheckIn) | `appearance: textfield`            | `none`                                                                       | kompat preflight                     |
| `::file-selector-button`, latar input range  | UA                                 | di-reset                                                                     | kompat preflight                     |
| `.maplibregl-popup-*` `@apply ...!`          | **mati** — 0 rule di build Laravel | hidup                                                                        | di-comment (sesuai `Rewrite.md`)     |

### 7. Klaim `Rewrite.md` yang perlu dikoreksi

- **"tailwindcss-animate dihapus"** — dipakai: `animate-in fade-in-0 zoom-in-95` di `Landing/map.tsx`.
  Dipertahankan sebagai `@plugin`.
- **`@tailwindcss/forms` tidak disebut sama sekali** — aktif dan me-reset semua input. Dipertahankan.
- **"seluruh delta tercakup `npx @tailwindcss/upgrade`"** — tidak; lihat temuan 1–5. Codemod hanya
  memasang satu dari tiga blok kompat preflight yang disebut dokumen (warna border).

## Yang tersisa sebelum gate bersih

1. Paginasi sel harness supaya viewport **390px** dan **768px** bisa diukur (sekarang timeout di 390px).
2. Terapkan mesin koreksi (`corrections.mjs --apply`: R0 rename `.ts`, R1 class mati, R2 tipografi,
   R3 manual) ke sumber scratch, lalu jalankan ulang harness di ketiga viewport.
3. Konflik seri bespoke vs varian: analisis statis penuh (walker tidak memicu `hover:`/`focus:`).
4. Pecah kandidat c2 menjadi berkas final di kedua repo Next (`globals.css` + kompat + bespoke via
   `@import … layer(utilities)`), verifikasi output kompilasinya identik dengan c2.
5. `ubsc-admin`: fondasi yang sama **tanpa** CSS bespoke landing (admin merujuk 0 class bespoke; blok
   `:root` bespoke hanya kurva easing hero landing).
6. Route `/styleguide` di `ubsc-landing` sebagai gate resmi, lalu hapus.
7. `cn()` (`tailwind-merge@3` vs `^2` Laravel) dan paritas output `format.ts` vs format di TSX Laravel
   (spasi vs NBSP pada `Rp`) — belum diperiksa.

Cara menjalankan ulang: `ubsc-landing/tools/fidelity-harness/pipeline.sh` (sesuaikan path dulu).
