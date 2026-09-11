import { Response } from 'express'

// ===== Kode error =====

/**
 * Satu-satunya daftar kode error yang boleh muncul di envelope.
 * FE memakai kode ini untuk mengambil keputusan — mis. VALIDATION_ERROR memicu
 * `applyApiErrors()` yang menempelkan `fields` ke `form.setError` per field.
 * Menambah kode baru: daftarkan di sini lebih dulu, lalu salin lewat `sync:contracts`.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Dibedakan dari INTERNAL_ERROR supaya FE bisa memisahkan "coba lagi nanti"
  // dari "ada bug". Dipakai /api/health/deep saat DB tidak terjangkau dan
  // jalur Google OAuth saat kredensialnya belum dikonfigurasi.
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Dipakai domain nanti — didaftarkan sekarang supaya FE bisa menyiapkan penanganannya lebih awal
  // TODO Fase 3: HOLD_LAPSED dilempar saat bukti bayar masuk setelah holdExpiresAt lewat
  HOLD_LAPSED: 'HOLD_LAPSED',
  // TODO Fase 3: PENDING_TOTAL_EXHAUSTED dilempar setelah 25 percobaan kode pendingTotal gagal
  PENDING_TOTAL_EXHAUSTED: 'PENDING_TOTAL_EXHAUSTED'
} as const

export type ApiErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

// ===== Bentuk envelope =====

/** Peta pesan per-field: nama field (path Zod di-join dengan titik) -> daftar pesan. */
export type ApiFieldErrors = Record<string, string[]>

/** Meta paginasi. Selalu lengkap bila ada — FE tidak perlu menghitung apa pun. */
export interface ApiMeta {
  page: number
  perPage: number
  total: number
  lastPage: number
}

export interface ApiError {
  code: ApiErrorCode
  message: string
  fields?: ApiFieldErrors
  requestId?: string
}

export interface ApiSuccessBody<T> {
  success: true
  data: T
  meta?: ApiMeta
}

export interface ApiErrorBody {
  success: false
  error: ApiError
}

export type ApiBody<T> = ApiSuccessBody<T> | ApiErrorBody

// ===== Pemetaan status -> kode =====

/**
 * Kode default yang diturunkan dari status HTTP.
 * Dipakai `ResponseError` supaya konvensi boilerplate `throw new ResponseError(404, 'Pesan')`
 * tetap bekerja tanpa argumen tambahan.
 */
export const errorCodeForStatus = (status: number): ApiErrorCode => {
  switch (status) {
    case 400:
    case 422:
      return ERROR_CODES.VALIDATION_ERROR
    case 401:
      return ERROR_CODES.UNAUTHENTICATED
    case 403:
      return ERROR_CODES.FORBIDDEN
    case 404:
      return ERROR_CODES.NOT_FOUND
    case 409:
      return ERROR_CODES.CONFLICT
    case 413:
      return ERROR_CODES.PAYLOAD_TOO_LARGE
    case 429:
      return ERROR_CODES.RATE_LIMITED
    case 502:
    case 503:
    case 504:
      // Dependensi di luar proses ini yang bermasalah (DB, SMTP, Google), bukan
      // kode kita — FE boleh menawarkan "coba lagi" alih-alih menyerah.
      return ERROR_CODES.SERVICE_UNAVAILABLE
    default:
      // 4xx lain (402, 410, 415, ...) diperlakukan sebagai penolakan input supaya FE punya satu jalur penanganan;
      // 5xx apa pun selalu INTERNAL_ERROR.
      return status >= 400 && status < 500 ? ERROR_CODES.VALIDATION_ERROR : ERROR_CODES.INTERNAL_ERROR
  }
}

// ===== Helper =====

/**
 * Ambil requestId yang dipasang `requestIdMiddleware`.
 * `res.locals` bertipe longgar di express, jadi nilainya dibaca sebagai unknown lalu dipersempit —
 * ini menghindari `any` bocor ke seluruh pemanggil.
 */
export const getRequestId = (res: Response): string | undefined => {
  const value: unknown = res.locals.requestId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Hitung meta paginasi. `lastPage` minimal 1 supaya UI tidak pernah menampilkan "halaman 1 dari 0". */
export const paginationMeta = (page: number, perPage: number, total: number): ApiMeta => {
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? Math.floor(perPage) : 1
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
  return {
    page: safePage,
    perPage: safePerPage,
    total: safeTotal,
    lastPage: Math.max(1, Math.ceil(safeTotal / safePerPage))
  }
}

/**
 * Balasan sukses. `meta` hanya ikut terkirim bila memang diberikan (endpoint non-list tidak punya meta).
 *
 * `status` default 200. Oper 201 pada endpoint yang benar-benar membuat resource baru
 * (register, store) — bentuk body-nya tetap sama, hanya kode statusnya yang berbeda.
 */
export const ok = <T>(res: Response, data: T, meta?: ApiMeta, status = 200): Response => {
  const body: ApiSuccessBody<T> = meta ? { success: true, data, meta } : { success: true, data }
  return res.status(status).json(body)
}

/**
 * Balasan gagal. `requestId` diisi otomatis dari `res.locals` bila tidak dioper —
 * dengan begitu setiap error yang sampai ke user selalu bisa ditelusuri ke satu baris log.
 */
export const fail = (res: Response, status: number, code: ApiErrorCode, message: string, fields?: ApiFieldErrors, requestId?: string): Response => {
  const error: ApiError = { code, message }
  if (fields && Object.keys(fields).length > 0) {
    error.fields = fields
  }
  const resolvedRequestId = requestId ?? getRequestId(res)
  if (resolvedRequestId) {
    error.requestId = resolvedRequestId
  }
  const body: ApiErrorBody = { success: false, error }
  return res.status(status).json(body)
}
