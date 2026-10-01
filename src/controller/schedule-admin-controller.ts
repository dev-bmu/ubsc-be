import { RequestHandler } from 'express'
import * as service from '../services/schedule-admin-services'
import { ok } from '../utils/respond'

// ===== Controller pengaturan jadwal bulanan (Fase 8G) =====
// Tipis: baca body, panggil service, balas ok(). Permission bookings.limits.manage dicek di baris
// route (requirePermission di details/admin-settings-schedules.ts), tidak pernah di sini.
//
// Ketiga aksi tulis membalas AdminScheduleMonthDto — bentuk yang sama dengan satu entri index —
// bukan `back()->with('success')` ala Inertia. Kalimat sukses Laravel ("Jadwal Januari 2026 berhasil
// dibuka.") tidak ikut dikirim: panel menyusunnya sendiri dari `label` dan `isOpen` di balasan,
// sehingga tidak ada kalimat berbahasa Indonesia yang hidup di dua repo sekaligus.

export const index: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminSchedules())
  } catch (error) {
    next(error)
  }
}

export const toggle: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.toggleSchedule(req.body))
  } catch (error) {
    next(error)
  }
}

export const updateClosedDates: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateScheduleClosedDates(req.body))
  } catch (error) {
    next(error)
  }
}

/** Tanpa body sama sekali: bulan tujuan dihitung server dari jam WIB (lihat quickOpenNextSchedule). */
export const quickOpenNext: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.quickOpenNextSchedule())
  } catch (error) {
    next(error)
  }
}
