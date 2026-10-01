import { createHash } from 'crypto'
import type { Request } from 'express'
import type { AdminNotificationItemDto, AdminNotificationTone, AdminNotificationsDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { PERMISSIONS, STAFF_ROLES } from '../config/permissions'
import { isBypassed } from '../middleware/permission-middleware'
import type { UserRequest } from '../type/user-request'
import { addDays, dateOnly, dateOnlyToString, formatInstant, jakartaDate, now } from '../utils/clock'
import { NotificationAdminValidation } from '../validation/notification-admin-validation'
import { Validation } from '../validation/Validation'
import { timeAgoId } from './dashboard-services'

// ============================================================================
// === Notification center admin — port App\Support\AdminNotificationCenter ===
// ============================================================================
// Tiga aksi Admin\NotificationController (index / markRead / clearRead) dipetakan satu-satu ke
// tiga fungsi di bawah. Enam pembangun item Laravel diport verbatim: judul, deskripsi, nada,
// prioritas, dan bahan sidik jarinya sama persis.
//
// ===== Bahasa =====
// Judul dan deskripsi Laravel DI-HARDCODE bahasa Inggris ("Identity review waiting",
// "2 members need document verification.") — bukan lewat lang file, jadi disalin apa adanya demi
// paritas 1:1. Yang berbahasa Indonesia hanya `time`, karena di sana Laravel memanggil
// Carbon `diffForHumans()` dan APP_LOCALE=id ("2 jam yang lalu"). Helper-nya `timeAgoId` yang
// sudah diekspor dashboard-services — satu implementasi, bukan salinan kedua.
//
// ===== Flash items TIDAK diport =====
// `AdminNotificationCenter::flashItems()` menyulap flash session `success`/`error` request
// berjalan menjadi item notifikasi. Arsitektur ini stateless JWT: tidak ada session, tidak ada
// flash, dan panel admin sudah menampilkan hasil aksi sebagai toast di tempat. Tidak ada
// pengganti yang dikarang di sini — `operationalItems` saja yang tersisa.
//
// Konsekuensinya: `source: 'System'` (AdminNotificationCenter baris 126 dan 141) TIDAK pernah muncul
// dari API ini — kedua kemunculannya ada di dalam flashItems(), bukan di pembangun operasional.
// Sama halnya, kedua item flash itu satu-satunya yang tidak punya `href`/`actionLabel`; keenam item
// operasional SELALU punya keduanya, sehingga `actionLabel: string | null` di kontrak praktis tidak
// pernah bernilai null selama flash tidak dihidupkan kembali.
//
// ===== Persistensi read/dismissed =====
// Laravel menyimpan DUA peta { notificationId => fingerprint } di session: 'read' dan
// 'dismissed'. Di sini keduanya pindah ke tabel NotificationState dengan kolom `state`
// sebagai pemisah, dan @@unique([userId, notificationId, state]) sebagai kunci upsert-nya.
//
// Sidik jari (fingerprint) meng-encode ISI item, bukan identitasnya. Pencocokan read/dismissed
// SELALU membandingkan sidik jari yang tersimpan dengan sidik jari yang baru dihitung: begitu
// isinya berubah (jumlah antrean naik, ada transaksi gagal baru), sidik jarinya berubah dan item
// itu muncul lagi sebagai belum dibaca meski versi lamanya sudah dibaca atau dibuang.
//
// DEVIASI YANG DISENGAJA: state ini sekarang bertahan melewati logout, sedangkan milik Laravel
// ikut mati bersama session. Tidak terhindarkan tanpa menghidupkan kembali session di server.

// ===== Konstanta dari Laravel =====

/** `->take(8)` di visibleItems(). Dengan flash dibuang, maksimal item operasional memang 6. */
const MAX_ITEMS = 8

/** Laravel: `Transaction::where('updated_at', '>=', now()->subDays(7))`. */
const FAILED_PAYMENT_WINDOW_DAYS = 7

/** Laravel: `Transaction::where('created_at', '<=', now()->subMinutes(30))`. */
const UNPAID_AGING_MINUTES = 30

/** Laravel: `whereDate('end_date', '<=', today()->addDays(7))`. */
const MEMBERSHIP_EXPIRY_WINDOW_DAYS = 7

/**
 * Padanan `route('admin.*.index')` Ziggy. Prefix `ubsc-staff/` hilang karena panel admin kini
 * origin tersendiri — nilainya adalah path halaman Next (lihat src/config/routes.ts di ubsc-admin),
 * dan Topbar mendorongnya lewat `router.push`. Ditulis literal: repo API tidak boleh mengimpor
 * modul milik app admin.
 */
const ADMIN_PAGE = {
  identity: '/identity',
  bookings: '/bookings',
  finance: '/finance',
  memberships: '/memberships',
  news: '/news'
} as const

// ===== Bentuk internal =====

/** Item sebelum `read` diputuskan. `fingerprint` + `priority` dibuang oleh publicItem(). */
interface RawItem {
  id: string
  fingerprint: string
  title: string
  description: string
  time: string
  important: boolean
  tone: AdminNotificationTone
  source: string
  href: string | null
  actionLabel: string | null
  priority: number
}

interface ResolvedItem extends RawItem {
  read: boolean
}

type NotificationStateName = 'read' | 'dismissed'

/**
 * `emptyPayload()` Laravel. Fungsi, bukan konstanta: `generated_at` dihitung ULANG setiap panggilan
 * (`now()->toIso8601String()`), jadi objek bersama yang dibekukan sekali saat modul dimuat akan
 * membuat Topbar mengira sinkronisasi terakhir terjadi saat proses API booting.
 */
function emptyPayload(): AdminNotificationsDto {
  return { items: [], unreadCount: 0, importantCount: 0, generatedAt: generatedAtIso(now()) }
}

// ===== Helper =====

/**
 * `sha1($id . '|' . implode('|', array_map(fn ($part) => (string) $part, $parts)))`.
 *
 * `(string) null` di PHP adalah '' — makanya null/undefined di sini juga dipetakan ke string kosong,
 * bukan ke 'null'. Salah di titik ini berarti sidik jari berbeda dari Laravel untuk baris yang sama.
 */
function fingerprint(id: string, parts: (string | number | null | undefined)[]): string {
  const body = parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('|')
  return createHash('sha1').update(`${id}|${body}`).digest('hex')
}

/**
 * `generated_at` — padanan `now()->toIso8601String()`.
 *
 * DEVIASI BENTUK (bukan nilai): Carbon menulis offset zona aplikasi ('2026-09-23T14:30:00+07:00'),
 * `toISOString()` menulis bentuk Z UTC ('2026-09-23T07:30:00.000Z'). Keduanya ISO 8601 yang sah dan
 * menunjuk INSTAN yang sama; bentuk Z dipilih karena itulah konvensi seluruh repo ini (lihat
 * staff-profile-services.ts, payment-services.ts, booking-services.ts). Topbar hanya menyimpannya
 * sebagai penanda "terakhir disinkronkan" dan tidak pernah mem-parse-nya.
 */
function generatedAtIso(at: Date): string {
  return at.toISOString()
}

/** `countBucket()` Laravel — meredam sidik jari finansial supaya tidak berubah tiap satu baris. */
function countBucket(count: number): string {
  if (count >= 50) return '50+'
  if (count >= 25) return '25-49'
  if (count >= 10) return '10-24'
  if (count >= 5) return '5-9'
  return String(count)
}

/**
 * `canSee()` Laravel: Administrator selalu true, selain itu cukup SATU permission yang cocok.
 *
 * Nama permission Laravel ('verify-identity', 'view-reports', ...) sudah dipetakan ke dot-code lewat
 * LARAVEL_PERMISSION_MAP di shared/permissions.ts; yang dipakai di bawah adalah dot-code-nya.
 *
 * Ini gate IMPERATIF (visibilitas per ITEM, bukan per baris route), jadi bypass Administrator dan
 * x-service-key diambil dari `isBypassed` middleware — tidak disalin ulang.
 */
function canSee(req: Request, codes: string[]): boolean {
  if (isBypassed(req)) return true

  const permissions = (req as UserRequest).permissions ?? []
  return codes.some((code) => permissions.includes(code))
}

/** `$user->hasAnyRole(self::STAFF_ROLES)` — daftar rolenya identik dengan STAFF_ROLES shared. */
function isStaffRole(roleName: string | null | undefined): boolean {
  return !!roleName && (STAFF_ROLES as readonly string[]).includes(roleName)
}

/**
 * `$date->diffForHumans()` Carbon (locale id) untuk waktu yang bisa berada di MASA DEPAN.
 *
 * `timeAgoId` menjepit selisih negatif ke 0, jadi tidak bisa dipakai apa adanya untuk end_date
 * membership yang biasanya masih di depan. Tangga satuannya tidak disalin ulang: argumen `timeAgoId`
 * dibalik lalu sufiksnya diganti, persis seperti Carbon yang memakai satu tangga satuan untuk
 * ':time yang lalu' dan ':time dari sekarang' (vendor/nesbot/carbon/src/Carbon/Lang/id.php).
 */
function relativeTimeId(target: Date, at: Date): string {
  if (target.getTime() <= at.getTime()) return timeAgoId(target, at)
  return `${timeAgoId(at, target).replace(/ yang lalu$/, '')} dari sekarang`
}

// ===== Pembangun item operasional =====
// Urutan pemanggilan mengikuti operationalItems() Laravel. Setiap pembangun mengulang pola yang
// sama: gate permission -> hitung -> keluar bila 0 -> ambil baris penanda -> rakit item.
//
// Laravel menghitung dulu baru mengambil baris penanda; di sini keduanya dijalankan berbarengan
// (Promise.all) karena hasilnya identik dan menghemat satu round-trip. `count < 1` tetap yang
// memutuskan item muncul atau tidak, jadi baris penanda yang terlanjur diambil hanya dibuang.
//
// Setiap `latest('updated_at')` Laravel diberi kunci urut kedua (id desc) — TAMBAHAN yang sama
// dengan identity-admin-services.ts: Laravel hanya memberi satu kunci sehingga dua baris dengan
// updatedAt identik keluar dalam urutan tak tentu. Himpunan dan urutan utamanya tidak berubah,
// hanya jadi deterministik — penting di sini karena baris itu ikut menentukan sidik jari.

async function pendingIdentityItem(req: Request, at: Date): Promise<RawItem | null> {
  if (!canSee(req, [PERMISSIONS.IDENTITY_VERIFY])) return null

  // Predikat yang sama dengan kartu `pendingIdentities` di dashboard-services.getDashboard().
  const where = { identityStatus: 'pending' } as const
  const [count, latest] = await Promise.all([
    prismaClient.user.count({ where }),
    prismaClient.user.findFirst({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { updatedAt: true } })
  ])
  if (count < 1) return null

  const id = 'identity.pending'
  return {
    id,
    // `optional($latest?->updated_at)->timestamp` — detik unix, bukan milidetik.
    fingerprint: fingerprint(id, [count, latest ? Math.floor(latest.updatedAt.getTime() / 1000) : null]),
    title: 'Identity review waiting',
    description: `${count} member${count > 1 ? 's need' : ' needs'} document verification.`,
    time: latest ? timeAgoId(latest.updatedAt, at) : 'Today',
    important: true,
    tone: 'warning',
    source: 'Identity',
    href: ADMIN_PAGE.identity,
    actionLabel: 'Review',
    priority: 90
  }
}

async function pendingBookingItem(req: Request, at: Date): Promise<RawItem | null> {
  if (!canSee(req, [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_MANAGE])) return null

  // `whereDate('booking_date', '>=', today())` — "hari ini" dihitung di jam Jakarta (R13),
  // lalu dipetakan ke bentuk tengah malam UTC yang dipakai kolom @db.Date.
  const where = { status: 'pending', bookingDate: { gte: dateOnly(jakartaDate(at)) } } as const
  const [count, latest] = await Promise.all([
    prismaClient.booking.count({ where }),
    prismaClient.booking.findFirst({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { updatedAt: true } })
  ])
  if (count < 1) return null

  const id = 'booking.pending'
  return {
    id,
    fingerprint: fingerprint(id, [count, latest ? Math.floor(latest.updatedAt.getTime() / 1000) : null]),
    title: 'Bookings need confirmation',
    description: `${count} upcoming booking${count > 1 ? 's are' : ' is'} still pending.`,
    time: latest ? timeAgoId(latest.updatedAt, at) : 'Today',
    important: true,
    tone: 'warning',
    source: 'Bookings',
    href: ADMIN_PAGE.bookings,
    actionLabel: 'Open',
    priority: 85
  }
}

async function failedPaymentItem(req: Request, at: Date): Promise<RawItem | null> {
  if (!canSee(req, [PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYMENTS_MANAGE])) return null

  const since = new Date(at.getTime() - FAILED_PAYMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const where = { paymentStatus: 'FAILED', updatedAt: { gte: since } } as const
  const [count, latest] = await Promise.all([
    prismaClient.transaction.count({ where }),
    prismaClient.transaction.findFirst({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { updatedAt: true } })
  ])
  if (count < 1) return null

  const id = 'payment.failed.7d'
  return {
    id,
    // `format('Y-m-d-H')` — presisi JAM, di zona aplikasi (Asia/Jakarta), bukan timestamp penuh.
    fingerprint: fingerprint(id, [countBucket(count), latest ? formatInstant(latest.updatedAt, 'Y-m-d-H') : null]),
    title: 'Failed payments detected',
    description: `${count} payment${count > 1 ? 's' : ''} failed in the last 7 days.`,
    time: latest ? timeAgoId(latest.updatedAt, at) : 'This week',
    important: true,
    tone: 'critical',
    source: 'Finance',
    href: ADMIN_PAGE.finance,
    actionLabel: 'Inspect',
    priority: 95
  }
}

async function unpaidTransactionItem(req: Request, at: Date): Promise<RawItem | null> {
  if (!canSee(req, [PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYMENTS_MANAGE])) return null

  const until = new Date(at.getTime() - UNPAID_AGING_MINUTES * 60 * 1000)
  const where = { paymentStatus: 'UNPAID', createdAt: { lte: until } } as const
  const [count, latest] = await Promise.all([
    prismaClient.transaction.count({ where }),
    prismaClient.transaction.findFirst({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } })
  ])
  if (count < 1) return null

  const id = 'payment.unpaid.30m'
  return {
    id,
    // Hanya bucket jumlah: Laravel sengaja TIDAK memasukkan waktu di sini, sehingga item ini tidak
    // muncul lagi sebagai belum dibaca setiap kali ada satu invoice baru menua.
    fingerprint: fingerprint(id, [countBucket(count)]),
    title: 'Unpaid invoices aging',
    description: `${count} invoice${count > 1 ? 's have' : ' has'} not been paid after 30 minutes.`,
    time: latest ? timeAgoId(latest.createdAt, at) : 'Today',
    important: false,
    tone: 'info',
    source: 'Finance',
    href: ADMIN_PAGE.finance,
    actionLabel: 'Check',
    priority: 55
  }
}

async function expiringMembershipItem(req: Request, at: Date): Promise<RawItem | null> {
  if (!canSee(req, [PERMISSIONS.MEMBERS_READ, PERMISSIONS.MEMBERS_MANAGE])) return null

  // `whereDate('end_date', '>=', today())` + `<= today()->addDays(7)` — rentang INKLUSIF di kedua
  // ujung, dihitung di kalender Jakarta lalu dipetakan ke tengah malam UTC milik kolom @db.Date.
  const today = jakartaDate(at)
  const where = { status: 'active', endDate: { gte: dateOnly(today), lte: dateOnly(addDays(today, MEMBERSHIP_EXPIRY_WINDOW_DAYS)) } } as const
  const [count, nearest] = await Promise.all([
    prismaClient.membership.count({ where }),
    // `orderBy('end_date')` — menaik, jadi yang TERDEKAT berakhir.
    prismaClient.membership.findFirst({ where, orderBy: [{ endDate: 'asc' }, { id: 'asc' }], select: { endDate: true } })
  ])
  if (count < 1) return null

  const id = 'membership.expiring.7d'
  return {
    id,
    fingerprint: fingerprint(id, [count, nearest ? dateOnlyToString(nearest.endDate) : null]),
    title: 'Memberships expiring soon',
    description: `${count} active membership${count > 1 ? 's are' : ' is'} ending within 7 days.`,
    // Satu-satunya item yang waktunya bisa di MASA DEPAN (end_date >= hari ini) — lihat relativeTimeId.
    time: nearest ? relativeTimeId(nearest.endDate, at) : 'This week',
    important: false,
    tone: 'info',
    source: 'Membership',
    href: ADMIN_PAGE.memberships,
    actionLabel: 'View',
    priority: 50
  }
}

async function activeBannerItem(req: Request, at: Date): Promise<RawItem | null> {
  if (!canSee(req, [PERMISSIONS.CMS_MANAGE])) return null

  // `InfoBanner::active()` = scopeActive: where('is_active', true).
  const where = { isActive: true } as const
  const [count, latest] = await Promise.all([
    prismaClient.infoBanner.count({ where }),
    prismaClient.infoBanner.findFirst({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { updatedAt: true } })
  ])
  if (count < 1) return null

  const id = 'banner.active'
  return {
    id,
    fingerprint: fingerprint(id, [count]),
    title: 'Public info banner active',
    description: `${count} announcement banner${count > 1 ? 's are' : ' is'} visible on the public site.`,
    time: latest ? timeAgoId(latest.updatedAt, at) : 'Today',
    important: false,
    tone: 'success',
    source: 'Content',
    href: ADMIN_PAGE.news,
    actionLabel: 'Manage',
    priority: 30
  }
}

/** `operationalItems()` — enam pembangun, urutan verbatim, yang null dibuang. */
async function operationalItems(req: Request, at: Date): Promise<RawItem[]> {
  const built = await Promise.all([
    pendingIdentityItem(req, at),
    pendingBookingItem(req, at),
    failedPaymentItem(req, at),
    unpaidTransactionItem(req, at),
    expiringMembershipItem(req, at),
    activeBannerItem(req, at)
  ])

  return built.filter((item): item is RawItem => item !== null)
}

// ===== visibleItems =====

/**
 * `visibleItems()` Laravel, dengan session diganti tabel NotificationState.
 *
 * Perbandingannya sengaja `state.fingerprint === item.fingerprint`, bukan sekadar "ada barisnya":
 * itulah yang membuat item muncul kembali begitu isinya berubah. Baris dengan sidik jari basi
 * dibiarkan saja — ia akan ditimpa upsert berikutnya, dan sementara itu tidak berpengaruh apa pun.
 */
async function visibleItems(req: Request, userId: string, at: Date): Promise<ResolvedItem[]> {
  const raw = await operationalItems(req, at)
  if (raw.length === 0) return []

  const states = await prismaClient.notificationState.findMany({
    where: { userId, notificationId: { in: raw.map((item) => item.id) } },
    select: { notificationId: true, fingerprint: true, state: true }
  })

  const byState = (name: NotificationStateName): Map<string, string> =>
    new Map(states.filter((row) => row.state === name).map((row) => [row.notificationId, row.fingerprint]))
  const readFingerprints = byState('read')
  const dismissedFingerprints = byState('dismissed')

  return (
    raw
      .filter((item) => dismissedFingerprints.get(item.id) !== item.fingerprint)
      .map((item) => ({ ...item, read: readFingerprints.get(item.id) === item.fingerprint }))
      // `sortByDesc(priority)` Laravel stabil; Array.prototype.sort juga stabil sejak ES2019, dan
      // keenam prioritasnya memang unik — jadi tidak ada ambiguitas urutan.
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_ITEMS)
  )
}

