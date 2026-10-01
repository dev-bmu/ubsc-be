import { RequestHandler } from 'express'
import * as service from '../services/membership-checkout-services'
import { UploadedFile } from '../services/payment-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller checkout membership lewat web (tahap C) =====
// Tipis: subjeknya selalu akun pemanggil (requireUser), tidak pernah id dari body.

export const preview: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.membershipCheckoutPreview(requireUser(req), String(req.params.planId)))
  } catch (error) {
    next(error)
  }
}

export const store: RequestHandler = async (req, res, next) => {
  try {
    const { created, membershipId } = await service.startMembershipCheckout(requireUser(req), req.body)
    ok(res, { membershipId }, undefined, created ? 201 : 200)
  } catch (error) {
    next(error)
  }
}

export const payment: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.membershipPaymentDetail(requireUser(req).id, String(req.params.membershipId)))
  } catch (error) {
    next(error)
  }
}

export const uploadProof: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.uploadMembershipProof(requireUser(req).id, String(req.params.membershipId), req.file as UploadedFile | undefined))
  } catch (error) {
    next(error)
  }
}
