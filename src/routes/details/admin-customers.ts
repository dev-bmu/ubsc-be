import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/membership-admin-controller'
import { requireAnyPermission } from '../../middleware/permission-middleware'

// ===== Route pencarian customer admin (staff) =====
// Prefix penuh (/api/admin/customers) dideklarasikan di private-api.ts.
//
//   GET /api/admin/customers/search?q=   typeahead "tautkan ke akun" (maks 8, non-staff)
//
// Laravel searchCustomers: `manage-members|manage-bookings`. Permission per baris, tidak pernah di controller.

const adminCustomerRoutes = express.Router()

adminCustomerRoutes.get('/search', requireAnyPermission([PERMISSIONS.MEMBERS_MANAGE, PERMISSIONS.BOOKINGS_MANAGE]), ctrl.customersSearch)
// Akun minimal walk-in (tahap C) — hak yang sama dengan membuat membership.
adminCustomerRoutes.post('/', requireAnyPermission([PERMISSIONS.MEMBERS_MANAGE, PERMISSIONS.BOOKINGS_MANAGE]), ctrl.customersStore)

export default adminCustomerRoutes
