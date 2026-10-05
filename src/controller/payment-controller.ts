import { RequestHandler, Response } from 'express'
import { customerProofFile, paymentDetail, ProofFile, uploadPaymentProof } from '../services/payment-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller pembayaran pelanggan =====

/**
 * Stream berkas bukti transfer. Dokumen bank: `private, no-store` supaya tidak tertinggal di cache
 * bersama atau proxy, dan `inline` supaya bisa ditampilkan di halaman, bukan diunduh paksa.
 *
 * Catatan untuk FE (Fase 4/8): access token hidup di memori JS, jadi <img src> tidak bisa memanggil
 * endpoint ini langsung. Ambil lewat axios sebagai blob lalu tampilkan dengan URL.createObjectURL.
 */
export function sendProofFile(res: Response, file: ProofFile): void {
  res.setHeader('Content-Type', file.mime)
  res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`)
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  res.setHeader('Content-Length', file.data.length)
  res.end(file.data)
}

export const show: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await paymentDetail(requireUser(req).id, String(req.params.bookingId)))
  } catch (error) {
    next(error)
  }
}

export const uploadProof: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await uploadPaymentProof(requireUser(req).id, String(req.params.bookingId), req.file))
  } catch (error) {
    next(error)
  }
}

export const proofFile: RequestHandler = async (req, res, next) => {
  try {
    sendProofFile(res, await customerProofFile(requireUser(req).id, String(req.params.transactionId)))
  } catch (error) {
    next(error)
  }
}
