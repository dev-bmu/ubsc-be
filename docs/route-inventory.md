# Inventaris Route Laravel -> Sistem Baru

Peta kerja untuk R10 (`route()` Ziggy dipakai di **47 file**, **99 nama berbeda**). Dibuat di Fase 0 supaya
tidak ada satu pun halaman ditulis sambil menebak URL-nya.

Sumber: `php artisan route:list --json` pada `UBSC-LARAVEL` — **147 route, 141 bernama**. Enam yang tidak
bernama sengaja tidak masuk tabel: `GET /` (beranda, `HomeController@index` — tetap ada sebagai
`routes.home()` di landing), `POST login`, `POST register`, `POST confirm-password`,
`POST ubsc-staff/login`, dan `GET up` (health check bawaan Laravel, diganti `/api/health`).

## Cara membaca tabel

Migrasinya **bukan 1:1**. Nama route Laravel terbelah dua nasib yang sangat berbeda:

- **HALAMAN-LANDING / HALAMAN-ADMIN** — route `GET|HEAD` yang merender komponen Inertia. Ini yang menjadi
  URL di `src/config/routes.ts`. Pekerjaannya mekanis dan sudah selesai di Fase 0.
- **ENDPOINT-API** — semua route tulis (`POST/PUT/PATCH/DELETE`) **plus** route `GET` yang sebenarnya
  mengembalikan JSON atau stream berkas (`booking.slots`, `booking.month`, `admin.customers.search`,
  `admin.notifications.index`, `user.transactions`, `payments.proof`, `admin.identity.document`).
  Nama-nama ini **tidak masuk `routes.ts`** dan **hilang total dari kode komponen** — mereka menjadi path
  API di dalam `src/services/*.ts`, dikerjakan per domain sebagai bagian dari port-nya, bukan codemod.
- **DIHAPUS** — tidak punya penerus.

Tanda `*` di kolom nama = nama itu benar-benar dipanggil lewat `route()` di `resources/js`. Nama tanpa `*`
hanya hidup di sisi Laravel (redirect, middleware, link email) dan tidak pernah disentuh komponen.

Klasifikasi ditentukan dengan membaca nilai balik tiap controller (`Inertia::render` vs `response()->json`
vs `Storage::response`), bukan dari nama route — beberapa nama menyesatkan. `admin.facilities.units.index`
dan `admin.checkin.show` terdengar seperti endpoint tapi merender halaman; `admin.notifications.index` dan
`user.transactions` terdengar seperti halaman tapi mengembalikan JSON.

## Topologi API baru

Tiga router, dipisah berdasarkan siapa yang boleh memanggil:

| Prefix            | Auth                             | Isi                                                         |
| ----------------- | -------------------------------- | ----------------------------------------------------------- |
| `/api/public/*`   | tidak ada                        | data landing, ketersediaan slot, alur auth yang belum login |
| `/api/customer/*` | customer login                   | booking, pembayaran, profil, identitas, review, riwayat     |
| `/api/admin/*`    | staf login + `requirePermission` | seluruh panel admin                                         |

---

## 1. HALAMAN-LANDING

Menjadi `ubsc-landing/src/config/routes.ts`. Slug bahasa Indonesia dipertahankan apa adanya — URL publik
tidak boleh berubah.

