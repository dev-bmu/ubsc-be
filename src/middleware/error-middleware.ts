import { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { ResponseError } from '../error/response-error'
import { logger } from '../utils/logger'
import { ApiFieldErrors, ERROR_CODES, fail, getRequestId } from '../utils/respond'

// ===== Pembaca properti yang aman =====

/** Baca properti string dari nilai apa pun tanpa cast ke `any`. */
const readString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const property = (value as Record<string, unknown>)[key]
  return typeof property === 'string' ? property : undefined
}

/** Baca properti object dari nilai apa pun tanpa cast ke `any`. */
const readRecord = (value: unknown, key: string): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const property = (value as Record<string, unknown>)[key]
  return typeof property === 'object' && property !== null ? (property as Record<string, unknown>) : undefined
}

// ===== Deteksi jenis error =====

/**
 * ZodError.
 * `instanceof` dipakai lebih dulu, lalu ada cadangan struktural: bila nanti ada dua salinan zod
 * di pohon dependency (mis. satu paket menarik versi sendiri), `instanceof` diam-diam gagal dan
 * seluruh validasi jatuh ke cabang 500 — justru cabang yang paling tidak boleh salah di sini.
 */
const isZodError = (error: unknown): error is ZodError => {
  if (error instanceof ZodError) {
    return true
  }
  const name = readString(error, 'name')
  return typeof name === 'string' && name.includes('ZodError') && Array.isArray((error as { issues?: unknown }).issues)
}

/**
 * MulterError.
 * Sengaja TIDAK di-import statis: multer baru terpasang saat modul upload dikerjakan (Fase 1/6),
 * sedangkan file ini dimuat di setiap boot. Import statis membuat seluruh API gagal start hanya
 * karena satu paket belum ada. Multer menyetel `name = 'MulterError'` dan `code = 'LIMIT_*'`,
 * jadi pengecekan berbasis nama constructor + properti `code` sudah cukup andal.
 */
const isMulterError = (error: unknown): boolean => {
  const name = readString(error, 'name')
  const code = readString(error, 'code')
  return name === 'MulterError' && typeof code === 'string' && code.startsWith('LIMIT_')
}

/**
 * PrismaClientKnownRequestError.
 * Alasan sama seperti multer, plus satu tambahan: `@prisma/client` baru punya isi setelah
 * `prisma generate` dijalankan, sedangkan skema baru ditulis di Fase 1. Prisma menjamin `name`
 * dan `code` ('P2002', 'P2025', ...) pada error jenis ini.
 */
const isPrismaKnownRequestError = (error: unknown): boolean => {
  const name = readString(error, 'name')
  const code = readString(error, 'code')
  return name === 'PrismaClientKnownRequestError' && typeof code === 'string' && /^P\d{4}$/.test(code)
}

// ===== Pembangun peta field =====

/**
 * Ubah `ZodError.issues` menjadi peta per-field.
 * Inilah yang membuat ~40 form aplikasi bisa menempelkan pesan ke field-nya masing-masing:
 * path di-join dengan titik dan index array ikut jadi bagian path ('items.0.quantity'),
 * persis nama yang dipakai react-hook-form.
 */
const fieldsFromZodIssues = (error: ZodError): ApiFieldErrors => {
  const fields: ApiFieldErrors = {}
  for (const issue of error.issues) {
    const path = issue.path.map((segment) => String(segment)).join('.')
    // Isu yang tidak menempel ke field mana pun (mis. `.refine()` di level objek) ditaruh di 'root' —
    // itu key yang diterima `form.setError('root', ...)` di react-hook-form.
    const key = path.length > 0 ? path : 'root'
    const messages = fields[key] ?? []
    if (!messages.includes(issue.message)) {
      messages.push(issue.message)
    }
    fields[key] = messages
  }
  return fields
}

/** Pesan Indonesia untuk tiap batas multer. Nilai batasnya sendiri diatur di `config/upload.ts`. */
const multerMessage = (code: string): { status: number; message: string } => {
  switch (code) {
    case 'LIMIT_FILE_SIZE':
      return { status: 413, message: 'Ukuran berkas melebihi batas yang diizinkan.' }
    case 'LIMIT_FILE_COUNT':
      return { status: 400, message: 'Jumlah berkas yang diunggah melebihi batas.' }
    case 'LIMIT_UNEXPECTED_FILE':
      return { status: 400, message: 'Berkas dikirim pada field yang tidak diharapkan.' }
    case 'LIMIT_PART_COUNT':
      return { status: 400, message: 'Jumlah bagian pada formulir melebihi batas.' }
    case 'LIMIT_FIELD_KEY':
      return { status: 400, message: 'Nama field pada formulir terlalu panjang.' }
    case 'LIMIT_FIELD_VALUE':
      return { status: 400, message: 'Isi salah satu field pada formulir terlalu panjang.' }
    case 'LIMIT_FIELD_COUNT':
      return { status: 400, message: 'Jumlah field pada formulir melebihi batas.' }
    default:
      return { status: 400, message: 'Berkas gagal diunggah.' }
  }
}

// ===== Logging =====

