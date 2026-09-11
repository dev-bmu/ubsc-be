// ===== Logger =====
// Winston + rotasi harian. Bentuknya mengikuti boilerplate, dengan tiga perbaikan:
//   1. path.resolve terhadap process.cwd(), bukan path.join terhadap __dirname. Boilerplate
//      menulis log ke dalam src/ saat dev dan ke dalam dist/ setelah build — dua lokasi berbeda
//      untuk proses yang sama.
//   2. transport Console hanya dipasang SEKALI. Boilerplate memasangnya dua kali, jadi setiap
//      baris tercetak dobel di terminal dan di output PM2. (Bonus: karena colorize sekarang
//      digabung dengan printf, warnanya benar-benar muncul — di boilerplate colorize dipasang
//      tanpa printf sehingga tidak pernah terlihat.)
//   3. helper logError(requestId, err) supaya requestId di envelope error bisa ditelusuri ke
//      satu baris log.

import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import winston from 'winston'
import winstonDaily from 'winston-daily-rotate-file'
import { LOG_DIR } from '../config'

const logDir: string = resolve(process.cwd(), LOG_DIR)

if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true })
}

const logFormat = winston.format.printf((info) => {
  const requestId = typeof info.requestId === 'string' ? `[${info.requestId}] ` : ''
  return `${String(info.timestamp)} ${info.level}: ${requestId}${String(info.message)}`
})

const rotateOptions = { datePattern: 'YYYY-MM-DD', filename: '%DATE%.log', maxFiles: 5, zippedArchive: true }

const logger = winston.createLogger({
  format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.json(), logFormat),
  transports: [
    new winston.transports.Console({ format: winston.format.combine(winston.format.splat(), winston.format.colorize(), logFormat) }),
    new winstonDaily({ ...rotateOptions, level: 'debug', dirname: `${logDir}/debug`, json: true }),
    new winstonDaily({ ...rotateOptions, level: 'info', dirname: `${logDir}/logininfo`, json: true }),
    new winstonDaily({ ...rotateOptions, level: 'error', dirname: `${logDir}/error`, json: false, handleExceptions: true })
  ]
})

/**
 * Mencatat error beserta requestId yang sama dengan yang dikembalikan ke browser, sehingga
 * keluhan user ("kode errornya abc123") bisa ditelusuri ke satu baris log.
 *
 * Menerima `unknown` karena catch block TypeScript memang bertipe unknown — yang dilempar tidak
 * selalu instance Error.
 */
export const logError = (requestId: string | undefined, err: unknown): void => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  logger.error(detail, { requestId })
}

/** Stream untuk morgan bila nanti dipasang. */
const stream = {
  write: (message: string) => {
    logger.info(message.substring(0, message.lastIndexOf('\n')))
  }
}

export { logger, stream }
