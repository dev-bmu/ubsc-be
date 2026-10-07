import { RequestHandler, Response } from 'express'
import { accurateCustomerExport, accurateInvoiceExport, accurateReceiptExport } from '../services/accurate-export-services'
import { getFinanceReport } from '../services/finance-report-services'
import { ok } from '../utils/respond'

// ===== Controller laporan keuangan (Fase 8D) =====
// Tipis: baca query, panggil service, balas ok(). Permission dicek di baris route, tidak pernah di sini.

export const financeIndex: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await getFinanceReport(req.query))
  } catch (error) {
    next(error)
  }
}

// ===== Export Accurate (.xlsx) =====

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function sendXlsx(res: Response, file: { filename: string; buffer: Buffer }) {
  res.setHeader('Content-Type', XLSX_TYPE)
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  res.send(file.buffer)
}

export const accurateCustomers: RequestHandler = async (req, res, next) => {
  try {
    sendXlsx(res, await accurateCustomerExport(req.query))
  } catch (error) {
    next(error)
  }
}

export const accurateInvoices: RequestHandler = async (req, res, next) => {
  try {
    sendXlsx(res, await accurateInvoiceExport(req.query))
  } catch (error) {
    next(error)
  }
}

export const accurateReceipts: RequestHandler = async (req, res, next) => {
  try {
    sendXlsx(res, await accurateReceiptExport(req.query))
  } catch (error) {
    next(error)
  }
}
