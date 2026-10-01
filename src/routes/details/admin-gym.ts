import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/gym-controller'
import { requireAnyPermission, requirePermission } from '../../middleware/permission-middleware'

// ===== Route gym: meja check-in + analitik kunjungan (tahap D) =====
// Prefix penuh (/api/admin/gym) dideklarasikan di private-api.ts.
//
//   GET  /api/admin/gym/checkin                 kunjungan hari ini (maks 100)
//   GET  /api/admin/gym/checkin/lookup?code=    vonis untuk satu nomor member (belum mencatat)
//   POST /api/admin/gym/checkin                 body { code, source, overrideReason? } -> vonis terbaru
//   GET  /api/admin/gym/visits?from=&to=        analitik rentang tanggal WIB (maks 92 hari)
//
// Mencatat hanya gym.checkin (FO, Staff Central, Manager). Analitik juga terbuka untuk reports.read.

const adminGymRoutes = express.Router()

adminGymRoutes.get('/checkin', requirePermission(PERMISSIONS.GYM_CHECKIN), ctrl.desk)
adminGymRoutes.get('/checkin/lookup', requirePermission(PERMISSIONS.GYM_CHECKIN), ctrl.lookup)
adminGymRoutes.post('/checkin', requirePermission(PERMISSIONS.GYM_CHECKIN), ctrl.checkIn)
adminGymRoutes.get('/visits', requireAnyPermission([PERMISSIONS.GYM_CHECKIN, PERMISSIONS.REPORTS_READ]), ctrl.report)

export default adminGymRoutes
