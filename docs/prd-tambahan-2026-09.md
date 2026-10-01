# PRD — Tambahan Fitur dari Catatan Client (September 2026)

Status: **DRAF — menunggu keputusan client.** Ditulis setelah Fase 0–8 selesai (seluruh
sistem inti sudah 1:1 dengan Laravel lama). Dokumen ini BUKAN bagian dari rewrite; ini
fitur baru di atas sistem yang sudah jadi.

Sumber: catatan client 2026-09-24 (4 poin). Poin 1–3 dirinci di bawah; poin 4 (export
Accurate) dibahas di bagian tersendiri karena masih berupa pertanyaan, bukan spesifikasi.

---

## 0. Ringkasan eksekutif

| # | Fitur | Inti perubahan | Skema? | Perkiraan |
|---|-------|----------------|--------|-----------|
| 1 | Biaya admin + kode unik | Rp500 biaya admin di setiap transfer; kode unik dipersempit ke 1–500 | 1 kolom | Kecil (1–2 hari) |
| 2 | E-Card + check-in gym | Nomor member, kartu ber-barcode, meja scan FO, batas 1×/hari, analitik jam ramai | 2 tabel + 2 kolom | Besar (5–7 hari) |
| 3 | Daftar membership via web | Checkout membership online + foto wajib; jalur FO dipertahankan | 3 kolom + 1 enum | Sedang (3–4 hari) |
| 4 | Export Excel → Accurate | Belum bisa di-scope; butuh template Accurate dari finance | — | Butuh keputusan dulu |

Fitur 2 dan 3 **saling mengunci**: E-Card tidak ada isinya tanpa membership, dan
pendaftaran membership tidak ada gunanya tanpa kartu. Keduanya sebaiknya dikerjakan
sebagai satu rilis. Fitur 1 berdiri sendiri dan bisa jalan duluan.

---

## 1. Keputusan yang dibutuhkan dari client

Ini didahulukan karena tujuh hal di bawah mengubah bentuk pekerjaan, bukan sekadar detail.

**Fitur 1 — biaya admin (UPDATED)**

1. Biaya admin Rp500 dikenakan ke **apa saja**? Hanya booking lewat website, atau juga
   booking yang dibuatkan FO, dan juga pembelian membership? Semua kena biaya admin 500 plus kode unik itu. 
2. Biaya admin ini **pendapatan** atau **pengganti biaya**? Pendapatan. intinya nanti yang total itu yang di export ke Accurate.

   Keputusan lanjutan (2026-09-25, saat implementasi):
   - Pelanggan yang dilayani FO (membership dan booking walk-in) membayar lewat **transfer/QRIS**, jadi
     keduanya juga kena biaya admin + kode unik.
   - Booking walk-in mendapat tombol **Tandai Lunas**. Sebelumnya walk-in tidak punya jalur lunas sama sekali.
   - **Total Pendapatan** di laporan = harga + biaya admin + kode unik (uang yang benar-benar masuk rekening).

**Fitur 2 — E-Card (UPDATED)**

3. Batas masuk gym 1×/hari itu **keras atau bisa di-override FO**? (Usulan: keras untuk
   member, tapi FO dengan izin khusus bisa menembus dengan alasan tercatat.) **FO boleh mengizinkan
   dengan catatan** (dijawab 2026-09-26).
4. Perlu **check-out** tidak? Tidak.

**Fitur 3 — pendaftaran membership (UPDATED)**

5. Member yang daftar lewat web, masa aktifnya mulai kapan — saat bayar, atau saat FO
   memverifikasi bukti transfer? saat diverifikasi
6. Foto profil untuk validasi gerbang: perlu **disetujui staff** dulu sebelum kartu aktif,
   atau langsung dipakai apa adanya? Perlu disetujui

   Jawaban lanjutan (2026-09-25): membership punya tarif Warga UB; satu paket membership per orang;
   prefiks nomor pelanggan `UB-` aman terhadap Accurate.

**Fitur 4 — Accurate**

7. Lihat bagian 6. Pertanyaan utamanya: **siapa pemilik data master pelanggan**, sistem
   UBSC atau Accurate?

---

## 2. Fitur 1 — Biaya admin Rp500 + kode unik maksimal 500

### 2.1 Keadaan sekarang

Sistem **sudah punya** mekanisme kode unik, jadi ini bukan fitur baru melainkan penyesuaian.

- `Transaction.amount` = harga fasilitas.
- `Transaction.uniqueCode` = angka acak **1–999**.
- `Transaction.pendingTotal` = `amount + uniqueCode`, dengan **UNIQUE index**.
- Pelanggan mentransfer sejumlah `pendingTotal`, sehingga satu baris di rekening koran
  menunjuk tepat satu booking.

Keunikan dijamin oleh index, bukan oleh pengecekan "kode ini sudah dipakai belum" —
`openTransfer()` mencoba-insert lalu menangkap pelanggaran unique
(`src/services/manual-payment-services.ts`). Pola itu **tidak boleh diubah**; dua checkout
di milidetik yang sama akan membaca kandidat kode yang sama.

### 2.2 Perubahan yang diminta

**a. Biaya admin Rp500.** Ditaruh di **kolom sendiri**, bukan dijumlahkan ke `amount`.

Alasannya penting: `amount` adalah angka yang dipakai seluruh laporan keuangan yang sudah
ada (`finance-report-services.ts` menjumlahkan `amount` untuk pendapatan per fasilitas,
per paket membership, dan buku besar). Kalau Rp500 dilebur ke `amount`, setiap laporan
pendapatan fasilitas naik Rp500 per transaksi dan tidak lagi cocok dengan daftar harga.
Untuk Accurate juga akan jadi masalah: biaya admin adalah akun pendapatan yang berbeda
dari sewa lapangan, dan harus bisa dipisah sebagai baris tersendiri.

```prisma
Transaction.adminFee  Int  @default(0)
```

`@default(0)` dipilih supaya **transaksi yang sedang berjalan saat migrasi tidak berubah
nominalnya.** Pelanggan yang sudah melihat "transfer Rp150.317" tidak boleh tiba-tiba
diminta angka lain.

Rumus baru: `pendingTotal = amount + adminFee + uniqueCode`.

**b. Kode unik dipersempit ke 1–500.** Ubah `CODE_MAX` dari 999 menjadi 500.

Konsekuensi yang perlu diketahui: kapasitas transfer terbuka **bersamaan pada nominal dasar
yang sama** turun dari 999 ke 500. Karena transfer kedaluwarsa dalam 120 menit
(`payment_hold_minutes`), ini berarti harus ada lebih dari 500 orang yang checkout dengan
harga persis sama dalam 2 jam sebelum sistem kehabisan kode. Untuk UBSC ini tidak realistis,
jadi aman. Kalau sampai habis, sistem sudah menangani dengan bersih: HTTP 409
`PENDING_TOTAL_EXHAUSTED`, bukan crash.

Kode tetap dimulai dari **1**, bukan 0 — kode 0 tidak bisa dibedakan dari "tidak ada kode".

