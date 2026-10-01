import { RequestHandler } from 'express'
import * as service from '../services/cms-card-admin-services'
import { ReelUploadFiles, TestimonialUploadFiles, UploadedImage } from '../services/cms-card-admin-services'
import { ok } from '../utils/respond'

// ===== Controller admin CMS kartu beranda (Fase 8F) =====
// Promo carousel, sponsor logo, reel, testimoni, dan review — keempat controller Laravel yang
// digerbangi `manage-cms`. Tipis: baca params/body/files, panggil service, balas ok(). Permission
// dicek di baris route (requirePermission di details/admin-promo|sponsors|reels|testimonials|reviews.ts),
// tidak pernah di sini.
//
// Bentuk berkas yang masuk berbeda per route dan itu disengaja:
//   - promo/sponsors  -> singleFileUpload  -> req.file  (memoryStorage, Buffer)
//   - testimonials    -> fieldsFileUpload  -> req.files { image?, logo? } (memoryStorage)
//   - reels           -> engine campuran   -> req.files { thumbnail? (Buffer), video? (path di disk) }
// Cast-nya dikumpulkan di tiga helper di bawah supaya tidak tersebar di tiap handler.

const singleImage = (file: unknown): UploadedImage | undefined => file as UploadedImage | undefined
const reelFiles = (files: unknown): ReelUploadFiles => (files ?? {}) as ReelUploadFiles
const testimonialFiles = (files: unknown): TestimonialUploadFiles => (files ?? {}) as TestimonialUploadFiles

// ===== Promo carousel =====

export const promoIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminPromos())
  } catch (error) {
    next(error)
  }
}

export const promoStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storePromo(req.body, singleImage(req.file)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const promoUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updatePromo(String(req.params.id), req.body, singleImage(req.file)))
  } catch (error) {
    next(error)
  }
}

export const promoReorder: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.reorderPromos(req.body))
  } catch (error) {
    next(error)
  }
}

export const promoDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyPromo(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Sponsor logo =====

export const sponsorIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminSponsors())
  } catch (error) {
    next(error)
  }
}

export const sponsorStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeSponsor(req.body, singleImage(req.file)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const sponsorUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateSponsor(String(req.params.id), req.body, singleImage(req.file)))
  } catch (error) {
    next(error)
  }
}

export const sponsorReorder: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.reorderSponsors(req.body))
  } catch (error) {
    next(error)
  }
}

export const sponsorDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroySponsor(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Reel =====

export const reelIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminReels())
  } catch (error) {
    next(error)
  }
}

export const reelStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeReel(req.body, reelFiles(req.files)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const reelUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateReel(String(req.params.id), req.body, reelFiles(req.files)))
  } catch (error) {
    next(error)
  }
}

export const reelDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyReel(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Testimoni =====

export const testimonialIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminTestimonials())
  } catch (error) {
    next(error)
  }
}

export const testimonialStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeTestimonial(req.body, testimonialFiles(req.files)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const testimonialUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateTestimonial(String(req.params.id), req.body, testimonialFiles(req.files)))
  } catch (error) {
    next(error)
  }
}

export const testimonialReorder: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.reorderTestimonials(req.body))
  } catch (error) {
    next(error)
  }
}

export const testimonialDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyTestimonial(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Review (dirender di halaman testimoni yang sama) =====

export const reviewToggleApprove: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.toggleReviewApproval(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

export const reviewDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyReview(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}
