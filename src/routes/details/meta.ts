// ===== Route meta =====
//
// Di-mount di public-api.ts pada prefix /api/meta, jadi path di file ini relatif polos
// (konvensi boilerplate: prefix penuh hanya di titik mount).
//
// Tanpa requirePermission: hash kontrak sudah ikut ter-commit di bundle kedua app Next,
// dan mewajibkan sesi staff justru membuat pengecekan saat boot dev tidak bisa jalan.

import express from 'express'
import * as ctrl from '../../controller/meta-controller'

const router = express.Router()

router.get('/contract-hash', ctrl.contractHash)

export default router
