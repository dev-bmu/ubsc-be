import { RequestHandler, Response } from 'express'
import { bookingHistory, createBooking, getMonth, getSlots } from '../services/booking-services'
import { UserRequest } from '../type/user-request'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller booking =====
// Tipis: panggil service, balas lewat ok(), lempar sisanya ke next().

/**
 * Grid slot dan kalender bulan berbeda per pemanggil (kategori harga, sesi milik sendiri) dan berubah
 * setiap ada booking. Tidak boleh disimpan cache bersama mana pun, termasuk proxy di depan API.
 */
const noSharedCache = (res: Response) => res.setHeader('Cache-Control', 'private, no-store')

export const slots: RequestHandler = async (req, res, next) => {
  try {
    noSharedCache(res)
    ok(res, await getSlots(req.query, (req as UserRequest).user))
  } catch (error) {
    next(error)
  }
}

export const month: RequestHandler = async (req, res, next) => {
  try {
    noSharedCache(res)
    ok(res, await getMonth(req.query, (req as UserRequest).user))
  } catch (error) {
    next(error)
  }
}

export const store: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await createBooking(requireUser(req), req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const history: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await bookingHistory(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}
