import { RequestHandler } from 'express'
import * as service from '../services/gym-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller gym: meja check-in, analitik, kartu member (tahap D) =====
// Tipis. Staff pencatat dan pemilik kartu selalu dari sesi (requireUser), tidak pernah dari body.

export const desk: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.gymDesk())
  } catch (error) {
    next(error)
  }
}

export const lookup: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.lookupGymMember(req.query))
  } catch (error) {
    next(error)
  }
}

export const checkIn: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.recordGymVisit(requireUser(req).id, req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const report: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.gymVisitReport(req.query))
  } catch (error) {
    next(error)
  }
}

export const card: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.membershipCard(requireUser(req)))
  } catch (error) {
    next(error)
  }
}