| Nama Laravel          | Method    | URI Laravel                     | Klasifikasi     | Tujuan di sistem baru                                                                                      | Fase |
| --------------------- | --------- | ------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- | ---- |
| `about`               | GET\|HEAD | `/about`                        | HALAMAN-LANDING | `routes.about()` -> `/about`                                                                               | 5    |
| `booking`             | GET\|HEAD | `/booking`                      | HALAMAN-LANDING | `routes.booking()` -> `/booking`                                                                           | 6    |
| `booking.history`     | GET\|HEAD | `/riwayat-booking`              | HALAMAN-LANDING | `routes.bookingHistory()` -> `/riwayat-booking`                                                            | 6    |
| `booking.payment`     | GET\|HEAD | `/booking/{booking}/pembayaran` | HALAMAN-LANDING | `routes.bookingPayment(bookingId)` -> `/booking/{id}/pembayaran`                                           | 6    |
| `branches.show`       | GET\|HEAD | `/branches/{slug}`              | HALAMAN-LANDING | `routes.branches(slug)` -> `/branches/{slug}`                                                              | 5    |
| `coming-soon`         | GET\|HEAD | `/coming-soon`                  | HALAMAN-LANDING | `routes.comingSoon()` -> `/coming-soon`                                                                    | 5    |
| `facility`            | GET\|HEAD | `/facilities`                   | HALAMAN-LANDING | `routes.facilities()` -> `/facilities`                                                                     | 5    |
| `legal.privacy`       | GET\|HEAD | `/kebijakan-privasi`            | HALAMAN-LANDING | `routes.legalPrivacy()` -> `/kebijakan-privasi`                                                            | 5    |
| `legal.refund`        | GET\|HEAD | `/kebijakan-pengembalian`       | HALAMAN-LANDING | `routes.legalRefund()` -> `/kebijakan-pengembalian`                                                        | 5    |
| `legal.terms`         | GET\|HEAD | `/syarat-ketentuan`             | HALAMAN-LANDING | `routes.legalTerms()` -> `/syarat-ketentuan`                                                               | 5    |
| `login` *             | GET\|HEAD | `/login`                        | HALAMAN-LANDING | BUKAN halaman: `routes.authModal("login")` -> `/?auth=login`. Laravel pun sudah `redirect("/?auth=login")` | 1    |
| `news`                | GET\|HEAD | `/news`                         | HALAMAN-LANDING | `routes.news()` -> `/news`                                                                                 | 5    |
| `password.confirm` *  | GET\|HEAD | `/confirm-password`             | HALAMAN-LANDING | `routes.confirmPassword()` -> `/confirm-password`                                                          | 1    |
| `password.request` *  | GET\|HEAD | `/forgot-password`              | HALAMAN-LANDING | `routes.forgotPassword()` -> `/forgot-password`                                                            | 1    |
| `password.reset`      | GET\|HEAD | `/reset-password/{token}`       | HALAMAN-LANDING | `routes.resetPassword(token)` -> `/reset-password/{token}`                                                 | 1    |
| `pricing`             | GET\|HEAD | `/pricing`                      | HALAMAN-LANDING | `routes.pricing()` -> `/pricing`                                                                           | 5    |
| `register` *          | GET\|HEAD | `/register`                     | HALAMAN-LANDING | BUKAN halaman: `routes.authModal("register")` -> `/?auth=register`. Laravel pun sudah redirect             | 1    |
| `verification.notice` | GET\|HEAD | `/verify-email`                 | HALAMAN-LANDING | `routes.verifyEmail()` -> `/verify-email`                                                                  | 1    |

**Catatan `login` / `register`.** Keduanya bukan halaman, dan itu bukan keputusan baru: di
`routes/auth.php` Laravel sudah menulis `Route::get('login', fn () => redirect('/?auth=login'))`.
Mekanismenya modal di atas beranda. Di landing baru jangan dibuat halaman `/login` sama sekali, dan
jangan membaca query `?auth=` dengan `useSearchParams()` — hook itu memaksa route jadi dinamis dan
mematikan ISR untuk seluruh subtree tanpa error apa pun.

---

## 2. HALAMAN-ADMIN

Menjadi `ubsc-admin/src/config/routes.ts`, dengan prefix `ubsc-staff/` dibuang karena admin kini origin
sendiri di `dash.ubsportcenter.co.id`.

