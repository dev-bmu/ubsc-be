import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/booking-admin-controller'
import { requireAnyPermission } from '../../middleware/permission-middleware'

// ===== Route check-in admin (staff) =====
// Prefix penuh (/api/admin/checkin) dideklarasikan di private-api.ts.
//
//   GET  /api/admin/checkin          daftar hari ini + cari (?q=)
//   GET  /api/admin/checkin/:token   satu booking untuk konfirmasi
//   POST /api/admin/checkin/:token   konfirmasi kehadiran
//
// URUTAN WAJIB: '/' didaftarkan SEBELUM '/:token' supaya parameter tidak menelan segmen literal.
// `manage-bookings` ATAU `view-bookings` Laravel = bookings.manage | bookings.read.

const CHECKIN_ACCESS = [PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.BOOKINGS_READ]

const adminCheckinRoutes = express.Router()

adminCheckinRoutes.get('/', requireAnyPermission(CHECKIN_ACCESS), ctrl.checkinIndex)
adminCheckinRoutes.get('/:token', requireAnyPermission(CHECKIN_ACCESS), ctrl.checkinShow)
adminCheckinRoutes.post('/:token', requireAnyPermission(CHECKIN_ACCESS), ctrl.checkinStore)

export default adminCheckinRoutes
