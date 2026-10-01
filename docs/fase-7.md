# Fase 7 — Admin chrome + staff auth

Padanan baris **Fase 7** tabel "Fase pengerjaan" di `Rewrite.md`: *Sidebar + Topbar + AuthGuard +
`config/permissions.ts` + `/login` + `/unauthorized` + Dashboard*. Kriteria kelulusan: **login sebagai
kelima role staff; badge "Locked" persis sama dengan aplikasi lama.**

Fase ini menyentuh dua repo: `ubsc-api` (endpoint dashboard, Fase 7-API) dan `ubsc-admin` (seluruh
chrome + halaman, Fase 7-FE). Keputusan user: **Dashboard di-port penuh 1:1 + endpoint API-nya dibangun**;
hanya operasi TULIS Info-Banner + gym-traffic yang ditunda ke Fase 8.

## Ringkas yang dibangun

### ubsc-api (Fase 7-API)
- `GET /api/admin/dashboard` — kartu statistik, tren pendapatan, pendapatan harian, okupansi lapangan
  hari ini, feed aktivitas, gym traffic, info banner. Padanan controller inline `Route::get('/')` Laravel.
  - `src/services/dashboard-services.ts`, `src/controller/dashboard-controller.ts`,
    `src/routes/details/admin-dashboard.ts`, di-mount di `src/routes/private-api.ts`.
  - `DashboardDto` (+ `DashboardStatsDto`, `OccupancyFacilityDto`, `RecentActivityDto`, `InfoBannerDto`)
    ditambahkan ke `shared/contracts.ts`, disalin ke kedua repo Next lewat `sync:contracts`.
  - **TANPA `requirePermission`.** Route dashboard Laravel hanya di grup role staff tanpa gate permission —
    kelima role mendarat di dashboard. Gate `stats.read` hanya menyembunyikan kartu di FE (sama seperti
    Laravel), bukan memblokir endpoint. Hanya `staffAuthRequired` (level router) yang berlaku. Ini WAJIB
    agar Staff Central / Staff Front Office (tanpa stats.read) tetap bisa login & mendarat.
  - Waktu SELALU Jakarta (R13) lewat `clock.ts`; batas bulan untuk `paidAt` (instan) dihitung
    `jakartaWallTimeToUtc(...,'00:00')`, bukan `dateOnly()`, supaya pembayaran di jam tepi bulan tidak
    salah 7 jam. `currentMonthLabel` = `translatedDate('M Y')` ("Sep 2026"). Okupansi memakai
    `blocking()` dari `availability-services` (sumber okupansi kanonik).

### ubsc-admin (Fase 7-FE)
- **Foundation / RBAC reconcile** — `config/permissions.ts` sebelumnya katalog boilerplate PALSU
  (`dashboard.read`/`account.read`, role `Admin`/`Staff`) yang tidak cocok backend, dan **tidak ada yang
  mengimpor** kontrak asli. Ditulis ulang: re-export dari `types/contracts/permissions.ts` (16 permission,
  5 role) + helper FE (`can`/`hasRole`/`createAccessChecker`/`canAccessPathByRole` + peta path→permission
  diturunkan dari gate menu Sidebar).
- **`middleware.ts`** — dulu hanya menjaga `['/dashboard','/settings']` sementara dashboard ada di `/`.
  Sekarang: `/login` = tamu; segala route lain butuh sesi; `/unauthorized` boleh dibuka saat login;
  route lain dicek `canAccessPathByRole`.
- **Login envelope bug** — `services/Auth.ts` `login()` membaca `response.data` langsung padahal API
  membungkus `{ success, data }` → `accessToken` selalu `undefined` (tertutup oleh `/refresh`). Diperbaiki
  unwrap `response.data.data`.
