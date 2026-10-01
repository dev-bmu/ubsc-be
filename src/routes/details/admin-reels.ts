import { randomUUID } from 'crypto'
import { createWriteStream, mkdirSync, unlink } from 'fs'
import { resolve } from 'path'
import express, { RequestHandler } from 'express'
import multer from 'multer'
import { PRIVATE_STORAGE_DIR } from '../../config'
import { PERMISSIONS } from '../../config/permissions'
import * as ctrl from '../../controller/cms-card-admin-controller'
import { ResponseError } from '../../error/response-error'
import { requirePermission } from '../../middleware/permission-middleware'
import { REEL_VIDEO_MAX_BYTES } from '../../services/cms-card-admin-services'

// ===== Route reel (staff) — Fase 8F =====
// Prefix penuh (/api/admin/reels) dideklarasikan di private-api.ts (baris mount lengkapnya
// didokumentasikan di details/admin-promo.ts).
//
//   GET    /api/admin/reels        cms.manage   AdminReelIndexDto (semua reel, createdAt DESC)
//   POST   /api/admin/reels        cms.manage   multipart `thumbnail` + `video` -> AdminReelDto (201)
//   PUT    /api/admin/reels/:id    cms.manage   multipart `thumbnail` + `video` -> AdminReelDto
//   DELETE /api/admin/reels/:id    cms.manage   -> { id }
//
// TIDAK ADA /reorder: tabel reels tidak punya kolom sort_order dan ReelController tidak punya aksinya.
// Karena itu juga tidak ada route literal yang perlu didahulukan terhadap '/:id'.
//
// ============================================================================
// === Unggahan campuran: thumbnail ke MEMORI, video ke DISK ===
// ============================================================================
// Satu badan multipart hanya bisa diurai SEKALI, jadi kedua field harus dilayani satu instance multer
// — padahal keduanya butuh penyimpanan yang berbeda:
//   - `thumbnail` (`nullable|image|max:5120`) harus berupa Buffer: storePublicMedia men-decode dan
//     meng-encode ulangnya lewat sharp, dan seluruh jalur gambar repo ini memakai memoryStorage.
//   - `video` (`nullable|mimes:mp4,webm|max:51200`) TIDAK boleh ke memori: 50 MB per request akan
//     ditahan di heap sampai request selesai. Ia ditulis ke berkas sementara, lalu DIPINDAHKAN
//     (bukan dibaca ulang) oleh storePublicVideo.
// Karena itu StorageEngine di bawah men-dispatch berdasarkan fieldname.
//
// TEMPATNYA SEMENTARA INI DI BERKAS ROUTE, DAN ITU BUKAN KONVENSI. Rumahnya yang benar adalah
// middleware/upload-middleware.ts bersama singleFileUpload/fieldsFileUpload; berkas itu di luar
// kepemilikan berkas tugas ini, jadi engine-nya ditulis di sini dan HARUS dipindahkan ke sana saat
// ada yang menyentuh upload-middleware berikutnya (tidak ada pemanggil lain, jadi pindahnya murni
// memotong-menempel + mengganti satu baris import).
//
// BATAS UKURAN = 50 MB, BUKAN UPLOAD_LIMITS.VIDEO_REEL.maxBytes (100 MB). Angka 100 MB di
// config/upload.ts adalah pagar infrastruktur dari Rewrite.md; aturan Laravel yang mengikat adalah
// `max:51200`. Memakai 100 MB akan menerima video yang di Laravel ditolak. Konstantanya hidup di
// services/cms-card-admin-services.ts (REEL_VIDEO_MAX_BYTES) supaya batas yang dipasang multer dan
// batas yang diperiksa ulang storePublicVideo tidak bisa melenceng satu sama lain.
//
// `limits.fileSize` berlaku untuk KEDUA field, jadi thumbnail kebesaran lolos multer di sini dan baru
// ditolak 413 oleh assertImageWithinCmsLimit() di service — status dan pesannya sama persis dengan
// yang dihasilkan route gambar lain, jadi FE tidak melihat perbedaan.

/** Berkas sementara ditaruh di storage/private (TIDAK PERNAH di-mount publik), bukan di uploads/. */
const TEMP_ROOT = (): string => resolve(process.cwd(), PRIVATE_STORAGE_DIR, 'tmp')

const VIDEO_TOO_LARGE = `Ukuran video maksimal ${REEL_VIDEO_MAX_BYTES / (1024 * 1024)} MB.`

/**
 * StorageEngine campuran. `video` di-stream ke berkas sementara bernama uuid TANPA ekstensi dari
 * klien (ekstensi tujuan baru ditentukan setelah isi berkasnya disniff); field lain dikumpulkan
 * sebagai Buffer seperti multer.memoryStorage().
 *
 * _removeFile dipanggil multer sendiri saat request dibatalkan atau melewati batas, sehingga berkas
 * sementara tidak tertinggal. Jalur sukses dan jalur error aplikasi dibersihkan di sisi service
 * (storePublicVideo + discardTempUpload).
 */
const reelStorage: multer.StorageEngine = {
  _handleFile(_req, file, callback) {
    if (file.fieldname !== 'video') {
      const chunks: Buffer[] = []
      file.stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      file.stream.on('error', callback)
      file.stream.on('end', () => {
        const buffer = Buffer.concat(chunks)
        callback(null, { buffer, size: buffer.length })
      })
      return
    }

    const destination = TEMP_ROOT()
    let target: string
    try {
      mkdirSync(destination, { recursive: true })
      target = resolve(destination, randomUUID())
    } catch (error) {
      callback(error)
      return
    }

    const out = createWriteStream(target)
    file.stream.on('error', (error: Error) => {
      out.destroy()
      callback(error)
    })
    out.on('error', callback)
    out.on('finish', () => callback(null, { destination, filename: target, path: target, size: out.bytesWritten }))
    file.stream.pipe(out)
  },

  _removeFile(_req, file, callback) {
    if (!file.path) {
      callback(null)
      return
    }
    // Berkas yang sudah hilang bukan error: multer hanya perlu tahu pembersihannya selesai.
    unlink(file.path, () => callback(null))
  }
}

/** `.fields()` thumbnail + video. Error batas dipetakan ke envelope yang sama dengan upload-middleware. */
const reelMediaUpload: RequestHandler = (() => {
  const upload = multer({
    storage: reelStorage,
    limits: { fileSize: REEL_VIDEO_MAX_BYTES, files: 2, fields: 20, parts: 30 }
  }).fields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'video', maxCount: 1 }
  ])

  return (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (!error) return next()
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new ResponseError(413, VIDEO_TOO_LARGE, 'PAYLOAD_TOO_LARGE', { video: [VIDEO_TOO_LARGE] }))
      }
      // Batas multer lain dipetakan errorMiddleware ke envelope yang sama.
      next(error)
    })
  }
})()

const adminReelRoutes = express.Router()

adminReelRoutes.get('/', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.reelIndex)
adminReelRoutes.post('/', reelMediaUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.reelStore)
adminReelRoutes.put('/:id', reelMediaUpload, requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.reelUpdate)
adminReelRoutes.delete('/:id', requirePermission(PERMISSIONS.CMS_MANAGE), ctrl.reelDestroy)

export default adminReelRoutes
