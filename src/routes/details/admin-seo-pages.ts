import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/news-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'
import { singleFileUpload } from '../../middleware/upload-middleware'

// ===== Route SEO halaman statis landing (staff) — PRD tambahan §7.7 =====
// Prefix penuh (/api/admin/seo-pages) dideklarasikan di private-api.ts, bersama revalidasi tag 'seo'.
//
//   GET /api/admin/seo-pages        cms.manage   AdminPageSeoDto[] — seluruh SEO_PAGES (shared/seo.ts)
//   PUT /api/admin/seo-pages/:key   cms.manage   multipart: title, description, noindex, removeOgImage,
//                                                berkas `ogImage` opsional -> AdminPageSeoDto; key asing 404

const ogImageUpload = singleFileUpload('ogImage', 'CMS_IMAGE', { tooLargeMessage: 'Ukuran gambar maksimal 5 MB.' })

const adminSeoPageRoutes = express.Router()

adminSeoPageRoutes.get('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.seoPageIndex)
adminSeoPageRoutes.put('/:key', ogImageUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.seoPageUpdate)

export default adminSeoPageRoutes
