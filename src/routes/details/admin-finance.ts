import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/finance-report-controller'
import { requirePermission } from '../../middleware/permission-middleware'

// ===== Route laporan keuangan (staff) =====
// Prefix penuh (/api/admin/finance) dideklarasikan di private-api.ts.
//
//   GET /api/admin/finance?month=&year=   laporan satu bulan (month 1..12, year 2020..2100; default bulan berjalan WIB)
//   GET /api/admin/finance/accurate/pelanggan?from=&to=   .xlsx impor pelanggan Accurate (pelanggan di faktur rentang itu)
//   GET /api/admin/finance/accurate/faktur?from=&to=      .xlsx impor faktur penjualan Accurate (transaksi dibuat di rentang itu)
//   GET /api/admin/finance/accurate/penerimaan?from=&to=  .xlsx impor penerimaan penjualan Accurate (transaksi lunas di rentang itu)
//
// `view-reports` Laravel ($this->authorize('view-reports')) = reports.read.

const adminFinanceRoutes = express.Router()

adminFinanceRoutes.get('/', requirePermission(PERMISSIONS.REPORTS_READ), ctrl.financeIndex)
adminFinanceRoutes.get('/accurate/pelanggan', requirePermission(PERMISSIONS.REPORTS_READ), ctrl.accurateCustomers)
adminFinanceRoutes.get('/accurate/faktur', requirePermission(PERMISSIONS.REPORTS_READ), ctrl.accurateInvoices)
adminFinanceRoutes.get('/accurate/penerimaan', requirePermission(PERMISSIONS.REPORTS_READ), ctrl.accurateReceipts)

export default adminFinanceRoutes