### 2.3 Jangan di-hardcode

Rp500 dan batas 500 masuk `system_settings`, mengikuti pola `payment_bank_name` /
`payment_hold_minutes` yang sudah ada:

| Key | Default | Arti |
|-----|---------|------|
| `payment_admin_fee` | `500` | Rupiah, 0 = matikan biaya admin |
| `payment_unique_code_max` | `500` | Batas atas kode unik |

Keduanya ditambahkan ke form **Pengaturan Pembayaran** yang sudah ada di panel admin
(halaman Payments), lewat `updatePaymentSettings()`. Client hampir pasti akan mengubah
angka Rp500 suatu saat; kalau di-hardcode, itu berarti deploy ulang.

### 2.4 Dampak ke kode yang sudah ada

`amount + uniqueCode` saat ini dihitung ulang di **lima tempat** berbeda:

- `booking-services.ts:633` (`transferTotal`)
- `customer-dashboard-services.ts:374`
- `payment-admin-services.ts:87`
- `payment-services.ts:95`
- `pending-payment-services.ts:51`

Kelimanya harus jadi satu helper — `transferTotal(tx)` di `utils/money.ts`. Kalau tidak,
menambah `adminFee` berarti lima peluang untuk lupa satu, dan yang terlupa akan menampilkan
nominal transfer yang salah ke pelanggan.

### 2.5 Tampilan

**Halaman pembayaran** (`ubsc-landing/src/features/booking-payment`) saat ini menulis:

> Harga Rp150.000 + kode unik **317**.

Menjadi:

> Harga Rp150.000 + biaya admin Rp500 + kode unik **317**.

**Yang paling berisiko: ringkasan sebelum checkout.** Kalau pelanggan melihat "Rp150.000"
di ringkasan booking lalu diminta transfer Rp150.817 di halaman berikutnya tanpa penjelasan,
itu keluhan. Biaya admin **wajib** muncul di ringkasan booking sebelum tombol bayar ditekan.

**Laporan keuangan** mendapat baris "Biaya Admin" terpisah. Total `amount` tidak berubah,
jadi seluruh angka historis tetap sama.

### 2.6 Yang perlu diuji

- Transfer berjalan yang dibuat sebelum migrasi: nominalnya tidak berubah (`adminFee = 0`).
- Booking paket (banyak sesi, satu transaksi): biaya admin **satu kali**, bukan per sesi.
- `payment_admin_fee = 0`: perilaku persis seperti sekarang.
- Kehabisan kode unik: 409 bersih, bukan transaksi setengah jadi.

### 2.7 Status implementasi (2026-09-25)

Kode selesai di ketiga repo. Migrasi dan test Jest belum dijalankan karena MySQL lokal sedang mati.

**API**

- Migrasi `20260925090000_transaksi_biaya_admin`: kolom `adminFee`, plus dua pembersihan data.
  Kode unik pada transaksi Rp0 (walk-in gratis) dihapus karena tidak pernah ditransfer.
  `pendingTotal` pada transaksi non-UNPAID dilepas, termasuk walk-in batal yang dulu menahannya selamanya.
- Setting `payment_admin_fee` (0–10.000) dan `payment_unique_code_max` (100–999) masuk form
  Pengaturan Pembayaran. Tanpa baris setting, default 500/500 berlaku.
- `openTransfer()` menambah biaya admin: `pendingTotal = amount + adminFee + uniqueCode`.
- `recordPaidTransfer()` baru untuk membership FO. Kode dialokasikan lewat `openTransfer()` supaya
  tidak bentrok dengan transfer web yang masih terbuka, lalu langsung PAID dan nominalnya dilepas.
  Nominal 0 tidak kena biaya admin maupun kode.
- Walk-in gratis tidak lagi membuka transfer. Walk-in batal/gagal melepas kodenya.
- Tandai Lunas memakai endpoint `POST /admin/payments/:id/approve` yang sudah ada
  (`bookings.manage` atau `payments.manage`). Tidak ada endpoint baru.
- `transferTotal()` di `utils/money.ts` menggantikan kelima rumus di 2.4. Laporan keuangan, dashboard,
  dan email "pembayaran dikonfirmasi" juga memakainya.
- Laporan: `totalRevenue`, tren, grafik, dan ledger berbasis uang masuk. Pendapatan reservasi,
  membership, dan rincian per fasilitas/paket tetap harga saja. Rincian tipe sekarang empat baris:
  Reservasi, Membership, Biaya Admin, Kode Unik. Keempatnya berjumlah total.

**Admin:** form setting, rincian nominal di antrean verifikasi, total transfer + Tandai Lunas di detail
walk-in, nominal di toast setelah membuat walk-in/membership, serta laporan (hero, ledger, CSV, cetak).
"Tandai Selesai" disembunyikan untuk walk-in yang belum lunas, karena menyelesaikannya menggagalkan
transaksi.

**Landing:** catatan "+ biaya admin + kode unik (maks.)" di ringkasan lapangan dan kelas sebelum tombol
bayar. Rincian harga + admin + kode di halaman pembayaran. Riwayat pembayaran menampilkan nominal transfer.

**Batasan yang perlu diketahui**

- Biaya di halaman /booking ikut cache ISR 600 detik. Setelah setting diubah, ringkasan bisa telat
  hingga 10 menit. Halaman pembayaran selalu memakai nominal yang tersimpan di transaksi.
- Membership FO tetap langsung LUNAS saat disimpan, sama seperti sebelumnya. FO harus memastikan
  transfernya masuk (nominal ada di toast dan detail).
- Role bawaan "Staff Front Office" hanya punya `bookings.read`. Agar FO bisa membuat walk-in dan
  menandai lunas, beri `bookings.manage` lewat halaman Role & Akses.

---

## 3. Fitur 2 — E-Card, check-in gym, dan analitik jam ramai

### 3.1 Keadaan sekarang

Tidak ada apa pun. Yang ada hanya tiga hal yang mudah dikira sudah relevan, padahal bukan:

- **QR check-in booking** (`Booking.checkInToken`) — itu untuk kehadiran booking lapangan,
  satu token per booking, sekali pakai. Bukan kartu member.
- **`system_settings['gym_traffic']`** — label yang **diketik manual** staff di Dashboard
  ("Low Occupancy") lalu ditampilkan di beranda publik. Tidak ada data di belakangnya.
- **`GymMembershipModal.tsx`** di dashboard customer sudah ada tampilannya, tapi isinya
  `DUMMY_MEMBERSHIP` dengan TODO. Ini tempat E-Card nanti dipasang.

### 3.2 Nomor member — keputusan desain paling menentukan

Client meminta FO bisa "scan barcode **atau mengetik manual** nomor membership gym". Berarti
nomornya harus **pendek dan bisa diketik manusia**. UUID (36 karakter) tidak memenuhi syarat.

