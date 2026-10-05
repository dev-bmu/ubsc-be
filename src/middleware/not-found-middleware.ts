// ===== 404 dalam bentuk envelope =====
//
// Tanpa middleware ini Express 5 menjawab route yang tidak cocok dengan halaman HTML
// bawaannya. Kedua app Next selalu mem-parse { success, error } dari setiap respons API,
// jadi satu salah ketik URL membuat parser-nya pecah dengan "Unexpected token '<'" —
// pesan yang tidak menunjuk ke penyebab aslinya sama sekali.
//
// Dipasang HANYA untuk prefix /api (lihat application/web.ts), dan itu disengaja:
//   - /api adalah permukaan kontrak; di sanalah envelope wajib berlaku tanpa kecuali.
//   - /uploads disajikan express.static dan dikonsumsi <img>/<video>, bukan fetch().
//     Berkas gambar yang hilang harus berakhir sebagai 404 kosong seperti yang
//     diharapkan browser, bukan sebagai badan JSON yang tetap gagal di-decode sebagai
//     gambar.
//   - Path lain (/, /favicon.ico, probe bot) bukan bagian kontrak mana pun dan tidak
//     ada klien yang mem-parse-nya sebagai JSON.

import { NextFunction, Request, Response } from 'express'
import { ResponseError } from '../error/response-error'
import { ERROR_CODES } from '../utils/respond'

/**
 * Ubah "tidak ada route yang cocok" menjadi error domain biasa, lalu serahkan ke
 * errorMiddleware. Sengaja lewat next(), bukan menulis respons sendiri: dengan begitu
 * requestId, bentuk envelope, dan jalur logging-nya tetap satu — yang sama dengan
 * seluruh error lain di aplikasi ini.
 */
export const notFoundMiddleware = (_req: Request, _res: Response, next: NextFunction): void => {
  next(new ResponseError(404, 'Endpoint tidak ditemukan', ERROR_CODES.NOT_FOUND))
}
