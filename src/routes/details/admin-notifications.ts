import express from 'express'
import * as ctrl from '../../controller/notification-admin-controller'

// ===== Route notification center admin (staff) =====
// Prefix penuh (/api/admin/notifications) dideklarasikan di private-api.ts.
//
//   GET  /api/admin/notifications              daftar item + unreadCount            (autentikasi staff saja)
//   POST /api/admin/notifications/read         body { ids? } -> payload dihitung ulang (autentikasi staff saja)
//   POST /api/admin/notifications/clear-read   body { ids? } -> payload dihitung ulang (autentikasi staff saja)
//
// TANPA requirePermission, dan itu memang disengaja: Laravel memasang ketiga route ini di dalam grup
// admin tanpa satu pun `authorize()` (routes/web.php baris 321-323). Visibilitas diputuskan PER ITEM
// oleh `canSee()` di AdminNotificationCenter — staff tanpa permission apa pun tetap boleh memanggil
// endpoint-nya, hanya saja daftarnya kosong. Memasang gate di baris route akan mengubah 200-berisi-
// kosong menjadi 403 dan membuat lonceng notifikasi Topbar error untuk role yang sah.
//
// Urutan: kedua route POST adalah segmen LITERAL dan tidak ada satu pun route ber-:param di file ini,
// jadi tidak ada yang bisa saling menelan. GET '/' tetap ditulis lebih dulu mengikuti konvensi
// literal-sebelum-:param repo ini, supaya penambahan '/:id' di kemudian hari tidak diam-diam salah urut.
//
// ===== Baris mount yang WAJIB ditambahkan parent di src/routes/private-api.ts =====
//
//   import adminNotificationRoutes from './details/admin-notifications'
//   ...
//   privateRouter.use('/api/admin/notifications', adminNotificationRoutes)
//
// Batasan urutan: TIDAK ADA. '/api/admin/notifications' adalah prefix literal yang tidak dimiliki
// router lain, dan router.use() Express mencocokkan pada batas segmen sehingga ia tidak menelan
// maupun ditelan prefix mana pun yang sudah terpasang (/me, /dashboard, /payments, /news, dst).
// Letakkan di mana saja di antara blok `privateRouter.use('/api/admin/...')` yang sudah ada.

const adminNotificationRoutes = express.Router()

adminNotificationRoutes.get('/', ctrl.index)
adminNotificationRoutes.post('/read', ctrl.markRead)
adminNotificationRoutes.post('/clear-read', ctrl.clearRead)

export default adminNotificationRoutes
