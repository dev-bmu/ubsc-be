import { RequestHandler } from 'express'
import { listPaymentQueue, updatePaymentSettings } from '../services/payment-admin-services'
import { staffInvoice } from '../services/invoice-services'
import { staffProofFile } from '../services/payment-services'
import { approvePayment, rejectPayment } from '../services/payment-verification-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'
import { sendProofFile } from './payment-controller'

// ===== Controller verifikasi pembayaran (staff) =====
// Permission dicek di baris route (requirePermission / requireAnyPermission), tidak pernah di sini.

// ===== Antrean + pengaturan (Fase 8D) =====

export const index: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await listPaymentQueue(req.query))
  } catch (error) {
    next(error)
  }
}

export const updateSettings: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await updatePaymentSettings(req.body))
  } catch (error) {
    next(error)
  }
}

// ===== Keputusan + bukti (Fase 3) =====

export const approve: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await approvePayment(String(req.params.transactionId), requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

export const reject: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await rejectPayment(String(req.params.transactionId), requireUser(req).id, req.body))
  } catch (error) {
    next(error)
  }
}

export const proofFile: RequestHandler = async (req, res, next) => {
  try {
    sendProofFile(res, next, await staffProofFile(String(req.params.transactionId)))
  } catch (error) {
    next(error)
  }
}

export const invoice: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await staffInvoice(String(req.params.transactionId)))
  } catch (error) {
    next(error)
  }
}
