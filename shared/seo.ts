// ===== SEO halaman statis landing (SUMBER KEBENARAN) =====
//
// Berbeda dari contracts.ts, berkas ini membawa NILAI runtime: daftar halaman yang SEO-nya bisa diatur
// dari dashboard admin, beserta default kodenya. Dipakai tiga pihak sekaligus:
//   - ubsc-api   : PUT /api/admin/seo-pages/:key menolak key di luar daftar ini; GET admin menggabungkan
//                  baris page_seo dengan default di sini.
//   - ubsc-admin : form SEO per halaman (label, path, placeholder default, batas karakter).
//   - ubsc-landing: generateMetadata() — nilai dari DB menang, kosong = default di sini.
//
// defaultTitle (KECUALI home) ditulis TANPA akhiran merek; landing memasang template '%s | UB Sport Center'.
// Judul home absolut karena di beranda merek adalah judulnya sendiri.

export const SITE_NAME = 'UB Sport Center'

/** Panjang karakter. titleIdeal/descriptionIdeal = batas tampil Google; *Max = batas kolom/validasi. */
export const SEO_LIMITS = { titleIdeal: 60, titleMax: 120, descriptionMin: 70, descriptionIdeal: 160, descriptionMax: 320 } as const

export const SEO_PAGES = [
  {
    key: 'home',
    label: 'Beranda',
    path: '/',
    defaultTitle: 'UB Sport Center — Pusat Olahraga Universitas Brawijaya',
    defaultDescription:
      'Sewa lapangan, ikuti kelas, dan kelola keanggotaan di UB Sport Center. Booking online untuk futsal, badminton, basket, kolam renang, dan fasilitas lainnya.'
  },
  {
    key: 'about',
    label: 'Tentang Kami',
    path: '/about',
    defaultTitle: 'Tentang Kami',
    defaultDescription: 'Mengenal UB Sport Center: sejarah, visi misi, layanan, cabang, dan lokasi pusat olahraga Universitas Brawijaya di Malang.'
  },
  {
    key: 'facilities',
    label: 'Fasilitas',
    path: '/facilities',
    defaultTitle: 'Fasilitas',
    defaultDescription: 'Lapangan, arena, kelas, dan fasilitas outdoor yang tersedia di UB Sport Center Malang.'
  },
  {
    key: 'pricing',
    label: 'Harga & Membership',
    path: '/pricing',
    defaultTitle: 'Harga & Membership',
    defaultDescription: 'Daftar harga sewa fasilitas, kelas, dan paket membership UB Sport Center.'
  },
  {
    key: 'booking',
    label: 'Booking',
    path: '/booking',
    defaultTitle: 'Booking',
    defaultDescription: 'Booking fasilitas olahraga terbaik di UB Sport Center Malang — gym, lapangan futsal, yoga, dan banyak lagi.'
  },
  {
    key: 'news',
    label: 'Berita & Artikel',
    path: '/news',
    defaultTitle: 'Berita & Artikel',
    // Deskripsi lama landing (60 karakter) di bawah SEO_LIMITS.descriptionMin, jadi diperpanjang.
    defaultDescription: 'Kabar terbaru, program, acara, dan artikel olahraga seputar UB Sport Center Universitas Brawijaya Malang.'
  },
  {
    key: 'terms',
    label: 'Syarat & Ketentuan',
    path: '/syarat-ketentuan',
    defaultTitle: 'Syarat & Ketentuan',
    defaultDescription:
      'Syarat dan ketentuan layanan UB Sport Center: akun, reservasi dan pembayaran, pembatalan, aturan fasilitas, serta batasan tanggung jawab.'
  },
  {
    key: 'privacy',
    label: 'Kebijakan Privasi',
    path: '/kebijakan-privasi',
    defaultTitle: 'Kebijakan Privasi',
    defaultDescription:
      'Kebijakan privasi UB Sport Center: data yang kami kumpulkan, cara penggunaan dan perlindungannya, pembayaran, serta hak Anda atas data pribadi.'
  },
  {
    key: 'refund',
    label: 'Kebijakan Pengembalian',
    path: '/kebijakan-pengembalian',
    defaultTitle: 'Kebijakan Pengembalian',
    defaultDescription:
      'Kebijakan pengembalian dana UB Sport Center: ketentuan pembatalan oleh pengguna maupun pengelola, alur proses refund, dan kontak bantuan.'
  }
] as const

export type SeoPageKey = (typeof SEO_PAGES)[number]['key']

export const isSeoPageKey = (v: string): v is SeoPageKey => SEO_PAGES.some((page) => page.key === v)
