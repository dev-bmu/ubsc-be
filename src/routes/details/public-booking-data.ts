import express from 'express'
import * as ctrl from '../../controller/customer-dashboard-controller'
import { publicLimiter } from '../../middleware/rate-limit-middleware'

// ===== Route data statis halaman /booking (publik) =====
// Prefix penuh (/api/public/booking) dideklarasikan di public-api.ts.
//
//   GET /api/public/booking/facilities  fasilitas + units (BookingFacilityIndexDto)
//   GET /api/public/booking/reviews     ulasan yang sudah disetujui (ApprovedReviewIndexDto)
//
// TERPISAH DARI details/public-booking.ts, dan pemisahannya bukan selera. Berkas itu melayani
// /slots dan /month yang jawabannya BERGANTUNG PEMANGGIL (kategori harga warga UB, penanda "sudah
// Anda pesan") sehingga memakai customerAuthOptional + Cache-Control 'private, no-store'. Dua path
// di sini kebalikannya: tanpa auth sama sekali, sama untuk setiap pengunjung, dan boleh di-cache
// bersama (header dipasang customer-dashboard-controller.ts). Menaruh keduanya di satu router berarti
// satu berkas dengan dua aturan cache dan dua aturan auth yang berlawanan.
//
// RATE LIMIT. Di Laravel halaman /booking memakai `throttle:60,1` (routes/web.php:178) — satu
// kunjungan = satu request = satu hitungan. publicLimiter adalah instance 60/menit yang sama dengan
// yang dipakai seluruh /api/public/* beranda, jadi kedua path ini BERBAGI jatah dengan endpoint
// beranda. Itu sedikit lebih ketat daripada Laravel (di sana '/' dan '/booking' punya ember sendiri),
// dan itu pilihan sadar: satu kunjungan /booking di arsitektur ini sudah memecah satu halaman Inertia
// menjadi beberapa request, jadi ember terpisah akan melonggarkan batas total per IP, bukan menirunya.
// Kalau kelak /booking perlu embernya sendiri, buat instance createLimiter('booking-data', ...) —
// JANGAN menaikkan angka publicLimiter, itu ikut melonggarkan beranda.

const publicBookingDataRoutes = express.Router()

publicBookingDataRoutes.get('/facilities', publicLimiter, ctrl.bookingFacilities)
publicBookingDataRoutes.get('/reviews', publicLimiter, ctrl.bookingReviews)

export default publicBookingDataRoutes
