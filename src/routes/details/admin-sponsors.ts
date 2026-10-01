import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/cms-card-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'
import { singleFileUpload } from '../../middleware/upload-middleware'

// ===== Route logo sponsor (staff) — Fase 8F =====
// Prefix penuh (/api/admin/sponsors) dideklarasikan di private-api.ts (baris mount lengkapnya
// didokumentasikan di details/admin-promo.ts).
//
//   GET    /api/admin/sponsors            cms.manage   AdminSponsorIndexDto (semua, urut sortOrder)
//   POST   /api/admin/sponsors            cms.manage   multipart `logo` -> AdminSponsorDto (201)
//   POST   /api/admin/sponsors/reorder    cms.manage   { ids } -> { ids } (sortOrder = index + 1)
//   PUT    /api/admin/sponsors/:id        cms.manage   multipart `logo` -> AdminSponsorDto
//   DELETE /api/admin/sponsors/:id        cms.manage   -> { id }
//
// Bentuknya identik dengan promo KECUALI satu hal: `name` WAJIB di store MAUPUN update
// (SponsorLogoController: `['required','string','max:255']`), sementara `title` promo nullable.
//
// URUTAN WAJIB: '/reorder' (literal) SEBELUM '/:id' — alasannya sama dengan admin-promo.ts.

const CMS_IMAGE_TOO_LARGE = 'Ukuran gambar maksimal 5 MB.'

/** `['nullable','image','max:5120']`. */
const sponsorLogoUpload = singleFileUpload('logo', 'CMS_IMAGE', { tooLargeMessage: CMS_IMAGE_TOO_LARGE })

const adminSponsorRoutes = express.Router()

adminSponsorRoutes.get('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.sponsorIndex)
adminSponsorRoutes.post('/reorder', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.sponsorReorder)
adminSponsorRoutes.post('/', sponsorLogoUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.sponsorStore)
adminSponsorRoutes.put('/:id', sponsorLogoUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.sponsorUpdate)
adminSponsorRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.sponsorDestroy)

export default adminSponsorRoutes
