import { RequestHandler } from 'express'
import { getDashboard } from '../services/dashboard-services'
import { ok } from '../utils/respond'

// ===== Controller dashboard admin =====
// Autentikasi staff berlaku di level router (private-api.ts). Route dashboard Laravel
// (Route::get('/')) TIDAK punya gate permission — semua role staff mendarat di sini — jadi
// tidak ada requirePermission di baris route-nya. Visibilitas kartu stats (stats.read) adalah
// urusan FE, sama seperti Laravel.
export const index: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await getDashboard())
  } catch (error) {
    next(error)
  }
}