/** `publicItem()` — buang `fingerprint` dan `priority`, keduanya detail internal. */
function publicItem(item: ResolvedItem): AdminNotificationItemDto {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    time: item.time,
    read: item.read,
    tone: item.tone,
    href: item.href,
    important: item.important,
    source: item.source,
    actionLabel: item.actionLabel
  }
}

/** Upsert satu himpunan sidik jari. Satu transaksi supaya "tandai semua" tidak setengah jalan. */
async function persistStates(userId: string, state: NotificationStateName, items: ResolvedItem[]): Promise<void> {
  if (items.length === 0) return

  await prismaClient.$transaction(
    items.map((item) =>
      prismaClient.notificationState.upsert({
        where: { userId_notificationId_state: { userId, notificationId: item.id, state } },
        update: { fingerprint: item.fingerprint },
        create: { userId, notificationId: item.id, state, fingerprint: item.fingerprint }
      })
    )
  )
}

/**
 * Resolusi `$ids` menjadi item nyata. Dua aturan Laravel sekaligus:
 *   1. `$ids ?: $fallback` — absen, null, DAN array kosong sama-sama jatuh ke fallback (`?:` PHP).
 *   2. `->filter(fn ($id) => $currentItems->contains('id', $id))` — id yang tidak sedang terlihat
 *      dibuang diam-diam, bukan error. Item yang sudah dismissed pun tidak ada di `current`,
 *      sehingga tidak bisa ditandai read dari luar.
 */
