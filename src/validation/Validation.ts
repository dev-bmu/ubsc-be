import { ZodSchema } from 'zod'

// ===== Gerbang validasi =====

/**
 * Satu-satunya pintu masuk validasi. Bentuk boilerplate dipertahankan: baris pertama setiap
 * service adalah `const v = Validation.validate(XValidation.SCHEMA, request)` — tidak ada
 * validation middleware, jadi service memvalidasi dirinya sendiri.
 *
 * `ZodError` yang dilempar di sini sengaja tidak ditangkap: `errorMiddleware` yang mengubahnya
 * menjadi envelope 400 VALIDATION_ERROR beserta peta pesan per-field.
 */
export class Validation {
  /** Validasi sinkron. Dipakai oleh hampir semua service. */
  static validate<T>(schema: ZodSchema<T>, data: unknown): T {
    return schema.parse(data)
  }

  /**
   * Validasi asinkron. Diperlukan bila schema memakai `.refine()` async —
   * mis. cek ketersediaan slot atau keunikan email yang menyentuh database.
   */
  static async validateAsync<T>(schema: ZodSchema<T>, data: unknown): Promise<T> {
    return schema.parseAsync(data)
  }
}
