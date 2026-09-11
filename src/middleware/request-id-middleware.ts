import { randomUUID } from 'crypto'
import { NextFunction, Request, Response } from 'express'

// ===== Request id =====

/** Nama header yang dibaca dan dikirim balik. */
const REQUEST_ID_HEADER = 'X-Request-Id'

/**
 * Bentuk id yang dianggap masuk akal: 8–128 karakter, hanya huruf/angka/`-`/`_`/`.`/`:`.
 * Ketat bukan karena rewel — nilainya dikirim balik sebagai header respons, jadi karakter apa pun
 * di luar daftar ini (terutama CR/LF) berpotensi jadi header injection.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/

/**
 * Pasang requestId ke `res.locals` dan kirim balik lewat header `X-Request-Id`.
 *
 * Id yang sama muncul di tiga tempat: header respons, field `error.requestId` pada envelope gagal,
 * dan baris log winston. Itu yang membuat keluhan user ("errornya ABC-123") bisa ditelusuri
 * ke satu baris log tanpa menebak-nebak.
 *
 * Bila klien (mis. nginx atau reverse proxy) sudah mengirim id yang bentuknya masuk akal, id itu
 * dipakai apa adanya supaya satu request bisa dilacak lintas hop.
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.get(REQUEST_ID_HEADER)
  const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID()

  res.locals.requestId = requestId
  res.setHeader(REQUEST_ID_HEADER, requestId)

  next()
}
