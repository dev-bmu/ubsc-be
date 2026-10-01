import { RequestHandler } from 'express'
import { clearAdminNotificationsRead, getAdminNotifications, markAdminNotificationsRead } from '../services/notification-admin-services'
import { ok } from '../utils/respond'

// ===== Controller notification center admin (Fase 8G) =====
// Tipis: oper `req` (service butuh user + permission efektif untuk gate `canSee` per item) dan
// `req.body`, lalu balas ok(). Tidak ada requirePermission di baris route-nya — sama seperti
// Laravel yang memasang ketiga route ini di grup admin tanpa `authorize()`; visibilitas diputuskan
// PER ITEM di dalam service.

export const index: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await getAdminNotifications(req))
  } catch (error) {
    next(error)
  }
}

/** Body `{ ids?: string[] }`. Absen/kosong = tandai semua yang terlihat. */
export const markRead: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await markAdminNotificationsRead(req, req.body))
  } catch (error) {
    next(error)
  }
}

/** Body `{ ids?: string[] }`. Absen/kosong = buang semua yang SUDAH dibaca (default Laravel). */
export const clearRead: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await clearAdminNotificationsRead(req, req.body))
  } catch (error) {
    next(error)
  }
}