| Nama Laravel                      | Method    | URI Laravel                                 | Klasifikasi   | Tujuan di sistem baru                                                    | Fase |
| --------------------------------- | --------- | ------------------------------------------- | ------------- | ------------------------------------------------------------------------ | ---- |
| `admin.bookings.index`            | GET\|HEAD | `/ubsc-staff/bookings`                      | HALAMAN-ADMIN | `routes.bookings()` -> `/bookings`                                       | 8    |
| `admin.checkin.index` *           | GET\|HEAD | `/ubsc-staff/checkin`                       | HALAMAN-ADMIN | `routes.checkin()` -> `/checkin`                                         | 8    |
| `admin.checkin.show`              | GET\|HEAD | `/ubsc-staff/checkin/{token}`               | HALAMAN-ADMIN | `routes.checkinToken(token)` -> `/checkin/{token}`                       | 8    |
| `admin.classes.index` *           | GET\|HEAD | `/ubsc-staff/classes`                       | HALAMAN-ADMIN | `routes.classes()` -> `/classes`                                         | 8    |
| `admin.dashboard` *               | GET\|HEAD | `/ubsc-staff`                               | HALAMAN-ADMIN | `routes.dashboard()` -> `/` (prefix `ubsc-staff` dibuang)                | 7    |
| `admin.facilities.create` *       | GET\|HEAD | `/ubsc-staff/facilities/create`             | HALAMAN-ADMIN | `routes.facilitiesCreate()` -> `/facilities/create`                      | 8    |
| `admin.facilities.edit` *         | GET\|HEAD | `/ubsc-staff/facilities/{facility}/edit`    | HALAMAN-ADMIN | `routes.facilitiesEdit(id)` -> `/facilities/{id}/edit`                   | 8    |
| `admin.facilities.index` *        | GET\|HEAD | `/ubsc-staff/facilities`                    | HALAMAN-ADMIN | `routes.facilities()` -> `/facilities`                                   | 8    |
| `admin.facilities.pricing` *      | GET\|HEAD | `/ubsc-staff/facilities/{facility}/pricing` | HALAMAN-ADMIN | `routes.facilitiesPricing(id)` -> `/facilities/{id}/pricing`             | 8    |
| `admin.facilities.units.index` *  | GET\|HEAD | `/ubsc-staff/facilities/{facility}/units`   | HALAMAN-ADMIN | `routes.facilitiesUnits(id)` -> `/facilities/{id}/units`                 | 8    |
| `admin.facility-categories.index` | GET\|HEAD | `/ubsc-staff/facility-categories`           | HALAMAN-ADMIN | `routes.facilityCategories()` -> `/facility-categories`                  | 8    |
| `admin.finance.index` *           | GET\|HEAD | `/ubsc-staff/finance`                       | HALAMAN-ADMIN | `routes.finance()` -> `/finance`                                         | 8    |
| `admin.identity.index` *          | GET\|HEAD | `/ubsc-staff/identity`                      | HALAMAN-ADMIN | `routes.identity()` -> `/identity`                                       | 8    |
| `admin.memberships.index`         | GET\|HEAD | `/ubsc-staff/memberships`                   | HALAMAN-ADMIN | `routes.memberships()` -> `/memberships`                                 | 8    |
| `admin.memberships.plans.index`   | GET\|HEAD | `/ubsc-staff/memberships/plans`             | HALAMAN-ADMIN | `routes.membershipPlans()` -> `/memberships/plans`                       | 8    |
| `admin.news.create` *             | GET\|HEAD | `/ubsc-staff/news/create`                   | HALAMAN-ADMIN | `routes.newsCreate()` -> `/news/create`                                  | 8    |
| `admin.news.edit` *               | GET\|HEAD | `/ubsc-staff/news/{news}/edit`              | HALAMAN-ADMIN | `routes.newsEdit(id)` -> `/news/{id}/edit`                               | 8    |
| `admin.news.index` *              | GET\|HEAD | `/ubsc-staff/news`                          | HALAMAN-ADMIN | `routes.news()` -> `/news`                                               | 8    |
| `admin.payments.index` *          | GET\|HEAD | `/ubsc-staff/payments`                      | HALAMAN-ADMIN | `routes.payments()` -> `/payments`                                       | 8    |
| `admin.promo.index`               | GET\|HEAD | `/ubsc-staff/promo`                         | HALAMAN-ADMIN | `routes.promo()` -> `/promo`                                             | 8    |
| `admin.reels.index`               | GET\|HEAD | `/ubsc-staff/reels`                         | HALAMAN-ADMIN | `routes.reels()` -> `/reels`                                             | 8    |
| `admin.settings.roles` *          | GET\|HEAD | `/ubsc-staff/settings/roles`                | HALAMAN-ADMIN | `routes.settingsRoles()` -> `/settings/roles`                            | 8    |
| `admin.settings.schedules`        | GET\|HEAD | `/ubsc-staff/settings/schedules`            | HALAMAN-ADMIN | `routes.settingsSchedules()` -> `/settings/schedules`                    | 8    |
| `admin.settings.users`            | GET\|HEAD | `/ubsc-staff/settings/users`                | HALAMAN-ADMIN | `routes.settingsUsers()` -> `/settings/users`                            | 8    |
| `admin.sponsors.index`            | GET\|HEAD | `/ubsc-staff/sponsors`                      | HALAMAN-ADMIN | `routes.sponsors()` -> `/sponsors`                                       | 8    |
| `admin.testimonials.index`        | GET\|HEAD | `/ubsc-staff/testimonials`                  | HALAMAN-ADMIN | `routes.testimonials()` -> `/testimonials`                               | 8    |
| `ubsc-staff.login` *              | GET\|HEAD | `/ubsc-staff/login`                         | HALAMAN-ADMIN | `routes.login()` -> `/login` (origin sendiri, bukan `/ubsc-staff/login`) | 7    |

Dua halaman di `routes.ts` admin **tidak** berasal dari route Laravel mana pun, jadi tidak muncul di tabel
ini: `unauthorized` (`/unauthorized`, tujuan dorongan `AuthGuard` boilerplate yang halamannya belum pernah
dibuat) dan `settingsGymTraffic` (`/settings/gym-traffic`, di Laravel hanya ada endpoint `PUT` yang
dipanggil dari kontrol inline di Dashboard). Keduanya diberi `TODO` di file masing-masing.

---

## 3. ENDPOINT-API

**Tidak ada satu pun dari ini yang boleh masuk `routes.ts`.** Kolom tujuan adalah path API yang
direncanakan; yang mengikat adalah pemilihan router (`public` / `customer` / `admin`), bukan ejaan
persisnya. Path final ditetapkan bersama `ubsc-api/shared/contracts.ts` di fase domain masing-masing.

