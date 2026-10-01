import { Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import type { AdminRoleDto, AdminRoleIndexDto, AdminStaffUserDto, AdminStaffUserIndexDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { ADMINISTRATOR_ROLE, isAdministrator, STAFF_ROLES } from '../config/permissions'
import { ResponseError } from '../error/response-error'
import { FORBIDDEN_MESSAGE } from '../middleware/permission-middleware'
import { addMinutes, now } from '../utils/clock'
import { isUniqueViolation } from '../utils/prisma-errors'
import { ApiFieldErrors } from '../utils/respond'
import { INTERNAL_ROLES, SettingsAdminValidation } from '../validation/settings-admin-validation'
import { Validation } from '../validation/Validation'
import { getPermissionsByRole } from './permission-services'

// ============================================================================
// === Pengaturan sistem: Role & Access + Pengguna Internal (Fase 8G) ===
// ============================================================================
// Port Admin\RoleController (index/update) dan Admin\UserController (index/store/update/destroy).
//
// Laravel menjawab Inertia::render()/back(); di sini setiap aksi membalas DATA sesuai kontrak
// shared/contracts.ts bagian "Fase 8G" (AdminRoleIndexDto / AdminRoleDto / AdminStaffUserIndexDto /
// AdminStaffUserDto).
//
// GATE. Baris route memasang requirePermission(rbac.manage) / requirePermission(users.manage) seperti
// biasa. Di ATAS itu, Laravel masih punya `abort_unless(hasRole('Administrator'))` untuk setiap aksi
// TULIS — gate imperatif yang tidak bisa diekspresikan matriks RBAC. Gate itu diport apa adanya lewat
// assertAdministrator() di bawah, yang membaca `actor.bypass` = isBypassed(req) milik
// permission-middleware (Administrator ATAU x-service-key). Logika bypass TIDAK disalin ke sini:
// controller yang memanggil isBypassed() dan menyerahkan hasilnya, persis pola StaffGate di
// news-admin-services.ts.

/**
 * Pemanggil, dirakit controller dari requireUser(req) + isBypassed(req).
 *
 * `bypass` bernilai true untuk Administrator dan untuk jalur x-service-key. Di berkas ini bypass
 * SETARA dengan hasRole('Administrator') Laravel: seluruh endpoint di sini melewati requireUser(),
 * sehingga panggilan x-service-key tanpa user sudah ditolak 401 sebelum sampai ke service.
 */
export interface SettingsActor {
  id: string
  roleName: string | null
  bypass: boolean
}

/** Padanan `abort_unless(auth()->user()?->hasRole('Administrator'), 403, $pesan)`. */
function assertAdministrator(actor: SettingsActor, message: string): void {
  if (actor.bypass) return
  throw new ResponseError(403, message, 'FORBIDDEN')
}

// ============================================================================
// === 1. Role & Access ===
// ============================================================================

/** `RoleController::ROLE_ORDER` — Administrator memang tidak ada di daftar ini (ia disaring lebih dulu). */
const ROLE_ORDER: readonly string[] = ['Manager', 'Finance', 'Staff Central', 'Staff Front Office']

/** Jendela "sedang online". Laravel: `now()->subMinutes(15)` pada kolom sessions.last_activity. */
const ONLINE_WINDOW_MINUTES = 15

/**
 * `array_search($r->name, $order)` sebagai kunci sortBy Laravel.
 *
 * array_search mengembalikan FALSE untuk nama di luar daftar. Collection::sortBy membandingkan kunci
 * dengan `<=>`, dan PHP membandingkan bool vs int dengan mengonversi keduanya ke bool: false <=> 0
 * menghasilkan 0 (SAMA dengan 'Manager'), sedangkan false <=> 1|2|3 menghasilkan -1 (lebih kecil).
 * Artinya role tak dikenal berperilaku persis seperti rank 0 — itulah yang ditiru di sini.
 *
 * Kasusnya hanya tercapai bila tabel roles memuat nama di luar lima role staff; tidak ada di seeder.
 */
function roleOrderRank(name: string): number {
  const index = ROLE_ORDER.indexOf(name)
  return index === -1 ? 0 : index
}

/**
 * Padanan hitung tabel `sessions` Laravel.
 *
 * API ini stateless (JWT) dan TIDAK punya tabel sessions, jadi dipakai padanan yang didokumentasikan
 * di AdminRoleDto: RefreshToken beraudience 'staff', belum dicabut, lastUsedAt dalam 15 menit
 * terakhir, dihitung DISTINCT per user. Satu user dengan tiga perangkat tetap dihitung satu, sama
 * seperti `distinct('user_id')` Laravel.
 *
 * expiresAt sengaja tidak ikut disaring: token yang dipakai < 15 menit lalu secara praktis belum
 * kedaluwarsa (TTL refresh jauh di atas 15 menit), dan kontraknya hanya menyebut audience + revoked +
 * lastUsedAt.
 */
async function onlineCountByRoleId(roleIds: string[], at: Date): Promise<Map<string, number>> {
  if (roleIds.length === 0) return new Map()

  const tokens = await prismaClient.refreshToken.findMany({
    where: {
      audience: 'staff',
      revoked: false,
      lastUsedAt: { gte: addMinutes(at, -ONLINE_WINDOW_MINUTES) },
      user: { roleId: { in: roleIds } }
    },
    select: { userId: true, user: { select: { roleId: true } } },
    distinct: ['userId']
  })

  const counts = new Map<string, number>()
  for (const token of tokens) {
    const roleId = token.user.roleId
    if (!roleId) continue
    counts.set(roleId, (counts.get(roleId) ?? 0) + 1)
  }
  return counts
}

/**
 * `$r->permissions->pluck('name')->sort()->values()`.
 *
 * DUA keputusan yang perlu dicatat:
 *
 *  1. Laravel mengurutkan NAMA permission Spatie ('manage-bookings'). Skema ini memisahkan
 *     Permission.code (kunci mesin, mis. 'bookings.manage') dari Permission.name (label Indonesia,
 *     'Kelola Reservasi'). Yang dikirim adalah CODE — itulah nilai yang dipakai matriks RBAC,
 *     dicocokkan requirePermission, dan disebut `exists:permissions,name` pada versi Laravel-nya.
 *     Mengirim label Indonesia akan membuat layar RBAC tidak bisa mencocokkan satu pun kotak centang.
 *
 *  2. Dibaca lewat getPermissionsByRole() (permission-services.ts) alih-alih langsung dari tabel
 *     role_permissions. Fungsi itu jatuh ke default shared/permissions.ts bila sebuah role belum
 *     punya satu pun baris pivot — dan itu JUGA himpunan yang benar-benar diberikan auth-middleware.
 *     Membaca pivot mentah akan menampilkan matriks kosong untuk role yang efektif punya akses penuh.
 *     Satu implementasi, tidak ada salinan kedua.
 */
async function permissionCodesFor(roleName: string): Promise<string[]> {
  return [...(await getPermissionsByRole(roleName))].sort()
}

async function toRoleDto(role: { id: string; name: string; _count: { users: number } }, online: Map<string, number>): Promise<AdminRoleDto> {
  return {
    name: role.name,
    permissions: await permissionCodesFor(role.name),
    usersCount: role._count.users,
    onlineUsersCount: online.get(role.id) ?? 0
  }
}

const ROLE_SELECT = { id: true, name: true, _count: { select: { users: true } } } as const satisfies Prisma.RoleSelect

/** Muat ulang satu role dalam bentuk DTO index — dipakai balasan update. */
async function loadRoleDto(name: string): Promise<AdminRoleDto> {
  const role = await prismaClient.role.findUnique({ where: { name }, select: ROLE_SELECT })
  if (!role) throw new ResponseError(404, 'Role tidak ditemukan.')

  return toRoleDto(role, await onlineCountByRoleId([role.id], now()))
}

/**
 * GET /api/admin/settings/roles — `RoleController::index`.
 *
 * Administrator SELALU dikecualikan dari daftar (whereNotIn), dan pemanggil non-Administrator hanya
 * melihat role-nya sendiri (`->when(! hasRole('Administrator'), fn ($q) => $q->where('name', $roleName))`).
 *
 * Pemanggil non-Administrator tanpa role sama sekali: Laravel menghasilkan `where name = null` yang
 * di Eloquent berubah menjadi `whereNull('name')`, dan roles.name NOT NULL — hasilnya kosong. Cabang
 * early-return di bawah adalah padanannya (Prisma tidak mengizinkan `name: null` pada kolom non-null).
 *
 * orderBy name di query hanyalah tie-break DETERMINISTIK: `Role::...->get()` Laravel tidak memberi
 * urutan apa pun, lalu sortBy (uasort, stabil sejak PHP 8.0) mempertahankan urutan datang untuk rank
 * yang sama. Tanpa kunci awal yang pasti, dua role ber-rank sama bisa keluar berbeda antar-request.
 * Array.prototype.sort juga stabil, sehingga hasil akhirnya sepadan.
 */
export async function listRoles(actor: SettingsActor): Promise<AdminRoleIndexDto> {
  const at = now()
  const ownRole = actor.roleName

  if (!actor.bypass && !ownRole) return { roles: [] }

  const where: Prisma.RoleWhereInput = actor.bypass
    ? { name: { notIn: [ADMINISTRATOR_ROLE] } }
    : { AND: [{ name: { notIn: [ADMINISTRATOR_ROLE] } }, { name: ownRole as string }] }

  const roles = await prismaClient.role.findMany({ where, select: ROLE_SELECT, orderBy: { name: 'asc' } })

  const online = await onlineCountByRoleId(
    roles.map((role) => role.id),
    at
  )

  const sorted = [...roles].sort((a, b) => roleOrderRank(a.name) - roleOrderRank(b.name))

  return { roles: await Promise.all(sorted.map((role) => toRoleDto(role, online))) }
}

/**
 * PUT /api/admin/settings/roles/:name — `RoleController::update`.
 *
 * URUTAN PENOLAKAN mengikuti Laravel apa adanya:
 *   1. role tidak ada          -> 404 (SubstituteBindings berjalan SEBELUM aksi, jadi ia mendahului
 *                                 kedua abort di bawah)
 *   2. bukan Administrator     -> 403 'Hanya Administrator yang dapat mengubah hak akses.'
 *   3. targetnya Administrator -> 403 'Hak akses Administrator tidak dapat diubah.'
 *   4. validasi payload        -> 422
 *
 * Kuncinya NAMA role, bukan uuid: RolePermission.roleName memang menyimpan nama (lihat skema), dan
 * AdminRoleDto pun tidak membawa id.
 *
 * TIDAK ADA CACHE PERMISSION YANG PERLU DIBERSIHKAN. Laravel memanggil
 * PermissionRegistrar::forgetCachedPermissions() karena Spatie meng-cache tabel permission 24 jam.
 * Di repo ini getPermissionsByRole() adalah query langsung ke role_permissions dan dipanggil ulang
 * pada SETIAP request oleh auth-middleware.ts:53 — tidak ada lapisan cache, tidak ada TTL, dan
 * permission tidak ditanam di dalam access token. Perubahan di sini berlaku pada request berikutnya.
 * Satu-satunya salinan basi adalah snapshot /api/admin/me di memori browser, yang urusan FE.
 */
export async function updateRolePermissions(actor: SettingsActor, roleName: string, request: unknown): Promise<AdminRoleDto> {
  const role = await prismaClient.role.findUnique({ where: { name: roleName }, select: { id: true, name: true } })
  if (!role) throw new ResponseError(404, 'Role tidak ditemukan.')

  assertAdministrator(actor, 'Hanya Administrator yang dapat mengubah hak akses.')

  if (isAdministrator(role.name)) throw new ResponseError(403, 'Hak akses Administrator tidak dapat diubah.', 'FORBIDDEN')

  const v = Validation.validate(SettingsAdminValidation.ROLE_PERMISSIONS, request)

  // `exists:permissions,name` -> di sini dicocokkan ke Permission.code (lihat permissionCodesFor).
  const known = await prismaClient.permission.findMany({ where: { code: { in: v.permissions } }, select: { id: true, code: true } })
  const idByCode = new Map(known.map((permission) => [permission.code, permission.id]))

  // Kunci field ditulis per-index ('permissions.0') supaya bentuknya identik dengan pesan
  // `permissions.*` Laravel dan applyApiErrors() menempel ke baris yang tepat.
  const fields: ApiFieldErrors = {}
  v.permissions.forEach((code, index) => {
    if (!idByCode.has(code)) fields[`permissions.${index}`] = ['Hak akses yang dipilih tidak dikenal.']
  })
  if (Object.keys(fields).length > 0) {
    throw new ResponseError(422, 'Hak akses yang dipilih tidak dikenal.', 'VALIDATION_ERROR', fields)
  }

  // syncPermissions(): himpunan akhir PERSIS sama dengan yang dikirim. Duplikat di payload dibuang —
  // @@unique([roleName, permissionId]) akan menolaknya, dan Laravel pun menganggapnya satu.
  const permissionIds = Array.from(new Set(v.permissions.map((code) => idByCode.get(code) as string)))

  // Hapus-lalu-tulis dalam satu transaksi: kalau createMany gagal di tengah, role tidak boleh
  // tertinggal tanpa satu pun permission.
  await prismaClient.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany({ where: { roleName: role.name } })
    await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleName: role.name, permissionId })) })
  })

  return loadRoleDto(role.name)
}

