import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/facility-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route kategori fasilitas (staff) =====
// Prefix penuh (/api/admin/facility-categories) dideklarasikan di private-api.ts. Semua butuh
// FACILITIES_MANAGE. /reorder didaftarkan SEBELUM /:id agar tidak ditelan parameter.

const adminFacilityCategoryRoutes = express.Router()

adminFacilityCategoryRoutes.get('/', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.categoryIndex)
adminFacilityCategoryRoutes.post('/reorder', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.categoryReorder)
adminFacilityCategoryRoutes.post('/', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.categoryStore)
adminFacilityCategoryRoutes.put('/:id', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.categoryUpdate)
adminFacilityCategoryRoutes.delete('/:id', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.categoryDestroy)

export default adminFacilityCategoryRoutes