| Nama Laravel                               | Method    | URI Laravel                                          | Klasifikasi  | Tujuan di sistem baru                                                                                          | Fase |
| ------------------------------------------ | --------- | ---------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- | ---- |
| `admin.bookings.destroy` *                 | DELETE    | `/ubsc-staff/bookings/{booking}`                     | ENDPOINT-API | DELETE `/api/admin/bookings/:id`                                                                               | 8    |
| `admin.bookings.store` *                   | POST      | `/ubsc-staff/bookings`                               | ENDPOINT-API | POST `/api/admin/bookings`                                                                                     | 8    |
| `admin.bookings.update` *                  | PATCH     | `/ubsc-staff/bookings/{booking}`                     | ENDPOINT-API | PATCH `/api/admin/bookings/:id`                                                                                | 8    |
| `admin.checkin.store` *                    | POST      | `/ubsc-staff/checkin/{token}`                        | ENDPOINT-API | POST `/api/admin/checkin/:token`                                                                               | 8    |
| `admin.classes.sessions.cancel` *          | POST      | `/ubsc-staff/classes/cancel-session`                 | ENDPOINT-API | POST `/api/admin/classes/cancel-session`                                                                       | 8    |
| `admin.classes.sessions.restore` *         | POST      | `/ubsc-staff/classes/restore-session`                | ENDPOINT-API | POST `/api/admin/classes/restore-session`                                                                      | 8    |
| `admin.customers.search` *                 | GET\|HEAD | `/ubsc-staff/customers/search`                       | ENDPOINT-API | GET `/api/admin/customers/search` (JSON autocomplete)                                                          | 8    |
| `admin.facilities.destroy` *               | DELETE    | `/ubsc-staff/facilities/{facility}`                  | ENDPOINT-API | DELETE `/api/admin/facilities/:id`                                                                             | 8    |
| `admin.facilities.gallery.add`             | POST      | `/ubsc-staff/facilities/{facility}/gallery`          | ENDPOINT-API | POST `/api/admin/facilities/:id/gallery`                                                                       | 8    |
| `admin.facilities.gallery.destroy` *       | DELETE    | `/ubsc-staff/facilities/gallery/{media}`             | ENDPOINT-API | DELETE `/api/admin/facilities/gallery/:mediaId`                                                                | 8    |
| `admin.facilities.hero.update`             | POST      | `/ubsc-staff/facilities/{facility}/hero`             | ENDPOINT-API | POST `/api/admin/facilities/:id/hero`                                                                          | 8    |
| `admin.facilities.pricing.sync` *          | POST      | `/ubsc-staff/facilities/{facility}/pricing/sync`     | ENDPOINT-API | POST `/api/admin/facilities/:id/pricing/sync`                                                                  | 8    |
| `admin.facilities.reorder` *               | POST      | `/ubsc-staff/facilities/reorder`                     | ENDPOINT-API | POST `/api/admin/facilities/reorder`                                                                           | 8    |
| `admin.facilities.store` *                 | POST      | `/ubsc-staff/facilities`                             | ENDPOINT-API | POST `/api/admin/facilities`                                                                                   | 8    |
| `admin.facilities.units.store` *           | POST      | `/ubsc-staff/facilities/{facility}/units`            | ENDPOINT-API | POST `/api/admin/facilities/:id/units`                                                                         | 8    |
| `admin.facilities.update` *                | PUT       | `/ubsc-staff/facilities/{facility}`                  | ENDPOINT-API | PUT `/api/admin/facilities/:id`                                                                                | 8    |
| `admin.facility-categories.destroy` *      | DELETE    | `/ubsc-staff/facility-categories/{facilityCategory}` | ENDPOINT-API | DELETE `/api/admin/facility-categories/:id`                                                                    | 8    |
| `admin.facility-categories.reorder` *      | POST      | `/ubsc-staff/facility-categories/reorder`            | ENDPOINT-API | POST `/api/admin/facility-categories/reorder`                                                                  | 8    |
| `admin.facility-categories.store` *        | POST      | `/ubsc-staff/facility-categories`                    | ENDPOINT-API | POST `/api/admin/facility-categories`                                                                          | 8    |
| `admin.facility-categories.update` *       | PUT       | `/ubsc-staff/facility-categories/{facilityCategory}` | ENDPOINT-API | PUT `/api/admin/facility-categories/:id`                                                                       | 8    |
| `admin.facility-units.destroy` *           | DELETE    | `/ubsc-staff/facility-units/{facilityUnit}`          | ENDPOINT-API | DELETE `/api/admin/facility-units/:id`                                                                         | 8    |
| `admin.facility-units.update` *            | PUT       | `/ubsc-staff/facility-units/{facilityUnit}`          | ENDPOINT-API | PUT `/api/admin/facility-units/:id`                                                                            | 8    |
| `admin.identity.document`                  | GET\|HEAD | `/ubsc-staff/identity/{user}/document`               | ENDPOINT-API | GET `/api/admin/identity/:userId/document` (stream privat via `resolvePrivate`)                                | 8    |
| `admin.identity.verify` *                  | PATCH     | `/ubsc-staff/identity/{user}/verify`                 | ENDPOINT-API | PATCH `/api/admin/identity/:userId/verify`                                                                     | 8    |
| `admin.info-banners.destroy` *             | DELETE    | `/ubsc-staff/info-banners/{infoBanner}`              | ENDPOINT-API | DELETE `/api/admin/info-banners/:id`                                                                           | 8    |
| `admin.info-banners.reorder` *             | POST      | `/ubsc-staff/info-banners/reorder`                   | ENDPOINT-API | POST `/api/admin/info-banners/reorder`                                                                         | 8    |
| `admin.info-banners.store` *               | POST      | `/ubsc-staff/info-banners`                           | ENDPOINT-API | POST `/api/admin/info-banners`                                                                                 | 8    |
| `admin.info-banners.update` *              | PUT       | `/ubsc-staff/info-banners/{infoBanner}`              | ENDPOINT-API | PUT `/api/admin/info-banners/:id`                                                                              | 8    |
| `admin.memberships.destroy` *              | DELETE    | `/ubsc-staff/memberships/{membership}`               | ENDPOINT-API | DELETE `/api/admin/memberships/:id`                                                                            | 8    |
| `admin.memberships.plans.destroy` *        | DELETE    | `/ubsc-staff/memberships/plans/{plan}`               | ENDPOINT-API | DELETE `/api/admin/memberships/plans/:id`                                                                      | 8    |
| `admin.memberships.plans.store` *          | POST      | `/ubsc-staff/memberships/plans`                      | ENDPOINT-API | POST `/api/admin/memberships/plans`                                                                            | 8    |
| `admin.memberships.plans.update` *         | PATCH     | `/ubsc-staff/memberships/plans/{plan}`               | ENDPOINT-API | PATCH `/api/admin/memberships/plans/:id`                                                                       | 8    |
| `admin.memberships.renew` *                | POST      | `/ubsc-staff/memberships/{membership}/renew`         | ENDPOINT-API | POST `/api/admin/memberships/:id/renew`                                                                        | 8    |
| `admin.memberships.store` *                | POST      | `/ubsc-staff/memberships`                            | ENDPOINT-API | POST `/api/admin/memberships`                                                                                  | 8    |
| `admin.memberships.update` *               | PATCH     | `/ubsc-staff/memberships/{membership}`               | ENDPOINT-API | PATCH `/api/admin/memberships/:id`                                                                             | 8    |
| `admin.news-categories.destroy` *          | DELETE    | `/ubsc-staff/news-categories/{newsCategory}`         | ENDPOINT-API | DELETE `/api/admin/news-categories/:id`                                                                        | 8    |
| `admin.news-categories.store` *            | POST      | `/ubsc-staff/news-categories`                        | ENDPOINT-API | POST `/api/admin/news-categories`                                                                              | 8    |
| `admin.news-categories.update` *           | PUT       | `/ubsc-staff/news-categories/{newsCategory}`         | ENDPOINT-API | PUT `/api/admin/news-categories/:id`                                                                           | 8    |
| `admin.news.destroy` *                     | DELETE    | `/ubsc-staff/news/{news}`                            | ENDPOINT-API | DELETE `/api/admin/news/:id`                                                                                   | 8    |
| `admin.news.store` *                       | POST      | `/ubsc-staff/news`                                   | ENDPOINT-API | POST `/api/admin/news`                                                                                         | 8    |
| `admin.news.update` *                      | PUT       | `/ubsc-staff/news/{news}`                            | ENDPOINT-API | PUT `/api/admin/news/:id`                                                                                      | 8    |
| `admin.notifications.clear-read`           | POST      | `/ubsc-staff/notifications/clear-read`               | ENDPOINT-API | POST `/api/admin/notifications/clear-read`                                                                     | 7    |
| `admin.notifications.index`                | GET\|HEAD | `/ubsc-staff/notifications`                          | ENDPOINT-API | GET `/api/admin/notifications` (JSON, bukan halaman)                                                           | 7    |
| `admin.notifications.read`                 | POST      | `/ubsc-staff/notifications/read`                     | ENDPOINT-API | POST `/api/admin/notifications/read`                                                                           | 7    |
| `admin.payments.approve` *                 | POST      | `/ubsc-staff/payments/{transaction}/approve`         | ENDPOINT-API | POST `/api/admin/payments/:transactionId/approve`                                                              | 8    |
| `admin.payments.reject` *                  | POST      | `/ubsc-staff/payments/{transaction}/reject`          | ENDPOINT-API | POST `/api/admin/payments/:transactionId/reject`                                                               | 8    |
| `admin.payments.settings` *                | POST      | `/ubsc-staff/payments/settings`                      | ENDPOINT-API | POST `/api/admin/payments/settings`                                                                            | 8    |
| `admin.promo.destroy` *                    | DELETE    | `/ubsc-staff/promo/{promoCarousel}`                  | ENDPOINT-API | DELETE `/api/admin/promo/:id`                                                                                  | 8    |
| `admin.promo.reorder` *                    | POST      | `/ubsc-staff/promo/reorder`                          | ENDPOINT-API | POST `/api/admin/promo/reorder`                                                                                | 8    |
| `admin.promo.store` *                      | POST      | `/ubsc-staff/promo`                                  | ENDPOINT-API | POST `/api/admin/promo`                                                                                        | 8    |
| `admin.promo.update` *                     | PUT       | `/ubsc-staff/promo/{promoCarousel}`                  | ENDPOINT-API | PUT `/api/admin/promo/:id`                                                                                     | 8    |
| `admin.reels.destroy` *                    | DELETE    | `/ubsc-staff/reels/{reel}`                           | ENDPOINT-API | DELETE `/api/admin/reels/:id`                                                                                  | 8    |
| `admin.reels.store` *                      | POST      | `/ubsc-staff/reels`                                  | ENDPOINT-API | POST `/api/admin/reels`                                                                                        | 8    |
| `admin.reels.update` *                     | PUT       | `/ubsc-staff/reels/{reel}`                           | ENDPOINT-API | PUT `/api/admin/reels/:id`                                                                                     | 8    |
| `admin.reviews.destroy` *                  | DELETE    | `/ubsc-staff/reviews/{review}`                       | ENDPOINT-API | DELETE `/api/admin/reviews/:id`                                                                                | 8    |
| `admin.reviews.toggle-approve` *           | POST      | `/ubsc-staff/reviews/{review}/toggle-approve`        | ENDPOINT-API | POST `/api/admin/reviews/:id/toggle-approve`                                                                   | 8    |
| `admin.settings.gym-traffic.update` *      | PUT       | `/ubsc-staff/settings/gym-traffic`                   | ENDPOINT-API | PUT `/api/admin/settings/gym-traffic`                                                                          | 8    |
| `admin.settings.roles.update` *            | PUT       | `/ubsc-staff/settings/roles/{role}`                  | ENDPOINT-API | PUT `/api/admin/settings/roles/:id`                                                                            | 8    |
| `admin.settings.schedules.quick-open-next` | POST      | `/ubsc-staff/settings/schedules/quick-open-next`     | ENDPOINT-API | POST `/api/admin/settings/schedules/quick-open-next`                                                           | 8    |
| `admin.settings.schedules.toggle` *        | POST      | `/ubsc-staff/settings/schedules/toggle`              | ENDPOINT-API | POST `/api/admin/settings/schedules/toggle`                                                                    | 8    |
| `admin.settings.schedules.update-dates` *  | POST      | `/ubsc-staff/settings/schedules/update-dates`        | ENDPOINT-API | POST `/api/admin/settings/schedules/update-dates`                                                              | 8    |
| `admin.settings.users.destroy` *           | DELETE    | `/ubsc-staff/settings/users/{user}`                  | ENDPOINT-API | DELETE `/api/admin/settings/users/:id`                                                                         | 8    |
| `admin.settings.users.store` *             | POST      | `/ubsc-staff/settings/users`                         | ENDPOINT-API | POST `/api/admin/settings/users`                                                                               | 8    |
| `admin.settings.users.update` *            | PUT       | `/ubsc-staff/settings/users/{user}`                  | ENDPOINT-API | PUT `/api/admin/settings/users/:id`                                                                            | 8    |
| `admin.sponsors.destroy` *                 | DELETE    | `/ubsc-staff/sponsors/{sponsorLogo}`                 | ENDPOINT-API | DELETE `/api/admin/sponsors/:id`                                                                               | 8    |
| `admin.sponsors.reorder` *                 | POST      | `/ubsc-staff/sponsors/reorder`                       | ENDPOINT-API | POST `/api/admin/sponsors/reorder`                                                                             | 8    |
| `admin.sponsors.store` *                   | POST      | `/ubsc-staff/sponsors`                               | ENDPOINT-API | POST `/api/admin/sponsors`                                                                                     | 8    |
| `admin.sponsors.update` *                  | PUT       | `/ubsc-staff/sponsors/{sponsorLogo}`                 | ENDPOINT-API | PUT `/api/admin/sponsors/:id`                                                                                  | 8    |
| `admin.testimonials.destroy` *             | DELETE    | `/ubsc-staff/testimonials/{testimonial}`             | ENDPOINT-API | DELETE `/api/admin/testimonials/:id`                                                                           | 8    |
| `admin.testimonials.reorder` *             | POST      | `/ubsc-staff/testimonials/reorder`                   | ENDPOINT-API | POST `/api/admin/testimonials/reorder`                                                                         | 8    |
| `admin.testimonials.store` *               | POST      | `/ubsc-staff/testimonials`                           | ENDPOINT-API | POST `/api/admin/testimonials`                                                                                 | 8    |
| `admin.testimonials.update` *              | PUT       | `/ubsc-staff/testimonials/{testimonial}`             | ENDPOINT-API | PUT `/api/admin/testimonials/:id`                                                                              | 8    |
| `booking.month` *                          | GET\|HEAD | `/booking/month`                                     | ENDPOINT-API | GET `/api/public/booking/month`                                                                                | 3    |
| `booking.payment.proof` *                  | POST      | `/booking/{booking}/pembayaran/bukti`                | ENDPOINT-API | POST `/api/customer/booking/:bookingId/pembayaran/bukti` (multipart, 10 MB)                                    | 3    |
| `booking.slots` *                          | GET\|HEAD | `/booking/slots`                                     | ENDPOINT-API | GET `/api/public/booking/slots`                                                                                | 3    |
| `booking.store` *                          | POST      | `/booking`                                           | ENDPOINT-API | POST `/api/customer/booking`                                                                                   | 3    |
| `google.callback`                          | GET\|HEAD | `/auth/google/callback`                              | ENDPOINT-API | GET `/api/public/auth/google/callback`                                                                         | 1    |
| `google.login`                             | GET\|HEAD | `/auth/google`                                       | ENDPOINT-API | GET `/api/public/auth/google`                                                                                  | 1    |
| `logout` *                                 | POST      | `/logout`                                            | ENDPOINT-API | POST `/api/customer/auth/logout`                                                                               | 1    |
| `password.email` *                         | POST      | `/forgot-password`                                   | ENDPOINT-API | POST `/api/public/auth/forgot-password`                                                                        | 1    |
| `password.store` *                         | POST      | `/reset-password`                                    | ENDPOINT-API | POST `/api/public/auth/reset-password`                                                                         | 1    |
| `password.update` *                        | PUT       | `/password`                                          | ENDPOINT-API | PUT `/api/customer/profile/password`                                                                           | 1    |
| `payments.proof`                           | GET\|HEAD | `/pembayaran/{transaction}/bukti`                    | ENDPOINT-API | GET `/api/customer/payments/:transactionId/bukti` (stream privat via `resolvePrivate`, bukan `/uploads`)       | 3    |
| `profile.identity` *                       | POST      | `/profile/identity`                                  | ENDPOINT-API | POST `/api/customer/profile/identity` (unggah dokumen identitas dari modal)                                    | 6    |
| `profile.update` *                         | PATCH     | `/profile`                                           | ENDPOINT-API | PATCH `/api/customer/profile` (dipakai `UserDashboard/ProfileModal` + `Admin/ProfileModal`)                    | 6    |
| `reviews.store` *                          | POST      | `/reviews`                                           | ENDPOINT-API | POST `/api/customer/reviews`                                                                                   | 6    |
| `ubsc-staff.logout`                        | POST      | `/ubsc-staff/logout`                                 | ENDPOINT-API | POST `/api/admin/auth/logout`                                                                                  | 1    |
| `user.transactions`                        | GET\|HEAD | `/user/transactions`                                 | ENDPOINT-API | GET `/api/customer/transactions` (JSON, bukan halaman)                                                         | 6    |
| `verification.send` *                      | POST      | `/email/verification-notification`                   | ENDPOINT-API | POST `/api/customer/auth/verification-notification`                                                            | 1    |
| `verification.verify`                      | GET\|HEAD | `/verify-email/{id}/{hash}`                          | ENDPOINT-API | GET `/api/public/auth/verify-email/:id/:hash` (link bertanda tangan dari email; BE redirect ke `/?verified=1`) | 1    |

