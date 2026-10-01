import express from 'express'
import * as ctrl from '../../controller/dashboard-controller'

// ===== Route dashboard admin (staff) =====
// Prefix penuh (/api/admin/dashboard) dideklarasikan di private-api.ts.
//
//   GET /api/admin/dashboard   kartu statistik + tren pendapatan + okupansi + feed aktivitas + info banner
//
// TANPA requirePermission: route dashboard Laravel (Route::get('/')) hanya di dalam grup role staff,
// tanpa gate permission — kelima role mendarat di dashboard setelah login (kriteria kelulusan Fase 7).
// stats.read hanya menyembunyikan kartu di FE, bukan memblokir endpoint. Hanya autentikasi staff
// (staffAuthRequired di level router) yang berlaku.
//
// TULIS info-banner (tambah/edit/hapus/urut) + PUT gym-traffic ditunda Fase 8.
const adminDashboardRoutes = express.Router()

adminDashboardRoutes.get('/', ctrl.index)

export default adminDashboardRoutes
