// ===== Klasifikasi error Prisma =====
// Dua error yang menjadi bagian dari ALUR NORMAL domain booking, bukan kegagalan:
//  - P2002 (unique violation) pada pendingTotal: dua checkout membaca kode unik bebas yang sama,
//    salah satunya kalah di indeks. Itu mekanisme korektness-nya — ditangkap lalu dicoba kode lain.
//  - Deadlock / lock wait timeout (MySQL 1213 / 1205, Prisma P2034): transaksi yang kalah di-rollback
//    utuh oleh InnoDB dan boleh diulang dari awal.
//
// Bentuk error DIBACA DARI FIELD TERSTRUKTUR, tidak dicari di teks pesan. Dengan driver adapter
// (Prisma 7 + @prisma/adapter-mariadb), P2002 tidak membawa meta.target; nama indeksnya ada di
// meta.driverAdapterError.cause.constraint.index ("transactions_pendingTotal_key"). Versi pertama
// modul ini men-JSON-kan error dengan replacer array — replacer itu menyaring kunci bersarang, sehingga
// pelanggaran pendingTotal tidak pernah dikenali dan loop coba-kode tidak pernah mencoba kode kedua.
// Ditemukan test konkurensi Fase 3. Pesan error juga tidak dipakai untuk pencocokan nama kolom: pesan
// Prisma memuat potongan kode sumber di sekitar pemanggilan, yang bisa menyebut kolom lain.

interface AdapterCause {
  kind?: string
  code?: number | string
  originalCode?: string
  message?: string
  originalMessage?: string
  constraint?: { index?: string; fields?: string[] }
}

interface PrismaLikeError {
  code?: string
  message?: string
  meta?: { target?: unknown; driverAdapterError?: { cause?: AdapterCause } }
}

const adapterCause = (e: unknown): AdapterCause | undefined => (e as PrismaLikeError | undefined)?.meta?.driverAdapterError?.cause

/** Nama indeks atau kolom yang dilanggar — dari meta.target (query engine) atau cause.constraint (driver adapter). */
function violatedNames(e: unknown): string[] {
  const err = e as PrismaLikeError
  const names: string[] = []
  const target = err.meta?.target
  if (Array.isArray(target)) names.push(...target.filter((t): t is string => typeof t === 'string'))
  else if (typeof target === 'string') names.push(target)

  const constraint = adapterCause(e)?.constraint
  if (constraint?.index) names.push(constraint.index)
  if (constraint?.fields) names.push(...constraint.fields)
  return names
}

/** Unique violation. Bila `field` diberikan, hanya bernilai true bila pelanggarannya pada kolom/indeks itu. */
export function isUniqueViolation(e: unknown, field?: string): boolean {
  if ((e as PrismaLikeError | undefined)?.code !== 'P2002') return false
  if (!field) return true
  return violatedNames(e).some((name) => name === field || name.includes(`_${field}_`) || name.endsWith(`_${field}`) || name.startsWith(`${field}_`))
}

/** Deadlock atau lock wait timeout yang aman diulang dari awal transaksi. */
export function isRetryableConflict(e: unknown): boolean {
  const err = e as PrismaLikeError | undefined
  if (err?.code === 'P2034') return true

  const cause = adapterCause(e)
  if (cause?.kind === 'TransactionWriteConflict') return true
  const mysqlCode = String(cause?.code ?? cause?.originalCode ?? '')
  if (mysqlCode === '1213' || mysqlCode === '1205') return true

  const text = `${cause?.message ?? ''} ${cause?.originalMessage ?? ''} ${err?.message ?? ''}`
  return /Deadlock found|Lock wait timeout exceeded/i.test(text)
}

/**
 * Menjalankan fn, mengulang bila kalah deadlock. InnoDB me-rollback transaksi korban seluruhnya,
 * jadi mengulang dari awal tidak pernah menggandakan tulisan.
 */
export async function withConflictRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!isRetryableConflict(e)) throw e
      lastError = e
    }
  }
  throw lastError
}