/** Catat error server (5xx) lengkap dengan requestId, supaya keluhan user bisa dicari di log. */
const logServerError = (error: unknown, req: Request, requestId: string | undefined): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : `nilai non-Error dilempar: ${String(error)}`
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : ''
  logger.error(`[api-error] requestId=${requestId ?? '-'} ${req.method} ${req.originalUrl} -> ${detail}${stack}`)
}

// ===== Middleware =====

/**
 * Satu-satunya tempat error berubah menjadi envelope gagal.
 * Bentuknya selalu: { success: false, error: { code, message, fields?, requestId? } }.
 */
export const errorMiddleware = (error: unknown, req: Request, res: Response, next: NextFunction): void => {
  const requestId = getRequestId(res)

  // Respons sudah mulai terkirim (mis. error di tengah stream berkas) — express harus menutup koneksinya sendiri.
  if (res.headersSent) {
    next(error)
    return
  }

  // --- ZodError: 400 dengan peta per-field ---
  if (isZodError(error)) {
    fail(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Data tidak valid', fieldsFromZodIssues(error), requestId)
    return
  }

  // --- ResponseError: status, kode, dan fields diambil apa adanya dari error yang dilempar service ---
  if (error instanceof ResponseError) {
    // 5xx yang sengaja dilempar tetap dicatat — bedanya dengan 4xx, ini bukan kesalahan user.
    if (error.status >= 500) {
      logServerError(error, req, requestId)
    }
    fail(res, error.status, error.code, error.message, error.fields, requestId)
    return
  }

  // --- MulterError: pengganti PostTooLargeException Laravel ---
  // Tanpa cabang ini, unggahan yang kebesaran mengembalikan 500 opaque dan user tidak tahu harus apa.
  if (isMulterError(error)) {
    const { status, message } = multerMessage(readString(error, 'code') ?? '')
    // Nama field ikut dikirim supaya pesannya menempel ke input unggah yang benar.
    const field = readString(error, 'field')
    const fields: ApiFieldErrors | undefined = field ? { [field]: [message] } : undefined
    const code = status === 413 ? ERROR_CODES.PAYLOAD_TOO_LARGE : ERROR_CODES.VALIDATION_ERROR
    fail(res, status, code, message, fields, requestId)
    return
  }

  // --- Body terlalu besar / JSON rusak dari express.json() ---
  // Jalur ini terpisah dari multer: request JSON besar ditolak body-parser sebelum multer sempat jalan.
  const bodyParserType = readString(error, 'type')
  if (bodyParserType === 'entity.too.large') {
    fail(res, 413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'Data yang dikirim melebihi batas ukuran permintaan.', undefined, requestId)
    return
  }
  if (bodyParserType === 'entity.parse.failed') {
    fail(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Format data yang dikirim tidak valid.', undefined, requestId)
    return
  }

  // --- Prisma known request error ---
  if (isPrismaKnownRequestError(error)) {
    const code = readString(error, 'code')

    // P2002 = pelanggaran unique constraint. Di sini bukan kecelakaan melainkan mekanisme:
    // retry loop pendingTotal di Fase 3 memang mengandalkan insert yang ditolak unique index.
    if (code === 'P2002') {
      const target: unknown = readRecord(error, 'meta')?.target
      // MariaDB kadang mengembalikan nama constraint (string), bukan daftar kolom — hanya dipetakan bila berupa array.
      const columns: string[] = Array.isArray(target) ? target.filter((column: unknown): column is string => typeof column === 'string') : []
      // Peta field dibangun lewat loop, bukan Object.fromEntries: overload-nya mengembalikan `any` untuk entry
      // non-tuple dan itu akan mematikan pengecekan tipe pada argumen `fields` tanpa terlihat.
      let fields: ApiFieldErrors | undefined
      if (columns.length > 0) {
        fields = {}
        for (const column of columns) {
          fields[column] = ['Data ini sudah terdaftar.']
        }
      }
      // Service yang butuh pesan lebih ramah sebaiknya menangkap P2002 sendiri lalu melempar ResponseError dengan fields-nya.
      fail(res, 409, ERROR_CODES.CONFLICT, 'Data yang sama sudah terdaftar.', fields, requestId)
      return
    }

    // P2025 = baris yang dituju update/delete tidak ada.
    if (code === 'P2025') {
      fail(res, 404, ERROR_CODES.NOT_FOUND, 'Data tidak ditemukan.', undefined, requestId)
      return
    }

    // Kode P lain (P1001 koneksi putus, P2003 relasi, ...) bukan kesalahan user — jatuh ke 500 di bawah.
  }

  // --- Fallback 500 ---
  // JANGAN PERNAH mengirim error.message mentah ke klien: isinya bisa berupa query, path berkas,
  // atau potongan kredensial. Pesan asli + stack hanya masuk log, dikaitkan lewat requestId yang
  // sama dengan yang dilihat user — satu keluhan user bisa ditelusuri ke satu baris log.
  logServerError(error, req, requestId)
  fail(res, 500, ERROR_CODES.INTERNAL_ERROR, 'Terjadi kesalahan pada server. Silakan coba lagi beberapa saat lagi.', undefined, requestId)
}
