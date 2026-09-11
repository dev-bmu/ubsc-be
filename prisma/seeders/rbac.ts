import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../../shared/permissions'
import { prisma, tally } from './shared'

// ============================================================================
// === RoleAndPermissionSeeder.php ===
// ============================================================================
// Daftar permission dan matriks role dibaca dari shared/permissions.ts, TIDAK
// diduplikasi di sini. Dua salinan berarti dua kebenaran, dan yang salah baru
// ketahuan saat ada staff kehilangan menu (R12).
//
// Laravel menghapus permission yang tidak lagi ada di daftar
// (`Permission::whereNotIn('name', $allPermissions)->delete()`). Perilaku itu
// TIDAK ditiru: dengan relationMode "prisma" tidak ada cascade DB, jadi
// menghapus permission akan meninggalkan baris role_permissions menggantung.
// Permission yang usang dilaporkan saja — penghapusannya keputusan sadar, lewat
// migration tersendiri.

export async function seedRbac() {
  console.log('RBAC (permission + role + matriks)')

  let permissionsCreated = 0
  let permissionsUpdated = 0

  for (const permission of ALL_PERMISSIONS) {
    const before = await prisma.permission.findUnique({ where: { code: permission.code }, select: { id: true } })
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, description: permission.description },
      create: { code: permission.code, name: permission.name, description: permission.description }
    })
    if (before) permissionsUpdated++
    else permissionsCreated++
  }

  const roleNames = Object.keys(ROLE_PERMISSIONS)
  let rolesCreated = 0
  for (const name of roleNames) {
    const before = await prisma.role.findUnique({ where: { name }, select: { id: true } })
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } })
    if (!before) rolesCreated++
  }

  const permissions = await prisma.permission.findMany({ select: { id: true, code: true } })
  const idByCode = new Map(permissions.map((permission) => [permission.code, permission.id]))

  let linksCreated = 0
  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      const permissionId = idByCode.get(code)
      if (!permissionId) {
        console.warn(`  ! permission "${code}" untuk role "${roleName}" tidak ada di tabel permissions — dilewati`)
        continue
      }

      // @@unique([roleName, permissionId]) membuat upsert ini aman diulang.
      const before = await prisma.rolePermission.findUnique({
        where: { roleName_permissionId: { roleName, permissionId } },
        select: { id: true }
      })
      await prisma.rolePermission.upsert({
        where: { roleName_permissionId: { roleName, permissionId } },
        update: {},
        create: { roleName, permissionId }
      })
      if (!before) linksCreated++
    }
  }

  // Laporkan permission yang ada di DB tapi tidak lagi di shared/permissions.ts.
  const knownCodes = new Set<string>(ALL_PERMISSIONS.map((p) => p.code))
  const stale = permissions.filter((p) => !knownCodes.has(p.code))
  if (stale.length > 0) {
    console.warn(`  ! ${stale.length} permission usang di DB (tidak dihapus otomatis): ${stale.map((p) => p.code).join(', ')}`)
  }

  tally('rbac', {
    'permission baru': permissionsCreated,
    'permission diperbarui': permissionsUpdated,
    'role baru': rolesCreated,
    'tautan baru': linksCreated
  })
}
