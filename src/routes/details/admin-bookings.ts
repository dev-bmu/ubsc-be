import express from 'express'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/booking-admin-controller'
import { requireAnyPermission, requirePermission } from '../../middleware/permission-middleware'

// ===== Route booking admin (staff) =====
// Prefix penuh (/api/admin/bookings) dideklarasikan di private-api.ts.
//
//   GET    /api/admin/bookings        daftar penuh + opsi fasilitas (transformBooking)
//   POST   /api/admin/bookings        walk-in staff (store)
//   PATCH  /api/admin/bookings/:id    ubah status
//   DELETE /api/admin/bookings/:id    soft-cancel
//   GET    /api/admin/bookings/:id/reschedule-options?date=&facilityUnitId=   slot tujuan pindah jadwal
//   PATCH  /api/admin/bookings/:id/reschedule                              pindah jadwal (tanggal/jam/unit)
//
// index boleh dibaca READ/MANAGE/PAYMENTS (`view-bookings|manage-bookings|manage-payment-links`
// Laravel) dan RESCHEDULE (role kustom yang hanya boleh memindah jadwal tetap perlu daftarnya); mutasi
// butuh bookings.manage, pindah jadwal butuh bookings.reschedule. Permission per baris, tidak pernah di controller.

const BOOKING_READERS = [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.PAYMENTS_MANAGE, PERMISSIONS.BOOKINGS_RESCHEDULE]

const adminBookingRoutes = express.Router()

adminBookingRoutes.get('/', requireAnyPermission(BOOKING_READERS), ctrl.bookingsIndex)
adminBookingRoutes.post('/', requirePermission(PERMISSIONS.BOOKINGS_MANAGE), ctrl.bookingsStore)
adminBookingRoutes.patch('/:id', requirePermission(PERMISSIONS.BOOKINGS_MANAGE), ctrl.bookingsUpdate)
adminBookingRoutes.delete('/:id', requirePermission(PERMISSIONS.BOOKINGS_MANAGE), ctrl.bookingsDestroy)
adminBookingRoutes.get('/:id/reschedule-options', requirePermission(PERMISSIONS.BOOKINGS_RESCHEDULE), ctrl.bookingsRescheduleOptions)
adminBookingRoutes.patch('/:id/reschedule', requirePermission(PERMISSIONS.BOOKINGS_RESCHEDULE), ctrl.bookingsReschedule)

export default adminBookingRoutes
