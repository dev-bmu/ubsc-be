# Media dan aset berat (R9)

Kebijakan penyimpanan aset besar untuk ketiga repo UBSC. Dokumen ini mengikat: berkas yang jatuh dalam kategori
"media" **tidak pernah masuk git**, di repo mana pun.

Semua ukuran di dokumen ini diverifikasi langsung terhadap `C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL/public`
pada 11 September 2026 dengan `du` dan `ls`. Angka yang berbeda dari dokumen rencana dicatat di bagian
[Koreksi angka](#koreksi-angka).

## Masalah

`public/` aplikasi Laravel berisi **177.346.275 byte (169,1 MiB)**, dan **146.590.275 byte (139,8 MiB)** di antaranya
adalah satu folder video: `assets/reels`. Lima berkas `reels ubsc 1..5.mp4` sendirian menyumbang
**133.308.115 byte (127,1 MiB)**.

Dua akibatnya, dan keduanya permanen kalau dibiarkan masuk git:

1. **Bloat repo.** Git menyimpan setiap versi berkas biner secara utuh. Sekali 140 MB video masuk riwayat,
   setiap clone berikutnya membawanya selamanya — menghapusnya di commit berikutnya tidak mengurangi apa pun.
   Dengan tiga repo, kesalahan ini bisa terulang tiga kali.
2. **Nama berkas berspasi.** Ada **17 berkas** dengan spasi di namanya. Spasi menjadi `%20` di URL, dan `%20`
   merusak cache key CDN (satu berkas bisa punya dua entri cache yang berbeda) serta rapuh di dalam `url()` CSS.

## Pendekatan

| Keputusan                                   | Isi                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Media tidak masuk git**                   | `.gitignore` di ketiga repo memblokir direktori media. Yang ikut git hanyalah aset ringan yang benar-benar bagian dari desain (ikon SVG kecil, favicon)                                                                                                                            |
| **Disimpan di direktori bersama di server** | Satu direktori di luar ketiga checkout git, yaitu bucket R2 publik (folder `reels/`), disajikan langsung sebagai `cdn.ubsportcenter.co.id`; tidak ada proses Node yang ikut menyentuhnya                                                                                           |
| **Di-sync dengan rsync**                    | `ops/scripts/sync-media.sh push` dan `pull`. rsync hanya memindahkan selisihnya, jadi menambah satu gambar tidak berarti mengunggah ulang 140 MB                                                                                                                                   |
| **Manifest ter-commit**                     | `ops/media-manifest.txt` berisi nama berkas + sha256 + ukuran untuk setiap berkas media. Berkas inilah yang ikut git, bukan medianya. Dengan begitu isi direktori media bisa **diverifikasi**: berkas hilang, berkas tambahan, dan berkas yang berubah diam-diam semuanya ketahuan |

Manifest adalah inti kompromi ini. Tanpa manifest, "media di luar git" berarti tidak ada yang tahu isi direktori itu
seharusnya apa, dan tidak ada cara membuktikan bahwa server produksi memegang berkas yang sama dengan mesin
pengembangan. Dengan manifest, riwayat git tetap mencatat setiap perubahan media — hanya isinya yang tidak ikut.

### Tata letak

```
/var/www/ubsc/media/             # direktori bersama di server (di luar semua checkout git)
├── reels/                       # video
├── hero/                        # gambar hero
├── images/                      # gambar konten statis
└── icons/                       # ikon dan logo partner

ubsc-api/ops/media-manifest.txt  # IKUT git — nama + sha256 + ukuran
ubsc-api/ops/scripts/sync-media.sh
```

Upload dari user (bukti bayar, dokumen identitas, gambar CMS) **bukan** urusan dokumen ini. Itu tinggal di
`ubsc-api/uploads/` dan `ubsc-api/storage/private/`, sudah di-`.gitignore`, dan punya siklus hidupnya sendiri lewat
tabel `media`.

### Manifest

Format satu baris per berkas, dipisah spasi ganda, diurutkan berdasarkan path supaya diff-nya bisa dibaca manusia:

```
<sha256>  <ukuran-byte>  <path relatif terhadap direktori media>
```

```bash
ops/scripts/sync-media.sh manifest    # buat atau perbarui manifest dari isi direktori media
ops/scripts/sync-media.sh verify      # bandingkan isi direktori media dengan manifest, laporkan selisihnya
ops/scripts/sync-media.sh push        # rsync direktori media lokal ke server
ops/scripts/sync-media.sh pull        # rsync dari server ke lokal
```

Alur yang benar saat menambah atau mengganti media: taruh berkasnya di direktori media lokal, jalankan `manifest`,
**commit perubahan manifest**, lalu `push`. Manifest yang di-commit belakangan setelah push membuat jejaknya hilang.

Catatan Windows: `rsync` tidak ada di Git Bash bawaan. Jalankan `push`/`pull` dari WSL, dari Git Bash yang sudah
dipasangi rsync, atau langsung di server. `manifest` dan `verify` hanya butuh `sha256sum` dan jalan di mana saja.

## Aturan rename: kebab-case, tanpa spasi

**Setiap berkas yang namanya mengandung spasi di-rename kebab-case pada saat dipindahkan.** Sekali, di awal, bukan
bertahap — nama campur adalah sumber bug yang paling mahal untuk ditemukan belakangan.

```
reels ubsc 1.mp4   ->  reels-ubsc-1.mp4
tennis vid.mp4     ->  tennis-vid.mp4
thumbnail 1.avif   ->  thumbnail-1.avif
UBSC PRO.png       ->  ubsc-pro.png
```

Alasannya bukan estetika: spasi menjadi `%20` di URL, dan `%20` merusak cache key CDN serta rapuh di dalam `url()`
CSS. Aturan turunannya: **huruf kecil semua**, hanya `a-z0-9-`, tanpa spasi, tanpa huruf kapital.

Ketujuh belas berkas berspasi di `public/` Laravel:

| Berkas                                        | Nasib                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `assets/reels/reels ubsc 1..5.mp4` (5 berkas) | Dipindahkan dan di-rename `reels-ubsc-1..5.mp4`; **di-re-encode di Fase 9** dan dipindah ke CDN                                            |
| `assets/reels/tennis vid.mp4`                 | Dipindahkan dan di-rename `tennis-vid.mp4`                                                                                                 |
| `assets/reels/thumbnail 1..5.avif` (5 berkas) | Dipindahkan dan di-rename `thumbnail-1..5.avif` — **versi AVIF inilah yang dipakai**                                                       |
| `assets/reels/thumbnail 1..5.png` (5 berkas)  | **Dihapus** — lihat tabel di bawah                                                                                                         |
| `UBSC PRO.png` (105.327 byte)                 | Dipakai (2 referensi di `resources/`). Di-rename `ubsc-pro.png`. **Tidak disebut dokumen rencana**, tetapi terkena aturan rename yang sama |

## Aset yang dihapus, tidak di-port

Dari bagian "Yang dihapus, tidak di-port" dokumen rencana. Kolom "Referensi" adalah hasil `grep` terhadap
`resources/` aplikasi Laravel (`.tsx`, `.ts`, `.css`, `.blade.php`) pada tanggal verifikasi.

| Berkas                                     | Ukuran terverifikasi        | Referensi | Catatan                                                                                                                                                     |
| ------------------------------------------ | --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubsc-tab.svg`                             | 1.652.752 B (1,65 MB)       | 0         | SVG raksasa, kemungkinan hasil trace bitmap                                                                                                                 |
| `ubsc.svg`                                 | 472.780 B (473 KB)          | 0         | Versi PNG-nya (`ubsc.png`, 10.594 B) yang dipakai di 4 berkas                                                                                               |
| `ubsc-blue.svg`                            | 472.550 B (473 KB)          | 1         | Satu-satunya pemakainya adalah `MembershipModal.tsx`, yang **ikut dihapus** sebagai komponen mati. Yang dipakai AuthModal adalah `ubsc-blue.png` (38.027 B) |
| `BMU.svg`                                  | 372.592 B (373 KB)          | 0         | `BMU.png` (25.113 B) yang dipakai                                                                                                                           |
| `assets/hero/Bottom.png`                   | 1.921.030 B (1,92 MB)       | 0         | Hero sekarang memakai `Hero.avif` (675.840 B, 2 referensi)                                                                                                  |
| `assets/hero/Top.png`                      | 1.559.794 B (1,56 MB)       | 0         | idem                                                                                                                                                        |
| `assets/reels/sg.mp4`                      | 2.215.512 B (2,22 MB)       | 0         |                                                                                                                                                             |
| `assets/reels/thumbnail 1..5.png`          | 4.045.843 B total (4,05 MB) | 0         | Versi `.avif`-nya (153.487 B untuk kelimanya) yang dipakai                                                                                                  |
| `fonts/*.otf` dan `fonts/*.ttf` (9 berkas) | 864.972 B total (865 KB)    | 0         | Seluruh 11 deklarasi `@font-face` di `app.css` menunjuk `.woff2`. `.otf`/`.ttf` adalah berkas sumber, bukan aset web                                        |

Total sembilan baris di atas: **13.577.825 byte (12,95 MiB / 13,58 MB)**.

### Pengecualian: `BES.png` DIPAKAI

| Berkas    | Ukuran terverifikasi  | Referensi |
| --------- | --------------------- | --------- |
| `BES.png` | 5.147.441 B (5,15 MB) | 2         |

**Jangan dihapus.** Berkas ini dipakai sebagai **logo partner berukuran kecil** — 5 MB untuk sesuatu yang dirender
beberapa ratus piksel. Yang harus dilakukan: **re-export ke maksimal 30 KB** (PNG ter-optimasi atau WebP, ukuran
piksel disesuaikan dengan ukuran render sebenarnya dikali 2 untuk layar retina), lalu ganti berkasnya. Ini
penghematan terbesar per satuan usaha di seluruh daftar: satu berkas, satu ekspor ulang, sekitar 5,1 MB hilang.

### Kandidat tambahan yang ditemukan saat verifikasi

Tidak ada di dokumen rencana, ditemukan saat mengukur ulang. **Verifikasi pemakaiannya sekali lagi sebelum
menghapus** — khususnya apakah ada `<picture>` dengan fallback PNG yang tidak tertangkap `grep` nama berkas.

| Berkas                                                    | Ukuran      | Referensi | Catatan                                             |
| --------------------------------------------------------- | ----------- | --------- | --------------------------------------------------- |
| `assets/images/ub-sport-center-gym-enterence.png`         | 2.772.041 B | 0         | Versi `.avif`-nya 129.933 B dan itu yang dipakai    |
| `assets/images/ub-sport-statistic-data.png`               | 2.555.206 B | 0         | Versi `.avif`-nya 87.701 B                          |
| `assets/images/ub-sport-enterence.png`                    | 835.792 B   | 0         | Versi `.avif`-nya 11.838 B                          |
| `assets/images/gym-konten-1-olahraga-ub-sport-center.png` | 192.819 B   | 0         | Ada juga `.webp` (117.336 B) dan `.avif` (27.487 B) |

Total: **6.355.858 byte (6,06 MiB / 6,36 MB)** yang tidak satu pun disebut di kode. Jumlah ini besar relatif terhadap
target Fase 9 (`public/` di bawah 25 MB, diet aset ke bawah 8 MB), jadi layak dikerjakan lebih awal.

`public/build/` (6,1 MiB) adalah keluaran Vite dan tidak ikut di-port sama sekali — Next punya pipeline build sendiri.

## Koreksi angka

Tiga angka di dokumen rencana berbeda dari hasil pengukuran. Dokumen rencana tidak diubah; koreksinya dicatat di sini.

| Klaim dokumen rencana                        | Hasil pengukuran                                    | Keterangan                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| font `.otf`/`.ttf` sekitar **944 KB**        | **864.972 B = 845 KiB = 865 KB**                    | Selisihnya sekitar 80 KB. Tidak mengubah keputusan apa pun — berkasnya tetap dihapus                                                                                                                                                                                                                                      |
| Daftar aset yang dihapus "**sekitar 19 MB**" | Sembilan baris daftar = **13.577.825 B = 13,58 MB** | Angka 19 MB hanya cocok bila `BES.png` (5.147.441 B) ikut dihitung: 13,58 + 5,15 = **18,73 MB**. Karena `BES.png` justru **dipertahankan** dan hanya di-re-export, penghematan nyata dari daftar hapus adalah **13,58 MB**, bukan 19 MB. Sisanya (sekitar 5,1 MB) datang dari re-export `BES.png`, bukan dari penghapusan |
| `BES.png` **5.1 MB**                         | **5.147.441 B = 4,91 MiB = 5,15 MB**                | Cocok                                                                                                                                                                                                                                                                                                                     |

Angka-angka yang **cocok** dan tidak perlu dikoreksi: `public/` 170 MB (177.346.275 B = 169,1 MiB — dokumen rencana
membaca MB sebagai MiB, konsisten dengan keluaran `du -sh`), reel 140 MB (folder `assets/reels` = 139,8 MiB),
`ubsc-tab.svg` 1,65 MB, `ubsc.svg` dan `ubsc-blue.svg` 473 KB, `BMU.svg` 373 KB, `hero/Bottom.png` 1,92 MB,
`hero/Top.png` 1,56 MB, `reels/sg.mp4` 2,2 MB, dan `thumbnail {1..5}.png` sekitar 4 MB (4.045.843 B).

## Yang dikerjakan kapan

- **Fase 0 (sekarang).** Kebijakan ini ditulis, `ops/scripts/sync-media.sh` disiapkan, dan `.gitignore` ketiga repo
  memblokir direktori media. Belum ada berkas yang dipindahkan.
- **Fase 9 (Hardening).** Eksekusinya: diet aset 170 MB menjadi di bawah 8 MB, pemindahan 140 MB reel ke object
  storage atau CDN dengan header immutable satu tahun, re-encode video, re-export `BES.png`, rename kebab-case
  seluruh berkas berspasi, dan pembuatan manifest awal. Gate Fase 9: `public/` di bawah 25 MB.

Aturan yang berlaku **mulai sekarang**, bukan menunggu Fase 9: jangan pernah menambahkan berkas media baru ke
`public/` repo Next mana pun. Kalau butuh aset baru sebelum Fase 9, taruh di direktori media dan tambahkan ke
manifest.
