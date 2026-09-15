import express from 'express'
import { staffAuthRequired } from '../middleware/auth-middleware'
import { UserRequest } from '../type/user-request'
import { ok } from '../utils/respond'
import adminPaymentRoutes from './details/admin-payments'

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

// Keputusan pembayaran (approve/reject) + berkas bukti — Fase 3. Antrean
// verifikasi dan pengaturan rekening menyusul di Fase 8 pada router yang sama.
privateRouter.use('/api/admin/payments', adminPaymentRoutes)

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