function resolveTargets(current: ResolvedItem[], ids: string[] | null | undefined, fallback: ResolvedItem[]): ResolvedItem[] {
  if (!ids || ids.length === 0) return fallback

  const requested = new Set(ids)
  return current.filter((item) => requested.has(item.id))
}

/** Pemilik state. Tanpa user (mis. panggilan x-service-key) tidak ada yang bisa disimpan. */
function stateOwner(req: Request): { id: string } | null {
  const user = (req as UserRequest).user
  if (!user || !isStaffRole(user.role?.name)) return null
  return { id: user.id }
}

// ===== 1. Index — `for($request)` =====

export async function getAdminNotifications(req: Request): Promise<AdminNotificationsDto> {
  const owner = stateOwner(req)
  if (!owner) return emptyPayload()

  const at = now()
  const items = await visibleItems(req, owner.id, at)

  return {
    items: items.map(publicItem),
    unreadCount: items.filter((item) => !item.read).length,
    // `$items->where('important', true)->count()` — dihitung SETELAH pemotongan take(8), jadi ia
    // menghitung yang benar-benar dikirim, bukan seluruh item yang sempat dibangun.
    importantCount: items.filter((item) => item.important).length,
    // Laravel memanggil `now()` lagi di sini; `at` yang sama dipakai supaya stempel waktunya
    // konsisten dengan `time` relatif pada item di payload yang sama.
    generatedAt: generatedAtIso(at)
  }
}

