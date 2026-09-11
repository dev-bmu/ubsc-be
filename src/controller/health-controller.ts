import { NextFunction, Request, Response } from 'express'
import { prismaClient } from '../application/database'
import { ResponseError } from '../error/response-error'
import { logger } from '../utils/logger'
import { ok } from '../utils/respond'

// ===== Health check =====
// Dua endpoint dengan biaya berbeda karena pemakainya berbeda (R15):
//   GET /api/health      — dipanggil UptimeRobot dan PM2 setiap menit. TIDAK
//                          menyentuh DB, supaya monitoring tidak ikut memakan
//                          koneksi pool yang dibutuhkan transaksi booking.
//   GET /api/health/deep — dipanggil manual saat menduga ada masalah. Ping DB.

const SERVICE_NAME = 'ubsc-api'

// npm_package_version hanya terisi bila proses dijalankan lewat npm script;
// di bawah PM2 (node dist/app.js) nilainya kosong. Bukan rahasia, jadi boleh
// dibaca langsung dari process.env tanpa lewat config.
const VERSION = process.env.npm_package_version ?? '0.0.0'

const baseInfo = () => ({ status: 'ok', service: SERVICE_NAME, version: VERSION, uptime: Math.round(process.uptime()) })

export const health = (_req: Request, res: Response) => {
  ok(res, baseInfo())
}

export const healthDeep = async (_req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now()

  try {
    await prismaClient.$queryRaw`SELECT 1`
  } catch (error) {
    logger.error(`Health check DB gagal: ${(error as Error).message}`)
    // Sengaja BUKAN 200 berisi status "down": monitoring uptime hanya membaca
    // status HTTP, dan 200 membuat DB mati terlihat sehat.
    return next(new ResponseError(503, 'Database tidak dapat dihubungi'))
  }

  ok(res, { ...baseInfo(), db: { status: 'ok', latencyMs: Date.now() - startedAt } })
}
