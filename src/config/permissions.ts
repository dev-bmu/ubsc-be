// ===== Permission (re-export) =====
//
// SUMBER KEBENARAN ada di shared/permissions.ts, bukan di file ini.
//
// Folder shared/ disalin apa adanya ke ubsc-landing dan ubsc-admin lewat
// npm run sync:contracts, jadi daftar permission harus hidup di sana supaya ketiga repo
// membaca satu daftar yang sama. File ini hanya menjaga jalur import konvensi boilerplate
// ('../config/permissions') tetap bekerja untuk middleware, route, dan service di src/.
//
// JANGAN menambah atau menyalin daftar permission di sini — tambahkan di shared/permissions.ts,
// lalu jalankan npm run sync:contracts di kedua repo Next.

export {
  PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_CODES,
  LARAVEL_PERMISSION_MAP,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  ADMINISTRATOR_ROLE,
  isAdministrator,
  isPermissionCode,
  getDefaultPermissionsByRole
} from '../../shared/permissions'

export type { PermissionCode, PermissionDefinition, StaffRoleName } from '../../shared/permissions'
