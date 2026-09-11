import { attachMedia, prisma, slugify, tally } from './shared'

// ============================================================================
// === FacilityCategorySeeder + FacilitySeeder + FacilityPriceSeeder ===
// ============================================================================
// Master data fasilitas. Ini yang wajib ada di sistem baru — tanpa ini panel
// admin kosong dan halaman publik tidak punya apa pun untuk dirender.

const CATEGORIES = [
  { name: 'Lapangan & Arena', slug: 'lapangan-arena', description: 'Fasilitas lapangan olahraga dan arena pertandingan.', sortOrder: 1 },
  { name: 'Kelas & Kebugaran', slug: 'kelas-kebugaran', description: 'Kelas kebugaran dan olahraga terstruktur.', sortOrder: 2 }
]

interface FacilitySeed {
  name: string
  classCode: string
  venueType: string
  location: string
  image: string
  sortOrder: number
  isActive: boolean
  /** 'court' untuk lapangan yang disewa per jam, 'class' untuk kelas berjadwal. */
  bookingMode: 'court' | 'class'
  categorySlug: string
  descriptionPrefix: string
}

const ARENAS: FacilitySeed[] = [
  { name: 'Lapangan Tenis', classCode: 'Tertutup 001', image: 'fasilitas-tenis-ub-sport-center.avif', sortOrder: 1 },
  { name: 'Lapangan Badminton', classCode: 'Tertutup 002', image: 'fasilitas-bulutangkis-ub-sport-center.avif', sortOrder: 2 },
  { name: 'Lapangan Tenis Meja', classCode: 'Tertutup 003', image: 'fasilitas-tennis-meja-ub-sport-center.avif', sortOrder: 3 },
  { name: 'Lapangan Futsal Veteran', classCode: 'Tertutup 004', image: 'fasilitas-futsal-dieng-ub-sport-center.avif', sortOrder: 4 },
  { name: 'Ruang Beladiri', classCode: 'Tertutup 005', image: 'fasilitas-beladiri-ub-sport-center.avif', sortOrder: 5 }
].map((item) => ({
  ...item,
  venueType: 'Indoor Facility',
  location: 'Veteran',
  isActive: true,
  bookingMode: 'court' as const,
  categorySlug: 'lapangan-arena',
  descriptionPrefix: 'Fasilitas'
}))

const CLASSES: FacilitySeed[] = [
  { name: 'Yoga', classCode: 'Class 001', image: 'fasilitas-yoga-ub-sport-center.avif', sortOrder: 6, isActive: true },
  { name: 'Zumba', classCode: 'Class 002', image: 'fasilitas-zumba-ub-sport-center.avif', sortOrder: 7, isActive: true },
  { name: 'Aerobik', classCode: 'Class 003', image: 'fasilitas-aerobik-ub-sport-center.avif', sortOrder: 8, isActive: true },
  { name: 'BMU Karate', classCode: 'Class 004', image: 'fasilitas-beladiri-ub-sport-center.avif', sortOrder: 9, isActive: true },
  { name: 'Zona Akurasi', classCode: 'Class 005', image: 'fasilitas-zona-akurasi-ub-sport-center.avif', sortOrder: 10, isActive: true },
  { name: 'Pilates', classCode: 'Class 006', image: 'comingsoon.avif', sortOrder: 11, isActive: false }
].map((item) => ({
  ...item,
  venueType: 'Indoor Facility',
  location: 'Veteran',
  bookingMode: 'class' as const,
  categorySlug: 'kelas-kebugaran',
  descriptionPrefix: 'Kelas'
}))

/**
 * [slug] => [harga warga UB, harga umum]. Di Laravel nilai ini diambil dari
 * DUMMY_PRICES di SectionSix.tsx. Zona Akurasi dan Pilates memang belum punya
 * harga — sengaja tidak diberi baris harga, bukan terlewat.
 */
const PRICES: Record<string, [number, number]> = {
  'lapangan-tenis': [105000, 115000],
  'lapangan-badminton': [50000, 65000],
  'lapangan-tenis-meja': [50000, 55000],
  'lapangan-futsal-veteran': [45000, 50000],
  'ruang-beladiri': [75000, 100000],
  yoga: [25000, 35000],
  aerobik: [23000, 28000],
  zumba: [28000, 33000],
  'bmu-karate': [100000, 175000]
}