// ============================================================================
// === 2. Pengguna internal (staf) ===
// ============================================================================

/** `UserController::STAFF_ROLE_ORDER` — perhatikan Administrator ada di posisi KEDUA, bukan pertama. */
const STAFF_ROLE_ORDER: readonly string[] = ['Manager', 'Administrator', 'Finance', 'Staff Central', 'Staff Front Office']

/** `array_search(..., true) === false ? 999 : $rank` — di sini strict, jadi tak dikenal benar-benar 999. */
function staffRoleRank(roleName: string): number {
  const index = STAFF_ROLE_ORDER.indexOf(roleName)
  return index === -1 ? 999 : index
}

const STAFF_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
  role: { select: { name: true } }
} as const satisfies Prisma.UserSelect

type StaffUserRow = Prisma.UserGetPayload<{ select: typeof STAFF_USER_SELECT }>

/**
 * `User::getAvatarUrlAttribute()` apa adanya:
 *   - avatar falsy ('' maupun null) -> null
 *   - diawali 'http://', 'https://' atau '/' -> dipakai apa adanya
 *   - selain itu -> diawali '/storage/'
 *
 * Str::startsWith PHP bersifat case-SENSITIVE, jadi 'HTTP://...' memang jatuh ke cabang /storage/ —
 * kejanggalan Laravel yang sengaja ikut diport.
 *
 * Dua catatan:
 *   - Laravel memakai asset('storage/'.$avatar) yang menghasilkan URL ABSOLUT (APP_URL + path).
 *     Di sini dipakai bentuk root-relatif '/storage/...', sama dengan keputusan avatar penulis berita
 *     di Fase 8F (news-admin-services.ts) — ubsc-api tidak punya helper asset() dan tidak perlu
 *     menebak host publik.
 *   - '/storage' TIDAK di-mount oleh API ini. Nilainya tetap dikirim 1:1 karena kontrak
 *     AdminStaffUserDto menjanjikannya dan FE hanya memakainya sebagai petunjuk; avatar staf di
 *     layar ini jatuh ke inisial nama bila gambarnya gagal dimuat.
 */
