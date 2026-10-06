import express from 'express'
import * as ctrl from '../../controller/home-controller'
import { publicLimiter } from '../../middleware/rate-limit-middleware'

// ===== Route data publik beranda dan koleksi CMS =====
// Prefix penuh (/api/public) dideklarasikan di public-api.ts.
//
//   GET /api/public/home              seluruh HomeDto dalam satu balasan
//   GET /api/public/membership-plans
//   GET /api/public/promos
//   GET /api/public/sponsors
//   GET /api/public/news
//   GET /api/public/news/:slug       NewsDetailDto, hanya artikel terbit (PRD §7.7)
//   GET /api/public/reels
//   GET /api/public/facilities
//   GET /api/public/testimonials
//   GET /api/public/reviews
//   GET /api/public/announcements
//   GET /api/public/gym-traffic
//   GET /api/public/seo              PageSeoDto[] — timpaan SEO halaman statis dari admin (PRD §7.7)
//
// PENAMAAN. Path jamak mengikuti nama field HomeDto (shared/contracts.ts) dengan camelCase diturunkan
// ke kebab-case, sama seperti /booking/slots dan /booking/month yang sudah ada: satu kata per konsep,
// huruf kecil, tanda hubung untuk kata majemuk. Dengan begitu `GET /api/public/news` mengembalikan persis
// isi `HomeDto.news`, dan tidak perlu ada tabel padanan nama antara route dan kontrak.
//
// Tanpa auth sama sekali. Berbeda dari /booking/slots yang memasang customerAuthOptional karena token
// customer ikut menentukan harga, tidak satu pun data di sini bergantung pemanggil — itulah yang membuat
// jawabannya boleh di-cache bersama (Cache-Control dipasang home-controller.ts).
//
// SATU INSTANCE publicLimiter UNTUK SELURUH BERKAS INI, dan itu disengaja: express-rate-limit menghitung
// per instance, jadi berbagi instance berarti kesebelas path berbagi satu jatah 60/menit per IP. Itu
// padanan `throttle:60,1` di routes/web.php:48, yang juga satu hitungan untuk satu kunjungan beranda.
//
// ⚠ KONSEKUENSI YANG HARUS DIPANTAU. 60/menit terhitung per IP, sementara jaringan kampus keluar lewat
// sedikit IP NAT bersama — peringatan yang sama sudah ditulis panjang di rate-limit-middleware.ts. Di
// Laravel satu kunjungan beranda = satu request; di sini landing sebaiknya memanggil /home (satu request)
// alih-alih sepuluh endpoint granular, kalau tidak satu kunjungan langsung memakan sepersepuluh jatah.
// Cache bersama 300s memperkecil dampaknya karena hit cache tidak pernah sampai ke limiter ini.

const publicHomeRoutes = express.Router()

publicHomeRoutes.get('/home', publicLimiter, ctrl.home)

publicHomeRoutes.get('/membership-plans', publicLimiter, ctrl.membershipPlans)
publicHomeRoutes.get('/promos', publicLimiter, ctrl.promos)
publicHomeRoutes.get('/sponsors', publicLimiter, ctrl.sponsors)
publicHomeRoutes.get('/news', publicLimiter, ctrl.news)
publicHomeRoutes.get('/news/:slug', publicLimiter, ctrl.newsDetail)
publicHomeRoutes.get('/reels', publicLimiter, ctrl.reels)
publicHomeRoutes.get('/facilities', publicLimiter, ctrl.facilities)
publicHomeRoutes.get('/testimonials', publicLimiter, ctrl.testimonials)
publicHomeRoutes.get('/reviews', publicLimiter, ctrl.reviews)
publicHomeRoutes.get('/announcements', publicLimiter, ctrl.announcements)
publicHomeRoutes.get('/gym-traffic', publicLimiter, ctrl.gymTraffic)
publicHomeRoutes.get('/seo', publicLimiter, ctrl.seo)

export default publicHomeRoutes
