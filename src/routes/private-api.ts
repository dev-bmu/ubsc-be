import express from 'express'
import { staffAuthRequired } from '../middleware/auth-middleware'
import { UserRequest } from '../type/user-request'
import { ok } from '../utils/respond'
import adminBookingRoutes from './details/admin-bookings'
import adminCheckinRoutes from './details/admin-checkin'
import adminGymRoutes from './details/admin-gym'
import adminClassRoutes from './details/admin-classes'
import adminCustomerRoutes from './details/admin-customers'
import adminDashboardRoutes from './details/admin-dashboard'
import adminFacilityRoutes from './details/admin-facilities'
import adminFacilityCategoryRoutes from './details/admin-facility-categories'
import adminFacilityUnitRoutes from './details/admin-facility-units'
import adminFinanceRoutes from './details/admin-finance'
import adminIdentityRoutes from './details/admin-identity'
import adminInfoBannerRoutes from './details/admin-info-banners'
import adminMembershipPlanRoutes from './details/admin-membership-plans'
import adminMembershipRoutes from './details/admin-memberships'
import adminNewsRoutes from './details/admin-news'
import adminNewsCategoryRoutes from './details/admin-news-categories'
import adminNotificationRoutes from './details/admin-notifications'
import adminPaymentRoutes from './details/admin-payments'
import adminProfileRoutes, { adminEmailRoutes } from './details/admin-profile'
import adminPromoRoutes from './details/admin-promo'
import adminReelRoutes from './details/admin-reels'
import adminReviewRoutes from './details/admin-reviews'
import adminSettingsRoutes from './details/admin-settings'
import adminSettingsRoleRoutes from './details/admin-settings-roles'
import adminSettingsScheduleRoutes from './details/admin-settings-schedules'
import adminSettingsUserRoutes from './details/admin-settings-users'
import adminSponsorRoutes from './details/admin-sponsors'
import adminTestimonialRoutes from './details/admin-testimonials'
import { LandingTag, revalidateLandingAfterWrite } from '../middleware/revalidate-landing-middleware'

// Tulis admin yang mengubah isi halaman publik landing → cache ISR halaman itu dibuang seketika.
const FACILITY_PAGES: LandingTag[] = ['home', 'facilities', 'booking-facilities']
const afterFacilityWrite = revalidateLandingAfterWrite(FACILITY_PAGES)
const afterHomeWrite = revalidateLandingAfterWrite(['home'])

// ===== Router staff (dash.ubsportcenter.co.id) =====
// authRequired dipasang SEKALI di level router. Middleware-nya diikat ke prefix
// '/api/admin' dengan alasan yang sama seperti customer-api.ts: ketiga router
// dipasang tanpa prefix dan berurutan di web.ts, jadi router.use() polos akan
// menghadang request milik audience lain.
//
// Permission dideklarasikan PER BARIS ROUTE lewat requirePermission(...) /
// requireAnyPermission([...]), tidak pernah di dalam controller dan tidak
// pernah di level router — hanya autentikasi yang berlaku untuk semuanya.

export const privateRouter = express.Router()

privateRouter.use('/api/admin', staffAuthRequired)

// Profil + permission efektif staff yang login. Dipakai AuthGuard app admin.
privateRouter.get('/api/admin/me', (req, res) => {
  const { user, permissions } = req as UserRequest
  // Jangan balas objek Prisma mentah: hash password ikut terbawa.
  ok(res, {
    user: user ? { id: user.id, name: user.name, email: user.email, role: user.role?.name ?? null } : null,
    permissions: permissions ?? []
  })
})

// Dashboard admin (kartu statistik + tren + okupansi + aktivitas + info banner) — Fase 7.
// Tanpa gate permission: kelima role staff mendarat di sini setelah login. Prefix literal,
// tidak bentrok dengan /me maupun /payments.
privateRouter.use('/api/admin/dashboard', adminDashboardRoutes)

// Keputusan pembayaran (approve/reject) + berkas bukti — Fase 3. Antrean verifikasi (GET /) dan
// pengaturan rekening (POST /settings) — Fase 8D, pada router yang sama.
privateRouter.use('/api/admin/payments', adminPaymentRoutes)

// Laporan keuangan — Fase 8D. Prefix literal tersendiri, tidak bentrok dengan prefix lain.
privateRouter.use('/api/admin/finance', adminFinanceRoutes)

// Fasilitas (index/form/units/pricing) + kategori + unit by-id — Fase 8A. Tiga prefix literal berbeda
// (facilities / facility-categories / facility-units), tidak saling menelan maupun bentrok dengan
// /me, /dashboard, /payments. Urutan route literal-sebelum-:id dijaga di dalam tiap file details.
privateRouter.use('/api/admin/facilities', afterFacilityWrite, adminFacilityRoutes)
privateRouter.use('/api/admin/facility-categories', afterFacilityWrite, adminFacilityCategoryRoutes)
privateRouter.use('/api/admin/facility-units', afterFacilityWrite, adminFacilityUnitRoutes)

// Booking / Check-in / Roster kelas — Fase 8B. Prefix literal berbeda (bookings / checkin / classes),
// tidak saling menelan maupun bentrok dengan /me, /dashboard, /payments, /facilities*. Urutan route
// literal-sebelum-:param dijaga di dalam tiap file details (checkin '/' sebelum '/:token'; classes
// '/cancel-session' & '/restore-session' eksplisit).
privateRouter.use('/api/admin/bookings', adminBookingRoutes)
privateRouter.use('/api/admin/checkin', adminCheckinRoutes)
privateRouter.use('/api/admin/classes', adminClassRoutes)