const ABSOLUTE_AVATAR_PREFIXES: readonly string[] = ['http://', 'https://', '/']

function avatarUrlFor(avatar: string | null): string | null {
  if (!avatar) return null
  return ABSOLUTE_AVATAR_PREFIXES.some((prefix) => avatar.startsWith(prefix)) ? avatar : `/storage/${avatar}`
}

/** map(fn (User $u) => [...]) Laravel. `getRoleNames()->first() ?? ''` -> role?.name ?? ''. */
function toStaffUser(row: StaffUserRow): AdminStaffUserDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role?.name ?? '',
    avatar: row.avatar,
    avatarUrl: avatarUrlFor(row.avatar)
  }
}

/**
 * Terjemahkan nama role internal -> roles.id.
 *
 * Aturan `in:` di validasi sudah memastikan namanya salah satu dari empat role internal, jadi cabang
 * "tidak ditemukan" hanya tercapai bila tabel roles belum di-seed. Dibalas 422 yang menempel ke field
 * `role` alih-alih 500, supaya panel menampilkan sebab yang bisa dibaca.
 */
async function internalRoleIdFor(name: string): Promise<string> {
  const role = await prismaClient.role.findUnique({ where: { name }, select: { id: true } })
  if (!role) throw new ResponseError(422, 'Role tidak ditemukan.', 'VALIDATION_ERROR', { role: ['Role tidak ditemukan.'] })
  return role.id
}

