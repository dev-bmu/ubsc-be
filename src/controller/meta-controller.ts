// ===== Controller meta =====

import { NextFunction, Request, Response } from 'express'
import { ok } from '../utils/respond'
import { getContractHashInfo } from '../services/meta-services'

export async function contractHash(_req: Request, res: Response, next: NextFunction) {
  try {
    ok(res, await getContractHashInfo())
  } catch (e) {
    next(e)
  }
}
