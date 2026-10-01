import { RequestHandler } from 'express'
import { getPendingPayment } from '../services/pending-payment-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller transfer tertunda (customer) =====
// Tipis: baca user, panggil service, balas ok(). Boleh null — Navbar menyembunyikan pill-nya.

export const pendingPayment: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await getPendingPayment(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}