Tapi ada jebakan yang lebih dalam: **`renewMembership()` membuat baris `Membership` BARU.**
Kalau nomor member menempel di `Membership`, maka setiap kali member memperpanjang, nomornya
berubah dan kartunya mati. Kartu yang berubah nomor tiap perpanjangan tidak bisa dipakai.

Karena itu nomor harus menempel pada **orangnya**, bukan pada periode membership-nya.

**Usulan: `User.customerNumber`, diterbitkan sekali, tidak pernah berubah, tidak pernah
dipakai ulang.**

```prisma
User.customerNumber  String?  @unique  @db.VarChar(16)   // "UB-000123"
```

Tiga keuntungan sekaligus:

1. **Bertahan melewati perpanjangan, jeda, dan ganti paket.** Kartu diterbitkan sekali.
2. **Menjadi nomor pelanggan untuk Accurate** (lihat bagian 6) — tidak perlu skema penomoran
   kedua.
3. **Memaksa deduplikasi orang.** Satu manusia = satu nomor, mau daftar lewat web atau lewat
   FO.

Konsekuensi yang harus diterima: **membership walk-in yang sekarang boleh tanpa akun
(`Membership.userId = null`, hanya `customerName`) tidak bisa lagi dapat E-Card.** Kalau
client ingin walk-in juga berkartu, FO harus membuatkan akun minimal (nama + nomor HP, tanpa
password). Ini justru sehat — tanpa akun, tidak ada tempat menyimpan foto validasi gerbang.

*Alternatif yang lebih murah:* taruh nomor di `Membership` dan **salin turun** saat
perpanjangan. Lebih sedikit perubahan, tapi tidak menyelesaikan deduplikasi dan tidak bisa
dipakai untuk Accurate. Tidak disarankan.

**Format nomor.** `UB-` + 6 digit berurutan. Prefiksnya penting untuk Accurate (bagian 6).
Diterbitkan lewat `autoincrement()` yang dipetakan ke string — pola yang sama dengan
`Transaction.receiptSequence` → `UBSC-000123` yang sudah terbukti jalan.

### 3.3 Kartu (E-Card)

Ditampilkan di dashboard customer, menggantikan `DUMMY_MEMBERSHIP` di `GymMembershipModal`.

Isi kartu: foto member, nama, nomor member, nama paket, berlaku s.d., status, dan **dua
bentuk kode**:

- **Code128** — untuk barcode scanner USB murah yang dipakai FO. Butuh library baru
  (`jsbarcode` atau `bwip-js`).
- **QR** — untuk scan pakai kamera HP. `qrcode.react` **sudah terpasang** di ubsc-landing.

Keduanya meng-encode `customerNumber` apa adanya, bukan UUID dan bukan token rahasia. Nomor
member bukan kredensial — pengaman sebenarnya adalah **foto yang muncul di layar FO**, bukan
kerahasiaan nomornya. Ini disengaja: kartu yang bocor nomornya tetap tidak bisa dipakai orang
lain, karena wajahnya tidak cocok.

Tambahan: tombol unduh kartu sebagai PNG, dan kartu dikirim lewat email saat membership
aktif. *(Apple/Google Wallet pass: di luar lingkup, catat sebagai permintaan lanjutan.)*

### 3.4 Meja check-in gym (FO)

Halaman admin baru: `/gym/checkin`.

**Hal yang menyederhanakan banyak:** barcode scanner USB adalah **emulator keyboard**. Dia
mengetikkan isi barcode lalu menekan Enter. Jadi tidak ada integrasi perangkat keras sama
sekali — halamannya cukup punya satu input teks yang selalu terfokus. **"Scan" dan "ketik
manual" adalah jalur kode yang sama persis.** Itu langsung memenuhi dua permintaan client
dengan satu implementasi.

Alur:

1. FO memindai atau mengetik nomor member, lalu Enter.
2. Layar menampilkan **besar**: foto member, nama, paket, berlaku s.d., dan satu vonis
   berwarna.
3. FO mencocokkan wajah dengan foto, lalu menekan **Catat Kehadiran**.

Vonis yang mungkin:

| Keadaan | Warna | Bisa dilanjut? |
|---------|-------|----------------|
| Membership aktif, belum masuk hari ini | Hijau | Ya |
| Sudah check-in hari ini (jam sekian) | Kuning | Hanya dengan override |
| Membership kedaluwarsa / dibatalkan | Merah | Tidak — tawarkan perpanjangan |
| Nomor tidak ditemukan | Merah | Tidak |
| Foto belum disetujui | Kuning | Keputusan client (usulan: boleh, tapi ditandai) |

Pencatatannya **dua langkah** (tampilkan dulu, baru konfirmasi), bukan sekali scan langsung
tercatat. Alasannya: seluruh gunanya foto adalah agar manusia membandingkannya. Scan yang
langsung mencatat membuat foto itu tidak ada fungsinya.

### 3.5 Tabel kunjungan

```prisma
model GymVisit {
  id             String   @id @default(uuid())
  userId         String
  membershipId   String            // membership yang berlaku saat itu (snapshot)
  visitDate      DateTime @db.Date  // tanggal WIB — kolom yang menegakkan batas harian
  checkedInAt    DateTime           // instan UTC, sumber analitik per jam
  checkedInById  String             // staff FO
  source         String   @db.VarChar(16)  // scan | manual
  isOverride     Boolean  @default(false)
  overrideReason String?  @db.VarChar(120)

  @@index([visitDate])
  @@index([userId, visitDate])
  @@index([checkedInAt])
}
```

`visitDate` disimpan terpisah dari `checkedInAt` dengan sengaja. `checkedInAt` adalah instan
UTC; "hari ini di WIB" tidak bisa di-index dari kolom UTC tanpa fungsi tanggal, dan fungsi
tidak bisa di-index di MySQL. Ini pola yang sama dengan `Booking.startsAt` yang
didenormalisasi (lihat komentarnya di `schema.prisma`).

### 3.6 Batas 1× per hari

Setting: `gym_visit_max_per_day`, default `1`, nilai `0` berarti tanpa batas.

Penegakannya **wajib** mengikuti pola konkurensi yang sudah berlaku di repo ini: kunci baris
dulu (`SELECT ... FOR UPDATE`), baru hitung, baru tulis — di dalam satu transaksi. Alasannya
sudah didokumentasikan panjang di `manual-payment-services.ts`: dengan
`relationMode = "prisma"`, `updateMany().count` **tidak** bisa dipakai sebagai
compare-and-swap, dan pola baca-lalu-tulis tanpa kunci terbukti membiarkan dua penulis
sama-sama menang. Dua scan beruntun di dua komputer FO adalah skenario nyata.

Override dibatasi permission baru `gym.checkin.override`, wajib mengisi alasan, dan tercatat
di baris kunjungan.

### 3.7 Analitik traffic

Halaman admin baru `/gym/visits`, dengan rentang tanggal:

1. **Log hari ini** — daftar kunjungan, jam, siapa yang mencatat.
2. **Histogram per jam** — inilah jawaban langsung atas pertanyaan client "rame jam berapa".
3. **Heatmap hari × jam** — memperlihatkan pola mingguan (mis. Senin malam selalu padat).
4. **Ringkasan** — total kunjungan, member unik, rata-rata per hari, jam puncak.
5. **Export** — lihat bagian 6.