---

## 4. DIHAPUS

| Nama Laravel           | Method    | URI Laravel            | Klasifikasi | Tujuan di sistem baru                                                                                                                   | Fase |
| ---------------------- | --------- | ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `profile.destroy` *    | DELETE    | `/profile`             | DIHAPUS     | Hanya dipanggil `Pages/Profile/Partials/DeleteUserForm.tsx` yang ikut mati bersama `Pages/Profile`                                      | -    |
| `profile.edit` *       | GET\|HEAD | `/profile`             | DIHAPUS     | Closure redirect belaka (staf -> dashboard, customer -> `/`); `Pages/Profile` tak terjangkau customer. Yang di-port adalah ProfileModal | -    |
| `sanctum.csrf-cookie`  | GET\|HEAD | `/sanctum/csrf-cookie` | DIHAPUS     | Sanctum tidak dipakai; auth memakai skema boilerplate sendiri                                                                           | -    |
| `storage.local`        | GET\|HEAD | `/storage/{path}`      | DIHAPUS     | Diganti `express.static` di `/uploads` (publik) + `resolvePrivate` (privat)                                                             | -    |
| `storage.local.upload` | PUT       | `/storage/{path}`      | DIHAPUS     | Idem; unggah lewat endpoint domain masing-masing, bukan disk driver Laravel                                                             | -    |
| `webhook.xendit`       | POST      | `/webhook/xendit`      | DIHAPUS     | Xendit di-drop total; pembayaran hanya transfer manual + verifikasi staf                                                                | -    |

