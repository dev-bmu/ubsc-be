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
}

export function singleFileUpload(field: string, kind: UploadKind, options: SingleUploadOptions): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMITS[kind].maxBytes, files: 1, fields: 20, parts: 30 }
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
