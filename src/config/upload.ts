// ===== Batas Upload =====
// Konstanta murni: batas ukuran, dimensi, dan MIME per jenis unggahan, plus parameter pipeline
// sharp. Tidak ada logic multer di sini — itu middleware/upload-middleware.ts.
//
// TODO Fase 1: pakai UPLOAD_LIMITS.CMS_IMAGE dan AVATAR di upload-middleware.
// TODO Fase 6: pakai PAYMENT_PROOF (memory storage + pipeline sharp) dan IDENTITY_DOC.
// TODO Fase 9: VIDEO_REEL pindah ke object storage/CDN; batas di sini tetap jadi pagar terakhir.

const MB = 1024 * 1024

/**
 * Batas per jenis unggahan. Angkanya dari Rewrite.md bagian "Upload" dan harus sama persis dengan
 * batas di sisi form supaya user tidak baru ditolak setelah mengunggah 100 MB.
 *
 * Catatan: errorMiddleware WAJIB punya branch MulterError (pengganti PostTooLargeException
 * Laravel). Tanpa itu, unggahan kebesaran mengembalikan 500 opaque, bukan pesan yang bisa dibaca.
 */
export const UPLOAD_LIMITS = {
  /** Gambar konten CMS (berita, banner, galeri fasilitas). */
  CMS_IMAGE: {
    maxBytes: 5 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    storage: 'memory'
  },
  /** Foto profil user. */
  AVATAR: {
    maxBytes: 2 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    storage: 'memory'
  },
  /**
   * Bukti transfer manual. Disimpan di storage/private, TIDAK pernah di-mount publik.
   * Batas dimensi menjaga decoder sharp dari decompression bomb: file 2 MB bisa mekar jadi
   * ratusan megabyte piksel di memori.
   */
  PAYMENT_PROOF: {
    maxBytes: 10 * MB,
    maxWidth: 6000,
    maxHeight: 6000,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
    storage: 'memory'
  },
  /** KTP/KTM untuk verifikasi identitas. storage/private juga. */
  IDENTITY_DOC: {
    maxBytes: 4 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    storage: 'memory'
  },
  /** Video reel landing. Satu-satunya yang pakai disk storage — 100 MB di memori tidak masuk akal. */
  VIDEO_REEL: {
    maxBytes: 100 * MB,
    mimeTypes: ['video/mp4', 'video/webm'],
    storage: 'disk'
  }
} as const

/**
 * Pipeline sharp. Gambar selalu di-decode dan ditulis ulang — ini properti KEAMANAN, bukan
 * optimasi: file yang hanya mengaku gambar tidak selamat melewati decoder, dan apa pun di luar
 * piksel (EXIF, payload di ekor file) tidak pernah sampai disk.
 *
 * Resize pakai fit 'inside' + withoutEnlargement supaya gambar kecil tidak dipaksa membesar.
 * .rotate() tanpa argumen menerapkan orientasi EXIF lalu membuang metadatanya.
 * Tulis WebP; bila hasil PNG lossless ternyata lebih kecil, simpan yang lebih kecil.
 */
export const IMAGE_PIPELINE = {
  /** Sisi terpanjang setelah resize (piksel). */
  MAX_EDGE: 1600,
  /** Kualitas encoder WebP. */
  WEBP_QUALITY: 78
} as const

export type UploadKind = keyof typeof UPLOAD_LIMITS