**Label `gym_traffic` di beranda publik tetap manual.** Jangan diubah jadi otomatis dalam
rilis ini: itu tampilan publik yang sekarang 1:1 dengan Laravel, dan mengotomatiskannya butuh
angka kapasitas gym yang belum ada. Yang ditambahkan cukup **saran** di sebelah kontrolnya di
Dashboard ("saat ini 23 kunjungan — biasanya 'Moderate'"), sehingga staff mengisinya dengan
tepat. Mode otomatis bisa menyusul setelah ada 2–3 bulan data nyata.

### 3.8 Catatan tentang occupancy

Tanpa check-out, sistem tahu **kedatangan per jam**, bukan **berapa orang di dalam saat ini**.
Untuk pertanyaan client apa adanya ("rame di jam berapa"), kedatangan sudah menjawab. Kalau
nanti diminta occupancy real-time, ada dua jalan: tambahkan check-out (FO harus disiplin), atau
asumsikan durasi kunjungan tetap yang bisa diatur (mis. 90 menit) lalu hitung perkiraan. Yang
kedua jauh lebih murah dan biasanya cukup. Ini masuk keputusan #4 di bagian 1.

---

## 4. Fitur 3 — Pendaftaran membership lewat web dan lewat FO

### 4.1 Keadaan sekarang

**Membership hanya bisa dibuat staff.** Tidak ada checkout membership di website sama sekali.
Halaman `/pricing` menampilkan paket, tapi tidak ada tombol beli yang berfungsi.

Yang dibuat staff **langsung LUNAS**: `createPaidTransaction()` menulis
`paymentStatus: 'PAID'` seketika, tanpa kode unik. Itu benar untuk pembayaran tunai di meja.

Kolom `Membership.createdVia` (`'admin' | 'self'`) sudah ada tapi nilai `'self'` belum pernah
dipakai — memang disiapkan untuk ini.

### 4.2 Jalur FO (sudah ada, tinggal ditambah)

Yang sudah jalan: cari pelanggan, pilih paket, tentukan tanggal, buat, cegah tumpang tindih
periode, catat riwayat, perpanjangan tanpa memotong sisa masa aktif.

Yang ditambahkan:

- Terbitkan `customerNumber` bila pelanggan belum punya.
- Ambil foto di meja (unggah berkas atau webcam).
- Tampilkan E-Card langsung setelah jadi, siap dicetak atau dikirim.
- Untuk walk-in tanpa akun: buat akun minimal (lihat 3.2).

### 4.3 Jalur web (baru)

Alur: `/pricing` → pilih paket → **login wajib** → unggah foto → ringkasan → transfer →
unggah bukti → FO verifikasi → **membership aktif + kartu terbit**.

Ini sengaja **memakai ulang seluruh mesin pembayaran yang sudah ada**. `openTransfer()` sudah
menerima `membershipId` sebagai subject — jalur itu sudah dibangun sejak Fase 3 tapi belum
pernah dipanggil dari mana pun. Antrean verifikasi pembayaran di panel admin juga sudah
mengenali `type: 'membership'`. Jadi yang benar-benar baru hanya halaman checkout dan
aktivasinya.

### 4.4 Masalah: membership belum lunas

`MembershipStatus` sekarang hanya `active | expired | cancelled`. Membership yang dibeli
online tapi belum diverifikasi **bukan salah satu dari ketiganya**.

```prisma
enum MembershipStatus {
  pending_payment   // BARU
  active
  expired
  cancelled
}
```

Tiga akibat yang harus ditangani:

1. **`ensureNoOverlappingActiveMembership()` harus ikut menghitung `pending_payment`.**
   Kalau tidak, satu orang bisa membeli membership yang sama lima kali dalam lima tab.
