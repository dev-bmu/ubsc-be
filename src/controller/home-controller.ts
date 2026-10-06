import { RequestHandler, Response } from 'express'
import {
  HOME_REELS_LIMIT,
  HOME_REVIEWS_LIMIT,
  getGymTraffic,
  getNewsDetail,
  listAnnouncements,
  listMembershipPlans,
  listNews,
  listPromos,
  listReels,
  listReviews,
  listSponsors,
  listTestimonials
} from '../services/cms-services'
import { getHome } from '../services/home-services'
import { listPageSeo } from '../services/page-seo-services'
import { listPublicFacilities } from '../services/public-facility-services'
import { ok } from '../utils/respond'

// ===== Controller data publik beranda =====
// Tipis: panggil service, balas lewat ok(), lempar sisanya ke next(). Tidak ada satu pun pembentukan
// data di file ini — bentuk JSON-nya milik service.

/**
 * SELURUH endpoint di file ini BOLEH di-cache bersama, dan header ini yang menyatakannya.
 *
 * KENAPA HARUS EKSPLISIT. Tanpa header, proxy bebas menebak dan jawabannya bisa berbeda antara dev,
 * nginx, dan CDN. Yang lebih penting: booking-controller.ts:14 memasang 'private, no-store' untuk
 * slots/month karena jawabannya memang bergantung pemanggil. Data di sini kebalikannya — sama untuk
 * setiap pengunjung, tidak ada satu pun field per-user di HomeDto — jadi mewarisi no-store hanya akan
 * membuang seluruh manfaat cache di jalur paling ramai yang dimiliki situs ini.
 *
 * Nilainya:
 *   public                     boleh disimpan cache BERSAMA (nginx/CDN), bukan cuma browser satu orang.
 *   max-age=0                  browser selalu revalidasi. Tab yang sudah terbuka tidak akan menampilkan
 *                              banner atau badge keramaian yang basi hanya karena belum di-hard-reload.
 *   s-maxage=300               cache bersama menyimpannya 5 menit. Angka 300 bukan pilihan bebas: ia
 *                              disamakan dengan ISR 300s beranda Next supaya tidak ada dua sumber
 *                              kebenaran soal seberapa basi data beranda boleh.
 *   stale-while-revalidate=600 sepuluh menit berikutnya cache boleh menyajikan salinan basi sambil
 *                              mengambil yang baru di belakang — pengunjung tidak pernah menunggu
 *                              query beranda, termasuk saat trafik datang serentak setelah entri
 *                              kedaluwarsa.
 *
 * SATU nilai untuk semua endpoint, termasuk /announcements dan /gym-traffic yang di Laravel dievaluasi
 * setiap request (HandleInertiaRequests::share memakai closure biasa, bukan Inertia::lazy). Keduanya ikut
 * terbungkus di dalam /home yang di-cache 300s juga, jadi memberi mereka umur berbeda justru membuat badge
 * di hero dan badge di SectionTwo bisa menampilkan status yang tidak sama pada saat yang sama.
 */
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'

const sharedCache = (res: Response) => res.setHeader('Cache-Control', PUBLIC_CACHE)

/** GET /api/public/home — sepuluh koleksi sekaligus, satu request untuk seluruh beranda. */
export const home: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await getHome())
  } catch (error) {
    next(error)
  }
}

// ===== Endpoint granular =====
// Masing-masing mengembalikan SATU koleksi dengan bentuk yang persis sama dengan field senamanya di
// HomeDto, untuk bagian halaman yang tidak butuh sembilan koleksi lain.
//
// LIMIT dioper eksplisit di bawah supaya terlihat di tempat keputusannya diambil, bukan tersembunyi di
// service. /reels dan /reviews masih menyajikan SUBSET BERANDA (8/10 baris teratas) — disengaja selama
// belum ada yang membutuhkan lebih.
//
// /news SUDAH TUMBUH di Fase 5: ia kini mengembalikan SELURUH berita terbit karena halaman /news Laravel
// memang tidak dibatasi dan tidak berpaginasi (PublicNewsController::index). Subset 7 baris milik beranda
// tetap dilayani /api/public/home lewat HOME_NEWS_LIMIT. Kalau kelak /news dipaginasi, yang tumbuh adalah
// endpoint ini (parameter query + meta paginasi), BUKAN limit service yang diam-diam memotong.

export const membershipPlans: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listMembershipPlans())
  } catch (error) {
    next(error)
  }
}

export const promos: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listPromos())
  } catch (error) {
    next(error)
  }
}

export const sponsors: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listSponsors())
  } catch (error) {
    next(error)
  }
}

export const news: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    // TANPA limit: berbeda dari /reels dan /reviews di bawah, endpoint ini melayani halaman /news
    // (Fase 5) yang di Laravel memang mengambil SELURUH berita terbit. Subset 7 baris milik beranda
    // tetap dilayani /api/public/home lewat HOME_NEWS_LIMIT — keduanya tidak saling memotong.
    ok(res, await listNews())
  } catch (error) {
    next(error)
  }
}

/**
 * Halaman /berita/<slug> dan /artikel/<slug> (PRD §7.7). Header cache dipasang SETELAH service berhasil:
 * 404 untuk slug yang belum terbit tidak boleh tersimpan 5 menit di cache bersama — artikel yang baru
 * diterbitkan akan tetap 404 sampai cache itu kedaluwarsa.
 */
export const newsDetail: RequestHandler = async (req, res, next) => {
  try {
    const detail = await getNewsDetail(String(req.params.slug))
    sharedCache(res)
    ok(res, detail)
  } catch (error) {
    next(error)
  }
}

export const reels: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listReels(HOME_REELS_LIMIT))
  } catch (error) {
    next(error)
  }
}

export const facilities: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listPublicFacilities())
  } catch (error) {
    next(error)
  }
}

export const testimonials: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listTestimonials())
  } catch (error) {
    next(error)
  }
}

/**
 * CATATAN STATUS: di BERANDA prop ini mati — SectionSeven.tsx:50 mendeklarasikan `reviews` tapi tidak
 * pernah men-destructure-nya. Endpoint tetap dibuat supaya koleksinya punya alamat sendiri saat halaman
 * ulasan dibangun, dan koleksinya tetap ikut di /home demi paritas bentuk dengan payload Inertia. Sampai
 * saat itu isinya subset beranda: 10 ulasan terbaru.
 */
export const reviews: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listReviews(HOME_REVIEWS_LIMIT))
  } catch (error) {
    next(error)
  }
}

export const announcements: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listAnnouncements())
  } catch (error) {
    next(error)
  }
}

export const gymTraffic: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await getGymTraffic())
  } catch (error) {
    next(error)
  }
}

/** Timpaan SEO halaman statis (hanya yang pernah disimpan admin); landing menggabungkannya dengan SEO_PAGES. */
export const seo: RequestHandler = async (_req, res, next) => {
  try {
    sharedCache(res)
    ok(res, await listPageSeo())
  } catch (error) {
    next(error)
  }
}
