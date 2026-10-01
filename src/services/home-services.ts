import type { HomeDto } from '../../shared/contracts'
import {
  HOME_NEWS_LIMIT,
  HOME_REELS_LIMIT,
  HOME_REVIEWS_LIMIT,
  getGymTraffic,
  listAnnouncements,
  listMembershipPlans,
  listNews,
  listPromos,
  listReels,
  listReviews,
  listSponsors,
  listTestimonials
} from './cms-services'
import { listPublicFacilities } from './public-facility-services'

// ============================================================================
// === Agregat beranda — port payload Inertia HomeController@index ===
// ============================================================================
// Komposer TIPIS dan sengaja tanpa logika sendiri: seluruh filter, urutan, limit, pemuatan media batch,
// dan pemformatan sudah dipegang cms-services.ts dan public-facility-services.ts. Satu-satunya pekerjaan
// file ini adalah menyusun sepuluh koleksi itu menjadi satu balasan, supaya beranda cukup satu request.
//
// KENAPA ADA SAMA SEKALI. Laravel mengirim kesepuluh prop ini dalam SATU response '/' (HomeController.php:25
// + HandleInertiaRequests::share). Kalau landing memanggil sepuluh endpoint granular satu per satu, tiap
// bagian beranda punya waktu render sendiri dan bagian yang lambat muncul belakangan — tampilannya tidak
// lagi identik meski datanya identik. Endpoint granular tetap ada untuk bagian halaman yang memang hanya
// butuh satu koleksi — sampai Fase 5, ketiganya (news/reels/reviews) menyajikan SUBSET BERANDA yang sama,
// bukan daftar penuh halaman /news.
//
// LIMIT BERANDA DIOPER DARI SINI. listNews/listReels/listReviews tidak punya limit bawaan: HOME_*_LIMIT di
// cms-services.ts adalah angka HomeController (7/8/10) dan file ini yang memasangnya. Limit yang tertanam
// di dalam service akan ikut terbawa ke endpoint granular, yang di Laravel tidak dibatasi.
//
// PARALEL, BUKAN BERURUTAN. Kesepuluh pengambilan saling bebas — tidak satu pun memakai hasil yang lain.
// Berurutan berarti sepuluh round-trip database ditumpuk berderet di jalur kritis beranda; Promise.all
// menjadikannya satu gelombang. Urutan elemen array hasil Promise.all deterministik mengikuti urutan
// argumennya, jadi destructuring di bawah aman.
//
// SATU GAGAL = SEMUA GAGAL, dan itu memang yang diinginkan. Promise.all menolak pada kegagalan pertama,
// sama seperti Laravel yang melempar 500 untuk seluruh halaman kalau salah satu query mati — beranda
// setengah terisi jauh lebih menyesatkan daripada halaman error. Dua koleksi yang di Laravel PUNYA guard
// (announcements dan gymTraffic, `Schema::hasTable`) sudah menelan kasusnya sendiri di dalam cms-services
// dan tidak pernah sampai ke sini sebagai penolakan.
//
// PROP PER-USER TIDAK BOLEH MASUK. `auth`, `flash`, `pendingPayment`, dan `admin_notifications` sengaja
// tidak ada di HomeDto: jawaban endpoint ini sama untuk semua pengunjung dan karena itu boleh di-cache
// bersama (lihat header Cache-Control di home-controller.ts). Menambahkan satu field per-user saja
// membuat cache itu membocorkan data satu orang ke orang lain.

/**
 * Seluruh data beranda dalam satu balasan — padanan payload Inertia '/' minus prop per-user.
 *
 * Sort/limit per koleksi tidak diulang di sini; sumbernya ada di masing-masing service dan diringkas di
 * dokumentasi HomeDto (shared/contracts.ts).
 */
export async function getHome(): Promise<HomeDto> {
  const [membershipPlans, promos, sponsors, news, reels, facilities, testimonials, reviews, announcements, gymTraffic] = await Promise.all([
    listMembershipPlans(),
    listPromos(),
    listSponsors(),
    listNews(HOME_NEWS_LIMIT),
    listReels(HOME_REELS_LIMIT),
    listPublicFacilities(),
    listTestimonials(),
    listReviews(HOME_REVIEWS_LIMIT),
    listAnnouncements(),
    getGymTraffic()
  ])

  return {
    membershipPlans,
    promos,
    sponsors,
    news,
    reels,
    facilities,
    testimonials,
    reviews,
    announcements,
    gymTraffic
  }
}
