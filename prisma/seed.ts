import { seedNews, seedInfoBanners, seedPromoCarousels, seedReels, seedSponsorLogos, seedTestimonials } from './seeders/cms'
import { seedBookings, seedReviews } from './seeders/demo'
import { seedFacilities, seedFacilityCategories, seedFacilityPrices } from './seeders/facilities'
import { seedRbac } from './seeders/rbac'
import { seedBookingSchedules, seedSystemSettings } from './seeders/settings'
import { prisma, SEED_DEMO } from './seeders/shared'
import { seedStaffUsers } from './seeders/users'

// ============================================================================
// === SEED FASE 1 ===
// ============================================================================
// Port dari 15 seeder Laravel (database/seeders/*.php). Urutannya mengikuti
// DatabaseSeeder.php karena memang ada ketergantungan nyata: berita butuh akun
// Administrator sebagai penulis, harga butuh fasilitas, booking butuh keduanya.
//
// Aturan yang tidak boleh dilanggar:
//  - Daftar permission & matriks role dibaca dari shared/permissions.ts, tidak
//    pernah diduplikasi (R12).
//  - Semua penulisan lewat Prisma, tidak pernah raw SQL (R2).
//  - Idempoten. Nilai yang mungkin sudah diubah staff — password, nomor
//    rekening, isOpen jadwal, baris harga — TIDAK PERNAH ditimpa.
//
// Dua tambahan di luar Laravel, keduanya disengaja:
//  - SystemSetting dan BookingSchedule ikut di-seed. Laravel membiarkan
//    keduanya kosong sampai diisi dari panel; tapi tanpa rekening tujuan,
//    halaman pembayaran tidak punya nomor untuk ditampilkan, dan tanpa jadwal
//    terbuka tidak ada satu pun tanggal yang bisa di-booking.
//  - Data demo (review + 20 booking) digerbangi SEED_DEMO=true. Laravel selalu
//    menjalankannya lewat DatabaseSeeder, termasuk ke database produksi.
// ============================================================================

interface Step {
  label: string
  run: () => Promise<void>
}

const MASTER_STEPS: Step[] = [
  { label: 'RoleAndPermissionSeeder', run: seedRbac },
  { label: 'AdminUserSeeder', run: seedStaffUsers },
  { label: 'FacilityCategorySeeder', run: seedFacilityCategories },
  { label: 'FacilitySeeder', run: seedFacilities },
  { label: 'FacilityPriceSeeder', run: seedFacilityPrices },
  { label: 'NewsCategorySeeder + NewsSeeder', run: seedNews },
  { label: 'PromoCarouselSeeder', run: seedPromoCarousels },
  { label: 'SponsorLogoSeeder', run: seedSponsorLogos },
  { label: 'ReelSeeder', run: seedReels },
  { label: 'InfoBannerSeeder', run: seedInfoBanners },
  { label: 'TestimonialSeeder', run: seedTestimonials },
  { label: 'SystemSetting (baru)', run: seedSystemSettings },
  { label: 'BookingSchedule (baru)', run: seedBookingSchedules }
]

const DEMO_STEPS: Step[] = [
  { label: 'ReviewSeeder', run: seedReviews },
  { label: 'BookingSeeder', run: seedBookings }
]

async function main() {
  const steps = SEED_DEMO ? [...MASTER_STEPS, ...DEMO_STEPS] : MASTER_STEPS

  console.log(
    `Menjalankan ${steps.length} seeder${SEED_DEMO ? ' (termasuk data demo)' : ' (master data saja — set SEED_DEMO=true untuk data demo)'}\n`
  )

  for (const [index, step] of steps.entries()) {
    console.log(`[${index + 1}/${steps.length}] ${step.label}`)
    await step.run()
  }

  console.log('\nSeed selesai.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
