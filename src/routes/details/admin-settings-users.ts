import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/settings-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route Pengguna Internal (staff) — Fase 8G =====
// Prefix penuh (/api/admin/settings/users) dideklarasikan di private-api.ts; baris mount-nya ditulis
// lengkap di kepala details/admin-settings-roles.ts, termasuk kendala urutannya terhadap router
// '/api/admin/settings' yang sudah ada (gym-traffic).
//
//   GET    /api/admin/settings/users       staf mana pun (tanpa permission)  -> AdminStaffUserIndexDto
//   POST   /api/admin/settings/users       users.manage + Administrator saja -> 201 AdminStaffUserDto
//   PUT    /api/admin/settings/users/:id   users.manage + Administrator saja -> AdminStaffUserDto
//   DELETE /api/admin/settings/users/:id   users.manage + Administrator saja -> { id }
//
// GATE. Laravel menggerbangi index dengan `hasAnyRole(STAFF_ROLES)` — "siapa pun yang staf", bukan
// permission. Router ini SUDAH di bawah staffAuthRequired, jadi padanannya adalah TANPA permission
// tambahan; menaruh users.manage di sini akan membuat Finance/Staff Central/Front Office menekan menu
// "Internal Users" yang memang ditampilkan Sidebar tanpa gate lalu mendarat di 403 — jalan buntu yang
// tidak ada di Laravel. Ketiga aksi TULIS tetap ketat: users.manage DI BARIS ROUTE + Administrator
// saja sebagai cek imperatif di settings-admin-services.ts.
//
// `canManageUsers` di AdminStaffUserIndexDto tetap dikirim = pemanggil adalah Administrator: gate FE
// hanya UX, keputusan sebenarnya tetap di server.
//
// GET '/' dan POST '/' (literal) didaftarkan sebelum kedua route ':id' supaya urutan
// literal-sebelum-:param terjaga.

const adminSettingsUserRoutes = express.Router()

adminSettingsUserRoutes.get('/', ctrl.usersIndex)
adminSettingsUserRoutes.post('/', requirePermission(PERMISSIONS.USERS_MANAGE), ctrl.usersStore)
adminSettingsUserRoutes.put('/:id', requirePermission(PERMISSIONS.USERS_MANAGE), ctrl.usersUpdate)
adminSettingsUserRoutes.delete('/:id', requirePermission(PERMISSIONS.USERS_MANAGE), ctrl.usersDestroy)

export default adminSettingsUserRoutes