// ===== 2. markRead =====

/**
 * `ids` kosong/absen -> SEMUA item yang sedang terlihat ditandai dibaca.
 *
 * Balasannya adalah payload yang DIHITUNG ULANG (`return $this->for($request)` Laravel), bukan
 * tambalan di memori — jadi jumlah dan isinya sudah memperhitungkan apa pun yang berubah di
 * antara dua perhitungan itu.
 */
export async function markAdminNotificationsRead(req: Request, request: unknown): Promise<AdminNotificationsDto> {
  const v = Validation.validate(NotificationAdminValidation.IDS, request)

  const owner = stateOwner(req)
  if (!owner) return emptyPayload()

  const current = await visibleItems(req, owner.id, now())
  await persistStates(owner.id, 'read', resolveTargets(current, v.ids, current))

  return getAdminNotifications(req)
}

// ===== 3. clearRead =====

/**
 * PERHATIAN pada default-nya: Laravel memakai
 * `$currentItems->where('read', true)->pluck('id')`, jadi tanpa `ids` yang dibuang HANYA item yang
 * SUDAH dibaca — bukan semua item yang terlihat. Itu yang membuat tombol "clear" di Topbar
 * membersihkan riwayat yang sudah dilihat tanpa menelan peringatan yang belum sempat dibaca.
 * Dengan `ids` eksplisit, item yang belum dibaca pun boleh dibuang.
 *
 * Item yang dibuang hilang dari daftar SAMPAI sidik jarinya berubah — bukan selamanya.
 */
export async function clearAdminNotificationsRead(req: Request, request: unknown): Promise<AdminNotificationsDto> {
  const v = Validation.validate(NotificationAdminValidation.IDS, request)

  const owner = stateOwner(req)
  if (!owner) return emptyPayload()

  const current = await visibleItems(req, owner.id, now())
  const alreadyRead = current.filter((item) => item.read)
  await persistStates(owner.id, 'dismissed', resolveTargets(current, v.ids, alreadyRead))

  return getAdminNotifications(req)
}