2. **Masa aktif dimulai saat verifikasi**, bukan saat checkout (keputusan #5). Berarti
   `startDate`/`endDate` diisi sementara saat dibuat, lalu **ditulis ulang** saat diaktifkan.
3. **Yang tidak dibayar harus kedaluwarsa** mengikuti `payment_hold_minutes` yang sama dengan
   booking — kalau tidak, daftar membership akan penuh sampah `pending_payment`.

E-Card **tidak terbit** selama status `pending_payment`, dan check-in gym menolaknya.

### 4.5 Foto member

Client: foto profil dipakai "untuk validasi saat user check-in atau masuk ke dalam area gym".

**Jangan pakai ulang `User.avatar`.** Avatar itu opsional, boleh kartun, dan untuk akun Google
berisi URL absolut ke server Google. Sistem tidak bisa menjamin itu foto wajah, padahal
seluruh gunanya adalah supaya FO bisa mencocokkan wajah.

```prisma
User.memberPhotoPath    String?
User.memberPhotoStatus  String?  @db.VarChar(16)   // pending | approved | rejected
```

Disimpan lewat pipeline `sharp` yang sudah ada (pola `uploads/avatars/`), di
`uploads/members/`. **Bukan** berkas privat seperti KTP — dia memang harus muncul cepat di
layar FO — tapi nama berkasnya acak sehingga tidak bisa ditebak.

**Ini berbeda dari verifikasi identitas yang sudah ada,** dan perbedaannya perlu dijaga agar
tidak tercampur:

| | Dokumen identitas (sudah ada) | Foto member (baru) |
|---|---|---|
| Isi | KTP / KTM | Foto wajah |
| Guna | Menentukan kategori harga (warga UB / umum) | Validasi wajah di gerbang gym |
| Simpan | Privat, tidak pernah publik | Mount unggahan, nama acak |
| Peninjau | Antrean Verifikasi Identitas | Antrean yang sama, tab baru |

Keduanya memakai antrean verifikasi yang sudah ada supaya FO tidak perlu belajar layar baru.

### 4.6 Yang belum jelas — dijawab client 2026-09-25

- Apakah harga membership punya tarif warga UB? **Ya.** Paket punya harga Warga UB sendiri,
  berlaku bila identitas Warga UB pembeli sudah terverifikasi (lihat 7.2).
- Apakah member boleh punya lebih dari satu paket aktif bersamaan (mis. gym + kolam)? **Tidak — satu
  paket membership per orang.** Aturan anti-tumpang-tindih yang sekarang tetap berlaku.

---

## 5. Ringkasan perubahan skema

Semuanya aditif — tidak ada kolom yang dihapus atau diganti tipe, jadi tidak ada migrasi data
yang berisiko.

```prisma
Transaction.adminFee         Int      @default(0)   // sudah ada, migrasi 20260925090000

User.customerSequence        Int      @unique @default(autoincrement())  // tampil 'UB-000123' — sudah ada (7.1)
User.memberPhotoPath         String?                                    // sudah ada
User.memberPhotoStatus       MemberPhotoStatus?                         // enum pending|approved|rejected — sudah ada

MembershipStatus             + pending_payment                          // sudah ada

model GymVisit { ... }                    // baru, lihat 3.5
model AccurateExportLog { ... }           // baru, lihat 6.6 — bila export disetujui
```

Satu perubahan yang **bukan** aditif dan perlu keputusan tersendiri: `User.phoneNumber`
sebaiknya menjadi **unique** untuk pelanggan (lihat 6.5). Itu bisa gagal kalau data sekarang
sudah punya nomor ganda, jadi perlu dibersihkan dulu.

---

## 6. Export Excel untuk Accurate — analisis, bukan spesifikasi

Bagian ini menjawab pertanyaan "kalau export data gym takutnya bentrok dengan data pelanggan
yang sudah ada, gimana? apa better nomor dibedakan khusus untuk di web?"

### 6.1 Jawaban singkat

**Ya, nomornya harus dibedakan — tapi dibedakan dari nomor milik Accurate, BUKAN dibedakan
antara web dan FO.**

Membuat seri nomor khusus web adalah jebakan. FO mendaftarkan member **lewat sistem yang
sama** (itu poin 3 dari client). Kalau web memakai seri sendiri dan FO memakai seri lain,
maka satu orang yang pernah daftar online lalu datang ke FO akan punya **dua nomor** — yaitu
persis masalah duplikasi yang dikhawatirkan, hanya berpindah tempat.

Yang benar: **satu orang, satu nomor, apa pun jalur pendaftarannya**, dengan prefiks yang
tidak mungkin diterbitkan Accurate. Itulah `User.customerNumber` di bagian 3.2 — jadi fitur 2
dan pertanyaan ini terjawab oleh kolom yang sama.

### 6.2 Tapi prefiks saja tidak cukup

Perlu dibedakan dua risiko yang sering tertukar:

**Risiko A — nomor bertabrakan.** Accurate mencocokkan impor berdasarkan No. Pelanggan. Kalau
sistem mengirim `000123` sementara Accurate sudah punya `000123` milik orang lain, impor akan
**menimpa** data orang lain. Ini diselesaikan oleh prefiks. Tuntas.

**Risiko B — orang yang sama tercatat dua kali.** Budi sudah ada di Accurate sebagai `C-0087`
(dibuat manual finance dua tahun lalu). Budi juga daftar di web dan dapat `UB-000123`. Impor
menambah master pelanggan **kedua** untuk manusia yang sama. Piutangnya terbelah, laporan per
pelanggan jadi salah. **Prefiks tidak menyelesaikan ini sama sekali.**

Risiko B jauh lebih merepotkan dan jauh lebih sering terjadi. Penyelesaiannya bukan penomoran,
melainkan keputusan di 6.3.

### 6.3 Pertanyaan sebenarnya: siapa pemilik master pelanggan?

Tiga model. Perlu dipilih satu bersama finance.

**Model 1 — Accurate tidak menerima master pelanggan sama sekali.** *(rekomendasi untuk
sekarang)*

Semua pendapatan web diposting ke 2–3 pelanggan generik: "Pelanggan Website", "Pelanggan
Walk-in", "Member Gym". Setiap baris export membawa nomor member dan nomor kuitansi UBSC di
kolom keterangan.

- Risiko tabrakan: **nol**. Risiko duplikasi: **nol**. Kerja rekonsiliasi: **nol**.
- Yang hilang: analisis piutang per orang **di dalam Accurate**.
- Yang tidak hilang: analisis per orang **di sistem UBSC**, yang justru lebih lengkap
  (riwayat booking, kunjungan gym, membership) dan sudah ada.

Akuntansi UBSC pada dasarnya ritel-tunai: pelanggan bayar di muka lewat transfer, tidak ada
tempo, tidak ada piutang beredar. Master pelanggan di Accurate untuk model bisnis seperti ini
memberi sedikit sekali manfaat dibanding beban pemeliharaannya.

**Model 2 — UBSC pemilik master, export pelanggan dengan prefiks.**

Dipakai kalau finance benar-benar butuh piutang per orang di Accurate. Butuh
`User.customerNumber` (sudah direncanakan) **plus** disiplin deduplikasi di 6.5, **plus**
rekonsiliasi satu kali terhadap pelanggan lama Accurate.

**Model 3 — Accurate pemilik master.**

UBSC menyimpan `User.accurateCustomerNo` yang diisi finance; export memakai nomor itu; yang
belum terisi jatuh ke pelanggan generik. Paling rapi secara akuntansi, paling banyak kerja
manual.

**Rekomendasi: jalankan Model 1 sekarang, tapi siapkan datanya supaya Model 2/3 hanya perlu
ganti pengaturan.** Konkretnya: terbitkan `customerNumber` berprefiks sejak hari pertama
(memang sudah dibutuhkan E-Card), tambahkan kolom kosong `accurateCustomerNo`, dan beri export
sebuah pilihan tingkat rincian. Kalau finance nanti minta per-pelanggan, nomornya sudah ada
dan sudah ber-namespace — tidak perlu penomoran ulang.

### 6.4 Aturan penomoran

Kalau nomor pelanggan jadi diekspor:

1. **Prefiks harus tidak mungkin dihasilkan Accurate.** Tanya finance seri apa yang sedang
   dipakai, lalu pilih yang tidak beririsan. `UB-` aman kecuali kebetulan sudah terpakai.
   **Dikonfirmasi client 2026-09-25: `UB-` aman.**
2. **Tidak pernah berubah.** Sekali terbit, nomor itu milik orang tersebut selamanya.
3. **Tidak pernah dipakai ulang.** Akun dihapus tidak berarti nomornya kembali ke kolam.
4. **Tidak diturunkan dari data yang bisa berubah.** Bukan dari email, bukan dari nomor HP —
   orang ganti keduanya.
5. **Satu seri untuk semua jalur.** Web dan FO menarik dari counter yang sama.

### 6.5 Deduplikasi — yang benar-benar menentukan

Tanpa ini, model apa pun akan tetap menghasilkan orang ganda:

- **Jadikan `User.phoneNumber` unique untuk pelanggan.** Di Indonesia nomor HP adalah kunci
  alami pelanggan ritel; email jauh lebih sering dipalsukan atau dikosongkan. Sekarang kolom
  ini `String?` tanpa unique. Perlu pembersihan data dulu sebelum constraint dipasang.
- **Paksa FO mencari sebelum membuat.** Pemilih pelanggan sudah ada di form membership; tutup
  jalan "buat baru" sebelum pencarian nomor HP dilakukan.
- **Rekonsiliasi sekali di awal:** export pelanggan Accurate → cocokkan dengan nomor HP/nama →
  isi `accurateCustomerNo`. Sekali kerja, selamanya bersih.

### 6.6 Hal yang belum dibahas tapi akan menggigit

**Nomor faktur juga bisa bertabrakan.** Nomor kuitansi UBSC (`UBSC-000123`) punya risiko yang
sama persis dengan nomor pelanggan, tapi terhadap seri faktur penjualan Accurate. Usulan:
masukkan sebagai **referensi/keterangan**, bukan sebagai nomor faktur, kecuali finance mau
memesan satu seri khusus untuk penjualan web.

**Impor ganda.** Kalau finance mengimpor file bulan yang sama dua kali, Accurate akan
memposting dua kali. Pengamannya: export per periode tertutup, setiap baris punya nomor dokumen
yang stabil, dan sistem mencatat apa yang sudah diekspor (`AccurateExportLog`) agar bisa
memperingatkan "periode ini sudah diekspor pada tanggal X".

**PPN.** Belum pernah dibahas sama sekali. Perlakuan pajak mengubah kolom export secara
signifikan, dan UBSC di bawah universitas bisa jadi punya perlakuan khusus. **Wajib ditanyakan
ke finance sebelum satu baris kode pun ditulis.**

**Biaya admin Rp500 dan kode unik.** Keduanya menjadikan uang yang masuk ke rekening berbeda
dari harga tercatat. Untuk Accurate itu berarti tiga komponen terpisah: pendapatan sewa,
pendapatan biaya admin, dan selisih pembulatan kode unik. Kode unik **bukan** pendapatan jasa —
biasanya diperlakukan sebagai pendapatan lain-lain atau selisih pembulatan. Finance yang
menentukan akunnya. Laporan UBSC sudah memisahkan ketiganya (lihat 2.7), jadi export tinggal
memetakan tiap komponen ke akun Accurate-nya.

### 6.7 Yang dibutuhkan sebelum fitur ini bisa di-scope

1. **Berkas template impor Accurate yang asli** dari finance (Pelanggan / Faktur Penjualan /
   Penerimaan Penjualan / Jurnal Umum — yang mana yang dipakai?). Kolomnya ditentukan Accurate,
   tidak bisa ditebak.
2. **Kode akun (chart of accounts)** untuk: sewa fasilitas, membership, biaya admin, selisih
   kode unik, dan kas/bank penerima.
3. **Perlakuan PPN.**
4. **Seri penomoran yang sudah dipakai Accurate** — untuk memilih prefiks yang aman.
5. **Jawaban 6.3:** model 1, 2, atau 3.
6. **Frekuensi:** harian, mingguan, atau bulanan.

Sampai enam hal ini ada, yang bisa dibangun hanyalah export generik dengan **lapisan pemetaan
kolom yang bisa diatur**, sehingga nama dan urutan kolom bisa disesuaikan tanpa mengubah kode.
Itu saran saya: bangun mesin exportnya sekarang (ambil data, filter periode, tulis .xlsx),
tunda pemetaan kolomnya sampai templatenya ada.

### 6.8 Export lain yang sekalian

Selagi mesin export dibangun, beberapa yang murah dan langsung berguna:

- Kunjungan gym per periode (permintaan analitik client di poin 2).
- Daftar member aktif + tanggal berakhir (untuk kampanye perpanjangan).
- Buku besar keuangan per bulan (layarnya sudah ada, tinggal tombol unduh).

---

## 7. Urutan pengerjaan yang disarankan

| Tahap | Isi | Alasan urutan |
|-------|-----|---------------|
| A | Fitur 1 (biaya admin + kode unik) — **kode selesai 2026-09-25, lihat 2.7** | Berdiri sendiri, kecil, bisa rilis cepat |
| B | `customerNumber` + foto member + `pending_payment` — **kode selesai 2026-09-25, lihat 7.1** | Fondasi bersama fitur 2 & 3 |
| C | Fitur 3 (checkout membership web + FO) — **kode selesai 2026-09-25, lihat 7.2** | Mengisi data yang dibutuhkan E-Card |
| D | Fitur 2 (E-Card + meja scan + analitik) — **kode selesai 2026-09-26, lihat 7.3** | Butuh member yang sudah berkartu |
| E | Export Accurate — **pelanggan + faktur selesai 2026-09-28, lihat 7.4**; penerimaan penjualan menyusul | Butuh jawaban dari finance |

Tahap A bisa berjalan paralel dengan B. Tahap D tidak bisa didemokan sebelum C jalan — tidak
ada member yang punya kartu.

**Catatan:** Fase 9 (hardening: diet aset 170 MB → di bawah 8 MB, rate limiting, paginasi
daftar admin, Lighthouse) dan Fase 10 (deploy VPS) belum dikerjakan. Fitur-fitur di atas
menambah halaman dan tabel baru, jadi sebaiknya Fase 9 dijalankan **setelah** tahap D, bukan
sebelum — kalau tidak, pekerjaan optimasinya diulang.

### 7.1 Status tahap B (2026-09-25)

Migrasi `20260925130000_tahap_b_nomor_pelanggan_foto_member_pending_payment` sudah terpasang di dev dan
test. 71 test Jest lolos.

**Nomor pelanggan (3.2).** Kolom `User.customerSequence` (auto-increment), tampil `UB-000123` lewat
`customerNumber()`. Semua akun mendapat nomor saat dibuat; akun lama dinomori urut tanggal daftar.
FO bisa mencari pelanggan dengan nomor itu (`UB-000123` atau `123`) di form membership. Nomor tampil di
profil pelanggan, detail membership admin, dan antrean foto.

**Foto member (4.5).** Pelanggan mengunggah di modal profil lewat `POST /api/customer/member-photo`
(field `photo`, maks 10 MB). Sharp menulis ulang berkasnya ke `uploads/members/<uuid>.webp`. Status
`pending → approved | rejected`; unggah ulang selalu kembali ke `pending`. Staff meninjau di halaman
Verifikasi Identitas, tab "Foto Member" (izin `identity.verify`). Keputusan membawa URL foto yang
dilihat staff. Kalau pelanggan sudah menggantinya, API menolak 409.

**`pending_payment` (4.4).** Status dan aturannya sudah ada, tapi belum ada yang membuatnya. Checkout
web masuk tahap C.

- Status ini ikut dihitung saat cek tumpang tindih. Membership pending tidak bisa diperpanjang dan tidak
  bisa diubah ke aktif secara manual, hanya dibatalkan. Paket yang masih punya membership pending tidak
  bisa dihapus.
- Transfer disetujui: status jadi `active`. Masa aktif mulai hari verifikasi, tapi tidak mundur dari
  tanggal mulai sementara (untuk perpanjangan online). Kalau bertumpuk dengan membership aktif lain,
  mulainya digeser ke setelah membership itu. Riwayat: `activated`.
- Transfer kedaluwarsa atau ditolak: status jadi `cancelled`. Sweep kedaluwarsa yang sama juga memeriksa
  `expiresAt` transaksi membership. Riwayat: `payment_expired` atau `payment_rejected`.

Pertanyaan yang terbuka di sini (prefiks `UB-`, 4.6) sudah dijawab client 2026-09-25.

### 7.2 Status tahap C (2026-09-25)

Migrasi `20260925150000_tahap_c_harga_warga_membership` sudah terpasang di dev dan test. 76 test Jest
lolos.

**Tarif Warga UB untuk paket.** Kolom `MembershipPlan.wargaPrice` (kosong = sama dengan harga umum),
diisi di halaman Paket admin. `membershipPriceFor()` dipakai meja depan dan checkout web: tarif Warga
UB hanya untuk identitas Warga UB yang sudah terverifikasi. Kartu paket di /pricing menampilkan kedua
harga. Form membership admin menampilkan harga sesuai akun yang dipilih.

**Checkout web.** Tombol di kartu paket membuka `/membership/daftar/{paket}`:

- Ringkasan dihitung server (`GET /api/customer/memberships/checkout/:planId`): harga sesuai kategori,
  biaya admin, batas kode unik, dan tanggal mulai. Yang masih punya membership aktif otomatis jadi
  perpanjangan, mulai sehari setelah masa aktifnya berakhir.
- Foto wajah wajib sebelum bayar (boleh masih menunggu tinjauan, tidak boleh yang ditolak).
- Pengajuan Warga UB yang masih ditinjau: halaman menawarkan tunggu hasilnya atau lanjut dengan harga
  umum. Checkout tidak diblok.
- `POST /api/customer/memberships` membuat `pending_payment` + transfer ber-hold. Klik ulang untuk paket
  yang sama mengembalikan pembelian yang sama; paket lain ditolak sampai yang menunggu selesai.
- `/membership/{id}/pembayaran`: instruksi transfer, countdown, unggah bukti. Komponennya dipakai
  bersama halaman bayar booking. Staff menyetujui di Verifikasi Pembayaran, lalu membership aktif.
- Riwayat pembayaran di dashboard pelanggan kini punya tautan kembali ke halaman bayar membership.

**Jalur meja depan.**

- Staff bisa membuat akun minimal untuk walk-in dari form membership (nama + email + HP, tanpa
  password): tombol "Buat akun baru" saat pencarian kosong. Pelanggan mengambil alih akunnya lewat
  "Lupa password". Email wajib karena kolomnya unik dan tidak boleh kosong.
- Detail membership admin menampilkan foto member. Staff bisa memotret di meja; foto dari staff
  langsung disetujui.

**Belum di tahap ini**

- Pill "pembayaran tertunda" di Navbar landing masih khusus booking; transfer membership yang tertunda
  bisa dibuka dari riwayat pembayaran.
- Kartu (E-Card), check-in gym, dan analitik — tahap D (lihat 7.3).

### 7.3 Status tahap D (2026-09-26)

Migrasi `20260926090000_tahap_d_kunjungan_gym` dan `20260926091000_tahap_d_pencatat_kunjungan_boleh_null`
sudah terpasang di dev dan test. 83 test Jest lolos, termasuk gate dua scan bersamaan (tepat satu tercatat).

**Kartu member (3.3).** Modal "Membership Gym" di dashboard pelanggan sekarang kartu sungguhan
(`GET /api/customer/memberships/card`): foto, nama, nomor member, paket, masa berlaku, dan QR berisi
nomor member. Status kartu: aktif, perlu foto disetujui, belum mulai, menunggu pembayaran, tidak aktif.
Email "Membership Anda siap dipakai" (nomor member + tautan kartu `/?kartu=1`) dikirim saat transfer
membership disetujui, dan saat membership dibuat/diperpanjang di meja depan.

**Meja check-in (3.4–3.6).** Halaman admin `/gym/checkin`: input yang selalu fokus (scan = ketik + Enter),
lalu foto besar, data membership, dan vonis berwarna; kehadiran baru dicatat setelah FO menekan tombol.

- Batas harian dari setting `gym_visit_max_per_day` (default 1, 0 = tanpa batas), ditegakkan di bawah
  kunci baris member. Belum ada form untuk mengubahnya.
- Keputusan client: FO boleh mengizinkan masuk ulang dengan alasan (maks 120 karakter). Alasannya
  tercatat di baris kunjungan dan tampil di log.
- Foto yang belum disetujui memblokir check-in (jawaban #6). FO bisa menyetujuinya di meja setelah
  mencocokkan wajah, atau memotret ulang (langsung disetujui).
- Membership yang tidak berlaku hari ini (kedaluwarsa, dibatalkan, menunggu bayar) ditolak; alasan tidak
  bisa menembusnya.
- Permission baru `gym.checkin` untuk Staff Front Office, Staff Central, dan Manager. Migrasi menautkannya
  hanya ke role yang sudah punya baris di `role_permissions`.

**Analitik (3.7).** Halaman admin `/gym/visits` (izin `gym.checkin` atau `reports.read`): kedatangan per jam,
pola hari × jam, ringkasan (total, member unik, rata-rata per hari, jam tersibuk, jumlah masuk ulang),
log, dan ekspor CSV. Rentang maksimal 92 hari. Dashboard menampilkan "Kunjungan gym tercatat hari ini"
di samping kontrol Gym Traffic; labelnya tetap dipilih staff (3.7).

**Sengaja tidak dikerjakan**

- **Code128.** Kartu hanya memakai QR (`qrcode.react` sudah terpasang). Memindai layar HP butuh scanner
  2D, dan scanner 2D juga membaca QR — Code128 hanya menambah dependensi. Nomor member tetap tertulis
  besar untuk diketik. Tambahkan Code128 bila meja gym ternyata memakai scanner laser 1D untuk kartu
  cetak.
- **Unduh kartu sebagai PNG** — dikerjakan 2026-09-28 (lihat 7.4). Apple/Google Wallet tetap belum.
- Occupancy real-time tetap di luar lingkup (tanpa check-out, lihat 3.8).

### 7.4 Catatan client 2026-09-28 (setelah uji tahap D)

Migrasi `20260928090000_export_accurate` terpasang di dev dan test. 89 test Jest lolos.

**Kartu member.** Modal "Membership Gym" menggambar kartu berukuran CR80 di `<canvas>`: logo, foto,
nama, nomor member, paket, masa berlaku, dan QR. Tombol "Unduh Kartu (PNG)" menyimpan gambar yang
sama persis dengan yang tampil.

**Email verifikasi.**
- Email pendaftaran tidak sampai karena `.env` dev berisi `MAIL_TRANSPORT=log`. Email ditulis ke
  `storage/mail-preview/*.eml`, tidak dikirim. Kirim sungguhan: `MAIL_TRANSPORT=smtp`. Pengirim otomatis
  memakai `MAIL_USER` bila `MAIL_FROM_ADDRESS` kosong.
- Endpoint auth sekarang membawa `emailVerifiedAt`. Situs publik menampilkan:
  - pengingat di bawah layar (bisa disembunyikan per sesi);
  - penanda di dropdown akun dan di Profil Saya;
  - tombol kirim ulang.
- Kirim ulang dibatasi per akun: jeda 60 detik, maksimal 5 per 24 jam (`issueVerification()`). Tombol
  menampilkan sisa waktu dari server.
- Gerbang pembayaran (AuthGate / BookingListItem) kini benar-benar aktif untuk akun yang belum
  terverifikasi. Dulu field-nya tidak pernah dikirim, sehingga gerbang ini selalu lolos.
- Reset password menandai email terverifikasi. Ini jalan masuk akun buatan FO.
- Halaman landing `/verifikasi-email?token=`, `/forgot-password`, dan `/reset-password?token=` dibuat.
  Sebelumnya ketiganya 404 walau endpoint API-nya sudah ada.
- Tautan verifikasi lama atau yang sudah terpakai dianggap sukses bila emailnya sudah terverifikasi.
- Lupa password memakai jeda dan batas harian per akun yang sama dengan kirim ulang verifikasi.
- SMTP dev memakai port 587 + STARTTLS wajib, karena jaringan dev memblokir 465 lewat IPv4.

**Membership lewat FO = tagihan + Tandai Lunas** (mengganti keputusan tahap A "langsung PAID").
- Membership yang dibuat atau diperpanjang di meja depan berstatus menunggu pembayaran, dengan transfer
  terbuka tanpa batas waktu sebesar harga + biaya admin + kode unik. Nominal 0 tetap langsung aktif.
- Invoice yang sama tampil di tiga tempat:
  - detail membership di admin, dengan tombol cetak;
  - dashboard pelanggan (Membership Gym → Lanjutkan Pembayaran, dan Riwayat Pembayaran);
  - email "Tagihan membership". Email hanya salinan: bila tidak sampai, invoice tetap ada di layar FO dan
    dashboard.
- FO menekan **Tandai Lunas** setelah mutasi cocok (`POST /admin/memberships/:id/lunas`, izin kelola
  membership). Membership aktif dan email kartu member terkirim.
- Pelanggan juga bisa mengunggah bukti. Bukti masuk ke Verifikasi Pembayaran seperti checkout web.

**Invoice / kuitansi.** Satu transaksi = satu dokumen HTML siap cetak bernomor kuitansi (`UBSC-000031`).
Endpoint: `GET /customer/transactions/:id/invoice` (hanya pemilik) dan `GET /admin/payments/:id/invoice`.
"Unduh" = tombol "Cetak / Simpan PDF" di dokumennya; tidak ada pustaka PDF di server. Riwayat
pembayaran kini menampilkan judul paket + masa aktif untuk baris membership (dulu "-").

**Nomor member tidak berurutan.** Tampil `UB-XXXX-XXXX` (8 karakter Crockford base32), hasil permutasi
Feistel dari `customerSequence`. Bisa dibalik tanpa kolom baru, dan tidak ada huruf I/L/O/U supaya
tidak tertukar saat diketik. Kunci permutasinya tidak boleh diubah: mengubahnya mengganti nomor di
semua kartu.

**Export Accurate (Finance → Export Accurate, izin `reports.read`).** Dua berkas .xlsx per rentang tanggal
(maks 31 hari). Kolom keduanya identik dengan template dari finance.
1. *Pelanggan*: pelanggan yang muncul di faktur rentang itu (keputusan client). `ID Pelanggan` =
   `WEB.0001` dst. (`User.accurateSequence`), ID terpisah dari nomor member.
   - Nomor terbit saat pelanggan pertama kali masuk export, urut tanggal daftar, jadi counternya hanya
     berisi pelanggan yang punya penjualan.
   - Transaksi tanpa akun (walk-in) memakai pelanggan umum `WEB.0000`.
2. *Faktur penjualan*: semua transaksi yang dibuat pada rentang itu, lunas maupun belum. Yang batal,
   kedaluwarsa, dan bernominal 0 tidak ikut.
   - Satu transaksi = satu faktur. NUMBER = nomor kuitansi UBSC, sehingga impor ulang ditolak Accurate
     dan export penerimaan kelak bisa merujuknya.
   - BRANCH = `1. UBSC - Jasa Cabang Olahraga`.
   - Baris item: fasilitas atau paket (`accurateItemNo`, diisi di form Fasilitas / Paket), lalu baris
     `UBSC-ADMIN` (biaya admin) dan `UBSC-KODEUNIK` (kode unik). Membership manual tanpa paket memakai
     `UBSC-MEMBERSHIP`.
   - Nomor item yang belum diisi menghentikan export (422) dengan daftar yang harus dilengkapi.

**Yang perlu disiapkan finance di Accurate.**
- Item jasa dengan nomor persis `UBSC-ADMIN`, `UBSC-KODEUNIK`, `UBSC-MEMBERSHIP`, dan satu per
  fasilitas/paket.
- Pelanggan `WEB.0000`. Pelanggan ini ikut terbawa di export pelanggan bila ada transaksi walk-in.
- TAXABLE (PPN) dan WAREHOUSE dikosongkan, jadi ikut default Accurate. Template menandai WAREHOUSE
  wajib; untuk item jenis jasa kolom itu biasanya tidak dipakai. Bila impor menolak, cukup tambah satu
  konstanta.
- Export penerimaan penjualan (yang lunas di hari itu) menyusul sesuai permintaan client.

**Susulan 2026-09-28 (sore).**
- **Nomor item Accurate per tarif.** Fasilitas dan paket punya dua nomor: Umum (`accurateItemNo`) dan
  Warga UB (`accurateItemNoWarga`), mis. membership reguler `1002` dan Warga UB `1006`.
  - Transaksi mencatat tarif yang benar-benar dipakai (`Transaction.priceCategory`):
    - booking web: kategori pelanggan;
    - walk-in FO: umum;
    - membership: Warga UB hanya bila paketnya punya harga warga.
  - Baris lama diisi migrasi `20260928120000` secara perkiraan.
  - Paket bulanan kelas memakai nomor item fasilitasnya (belum dipisah).
- **Fasilitas nonaktif masih tampil — dua sebab, keduanya diperbaiki.**
  - Section fasilitas landing punya daftar contoh statis yang dipakai saat data kosong atau tanpa data
    sama sekali (`/booking` bagian bawah, `/facilities` outdoor, akordeon `/pricing`). Daftar contoh
    dihapus; section tanpa data disembunyikan.
  - Cache ISR 5-10 menit tanpa pemicu. API sekarang memanggil `POST /revalidate` di landing setelah
    tulis admin fasilitas/unit/kategori/paket/CMS (`LANDING_REVALIDATE_URL` + secret bersama).
  - Slot dan kalender publik menolak fasilitas nonaktif.
- **Form profil tidak bisa diketik.** Objek user gabungan dibuat ulang tiap render sehingga efek prefill
  me-reset form terus-menerus; diperbaiki dengan `useMemo`.
- **Faktur satu baris.** Permintaan client: biaya admin dan kode unik tidak lagi jadi baris item terpisah. Satu
  faktur = satu baris item seharga total transfer; rinciannya dicatat di ITEM NOTES. Item `UBSC-ADMIN` dan
  `UBSC-KODEUNIK` tidak dipakai lagi. Panel Export Accurate pindah ke kepala card tabel ledger.
- **Export penerimaan penjualan** menunggu template impor resminya dari Accurate (kolomnya tidak bisa ditebak).
