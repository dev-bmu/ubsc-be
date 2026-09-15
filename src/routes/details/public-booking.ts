import express from 'express'
import * as ctrl from '../../controller/booking-controller'
import { customerAuthOptional } from '../../middleware/auth-middleware'
import { slotsLimiter } from '../../middleware/rate-limit-middleware'

// ===== Route booking publik =====
// Prefix penuh (/api/public/booking) dideklarasikan di public-api.ts.
//
//   GET /api/public/booking/slots  ?facilityId&facilityUnitId&date=YYYY-MM-DD
//   GET /api/public/booking/month  ?facilityId&facilityUnitId&month=YYYY-MM
//
// Tanpa login pun bisa, tapi token customer yang DIKIRIM ikut menentukan harga — lihat
// customerAuthOptional. Satu instance limiter untuk keduanya: di Laravel throttle:120,1 kedua route
// juga berbagi satu hitungan per pengunjung.

const publicBookingRoutes = express.Router()

publicBookingRoutes.get('/slots', slotsLimiter, customerAuthOptional, ctrl.slots)
publicBookingRoutes.get('/month', slotsLimiter, customerAuthOptional, ctrl.month)

export default publicBookingRoutes
