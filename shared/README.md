# `shared/` — kontrak antar repo UBSC

Folder ini adalah **satu-satunya tempat kontrak ditulis**. Tiga repo harus tetap sinkron
(`ubsc-api`, `ubsc-landing`, `ubsc-admin`) dan tidak ada workspace npm di antara mereka,
jadi tidak ada paket `@ubsc/contracts` yang bisa di-`import`. Yang ada: satu sumber
kebenaran di sini, dan salinan otomatis di kedua repo Next.

| File             | Isi                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `contracts.ts`   | Envelope respons, `ErrorCode`, dan seluruh DTO. Murni tipe, tanpa nilai runtime.            |
| `permissions.ts` | 16 permission, matriks 5 role staff, helper role. Reproduksi `RoleAndPermissionSeeder.php`. |
| `format.ts`      | Rupiah, tanggal, dan jam Indonesia. Satu implementasi, `Asia/Jakarta` eksplisit.            |
| `seo.ts`         | Daftar halaman statis landing yang SEO-nya diatur admin + default judul/deskripsi + batas.  |

## Aturan

1. **Tulis di sini dulu, baru di tempat lain.** Menambah DTO, permission, atau formatter
   dimulai dari folder ini, bukan dari service API atau komponen FE.
2. **Jangan pernah mengedit salinannya.** Di kedua repo Next, folder tujuan adalah
   `src/types/contracts/` dan setiap file di sana diawali penanda
   `// AUTO-GENERATED — jangan edit tangan`. Edit di sana akan tertimpa pada sinkronisasi
   berikutnya, dan sampai saat itu tipe-nya berbohong.
3. **Salinan tetap di-commit.** Build kedua repo Next tidak boleh butuh akses ke repo API.

## Cara menyalin

Di `ubsc-landing` dan `ubsc-admin`:

```bash
npm run sync:contracts
```

Script itu menyalin `ubsc-api/shared/` (dari path lokal, atau `curl` dari raw git) ke
`src/types/contracts/`, menempelkan penanda AUTO-GENERATED, lalu menjalankan `tsc --noEmit`.
Gagal `tsc` berarti salinan baru memutus kode yang sudah ada — itu memang tujuannya:
kerusakan muncul saat sinkronisasi, bukan di runtime produksi.

## Penjaga drift: `GET /api/meta/contract-hash`

Endpoint itu mengembalikan sha256 deterministik atas isi folder ini
(`src/utils/contract-hash.ts`; urut nama file, newline dinormalisasi ke LF, sehingga hash
Windows dan Linux sama). Saat boot **dev**, kedua app Next membandingkannya dengan hash
salinan lokalnya dan `console.warn` bila berbeda.

Tanpa itu, mode gagal drift kontrak bersifat **diam**: API menambah field, satu app Next
lupa disalin, TypeScript tetap hijau karena salinannya konsisten dengan dirinya sendiri,
dan kesalahannya baru muncul sebagai `undefined` di layar user (R12). Hash ini yang
mengubahnya jadi satu baris peringatan di terminal.

Cek manual, dari root `ubsc-api`:

```bash
npm run contract:hash
```

## Yang SENGAJA tidak di-share: Zod schema request

Schema validasi request diduplikasi antara API dan FE, dan itu keputusan sadar — bukan
utang teknis:

- **API memvalidasi untuk keamanan.** Ia tidak pernah percaya klien, dan ia satu-satunya
  yang bisa mengecek keunikan email atau ketersediaan slot.
- **FE memvalidasi untuk UX.** Ia perlu mengecek konfirmasi password sebelum request dikirim,
  sesuatu yang tidak ada artinya di level field API.

Aturannya memang tidak sama di kedua sisi. Men-share-nya akan memaksa satu aturan yang salah
untuk keduanya. Boilerplate sudah memisahkan ini, dan di sini dipertahankan.

## Biayanya, ditulis terang-terangan

**Menambah satu field DTO = tiga commit.** Satu di `ubsc-api` (file ini + service yang
mengisinya), satu di `ubsc-landing`, satu di `ubsc-admin` — dua terakhir hasil
`npm run sync:contracts`. Itu harga kemerdekaan tiga repo dengan deploy terpisah. Pada tim
sekecil ini biasanya sepadan, tapi jangan berpura-pura biayanya nol: kalau tiga commit itu
mulai terasa berat setiap hari, sinyalnya adalah pindah ke workspace, bukan menyalin kontrak
dengan tangan.
