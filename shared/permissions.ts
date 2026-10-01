// ===== Daftar permission UBSC (SUMBER KEBENARAN) =====
//
// File ini adalah satu-satunya tempat daftar permission ditulis. src/config/permissions.ts
// hanya me-re-export dari sini, dan kedua repo Next menyalin folder shared/ lewat
// npm run sync:contracts. Jangan pernah menduplikasi daftar di bawah ke tempat lain.
//
// Isinya reproduksi verbatim dari database/seeders/RoleAndPermissionSeeder.php aplikasi
// Laravel lama: 14 permission kebab-case dipetakan ke dot-code gaya boilerplate, ditambah
// 2 permission baru (rbac.manage, users.manage) yang menutup celah keamanan — lihat catatan
// di kelompok "Sistem" dan di ROLE_PERMISSIONS.

// ===== Kode permission =====

export const PERMISSIONS = {
  // Beranda & Dasbor
  STATS_READ: 'stats.read',
  REPORTS_READ: 'reports.read',

  // Reservasi & Jadwal
  BOOKINGS_READ: 'bookings.read',
  BOOKINGS_MANAGE: 'bookings.manage',
  BOOKINGS_LIMITS_MANAGE: 'bookings.limits.manage',

  // Fasilitas & Lapangan
  FACILITIES_READ: 'facilities.read',
  FACILITIES_MANAGE: 'facilities.manage',
  PRICING_MANAGE: 'pricing.manage',

  // CMS
  CMS_MANAGE: 'cms.manage',
  NEWS_PUBLISH: 'news.publish',

  // Member & Pelanggan
  MEMBERS_READ: 'members.read',
  MEMBERS_MANAGE: 'members.manage',
  PAYMENTS_MANAGE: 'payments.manage',

  // Verifikasi
  IDENTITY_VERIFY: 'identity.verify',

  // Gym (BARU, PRD tambahan 2026-09 tahap D)
  GYM_CHECKIN: 'gym.checkin',

  // Sistem (BARU, tidak ada di Laravel)
  RBAC_MANAGE: 'rbac.manage',
  USERS_MANAGE: 'users.manage'
} as const

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

// ===== Peta nama Laravel lama -> dot-code =====
//
// Dipakai saat seeder/import Fase 1 memindahkan baris tabel permissions Spatie yang lama.
// Hanya 14 permission Laravel yang ada di sini; rbac.manage dan users.manage tidak punya
// padanan lama karena memang baru.

export const LARAVEL_PERMISSION_MAP: Record<string, PermissionCode> = {
  'view-stats': PERMISSIONS.STATS_READ,
  'view-reports': PERMISSIONS.REPORTS_READ,
  'view-bookings': PERMISSIONS.BOOKINGS_READ,
  'manage-bookings': PERMISSIONS.BOOKINGS_MANAGE,
  'manage-booking-limits': PERMISSIONS.BOOKINGS_LIMITS_MANAGE,
  'view-facilities': PERMISSIONS.FACILITIES_READ,
  'manage-facilities': PERMISSIONS.FACILITIES_MANAGE,
  'manage-pricing': PERMISSIONS.PRICING_MANAGE,
  'manage-cms': PERMISSIONS.CMS_MANAGE,
  'publish-news': PERMISSIONS.NEWS_PUBLISH,
  'view-members': PERMISSIONS.MEMBERS_READ,
  'manage-members': PERMISSIONS.MEMBERS_MANAGE,
  'manage-payment-links': PERMISSIONS.PAYMENTS_MANAGE,
  'verify-identity': PERMISSIONS.IDENTITY_VERIFY
}

// ===== Katalog permission =====
//
// Urutan array ini adalah urutan tampil di matriks Role & Access admin. Pengelompokan
// mengikuti komentar kelompok di RoleAndPermissionSeeder.php, dengan satu kelompok
// tambahan: Sistem.

export interface PermissionDefinition {
  code: PermissionCode
  name: string
  description: string
}