**Koreksi terhadap rencana: `profile.*` tidak dihapus seluruhnya.** Rencana awal menandai `profile.*`
sebagai dihapus dengan alasan `Pages/Profile` tidak terjangkau customer. Alasan itu benar, tapi hanya
berlaku untuk dua dari empat nama. Penelusuran pemanggilnya di `resources/js`:

| Nama               | Pemanggil                                                                                                                           | Nasib                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `profile.edit`     | `Layouts/AuthenticatedLayout.tsx` (2 tempat)                                                                                        | **Dihapus.** Closure-nya memang cuma redirect; halamannya tak pernah tampil.           |
| `profile.destroy`  | `Pages/Profile/Partials/DeleteUserForm.tsx`                                                                                         | **Dihapus.** Satu-satunya pemanggil ada di dalam pohon `Pages/Profile` yang ikut mati. |
| `profile.update`   | `Components/UserDashboard/ProfileModal.tsx`, `Components/Admin/ProfileModal.tsx`, `Components/UserDashboard/UserDashboardModal.tsx` | **Hidup** sebagai endpoint. Tiga pemanggilnya modal, bukan halaman.                    |
| `profile.identity` | `Components/UserDashboard/ProfileModal.tsx`                                                                                         | **Hidup** sebagai endpoint. Ini jalur unggah dokumen identitas.                        |

