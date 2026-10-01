# Fase 6 — Area customer (SELESAI)

Cakupan sesuai Rewrite.md: `/booking` (grid + Class/*), `/riwayat-booking`, `/booking/[id]/pembayaran`,
identity, review, profil. 16 berkas frontend + 11 endpoint customer. Paritas className 16/16 identik.

## Temuan yang memangkas pekerjaan

**Mesin booking-nya sudah ada sejak Fase 3.** `POST /api/customer/booking` (12 langkah), `GET
/api/customer/booking` (riwayat), `GET|POST .../pembayaran[/bukti]`, `GET /api/customer/payments/:id/bukti`,
plus `/api/public/booking/{slots,month}` — semuanya sudah terbangun dan teruji. Fase 6 tidak membangun
ulang satu pun.

## API yang ditambahkan

| Method | Path | Catatan |
|---|---|---|
| GET | `/api/public/booking/facilities` | `BookingFacilityDto` = FacilityDto + `units`. HANYA jalur ini yang eager-load `units.media` di Laravel; `/facilities` dan `/pricing` tidak. |
| GET | `/api/public/booking/reviews` | ulasan disetujui + authorName/authorDate/avatar |
| GET | `/api/customer/reviews/eligibility` | `canReview` + `existingReview` |
| POST | `/api/customer/reviews` | updateOrCreate per user; SELALU reset `isApproved: false` |
| GET | `/api/customer/transactions` | 20 terbaru; tanpa gate `verified` (1:1 `withoutMiddleware('verified')`) |
| GET | `/api/customer/pending-payment` | badge Navbar; port `HandleInertiaRequests::pendingPayment` |
| GET/POST | `/api/customer/profile` | POST multipart (avatar) |
| PUT | `/api/customer/password` | sengaja tanpa `denyStaffAccounts`/`verified` — grup Laravel-nya memang `auth` saja |
| POST | `/api/customer/identity` | multipart, `identityLimiter` 5/menit |
| DELETE | `/api/customer/profile` | |

**Router baru WAJIB di atas `/api/public/booking`** yang lama: keduanya berbagi prefix, dan aturan
cache/auth-nya berlawanan (yang lama `customerAuthOptional` + `private, no-store` karena harga
bergantung pemanggil; yang baru tanpa auth + cache bersama). Sudah diverifikasi `/slots` dan `/month`
tetap terjangkau setelah mount baru.

**Dipakai ulang dari 8G:** seluruh pipeline avatar, hashing, dan pagar hapus-akun diimpor dari
`staff-profile-services.ts` — bukan disalin. Nama fungsinya menyebut "Staff" karena layar itu yang
melahirkannya, tapi isinya tidak pernah melihat role. **Pekerjaan terpisah yang tercatat:** ekstrak
keempatnya ke `account-profile-services.ts` yang netral audience.

**Dokumen identitas** disimpan `storage/private/identity/<userId>/<stem>.<ext>` lewat `resolvePrivate()`
— akar dan pagar path-traversal yang SAMA dengan pembaca 8E (`GET /api/admin/identity/:id/document`),
jadi kedua sisi tidak bisa melenceng. Gambar di-encode ulang (EXIF/GPS pada foto KTM tidak pernah
sampai disk); PDF diperiksa magic bytes lalu disimpan apa adanya.

## Frontend (ubsc-landing)

16 berkas: `/booking` + 8 komponen section, 6 komponen picker kelas + UnitPicker, `/riwayat-booking`,
`/booking/[id]/pembayaran`. Plus `src/lib/calendar.ts` dan `src/components/booking/class/types.ts`
(alias tipis di atas DTO kontrak, bukan sumber kebenaran kedua).

**Batas RSC/client yang menjaga ISR 600s `/booking`:** halaman adalah Server Component yang hanya
mengambil data PUBLIK (`getBookingFacilities()`, `getApprovedReviews()`, masing-masing try/catch
terpisah). Semua yang per-user — kelayakan ulasan, pilih slot, submit booking — ada di client leaf
dengan `enabled: !!user`. Tidak ada `useSearchParams()` di subtree ini.

**Sisa Fase 4 kini hidup:** `ProfileModal` customer (profil/password/identitas), `PaymentHistoryModal`,
dan badge pembayaran tertunda di Navbar — ketiganya dulu menembak endpoint yang belum ada. Field
form-nya diubah snake_case → camelCase mengikuti kontrak, dan tipe lokal `TransactionItem`/`ProfileUser`
diganti DTO asli.

## Penyimpangan yang disengaja

1. **Halaman pembayaran TIDAK menampilkan bukti tersimpan.** Instruksi awal saya meminta itu; ternyata
   keliru. Laravel `Pages/Bookings/Payment.tsx` nol rujukan ke `proof_url` — yang ada hanya pratinjau
   `URL.createObjectURL(file)` dari berkas yang baru dipilih. Menambahkannya = menambah DOM di luar
   sumber. Endpoint stream bukti tetap ada dan dipakai panel admin.
2. **Hapus akun customer ditolak 422 bila masih punya jejak** (booking/transaksi/ulasan/membership),
   sama seperti staf di 8G. **Konsekuensi produk:** customer yang pernah memesan sekali tidak akan
   pernah bisa menghapus akunnya lewat endpoint ini. Disengaja — menganonimkan riwayat pembayaran jauh
   lebih buruk. Untuk benar-benar bisa, skema perlu soft delete atau akun sistem penampung.
3. **`emailVerifiedAt` absen dibaca sebagai SUDAH terverifikasi** di `AuthGate`. `/me` tidak
   membawanya, dan ubsc-api sendiri menolak login customer yang belum verifikasi — membacanya sebagai
   `false` akan mengunci semua orang di layar verifikasi dan mematikan seluruh alur booking.
4. **Toast sukses setelah booking dibuat hilang.** Laravel mem-flash "Reservasi dibuat..."; di sini
   pengguna langsung didorong ke halaman pembayaran. `FLASH_MESSAGES` di `FlashToast` masih kosong —
   menambah satu kode flash di sana akan mengembalikannya.
5. **Quirk Laravel dipertahankan:** salah tulis `sm   :px-10` (dua token mati) di BookingSection;
   `max-w` telanjang dan `max-w-8xl`; gate tiga-cabang di `BookingListItem` tetap inline alih-alih
   memakai `<AuthGate>` (Laravel pun menyalinnya).

## Verifikasi

- **Paritas className 16/16 IDENTIK** (`verifyClass.js`), plus Navbar dicek ulang setelah disambungkan
  dan tidak bergeser. Satu selisih awal ternyata false positive: komentar penjelas di `BookingListItem`
  mengutip `className="mt-3 …"` dan ikut terpindai — komentarnya diubah, bukan kodenya.
- tsc api + landing 0, eslint 0 error, `next build` exit 0 (`/booking` ISR 10m, `/booking/[id]/pembayaran`
  dinamis, `/riwayat-booking` statis-klien).
- API vs DB nyata: fasilitas booking 9 baris dengan units; ulasan disetujui 2 baris; `/slots` & `/month`
  masih terjangkau; endpoint customer 401 tanpa login. **Alur ulasan terbukti end-to-end:** akun baru
  → `canReview:false` dan POST ditolak 403 dengan pesan persis Laravel → setelah punya booking selesai
  → `canReview:true` → simpan → **tidak muncul di daftar publik** (menunggu approve) → simpan lagi
  memperbarui baris yang sama, bukan duplikat. Profil, password salah (422), dan hapus akun (422
  berisi rincian) juga terbukti.
- Render `/booking` diperiksa di browser: 5 nama fasilitas dan teks ulasan dari database tampil, nol
  gambar rusak, nol empty-state.
- Seluruh data uji dihapus; DB kembali 3 ulasan / 20 booking.

## Catatan proses

Empat dari lima agen gelombang pertama mati karena watchdog infrastruktur (macet 600 detik), bukan
kesalahan tugas. Pekerjaan yang sempat mendarat diselamatkan dan diverifikasi; sisanya dijalankan ulang
dengan instruksi menulis berkas bertahap. Dua berkas route dan endpoint `pending-payment` ditulis
langsung, bukan lewat agen.

## Status

Fase 6 selesai. **Seluruh fase inti (0–8) tuntas.** Git belum disentuh.
Tersisa Fase 9 (hardening: diet aset 170 MB → <8 MB, rate limiting menyeluruh, paginasi list admin,
JSON-LD, audit prefers-reduced-motion, Lighthouse) dan Fase 10 (deploy VPS).