const EMAIL_TAKEN = 'Email sudah terdaftar.'

/**
 * `unique:users,email` dan `unique:users,email,{$user->id}`.
 *
 * Dibalas 422 VALIDATION_ERROR — bukan 409 CONFLICT seperti registerAuth() di registration-services.ts.
 * Laravel memang menjawab 422 untuk aturan unique, dan form panel staf menampilkannya sebagai error
 * field biasa. Pemeriksaan ini balapan secara teori, karena itu P2002 pada indeks email ditangkap di
 * createStaffUser()/updateStaffUser() dan dijatuhkan ke pesan yang sama.
 */
async function assertEmailAvailable(email: string, exceptUserId?: string): Promise<void> {
  const existing = await prismaClient.user.findUnique({ where: { email }, select: { id: true } })
  if (existing && existing.id !== exceptUserId) {
    throw new ResponseError(422, EMAIL_TAKEN, 'VALIDATION_ERROR', { email: [EMAIL_TAKEN] })
  }
}

function emailConflict(error: unknown): ResponseError | null {
  return isUniqueViolation(error, 'email') ? new ResponseError(422, EMAIL_TAKEN, 'VALIDATION_ERROR', { email: [EMAIL_TAKEN] }) : null
}

/**
 * GET /api/admin/settings/users — `UserController::index`.
 *
 * Laravel menggerbangi aksi ini dengan `hasAnyRole(STAFF_ROLES)`, yaitu "siapa pun yang staf" — bukan
 * permission. Di sini gerbangnya users.manage di baris route (bug 10 di shared/permissions.ts:
 * hasRole yang di-hardcode tidak bisa diatur matriks). `canManageUsers` tetap dikirim karena
 * tombol tulis di panel butuh tahu apakah pemanggil Administrator.
 *
 * Urutannya DUA tahap, persis Laravel: orderBy('name') di SQL, lalu sortBy(rank) yang stabil di
 * aplikasi. Array.prototype.sort stabil (V8), sama seperti uasort PHP 8, sehingga di dalam satu role
 * urutan nama tetap terjaga.
 */
