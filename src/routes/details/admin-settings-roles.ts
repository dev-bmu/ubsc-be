import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/settings-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route Role & Access (staff) — Fase 8G =====
// Prefix penuh (/api/admin/settings/roles) dideklarasikan di private-api.ts.
//
//   GET /api/admin/settings/roles         staf mana pun (tanpa permission)  -> AdminRoleIndexDto
//   PUT /api/admin/settings/roles/:name   rbac.manage + Administrator saja  -> AdminRoleDto
//
// :name adalah NAMA role ('Manager', 'Staff Front Office'), bukan uuid: RolePermission.roleName
// memang berkunci nama (prisma/schema.prisma) dan AdminRoleDto tidak membawa id.
//
// GATE. BACA sengaja TANPA permission, 1:1 dengan Laravel: kelima role staf boleh membuka layar
// Role & Access, dan yang membatasi isinya adalah service (non-Administrator hanya melihat ROLE-NYA
// SENDIRI). Sidebar pun menampilkan menu ini ke semua role tanpa gate (components/admin/Sidebar.tsx),
// jadi memasang rbac.manage di sini akan membuat Finance/Staff Central/Front Office menekan menu yang
// terlihat lalu mendarat di 403 — jalan buntu yang tidak ada di Laravel, dan sekaligus mematikan
// cabang "lihat role sendiri" itu. Gate TULIS tetap ketat: rbac.manage DI BARIS ROUTE + Administrator
// saja sebagai cek imperatif di settings-admin-services.ts (pesannya sendiri:
// 'Hanya Administrator yang dapat mengubah hak akses.').
//
// GET '/' (literal) didaftarkan sebelum PUT '/:name' supaya urutan literal-sebelum-:param terjaga.
//
// ============================================================================
// === BARIS MOUNT YANG HARUS DITAMBAHKAN PARENT DI src/routes/private-api.ts ===
// ============================================================================
// Import (sisipkan tepat SETELAH baris `import adminSettingsRoutes from './details/admin-settings'`,
// daftar import berkas itu terurut menurut path):
//
//   import adminSettingsRoleRoutes from './details/admin-settings-roles'
//   import adminSettingsUserRoutes from './details/admin-settings-users'
//
// Mount (di blok CMS/Fase 8F, tepat SEBELUM baris `privateRouter.use('/api/admin/settings', adminSettingsRoutes)`):
//
//   privateRouter.use('/api/admin/settings/roles', adminSettingsRoleRoutes)
//   privateRouter.use('/api/admin/settings/users', adminSettingsUserRoutes)
//   privateRouter.use('/api/admin/settings', adminSettingsRoutes)   // <- baris yang SUDAH ADA (gym-traffic)
//
// URUTAN. Kedua baris di atas WAJIB berada SEBELUM mount '/api/admin/settings' yang sudah ada.
// router.use() Express mencocokkan PREFIX, bukan segmen penuh: '/api/admin/settings' ikut menangkap
// '/api/admin/settings/roles'. Hari ini router gym-traffic hanya mendeklarasikan PUT '/gym-traffic'
// sehingga request /roles jatuh lewat (next()) dan tetap sampai — jadi urutan terbalik kebetulan masih
// bekerja. Begitu router settings itu menambah satu saja route ber-parameter (mis. PUT '/:key'),
// urutan terbalik akan membuat layar RBAC diam-diam memanggil handler gym-traffic dengan key 'roles'.
// Karena itu urutannya diperlakukan sebagai WAJIB dan sejenis dengan pasangan
// /memberships/plans sebelum /memberships/:id yang sudah didaftar di catatan urutan private-api.ts.
//
// Tidak ada kendala urutan terhadap prefix lain: '/api/admin/payments/settings' (8D) berada di bawah
// router payments dan tidak bersinggungan dengan '/api/admin/settings*'.

const adminSettingsRoleRoutes = express.Router()

adminSettingsRoleRoutes.get('/', ctrl.rolesIndex)
adminSettingsRoleRoutes.put('/:name', requirePermission(PERMISSIONS.RBAC_MANAGE), ctrl.rolesUpdate)

export default adminSettingsRoleRoutes
