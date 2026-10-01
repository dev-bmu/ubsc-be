import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/facility-controller'
import { requirePermission } from '../../middleware/permission-middleware'
import { unitImageUpload } from '../../middleware/upload-middleware'

// ===== Route unit fasilitas by-id (staff) =====
// Prefix penuh (/api/admin/facility-units) dideklarasikan di private-api.ts. Membuat unit lewat
// /api/admin/facilities/:id/units; di sini hanya update & destroy per unit. Butuh FACILITIES_MANAGE.
// PUT nyata (bukan _method spoof); multipart PUT membawa unit_image lewat unitImageUpload.

const adminFacilityUnitRoutes = express.Router()

adminFacilityUnitRoutes.put('/:id', unitImageUpload, requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.updateUnit)
adminFacilityUnitRoutes.delete('/:id', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.destroyUnit)

export default adminFacilityUnitRoutes