export async function listStaffUsers(actor: SettingsActor): Promise<AdminStaffUserIndexDto> {
  const rows = await prismaClient.user.findMany({
    where: { role: { name: { in: [...STAFF_ROLES] } } },
    select: STAFF_USER_SELECT,
    orderBy: { name: 'asc' }
  })

  const users = rows.map(toStaffUser).sort((a, b) => staffRoleRank(a.role) - staffRoleRank(b.role))

  return { users, roles: [...INTERNAL_ROLES], canManageUsers: actor.bypass }
}

/**
 * POST /api/admin/settings/users — `UserController::store`.
 *
 * `email_verified_at => now()` diport apa adanya: akun staf dibuat oleh Administrator, jadi tidak
 * perlu (dan tidak bisa) memverifikasi emailnya sendiri.
 *
 * Password di-hash bcrypt cost 10 lewat bcryptjs — MEKANISME YANG SAMA dengan registration-services.ts
 * dan yang dibandingkan auth-services.ts saat login. Tidak ada skema hash kedua di repo ini.
 */
export async function createStaffUser(actor: SettingsActor, request: unknown): Promise<AdminStaffUserDto> {
  assertAdministrator(actor, FORBIDDEN_MESSAGE)

  const v = Validation.validate(SettingsAdminValidation.STAFF_USER_CREATE, request)
  const roleId = await internalRoleIdFor(v.role)
  await assertEmailAvailable(v.email)

  try {
    const created = await prismaClient.user.create({
      data: {
        name: v.name,
        email: v.email,
        password: bcrypt.hashSync(v.password, 10),
        emailVerifiedAt: now(),
        roleId
      },
      select: STAFF_USER_SELECT
    })
    return toStaffUser(created)
  } catch (error) {
    const conflict = emailConflict(error)
    if (conflict) throw conflict
    throw error
  }
}

/**
 * PUT /api/admin/settings/users/:id — `UserController::update`.
 *
 * Urutan penolakan mengikuti Laravel: 404 route-model binding -> 403 bukan Administrator -> 422 target
 * Administrator -> 422 validasi.
 *
 * PASSWORD KOSONG BERARTI TIDAK DIUBAH (`...($data['password'] ? [...] : [])`). Validasi sudah
 * memetakan absen/null/'' menjadi undefined, jadi kolomnya benar-benar tidak disentuh — bukan ditulis
 * ulang dengan hash string kosong.
 *
 * syncRoles([$role]) = satu role per user; di skema ini User.roleId memang tunggal, jadi cukup
 * menyetel kolomnya.
 */
