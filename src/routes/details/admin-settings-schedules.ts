import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/schedule-admin-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route pengaturan jadwal bulanan (staff) — Fase 8G =====
// Prefix penuh (/api/admin/settings/schedules) dideklarasikan di private-api.ts.
//
//   GET  /api/admin/settings/schedules                   bookings.limits.manage   7 bulan mulai bulan berjalan (WIB)
//   POST /api/admin/settings/schedules/toggle            bookings.limits.manage   body { month, year } -> bulan terbaru
//   POST /api/admin/settings/schedules/update-dates      bookings.limits.manage   body { month, year, closedDates } -> bulan terbaru
//   POST /api/admin/settings/schedules/quick-open-next   bookings.limits.manage   tanpa body -> bulan depan, dibuka
//
// `abort_unless(auth()->user()?->can('manage-booking-limits'), 403)` di keempat aksi
// Admin\ScheduleController = PERMISSIONS.BOOKINGS_LIMITS_MANAGE ('bookings.limits.manage'). Peta
// namanya ada di shared/permissions.ts (LARAVEL_PERMISSION_MAP: 'manage-booking-limits' ->
// BOOKINGS_LIMITS_MANAGE) — dicek, bukan ditebak. Keempatnya memakai gate yang sama persis, jadi
// requirePermission tunggal, bukan requireAnyPermission.
//
// Urutan: GET '/' (literal) lebih dulu, lalu tiga POST yang juga literal. Tidak ada satu pun route
// ber-parameter di router ini, jadi aturan literal-sebelum-:param tidak punya pasangan yang bisa
// dilanggar di sini.
//
// ============================================================================
// === BARIS MOUNT YANG WAJIB DITAMBAHKAN PARENT DI routes/private-api.ts ===
// ============================================================================
// Impor (kelompok import, urut alfabet di antara adminSettingsRoutes dan adminSponsorRoutes):
//
//   import adminSettingsScheduleRoutes from './details/admin-settings-schedules'
//
// Mount (di blok CMS Fase 8F, TEPAT DI ATAS baris '/api/admin/settings' yang sudah ada):
//
//   privateRouter.use('/api/admin/settings/schedules', adminSettingsScheduleRoutes)
//   privateRouter.use('/api/admin/settings', adminSettingsRoutes)   // <- baris yang sudah ada
//
// URUTAN: router ini WAJIB didaftarkan SEBELUM '/api/admin/settings' (gym-traffic, Fase 8F).
//
// Alasannya bukan sekadar kehati-hatian. router.use('/api/admin/settings', ...) ikut mencocokkan
// SELURUH turunannya, termasuk '/api/admin/settings/schedules/toggle' — yang di dalam router
// gym-traffic menjadi '/schedules/toggle' dan tidak cocok dengan satu-satunya baris di sana (PUT
// '/gym-traffic'). Hari ini itu berarti next() dan request jatuh ke router yang benar di bawahnya.
// Yang membuat urutan ini tetap wajib adalah hari esok: begitu router settings punya satu saja route
// ber-parameter (mis. PUT '/:key', atau settings/roles/:name & settings/users/:id milik fase RBAC
// yang memang direncanakan tinggal di prefix ini), parameter itu akan menelan segmen 'schedules' dan
// permintaan jadwal mendarat di handler yang salah dengan key = 'schedules'. Gejalanya bukan 404,
// melainkan gate permission yang salah (cms.manage/rbac.manage alih-alih bookings.limits.manage) —
// persis pasangan 1 dan 3 di daftar "URUTAN ROUTE YANG WAJIB DIPERTAHANKAN" pada private-api.ts.
//
// Disarankan menambahkan pasangan ini sebagai butir 4 pada daftar itu:
//
//   4. /api/admin/settings/schedules
//      WAJIB didaftarkan SEBELUM /api/admin/settings
//
// Tidak ada batasan urutan terhadap prefix lain mana pun: '/api/admin/settings*' saling lepas dari
// '/api/admin/payments/settings' (pengaturan rekening 8D) dan dari seluruh prefix Fase 8 lainnya.

const adminSettingsScheduleRoutes = express.Router()

adminSettingsScheduleRoutes.get('/', requirePermission(PERMISSIONS.BOOKINGS_LIMITS_MANAGE), ctrl.index)
adminSettingsScheduleRoutes.post('/toggle', requirePermission(PERMISSIONS.BOOKINGS_LIMITS_MANAGE), ctrl.toggle)
adminSettingsScheduleRoutes.post('/update-dates', requirePermission(PERMISSIONS.BOOKINGS_LIMITS_MANAGE), ctrl.updateClosedDates)
adminSettingsScheduleRoutes.post('/quick-open-next', requirePermission(PERMISSIONS.BOOKINGS_LIMITS_MANAGE), ctrl.quickOpenNext)

export default adminSettingsScheduleRoutes