- **Chrome (port 1:1 dari Laravel):**
  - `components/layout/AdminLayout.tsx` — shell RANGKA saja (Sidebar + kolom-scroll + Topbar). Dipasang di
    `(protected)/layout.tsx` supaya TIDAK re-mount saat navigasi (collapse sidebar + scroll bertahan).
    Slot `header` Laravel tak bisa dioper per-halaman di App Router, jadi SETIAP halaman merender sendiri
    `div header` + `<main>` PERSIS seperti yang dulu dibungkus AdminLayout.
  - `components/admin/Sidebar.tsx` (+ `sidebar.css`) — 16 menu, grup Main/Content/Settings/Other, **badge
    Locked** (item tak berizin tetap tampil, abu-abu + pill "Locked" + tooltip "Akses belum diberikan oleh
    Administrator"), collapse `localStorage("sb_collapsed")`, scroll `sessionStorage`, drawer mobile.
    Gate memakai dot-code (kebab Laravel dipetakan via LARAVEL_PERMISSION_MAP). Administrator bypass.
  - `components/admin/Topbar.tsx` + `ProfileModal.tsx` — search palette ⌘K, notification center, menu
    profil. Notifikasi (`admin.notifications.*`) + simpan profil staf INERT (endpoint Fase 8, gagal anggun).
  - `features/auth/login/page/Index.tsx` (+ `login.css`) — portal login staf (gradient terracotta, grain,
    grid, glow, LiveClock, kartu glass). Logika form dari `useLogin` + RHF + returnUrl yang sudah jalan.
  - `components/errors/Forbidden.tsx` — 403 split-panel; dipasang di `(protected)/unauthorized/page.tsx`
    sehingga tampil BERSAMA chrome (setara cabang staff Laravel yang membungkus AdminLayout).
  - `features/(protected)/dashboard/page/Index.tsx` (+ `dashboard.css`) + `components/admin/SortableListItem.tsx`
    — Dashboard 1:1 disuapi `useDashboard()` (TanStack Query → `/api/admin/dashboard`). TULIS Info-Banner
    (tambah/edit/hapus/urut dnd-kit) + gym-traffic PUT INERT (Fase 8).
- **Placeholder Fase 8** — `components/ComingSoon.tsx` + 17 halaman stub `(protected)/<route>` untuk route
  yang ditautkan Sidebar/Topbar tapi halaman aslinya baru dibuat Fase 8. Membuat `<Link>` chrome lolos
  `typedRoutes` (routes.ts melarang melonggarkan tipe) tanpa 404. Fase 8 mengganti tiap stub.
- Aset disalin ke `public/`: `UBSC PRO.png` (sidebar/login), `BES.png` (template cetak laporan dashboard).

## Verifikasi (dijalankan)

| Cek | Perintah | Hasil |
| --- | --- | --- |
| tsc ubsc-api | `npx tsc --noEmit` (ubsc-api) | **0 error** |
| Build admin | `next build` (ubsc-admin) | **exit 0**, 25 route; `/` 183 kB, `/login` 176 kB, middleware 35.7 kB |
| Paritas className | `verifyAdmin.js` (himpunan token, transform v3→v4) | **identik**: Sidebar 185/185, Topbar 279/279, ProfileModal 200/200, Forbidden 118/118, SortableListItem 22/22; Dashboard identik kecuali 4 token wrapper AdminLayout (`pt-2 xl:px-8 max-w-full pb-10`) yang SENGAJA dipindah ke halaman |
| API end-to-end | `POST /api/auth/staff/login` → `GET /api/admin/dashboard` (Bearer) | **200**; data nyata (9 fasilitas, Rp 865.000, "Sep 2026", 5 lapangan okupansi, 8 aktivitas, 3 banner) |
| Render login | browser :3001/login | **1:1**, LiveClock jalan, 0 error console (hydration LiveClock diperbaiki dgn mount-guard) |

Akun seed (password `password123`): `admin@ubsc.id` (Administrator), `manager@ubsc.id` (Manager),
`finance@ubsc.id` (Finance), `stafffo@ubsc.id` (Staff Front Office), `staffcentral@ubsc.id` (Staff Central).

## Catatan & penyimpangan (jujur)

1. **Feed aktivitas — urutan.** Laravel `->sortByDesc('time')` mengurutkan STRING "…yang lalu"
   (string-sort, tidak kronologis — bug laten). Di sini diurut **kronologis DESC** (perilaku yang
   dimaksud) berdasar timestamp asli. Ini penyimpangan sengaja dari "logika 1:1"; hasilnya feed yang benar.
2. **Render terautentikasi belum dikonfirmasi di browser oleh Claude.** Aturan operasional Claude melarang
   mengetik password ke form login. Dashboard + Sidebar (badge Locked) terverifikasi lewat build + paritas
   className + API, TAPI belum discreenshot login. User bisa login (akun seed) untuk melihatnya.
3. **Warning lint (bukan error) di Dashboard** — dead code dipertahankan 1:1 dari sumber Laravel (impor
   `Coins/Ticket/Star`, fungsi `PremiumStatCard`/`smoothBezierPath`, beberapa var lokal tak terpakai).
   Build tetap hijau. Pembersihan = Fase 8 (R19).
4. **Gate `/settings/roles` & `/settings/users`** di-port SESUAI Laravel (tanpa gate FE, selalu aktif).
   Permission baru `rbac.manage`/`users.manage` di-enforce di SERVER saat route-nya dibangun (Fase 8).

## Belum (Fase 8)

Endpoint tulis yang UI-nya sudah memanggil (semua diberi `// TODO Fase 8`): `PUT /api/admin/settings/gym-traffic`,
`POST/PUT/DELETE /api/admin/info-banners`, `admin.notifications.*`, update profil staf. Plus seluruh halaman
CRUD admin (facilities, bookings, memberships, finance, CMS, settings) yang kini stub `ComingSoon`.

## Status

**Fase 7 (API + chrome + Dashboard) selesai & terbukti** (build hijau, paritas className identik, API
data nyata). Git belum disentuh (permintaan user). Gate fidelity resmi (`/styleguide` pixel/DOM-diff)
belum dijalankan — verifikasi baru paritas className + render login.