Menghapus `profile.identity` akan memutus satu-satunya cara customer mengirim dokumen identitas,
sementara `admin.identity.index` di panel admin ada justru untuk meninjau kiriman itu. Jadi dua nama
terakhir diklasifikasikan ENDPOINT-API, bukan DIHAPUS.

---

## Ringkasan hitungan

| Klasifikasi             | Jumlah  | Di antaranya dipanggil `route()` |
| ----------------------- | ------- | -------------------------------- |
| HALAMAN-LANDING         | 18      | 4                                |
| HALAMAN-ADMIN           | 27      | 16                               |
| ENDPOINT-API            | 90      | 77                               |
| DIHAPUS                 | 6       | 2                                |
| **Total route bernama** | **141** | **99**                           |

Rekonsiliasi dengan `route:list`: 141 bernama + 6 tidak bernama = **147 route**, cocok.

Rekonsiliasi dengan perkiraan di `Rewrite.md` ("~20 nama URL halaman, ~72 endpoint"). Angka itu memang
bicara tentang subset Ziggy saja, bukan seluruh 141, dan subset itu terbelah begini:

|                                             | Nama dipanggil `route()`          |
| ------------------------------------------- | --------------------------------- |
| Halaman (landing 4 + admin 16)              | **20** — persis seperti perkiraan |
| Endpoint                                    | **77** — perkiraan menyebut ~72   |
| Dihapus (`profile.edit`, `profile.destroy`) | 2                                 |
| **Total**                                   | **99**                            |

Selisih 77 lawan ~72 bukan temuan baru, hanya pencacahan yang lebih teliti; tidak ada nama Ziggy yang
gagal dicocokkan ke route Laravel (99 dari 99 ketemu). Kesimpulan perencanaan tetap berdiri: **pekerjaan
Fase 0 hanya 20 nama**, sisanya 79 menyusul bersama port domain masing-masing.

Sebaran 90 endpoint per router: `/api/public/*` 7, `/api/customer/*` 10, `/api/admin/*` 73.

## Cara regenerasi

```
cd UBSC-LARAVEL && php artisan route:list --json
```

Klasifikasi tidak bisa disimpulkan dari keluaran itu sendirinya — perlu membaca nilai balik tiap
controller. Bila ada route Laravel baru yang muncul, tambahkan barisnya di sini dulu sebelum menulis
halaman yang memakainya.
