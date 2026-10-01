import { RequestHandler, Response } from 'express'
import {
  approvedReviewIndex,
  bookingFacilityIndex,
  customerTransactionIndex,
  reviewEligibility,
  storeReview
} from '../services/customer-dashboard-services'
import { customerInvoice } from '../services/invoice-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller area customer Fase 6 =====
// Tipis: panggil service, balas lewat ok(), lempar sisanya ke next(). Tidak ada satu pun pembentukan
// data di berkas ini — bentuk JSON-nya milik customer-dashboard-services.ts.

/**
 * Dua endpoint publik di berkas ini (/booking/facilities dan /booking/reviews) sama untuk SETIAP
 * pengunjung — tidak ada satu field pun yang bergantung pemanggil — jadi keduanya boleh disimpan
 * cache bersama, persis seperti koleksi beranda di home-controller.ts.
 *
 * Nilainya disalin apa adanya dari PUBLIC_CACHE (home-controller.ts:44) DAN ITU DISENGAJA: kedua data
 * ini ikut menyusun satu halaman yang sama dengan koleksi beranda, jadi umur cache yang berbeda hanya
 * akan membuat dua bagian halaman menampilkan keadaan yang tidak sama pada saat yang sama. Konstanta
 * di home-controller.ts tidak diekspor dan berkas itu milik fase lain, jadi nilainya diduplikasi di
 * sini alih-alih diambil lewat import — kalau salah satu berubah, keduanya harus berubah.
 *
 * /api/customer/* di bawah TIDAK memakai ini: jawabannya per-user (Cache-Control default 'private'
 * tidak dipasang eksplisit, sama seperti endpoint customer Fase 3).
 */
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'

const sharedCache = (res: Response) => res.setHeader('Cache-Control', PUBLIC_CACHE)

// ===== Publik =====

/** GET /api/public/booking/facilities — FacilityDto beranda PLUS `units` (routes/web.php:157-159). */
export const bookingFacilities: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await bookingFacilityIndex())
  } catch (error) {
    next(error)
  }
}

/** GET /api/public/booking/reviews — `approved_reviews` halaman /booking (routes/web.php:167-177). */
export const bookingReviews: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await approvedReviewIndex())
  } catch (error) {
    next(error)
  }
}

// ===== Customer =====

/** GET /api/customer/reviews/eligibility — `can_review` + `existing_review`. */
export const reviewsEligibility: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await reviewEligibility(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/customer/reviews.
 *
 * 200, BUKAN 201: Laravel memakai updateOrCreate, jadi permintaan yang sama bisa membuat ATAU
 * memperbarui baris yang sudah ada — status 201 akan berbohong pada separuh kasusnya. (Di Laravel
 * sendiri balasannya redirect 302 back(), yang tidak punya padanan di API JSON.)
 */
export const reviewsStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await storeReview(requireUser(req).id, req.body))
  } catch (error) {
    next(error)
  }
}

/** GET /api/customer/transactions — 20 transaksi terbaru milik pemanggil. */
export const transactions: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await customerTransactionIndex(requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

/** GET /api/customer/transactions/:transactionId/invoice — invoice/kuitansi siap cetak, hanya pemiliknya. */
export const transactionInvoice: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await customerInvoice(requireUser(req).id, String(req.params.transactionId)))
  } catch (error) {
    next(error)
  }
}
