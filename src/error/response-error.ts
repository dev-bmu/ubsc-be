import { ApiErrorCode, ApiFieldErrors, errorCodeForStatus } from '../utils/respond'

// ===== Error domain =====

/**
 * Error yang sengaja dilempar service dan langsung dipetakan ke envelope oleh `errorMiddleware`.
 *
 * Konvensi boilerplate dipertahankan: `throw new ResponseError(404, 'Fasilitas tidak ditemukan')`
 * tetap bekerja tanpa argumen tambahan — `code` diturunkan otomatis dari status.
 *
 * Argumen ketiga dipakai bila kode default tidak cukup spesifik:
 *   throw new ResponseError(409, 'Waktu tunggu pembayaran sudah habis', ERROR_CODES.HOLD_LAPSED)
 *
 * Argumen keempat mengirim pesan yang menempel ke field form:
 *   throw new ResponseError(409, 'Data tidak valid', ERROR_CODES.CONFLICT, { email: ['Email sudah terdaftar'] })
 */
export class ResponseError extends Error {
  public readonly code: ApiErrorCode

  constructor(
    public status: number,
    public message: string,
    code?: ApiErrorCode,
    public fields?: ApiFieldErrors
  ) {
    super(message)
    this.name = 'ResponseError'
    this.code = code ?? errorCodeForStatus(status)
    // Rantai prototype perlu dipulihkan manual saat meng-extend Error dengan target ES2020 ke bawah,
    // kalau tidak `instanceof ResponseError` gagal di hasil kompilasi.
    Object.setPrototypeOf(this, ResponseError.prototype)
  }
}
