import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/membership-admin-controller'
import { requireAnyPermission } from '../../middleware/permission-middleware'

// ===== Route membership admin (staff) =====
// Prefix penuh (/api/admin/memberships) dideklarasikan di private-api.ts, SETELAH router paket
// (/api/admin/memberships/plans) supaya 'plans' tidak pernah sampai ke '/:id' di sini.
//
//   GET    /api/admin/memberships             daftar penuh + opsi paket (transform)
//   POST   /api/admin/memberships             buat membership (akun customer / walk-in)
//   POST   /api/admin/memberships/:id/renew   perpanjang tanpa menghapus sisa masa aktif
//   POST   /api/admin/memberships/:id/lunas   Tandai Lunas: transfer membership meja depan sudah masuk
//   PATCH  /api/admin/memberships/:id         ubah status
//   DELETE /api/admin/memberships/:id         soft-cancel
//
// index: `view-members|manage-members|manage-bookings|manage-payment-links` Laravel; mutasi:
// `manage-members|manage-bookings`. Permission per baris, tidak pernah di controller.

const MEMBERSHIP_READERS = [PERMISSIONS.MEMBERS_READ, PERMISSIONS.MEMBERS_MANAGE, PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.PAYMENTS_MANAGE]
const MEMBERSHIP_WRITERS = [PERMISSIONS.MEMBERS_MANAGE, PERMISSIONS.BOOKINGS_MANAGE]

const adminMembershipRoutes = express.Router()

adminMembershipRoutes.get('/', requireAnyPermission(MEMBERSHIP_READERS), ctrl.membershipsIndex)
adminMembershipRoutes.post('/', requireAnyPermission(MEMBERSHIP_WRITERS), ctrl.membershipsStore)
adminMembershipRoutes.post('/:id/renew', requireAnyPermission(MEMBERSHIP_WRITERS), ctrl.membershipsRenew)
adminMembershipRoutes.post('/:id/lunas', requireAnyPermission(MEMBERSHIP_WRITERS), ctrl.membershipsMarkPaid)
adminMembershipRoutes.patch('/:id', requireAnyPermission(MEMBERSHIP_WRITERS), ctrl.membershipsUpdate)
adminMembershipRoutes.delete('/:id', requireAnyPermission(MEMBERSHIP_WRITERS), ctrl.membershipsDestroy)

export default adminMembershipRoutes