export async function updateStaffUser(actor: SettingsActor, userId: string, request: unknown): Promise<AdminStaffUserDto> {
  const target = await prismaClient.user.findUnique({ where: { id: userId }, select: { id: true, role: { select: { name: true } } } })
  if (!target) throw new ResponseError(404, 'Akun tidak ditemukan.')

  assertAdministrator(actor, FORBIDDEN_MESSAGE)

  if (isAdministrator(target.role?.name)) {
    throw new ResponseError(422, 'Akun Administrator tidak dapat diubah dari halaman staff.', 'VALIDATION_ERROR')
  }

  const v = Validation.validate(SettingsAdminValidation.STAFF_USER_UPDATE, request)
  const roleId = await internalRoleIdFor(v.role)
  await assertEmailAvailable(v.email, target.id)

  const data: Prisma.UserUncheckedUpdateInput = { name: v.name, email: v.email, roleId }
  if (v.password) data.password = bcrypt.hashSync(v.password, 10)

  try {
    const updated = await prismaClient.user.update({ where: { id: target.id }, data, select: STAFF_USER_SELECT })
    return toStaffUser(updated)
  } catch (error) {
    const conflict = emailConflict(error)
    if (conflict) throw conflict
    throw error
  }
}

/**
 * DELETE /api/admin/settings/users/:id — `UserController::destroy`.
 *
 * Tiga penolakan Laravel diport apa adanya (404 binding -> 403 bukan Administrator -> 422 akun sendiri
 * -> 422 target Administrator), DITAMBAH satu pagar yang wajib ada di sini:
 *
 * PENGHAPUSAN BERANTAI. prisma/schema.prisma memakai relationMode = "prisma", jadi TIDAK ADA foreign
 * key di level MySQL; Prisma yang mengemulasi aksi referensial di sisi client. Yang terjadi saat satu
 * akun staf dihapus:
 *   - Cascade (baris ikut terhapus): RefreshToken, PasswordResetToken, EmailVerificationToken,
 *     NotificationState.
 *   - SetNull (relasi opsional, default emulasi Prisma): Booking.checkedInById,
 *     Transaction.verifiedById, Membership.createdById, MembershipHistory.actorId/userId,
 *     ClassSessionException.createdById, Review.userId, Booking.userId, Transaction.userId.
 *     Konsekuensinya JEJAK AUDIT HILANG — kuitansi kehilangan "diverifikasi oleh", check-in
 *     kehilangan petugasnya. Ini setara dengan nullOnDelete di Laravel dan diterima apa adanya.
 *   - Restrict (relasi WAJIB): News.authorId NOT NULL. Migrasi Laravel-nya pun
 *     `->constrained('users')->restrictOnDelete()`, jadi di sana penghapusan gagal dengan
 *     QueryException (500). Di sini dicegat LEBIH DULU dengan hitungan eksplisit dan dibalas 422
 *     berpesan jelas: emulasi Prisma akan melempar error mentah yang tidak bisa dibaca panel, dan
 *     membiarkannya lewat berarti mengorbankan baris berita.
 */
export async function deleteStaffUser(actor: SettingsActor, userId: string): Promise<{ id: string }> {
  const target = await prismaClient.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: { select: { name: true } } } })
  if (!target) throw new ResponseError(404, 'Akun tidak ditemukan.')

  assertAdministrator(actor, FORBIDDEN_MESSAGE)

  if (target.id === actor.id) throw new ResponseError(422, 'Tidak dapat menghapus akun sendiri.', 'VALIDATION_ERROR')

  if (isAdministrator(target.role?.name)) {
    throw new ResponseError(422, 'Akun Administrator tidak dapat dihapus dari halaman staff.', 'VALIDATION_ERROR')
  }

  const authoredNews = await prismaClient.news.count({ where: { authorId: target.id } })
  if (authoredNews > 0) {
    throw new ResponseError(
      422,
      `Akun ${target.name} masih tercatat sebagai penulis ${authoredNews} artikel berita. Pindahkan penulis artikel tersebut lebih dulu sebelum menghapus akun ini.`,
      'VALIDATION_ERROR'
    )
  }

  await prismaClient.user.delete({ where: { id: target.id } })

  return { id: target.id }
}