export async function seedFacilityCategories() {
  console.log('Kategori fasilitas')
  let created = 0

  for (const category of CATEGORIES) {
    const before = await prisma.facilityCategory.findUnique({ where: { slug: category.slug }, select: { id: true } })
    await prisma.facilityCategory.upsert({
      where: { slug: category.slug },
      update: { name: category.name, description: category.description, sortOrder: category.sortOrder },
      create: category
    })
    if (!before) created++
  }

  tally('facility_categories', { baru: created, total: CATEGORIES.length })
}

export async function seedFacilities() {
  console.log('Fasilitas')

  const categories = await prisma.facilityCategory.findMany({ select: { id: true, slug: true } })
  const categoryIdBySlug = new Map(categories.map((c) => [c.slug, c.id]))

  let created = 0
  let mediaCreated = 0
  let mediaMissing = 0

  for (const item of [...ARENAS, ...CLASSES]) {
    const facilityCategoryId = categoryIdBySlug.get(item.categorySlug)
    if (!facilityCategoryId) {
      console.warn(`  ! kategori "${item.categorySlug}" tidak ditemukan — fasilitas ${item.name} dilewati`)
      continue
    }

    const slug = slugify(item.name)
    const before = await prisma.facility.findUnique({ where: { slug }, select: { id: true } })

    const facility = await prisma.facility.upsert({
      where: { slug },
      update: {
        facilityCategoryId,
        name: item.name,
        location: item.location,
        venueType: item.venueType,
        classCode: item.classCode,
        bookingMode: item.bookingMode,
        isActive: item.isActive,
        sortOrder: item.sortOrder
      },
      create: {
        facilityCategoryId,
        name: item.name,
        slug,
        description: `${item.descriptionPrefix} ${item.name} UB Sport Center.`,
        location: item.location,
        venueType: item.venueType,
        classCode: item.classCode,
        bookingMode: item.bookingMode,
        rating: 5.0,
        isActive: item.isActive,
        sortOrder: item.sortOrder
      }
    })

    if (!before) created++

    const result = await attachMedia({
      modelType: 'Facility',
      modelId: facility.id,
      collectionName: 'hero',
      sourceRelativePath: `public/assets/images/${item.image}`,
      name: item.name
    })
    if (result === 'dibuat') mediaCreated++
    if (result === 'tanpa-berkas') mediaMissing++
  }

  tally('facilities', { baru: created, 'media hero': mediaCreated, 'media tanpa berkas': mediaMissing })
}

export async function seedFacilityPrices() {
  console.log('Harga fasilitas')

  let created = 0

  for (const [slug, [wargaPrice, umumPrice]] of Object.entries(PRICES)) {
    const facility = await prisma.facility.findUnique({ where: { slug }, select: { id: true } })
    if (!facility) {
      console.warn(`  ! fasilitas "${slug}" tidak ditemukan — harga dilewati`)
      continue
    }

    // Setara firstOrCreate(['facility_id', 'user_category']) di Laravel: baris
    // harga yang sudah diedit staff TIDAK ditimpa.
    const rows = [
      { userCategory: 'warga_ub' as const, price: wargaPrice, notes: 'Harga khusus warga UB', sortOrder: 1 },
      { userCategory: 'umum' as const, price: umumPrice, notes: null, sortOrder: 2 }
    ]

    for (const row of rows) {
      const existing = await prisma.facilityPrice.findFirst({
        where: { facilityId: facility.id, userCategory: row.userCategory },
        select: { id: true }
      })
      if (existing) continue

      await prisma.facilityPrice.create({
        data: {
          facilityId: facility.id,
          userCategory: row.userCategory,
          priceType: 'per_session',
          label: 'Per Jam',
          price: row.price,
          durationMinutes: 60,
          notes: row.notes,
          sortOrder: row.sortOrder
        }
      })
      created++
    }
  }

  tally('facility_prices', { baru: created })
}
