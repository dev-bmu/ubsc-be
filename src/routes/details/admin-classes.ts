import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/booking-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route roster kelas admin (staff) =====
// Prefix penuh (/api/admin/classes) dideklarasikan di private-api.ts.
//
//   GET  /api/admin/classes                   roster bulanan (?facilityId=&facilityUnitId=&month=&date=)
//   POST /api/admin/classes/cancel-session    batalkan satu pertemuan
//   POST /api/admin/classes/restore-session   buka kembali (tidak un-cancel booking lama)
//
// URUTAN WAJIB: prefix literal /cancel-session & /restore-session tidak bentrok dengan '/', tapi
// tetap didaftarkan eksplisit. Semua butuh bookings.manage (authorize('manage-bookings') Laravel).

const adminClassRoutes = express.Router()

adminClassRoutes.get('/', requirePermission(PERMISSIONS.BOOKINGS_MANAGE), ctrl.classesIndex)
adminClassRoutes.post('/cancel-session', requirePermission(PERMISSIONS.BOOKINGS_MANAGE), ctrl.classesCancelSession)
adminClassRoutes.post('/restore-session', requirePermission(PERMISSIONS.BOOKINGS_MANAGE), ctrl.classesRestoreSession)

export default adminClassRoutes
