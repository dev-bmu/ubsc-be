import { prismaClient } from '../application/database'
import { getDefaultPermissionsByRole } from '../config/permissions'

// ===== Permission efektif per role =====
// Tanpa dimensi divisionId: UBSC tidak punya struktur organisasi itu, dan
// @@unique bertiga di boilerplate memang tidak enforceable di MySQL (bug 7).
//
// Tabel role_permissions adalah otoritas. shared/permissions.ts hanya fallback
// untuk role yang belum pernah di-seed atau di-set lewat layar RBAC — supaya
// database kosong tidak berarti panel admin tanpa satu pun menu.

export async function getPermissionsByRole(roleName: string): Promise<string[]> {
  const rolePermissions = await prismaClient.rolePermission.findMany({
    where: { roleName },
    include: { permission: true }
  })

  if (rolePermissions.length > 0) {
    return Array.from(new Set(rolePermissions.map((item) => item.permission.code))).sort()
  }

  return [...getDefaultPermissionsByRole(roleName)]
}

// TODO Fase 8: layar Role & Access memerlukan tambahan di file ini —
//   getAllPermissions(), getPermissionMatrix() (roles x permissions, tanpa
//   dimensi divisi), dan updateRolePermissions() yang mengganti seluruh baris
//   satu role dalam satu $transaction. Ketiganya dijaga permission
//   'rbac.manage' di level route, bukan hasRole('Administrator') hardcoded
//   seperti Laravel (bug 10). Sengaja belum ditulis di Fase 0: tidak ada
//   pemakainya, dan bentuk akhirnya ditentukan layar adminnya.