// Membership + paket + pencarian customer — Fase 8C. Router PAKET WAJIB di atas router membership
// (pasangan 1 di bawah): kalau terbalik, GET/PATCH/DELETE /memberships/plans[/:id] jatuh ke handler
// membership dengan id 'plans'. /customers prefix literal tersendiri.
privateRouter.use('/api/admin/memberships/plans', revalidateLandingAfterWrite(['home', 'membership-plans']), adminMembershipPlanRoutes)
privateRouter.use('/api/admin/memberships', adminMembershipRoutes)
privateRouter.use('/api/admin/customers', adminCustomerRoutes)

// Antrean verifikasi identitas — Fase 8E. Prefix literal tersendiri, tidak bentrok dengan prefix lain.
// Ketiga route-nya digerbangi identity.verify (= `verify-identity` Laravel); urutan
// literal-sebelum-:param dijaga di dalam file details-nya.
privateRouter.use('/api/admin/identity', adminIdentityRoutes)

// Gym: meja check-in + analitik kunjungan (PRD tambahan 2026-09, tahap D). Prefix literal tersendiri.
privateRouter.use('/api/admin/gym', adminGymRoutes)

// CMS — Fase 8F. Sembilan prefix literal yang saling lepas; tidak ada batasan urutan di antaranya
// (router.use Express mencocokkan pada batas segmen, jadi '/news' TIDAK menelan '/news-categories').
// Urutan literal-sebelum-:param ('/create', '/reorder') dijaga di dalam tiap file details.
// Catatan: pengaturan rekening 8D ada di /api/admin/payments/settings, jadi /api/admin/settings
// (gym traffic) tidak bentrok dengannya.
privateRouter.use('/api/admin/news-categories', revalidateLandingAfterWrite(['home', 'news']), adminNewsCategoryRoutes)
privateRouter.use('/api/admin/news', revalidateLandingAfterWrite(['home', 'news']), adminNewsRoutes)
privateRouter.use('/api/admin/info-banners', afterHomeWrite, adminInfoBannerRoutes)
privateRouter.use('/api/admin/promo', afterHomeWrite, adminPromoRoutes)
privateRouter.use('/api/admin/sponsors', afterHomeWrite, adminSponsorRoutes)
privateRouter.use('/api/admin/reels', afterHomeWrite, adminReelRoutes)
privateRouter.use('/api/admin/testimonials', afterHomeWrite, adminTestimonialRoutes)
privateRouter.use('/api/admin/reviews', revalidateLandingAfterWrite(['home', 'booking-reviews']), adminReviewRoutes)

// Settings + profil staf — Fase 8G. Ketiga sub-prefix '/settings/*' WAJIB di atas '/api/admin/settings'
// (pasangan 4 di bawah). '/profile' dan '/email' prefix literal lepas, tanpa kendala urutan.
privateRouter.use('/api/admin/settings/roles', adminSettingsRoleRoutes)
privateRouter.use('/api/admin/settings/users', adminSettingsUserRoutes)
privateRouter.use('/api/admin/settings/schedules', adminSettingsScheduleRoutes)
// Router ini hanya memuat PUT /gym-traffic, yang tampil di hero dan SectionTwo beranda.
privateRouter.use('/api/admin/settings', afterHomeWrite, adminSettingsRoutes)
privateRouter.use('/api/admin/profile', adminProfileRoutes)
privateRouter.use('/api/admin/email', adminEmailRoutes)
privateRouter.use('/api/admin/notifications', adminNotificationRoutes)

// ============================================================================
// === URUTAN ROUTE YANG WAJIB DIPERTAHANKAN (Fase 3, 6, 8) ===
// ============================================================================
// Express mencocokkan route dari atas ke bawah dan sebuah parameter path akan
// menelan segmen literal yang didaftarkan SETELAHNYA. Tiga pasangan berikut
// diam-diam rusak kalau urutannya terbalik — gejalanya bukan 404, melainkan
// handler salah yang menerima 'plans' atau 'create' sebagai id:
//
//   1. /api/admin/memberships/plans dan /memberships/plans/:id
//      WAJIB didaftarkan SEBELUM /api/admin/memberships/:id
//   2. /api/admin/checkin
//      WAJIB didaftarkan SEBELUM /api/admin/checkin/:token
//   3. /api/admin/facilities/create dan /api/admin/facilities/reorder
//      WAJIB didaftarkan SEBELUM /api/admin/facilities/:id
//   4. /api/admin/settings/{roles,users,schedules}
//      WAJIB didaftarkan SEBELUM /api/admin/settings (gym traffic).
//      router.use() mencocokkan PREFIX: '/api/admin/settings' ikut menangkap ketiganya. Hari ini
//      router gym-traffic hanya punya PUT '/gym-traffic' sehingga request jatuh-lewat dan urutan
//      terbalik kebetulan masih bekerja — begitu ia menambah satu route ber-parameter, layar RBAC
//      diam-diam memanggil handler gym traffic dengan key 'roles'.
//
// ============================================================================
// === TODO Fase 8 — domain admin, dikerjakan berurutan ===
// ============================================================================
// facilities (index/form/units/pricing) -> bookings -> checkin -> classes ->
// memberships -> plans -> payments -> finance -> identity -> cms -> settings.
// Tiap domain: privateRouter.use('/api/admin/<domain>', <domain>Routes) di sini,
// permission per baris route di file details/<domain>.ts.
// Permission yang sudah disepakati: stats.read, reports.read, bookings.read,
// bookings.manage, bookings.limits.manage, facilities.read, facilities.manage,
// pricing.manage, cms.manage, news.publish, members.read, members.manage,
// payments.manage, identity.verify, rbac.manage, users.manage.
