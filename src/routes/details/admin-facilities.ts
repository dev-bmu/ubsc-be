import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/facility-controller'
import { requireAnyPermission, requirePermission } from '../../middleware/permission-middleware'
import { facilityMediaUpload, unitImageUpload } from '../../middleware/upload-middleware'

// ===== Route fasilitas (staff) =====
// Prefix penuh (/api/admin/facilities) dideklarasikan di private-api.ts.
//
// URUTAN WAJIB: route literal (/create, /reorder, /gallery/:mediaId) didaftarkan SEBELUM /:id, kalau
// tidak parameter :id menelan 'create'/'reorder' dan handler yang salah menerimanya sebagai id. Route
// /:id/pricing, /:id/units, dan /:id/pricing/sync aman karena kedalaman path-nya berbeda dari /:id.
//
// Permission per baris (requirePermission / requireAnyPermission), tidak pernah di controller.
// index boleh dibuka pembaca (READ) maupun pengelola harga (PRICING); mutasi butuh FACILITIES_MANAGE;
// pricing butuh PRICING_MANAGE ATAU FACILITIES_MANAGE.

const FACILITY_READERS = [PERMISSIONS.FACILITIES_READ, PERMISSIONS.FACILITIES_MANAGE, PERMISSIONS.PRICING_MANAGE]
const PRICING_MANAGERS = [PERMISSIONS.PRICING_MANAGE, PERMISSIONS.FACILITIES_MANAGE]

const adminFacilityRoutes = express.Router()

adminFacilityRoutes.get('/', requireAnyPermission(FACILITY_READERS), ctrl.index)
adminFacilityRoutes.get('/create', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.createForm)
adminFacilityRoutes.post('/reorder', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.reorder)
adminFacilityRoutes.delete('/gallery/:mediaId', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.destroyGallery)
adminFacilityRoutes.post('/', facilityMediaUpload, requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.store)
adminFacilityRoutes.get('/:id/edit', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.editForm)
adminFacilityRoutes.put('/:id', facilityMediaUpload, requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.update)
adminFacilityRoutes.delete('/:id', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.destroy)
adminFacilityRoutes.get('/:id/pricing', requireAnyPermission(PRICING_MANAGERS), ctrl.pricing)
adminFacilityRoutes.post('/:id/pricing/sync', requireAnyPermission(PRICING_MANAGERS), ctrl.pricingSync)
adminFacilityRoutes.get('/:id/units', requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.units)
adminFacilityRoutes.post('/:id/units', unitImageUpload, requirePermission(PERMISSIONS.FACILITIES_MANAGE), ctrl.storeUnit)

export default adminFacilityRoutes
