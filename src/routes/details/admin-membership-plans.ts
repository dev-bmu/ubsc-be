import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/membership-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route paket membership admin (staff) =====
// Prefix penuh (/api/admin/memberships/plans) dideklarasikan di private-api.ts — WAJIB didaftarkan
// SEBELUM /api/admin/memberships supaya 'plans' tidak ditelan sebagai :id.
//
//   GET    /api/admin/memberships/plans        SEMUA paket + activeMembersCount
//   POST   /api/admin/memberships/plans        buat paket
//   PATCH  /api/admin/memberships/plans/:id    ubah paket
//   DELETE /api/admin/memberships/plans/:id    hapus (ditolak bila masih ada anggota aktif)
//
// Laravel gate(): `manage-members` saja untuk keempatnya. Permission per baris, tidak pernah di controller.

const adminMembershipPlanRoutes = express.Router()

adminMembershipPlanRoutes.get('/', requirePermission(PERMISSIONS.MEMBERS_MANAGE), ctrl.plansIndex)
adminMembershipPlanRoutes.post('/', requirePermission(PERMISSIONS.MEMBERS_MANAGE), ctrl.plansStore)
adminMembershipPlanRoutes.patch('/:id', requirePermission(PERMISSIONS.MEMBERS_MANAGE), ctrl.plansUpdate)
adminMembershipPlanRoutes.delete('/:id', requirePermission(PERMISSIONS.MEMBERS_MANAGE), ctrl.plansDestroy)

export default adminMembershipPlanRoutes