export const ALL_PERMISSIONS: PermissionDefinition[] = [
  // ===== Beranda & Dasbor =====
  { code: PERMISSIONS.STATS_READ, name: 'Lihat Statistik', description: 'Melihat kartu statistik di dashboard admin' },
  { code: PERMISSIONS.REPORTS_READ, name: 'Lihat Laporan Keuangan', description: 'Membuka laporan keuangan dan rekap pendapatan' },

  // ===== Reservasi & Jadwal =====
  { code: PERMISSIONS.BOOKINGS_READ, name: 'Lihat Reservasi', description: 'Melihat daftar dan detail reservasi, tanpa mengubah' },
  { code: PERMISSIONS.BOOKINGS_MANAGE, name: 'Kelola Reservasi', description: 'Membuat, mengubah, membatalkan reservasi, dan check-in' },
  { code: PERMISSIONS.BOOKINGS_LIMITS_MANAGE, name: 'Kelola Batas Reservasi', description: 'Mengatur batas jadwal, kuota, dan tanggal tutup' },

  // ===== Fasilitas & Lapangan =====
  { code: PERMISSIONS.FACILITIES_READ, name: 'Lihat Fasilitas', description: 'Melihat daftar fasilitas dan unit lapangan, tanpa mengubah' },
  { code: PERMISSIONS.FACILITIES_MANAGE, name: 'Kelola Fasilitas', description: 'Membuat, mengubah, dan mengurutkan fasilitas, kategori, dan unit' },
  { code: PERMISSIONS.PRICING_MANAGE, name: 'Kelola Harga', description: 'Mengatur tarif fasilitas, harga khusus, dan paket bulanan' },

  // ===== CMS =====
  { code: PERMISSIONS.CMS_MANAGE, name: 'Kelola Konten', description: 'Mengelola berita, promo, reel, logo sponsor, dan testimoni' },
  { code: PERMISSIONS.NEWS_PUBLISH, name: 'Terbitkan Berita', description: 'Menerbitkan atau menarik berita dari halaman publik' },

  // ===== Member & Pelanggan =====
  { code: PERMISSIONS.MEMBERS_READ, name: 'Lihat Member', description: 'Melihat daftar member dan pelanggan, tanpa mengubah' },
  { code: PERMISSIONS.MEMBERS_MANAGE, name: 'Kelola Member', description: 'Membuat dan mengubah data member serta masa berlaku membership' },
  { code: PERMISSIONS.PAYMENTS_MANAGE, name: 'Kelola Pembayaran', description: 'Menyetujui, menolak, dan mengelola tautan pembayaran' },

  // ===== Verifikasi =====
  { code: PERMISSIONS.IDENTITY_VERIFY, name: 'Verifikasi Identitas', description: 'Memproses antrean verifikasi identitas warga kampus' },

  {
    code: PERMISSIONS.GYM_CHECKIN,
    name: 'Check-in Gym',
    description: 'Mencatat kehadiran member di meja gym (termasuk mengizinkan masuk ulang dengan alasan) dan melihat analitik kunjungan'
  },

  // ===== Sistem =====
  // Dua permission ini BARU dan sengaja ditambahkan. Di Laravel, RoleController::index dan
  // UserController::index tidak punya gate baca sama sekali di luar middleware role: grup
  // admin — kelima role staff bisa membuka layar Role & Access dan Internal Users. Operasi
  // tulisnya memang dibatasi, tapi lewat hasRole('Administrator') yang di-hardcode sehingga
  // tidak bisa diekspresikan matriks RBAC. Dua permission di bawah menutup celah itu dan
  // di-enforce di server; gate di FE hanya UX.
  { code: PERMISSIONS.RBAC_MANAGE, name: 'Kelola Role & Akses', description: 'Membuka dan mengubah matriks role beserta permission-nya' },
  { code: PERMISSIONS.USERS_MANAGE, name: 'Kelola Pengguna Internal', description: 'Membuka dan mengelola akun staf internal' }
]

/** Semua kode permission, urut sesuai ALL_PERMISSIONS. */
export const PERMISSION_CODES: PermissionCode[] = ALL_PERMISSIONS.map((permission) => permission.code)

// ===== Role staff =====

export const STAFF_ROLES = ['Administrator', 'Manager', 'Finance', 'Staff Central', 'Staff Front Office'] as const

export type StaffRoleName = (typeof STAFF_ROLES)[number]

/** Role berakses penuh. Administrator mem-bypass seluruh pengecekan permission di middleware. */
export const ADMINISTRATOR_ROLE: StaffRoleName = 'Administrator'

// ===== Matriks role -> permission =====
//
// Verbatim dari $matrix di RoleAndPermissionSeeder.php. Administrator dan Manager memegang
// SEMUA permission, termasuk rbac.manage dan users.manage yang baru; tiga role sisanya tidak.
// Ini nilai default saat seeding — setelah itu tabel role_permissions yang jadi otoritas,
// sehingga matriks bisa digeser dari panel admin tanpa deploy.

export const ROLE_PERMISSIONS: Record<StaffRoleName, PermissionCode[]> = {
  // Disalin, bukan referensi langsung ke PERMISSION_CODES: satu pemanggil yang menyortir atau
  // mem-push array ini tidak boleh ikut merusak katalog permission.
  Administrator: [...PERMISSION_CODES],

  Manager: [...PERMISSION_CODES],

  Finance: [PERMISSIONS.STATS_READ, PERMISSIONS.REPORTS_READ, PERMISSIONS.BOOKINGS_READ, PERMISSIONS.MEMBERS_READ, PERMISSIONS.PAYMENTS_MANAGE],

  'Staff Central': [
    PERMISSIONS.BOOKINGS_READ,
    PERMISSIONS.BOOKINGS_MANAGE,
    PERMISSIONS.FACILITIES_READ,
    PERMISSIONS.CMS_MANAGE,
    PERMISSIONS.MEMBERS_READ,
    PERMISSIONS.GYM_CHECKIN
  ],

  'Staff Front Office': [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.IDENTITY_VERIFY, PERMISSIONS.GYM_CHECKIN]
}

// ===== Helper =====

/** Benar bila role adalah Administrator. Administrator melewati semua pengecekan permission. */
export const isAdministrator = (roleName?: string | null): boolean => roleName === ADMINISTRATOR_ROLE

/**
 * Permission default sebuah role. Dipakai seeder Fase 1 dan sebagai fallback bila tabel
 * role_permissions belum punya entri untuk role tersebut.
 *
 * Menyimpang dari boilerplate yang mengembalikan set "base" untuk role tak dikenal: di sini
 * role tak dikenal mendapat array kosong (fail-closed). UBSC tidak punya satu pun permission
 * yang aman diberikan tanpa disebut di matriks.
 */
export const getDefaultPermissionsByRole = (roleName?: string | null): PermissionCode[] => {
  if (!roleName) return []
  return ROLE_PERMISSIONS[roleName as StaffRoleName] ?? []
}

/** Benar bila kode yang diberikan memang permission yang dikenal sistem. */
export const isPermissionCode = (code: string): code is PermissionCode => (PERMISSION_CODES as string[]).includes(code)
