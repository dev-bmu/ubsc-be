import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/news-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route pengaturan sistem (staff) — Fase 8F =====
// Prefix penuh (/api/admin/settings) dideklarasikan di private-api.ts; baris mount-nya ditulis
// lengkap di kepala details/admin-news.ts.
//
//   PUT /api/admin/settings/gym-traffic   cms.manage   body { value } -> { value }
//
// Padanan closure inline routes/web.php:618-622. Closure itu berada DI DALAM grup admin yang sudah
// ber-`can:manage-cms`, jadi gate-nya cms.manage — bukan permission pengaturan tersendiri. `value`
// dibatasi empat pilihan yang sama dengan aturan `in:` Laravel (GYM_TRAFFIC_VALUES di
// validation/news-admin-validation.ts); penulisannya `SystemSetting::set()` = upsert baris
// system_settings berkunci 'gym_traffic', baris yang dibaca getGymTraffic() di cms-services.ts.
//
// Router ini SENGAJA hanya memuat gym-traffic. Laravel juga menaruh settings/roles dan settings/users
// di prefix ini; keduanya milik fase RBAC dan menyusul di berkas yang sama, dengan permission sendiri
// (rbac.manage / users.manage) — jangan menambahkan gate level router di sini.

const adminSettingsRoutes = express.Router()

adminSettingsRoutes.put('/gym-traffic', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.gymTrafficUpdate)

export default adminSettingsRoutes
