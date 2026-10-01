import { RequestHandler } from 'express'
import * as service from '../services/facility-services'
import { FacilityUploadFiles, UploadedFile } from '../services/facility-services'
import { ok } from '../utils/respond'

// ===== Controller admin Facilities (Fase 8A) =====
// Tipis: baca params/body/files, panggil service, balas ok(). Permission dicek di baris route
// (requirePermission / requireAnyPermission di details/admin-*.ts), tidak pernah di sini.
//
// req.files (facilityMediaUpload .fields) berbentuk { hero?: File[], gallery?: File[] }; req.file
// (unitImageUpload .single) satu berkas. Keduanya di-cast ke bentuk minimum yang dipakai service.

const facilityFiles = (files: unknown): FacilityUploadFiles => (files ?? {}) as FacilityUploadFiles
const singleImage = (file: unknown): UploadedFile | undefined => file as UploadedFile | undefined

// ===== Fasilitas =====

export const index: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listAdminFacilities())
  } catch (error) {
    next(error)
  }
}

export const createForm: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.facilityCreateForm())
  } catch (error) {
    next(error)
  }
}

export const editForm: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.facilityEditForm(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

export const store: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeFacility(req.body, facilityFiles(req.files)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateFacility(String(req.params.id), req.body, facilityFiles(req.files)))
  } catch (error) {
    next(error)
  }
}

export const destroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyFacility(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

export const reorder: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.reorderFacilities(req.body))
  } catch (error) {
    next(error)
  }
}

export const destroyGallery: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyGalleryMedia(String(req.params.mediaId)))
  } catch (error) {
    next(error)
  }
}

// ===== Harga fasilitas =====

export const pricing: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.getFacilityPricing(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

export const pricingSync: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.syncFacilityPricing(String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

// ===== Unit fasilitas =====

export const units: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.listFacilityUnits(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

export const storeUnit: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeFacilityUnit(String(req.params.id), req.body, singleImage(req.file)), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const updateUnit: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateFacilityUnit(String(req.params.id), req.body, singleImage(req.file)))
  } catch (error) {
    next(error)
  }
}

export const destroyUnit: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyFacilityUnit(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}

// ===== Kategori fasilitas =====

export const categoryIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await service.listFacilityCategories())
  } catch (error) {
    next(error)
  }
}

export const categoryStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.storeFacilityCategory(req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const categoryUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.updateFacilityCategory(String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

export const categoryReorder: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.reorderFacilityCategories(req.body))
  } catch (error) {
    next(error)
  }
}

export const categoryDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await service.destroyFacilityCategory(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}
