import { Prisma } from '@prisma/client'

// ===== Opsi transaksi interaktif domain booking & pembayaran =====

/**
 * ReadCommitted (Rewrite.md): setiap statement melihat data ter-commit terbaru. Dipasangkan dengan
 * kunci `SELECT ... FOR UPDATE` pada baris induk yang diambil SEBAGAI STATEMENT PERTAMA, sehingga
 * pembacaan okupansi sesudahnya pasti melihat booking pesaing yang baru saja commit.
 *
 * maxWait/timeout eksplisit: transaksi interaktif mem-pin satu koneksi pool selama durasinya (R5),
 * dan transaksi yang menggantung tidak boleh menahan kunci tanpa batas.
 */
export const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 15_000
} as const
