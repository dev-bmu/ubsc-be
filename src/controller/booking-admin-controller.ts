import { RequestHandler } from 'express'
import { createAdminBooking, destroyBooking, listAdminBookings, updateBookingStatus } from '../services/booking-admin-services'
import { checkInIndex, checkInShow, checkInStore } from '../services/checkin-services'
import { cancelSession, classRoster, restoreSession } from '../services/class-roster-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller admin Booking / Check-in / Class roster (Fase 8B) =====
// Tipis: baca params/body/query/user, panggil service, balas ok(). Permission dicek di baris route
// (requirePermission / requireAnyPermission di details/admin-*.ts), tidak pernah di sini.

// ===== Bookings =====

export const bookingsIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await listAdminBookings())
  } catch (error) {
    next(error)
  }
}

export const bookingsStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await createAdminBooking(req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const bookingsUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await updateBookingStatus(String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

export const bookingsDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await destroyBooking(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Check-in =====

export const checkinIndex: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await checkInIndex(req.query))
  } catch (error) {
    next(error)
  }
}

export const checkinShow: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await checkInShow(String(req.params.token)))
  } catch (error) {
    next(error)
  }
}

export const checkinStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await checkInStore(String(req.params.token), requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

// ===== Classes =====

export const classesIndex: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await classRoster(req.query))
  } catch (error) {
    next(error)
  }
}

export const classesCancelSession: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await cancelSession(req.body, requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

export const classesRestoreSession: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await restoreSession(req.body))
  } catch (error) {
    next(error)
  }
}
