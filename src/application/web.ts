// ===== Aplikasi Express =====
// Urutan middleware di file ini adalah kontrak, bukan selera. requestId harus lebih dulu dari
// apa pun yang bisa melempar error, supaya setiap baris log dan setiap envelope error punya id
// yang sama untuk ditelusuri.

import path from 'path'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { ADMIN_URL, LANDING_URL, MEDIA_DIR, UPLOAD_DIR } from '../config'
import { requestIdMiddleware } from '../middleware/request-id-middleware'
import { publicRouter } from '../routes/public-api'
import { customerRouter } from '../routes/customer-api'
import { privateRouter } from '../routes/private-api'
import { notFoundMiddleware } from '../middleware/not-found-middleware'
import { errorMiddleware } from '../middleware/error-middleware'

export const web = express()

// Di produksi nginx yang menerminasi TLS dan meneruskan X-Forwarded-*. Tanpa ini req.ip berisi IP
// nginx, bukan IP pengunjung — dan rate limit Fase 9 jadi global, bukan per IP (R18).
web.set('trust proxy', 1)

// ===== Allowlist CORS =====
// Hanya dua origin: landing dan admin. Keduanya sebenarnya same-origin lewat proxy (rewrite Next
// di dev, nginx di produksi), jadi daftar ini adalah pagar untuk akses langsung ke port API.

/** Header Origin dari browser tidak pernah berakhiran slash; samakan bentuknya supaya LANDING_URL
 * yang terlanjur ditulis dengan trailing slash di .env tidak diam-diam menolak semua request. */
const normalizeOrigin = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value)

const allowedOrigins = [LANDING_URL, ADMIN_URL].map(normalizeOrigin)

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // origin undefined = request same-origin, curl, atau health check.
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Origin tidak diizinkan oleh CORS'))
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Wajib true: access token dan refresh token hidup di cookie httpOnly.
  credentials: true
}

// ===== Middleware dasar =====
web.use(helmet())
web.use(requestIdMiddleware)

// Folder unggahan publik. Path di-resolve terhadap cwd proses, bukan __dirname — dist/ dan src/
// punya kedalaman berbeda, dan path relatif __dirname pecah begitu build dijalankan.
// Di produksi mount ini tidak terpakai: nginx menerminasi /uploads sendiri.
// storage/private TIDAK pernah di-mount di sini, dan itu disengaja.
web.use('/uploads', express.static(path.resolve(process.cwd(), UPLOAD_DIR), { index: false, dotfiles: 'ignore', maxAge: '7d' }))

// Direktori media bersama (R9): video reel dan aset berat yang sengaja tidak ikut git, dipindahkan dengan
// ops/scripts/sync-media.sh. Dipisahkan dari /uploads karena isinya beda sifat — /uploads berisi unggahan
// user yang lahir dan mati bersama baris tabel `media`, /media berisi aset build yang dikelola manifest.
//
// Seperti /uploads, mount ini hanya jalur DEV: di produksi nginx menerminasi /media langsung dari
// /srv/ubsc/media dan permintaan tidak pernah sampai ke proses Node (docs/media.md).
//
// maxAge 1 tahun, bukan 7 hari: isi direktori ini immutable — berkas tidak pernah ditulis ulang di tempat,
// perubahan selalu berupa nama baru plus baris manifest baru. Itu justru syarat yang dituntut CDN.
web.use('/media', express.static(path.resolve(process.cwd(), MEDIA_DIR), { index: false, dotfiles: 'ignore', maxAge: '365d', immutable: true }))

web.use(cors(corsOptions))
web.use(cookieParser())
web.use(express.json({ limit: '15mb' }))
web.use(express.urlencoded({ limit: '15mb', extended: true }))

// ===== Router per audience =====
// Tiga audience, tiga router. authRequired diterapkan sekali di level router, bukan per baris.
web.use(publicRouter) // /api/public/*, /api/auth/*
web.use(customerRouter) // authRequired('customer') -> /api/customer/*
web.use(privateRouter) // authRequired('staff')    -> /api/admin/*

// ===== 404 di bawah /api =====
// Dipasang SETELAH ketiga router dan SEBELUM error handler: apa pun yang sampai ke sini sudah
// gagal dicocokkan semua router, jadi jawabannya 404 dalam envelope yang sama dengan error lain.
// Lingkupnya sengaja hanya /api - alasan lengkapnya ada di middleware/not-found-middleware.ts.
web.use('/api', notFoundMiddleware)

// Error handler selalu paling akhir: Express hanya mengenalinya sebagai error handler kalau
// terdaftar setelah seluruh route.
web.use(errorMiddleware)
