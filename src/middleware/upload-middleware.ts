import { RequestHandler } from 'express'
import multer from 'multer'
import { UPLOAD_LIMITS, UploadKind } from '../config/upload'
import { ResponseError } from '../error/response-error'

// ===== Upload satu berkas ke memori =====
// Berkas masuk ke memori (bukan disk) karena setiap gambar di-decode dan di-encode ulang oleh sharp
// sebelum menyentuh disk — berkas mentah dari klien tidak pernah ditulis apa adanya.
//
// SENGAJA tidak ada fileFilter berdasarkan mimetype. Content-Type bagian multipart ditulis klien dan
// bisa apa saja (sebagian aplikasi m-banking mengirim application/octet-stream untuk JPEG yang sah).
// Aturan `image|mimes` Laravel memeriksa ISI berkas; padanannya di sini adalah decoder sharp di
// payment-proof-services.inspect(). Menolak berdasarkan header hanya menambah penolakan palsu.

interface SingleUploadOptions {
  /** Pesan saat melewati batas ukuran — menempel ke field yang sama. */
  tooLargeMessage: string
  /** Batas byte satu field TEKS (default multer 1 MB) — dinaikkan untuk isi artikel HTML yang panjang. */
  fieldSize?: number
}

export function singleFileUpload(field: string, kind: UploadKind, options: SingleUploadOptions): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMITS[kind].maxBytes, files: 1, fields: 20, parts: 30, fieldSize: options.fieldSize }
  }).single(field)

  return (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (!error) return next()
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new ResponseError(413, options.tooLargeMessage, 'PAYLOAD_TOO_LARGE', { [field]: [options.tooLargeMessage] }))
      }
      // Batas multer lain dipetakan errorMiddleware ke envelope yang sama.
      next(error)
    })
  }
}

/** Bukti transfer: 10 MB, field `proof`. */
export const paymentProofUpload = singleFileUpload('proof', 'PAYMENT_PROOF', { tooLargeMessage: 'Ukuran gambar maksimal 10 MB.' })

// ===== Upload beberapa field sekaligus (mis. hero + gallery dalam satu submit) =====
// Padanan `->fields([...])` multer. Field non-berkas (name, slug, JSON slots) ikut terurai ke
// req.body; berkas ke req.files sebagai { [field]: Express.Multer.File[] }.
export function fieldsFileUpload(fields: { name: string; maxCount: number }[], kind: UploadKind, options: SingleUploadOptions): RequestHandler {
  const totalFiles = fields.reduce((sum, field) => sum + field.maxCount, 0)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMITS[kind].maxBytes, files: totalFiles, fields: 40, parts: 60, fieldSize: options.fieldSize }
  }).fields(fields)

  return (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (!error) return next()
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new ResponseError(413, options.tooLargeMessage, 'PAYLOAD_TOO_LARGE'))
      }
      next(error)
    })
  }
}

const CMS_IMAGE_TOO_LARGE = 'Ukuran gambar maksimal 5 MB.'

/** Media fasilitas: hero (1) + gallery (maks 12) dalam satu submit multipart. */
export const facilityMediaUpload = fieldsFileUpload(
  [
    { name: 'hero', maxCount: 1 },
    { name: 'gallery', maxCount: 12 }
  ],
  'CMS_IMAGE',
  { tooLargeMessage: CMS_IMAGE_TOO_LARGE }
)

/** Foto satu unit fasilitas: field `unit_image`, 5 MB. */
export const unitImageUpload = singleFileUpload('unit_image', 'CMS_IMAGE', { tooLargeMessage: CMS_IMAGE_TOO_LARGE })
