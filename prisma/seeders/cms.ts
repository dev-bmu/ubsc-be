import { attachMedia, prisma, slugify, tally } from './shared'

// ============================================================================
// === NewsCategorySeeder + NewsSeeder + PromoCarouselSeeder +
// === SponsorLogoSeeder + ReelSeeder + InfoBannerSeeder + TestimonialSeeder
// ============================================================================
// Konten CMS yang tampil di halaman publik. Semuanya idempoten.

const NEWS_CATEGORIES = [
  { name: 'Berita', slug: 'berita' },
  { name: 'Artikel', slug: 'artikel' }
]

const NEWS_ITEMS = [
  { title: 'Dalam Pengembangan: Fitur artikel dan berita akan Segera Hadir', category: 'berita', date: '2026-02-26' },
  { title: 'Dalam Pengembangan: Fitur artikel dan berita akan Segera Hadir', category: 'artikel', date: '2026-02-26' },
  { title: 'Dalam Pengembangan: Fitur artikel dan berita akan Segera Hadir', category: 'berita', date: '2026-02-24' },
  { title: 'Dalam Pengembangan: Fitur artikel dan berita akan Segera Hadir', category: 'artikel', date: '2026-02-22' },
  { title: 'Dalam Pengembangan: Fitur artikel dan berita akan Segera Hadir', category: 'berita', date: '2026-02-20' },
  { title: 'Dalam Pengembangan: Fitur artikel dan berita akan Segera Hadir', category: 'artikel', date: '2026-02-18' },
  { title: 'Raih Performa Terbaik Dengan Paket Fasilitas Unggulan', category: 'berita', date: '2026-02-15' }
]

const PROMO_SLIDES = [
  { title: 'Gym Training Area', file: 'poster-gym-konten-program-ub-sport-center.avif', sortOrder: 1 },
  { title: 'Football Training', file: 'poster-sepakbola-konten-program-ub-sport-center.avif', sortOrder: 2 },
  { title: 'Basketball Court', file: 'poster-basket-konten-program-ub-sport-center.avif', sortOrder: 3 },
  { title: 'Group Fitness Class', file: 'poster-mahal-konten-program-ub-sport-center.avif', sortOrder: 4 }
]

const SPONSORS = [
  { name: 'B1', file: 'B1.png', sortOrder: 1 },
  { name: 'Mo-Fruits', file: 'Mo-Fruits.png', sortOrder: 2 },
  { name: 'ExtraJoss', file: 'ExtraJoss.png', sortOrder: 3 },
  { name: 'AYO', file: 'AYO.png', sortOrder: 4 },
  { name: 'SC-Mart', file: 'SC-Mart.png', sortOrder: 5 }
]

// Nama berkas asli mengandung spasi; kebabFileName() merapikannya saat menyalin
// (R9: %20 merusak cache key CDN dan url() di CSS).
const REELS = [1, 2, 3, 4, 5].map((n) => ({
  title: 'SPORT CENTER UB.',
  thumb: `thumbnail ${n}.png`,
  video: `reels ubsc ${n}.mp4`,
  index: n
}))

const INFO_BANNERS = [
  { message: 'Jadwal Zumba 10.00-12.00 ✦ Jadwal Aerobik Saat ini Sedang Tutup', sortOrder: 1 },
  { message: 'Dapatkan Diskon 20% untuk Pendaftaran Member Tahunan Bulan Ini', sortOrder: 2 },
  { message: 'UB Sport Center Buka Setiap Hari: 06.00 - 21.00 WIB', sortOrder: 3 }
]

const TESTIMONIALS = [
  {
    authorName: 'UB Football Club',
    authorRole: 'Klub Sepak Bola',
    quote: 'Fasilitas lapangan futsal di UB Sport Center sangat terawat dan nyaman. Kami rutin mengadakan latihan di sini setiap minggunya.',
    sortOrder: 1,
    image: 'resources/assets/icons/testimonial-ub-sport-center.avif'
  },
  {
    authorName: 'Malang Tennis Academy',
    authorRole: 'Akademi Tenis',
    quote:
      'Malang Tenis Academy mengapresiasi kualitas lapangan tenis UB Sport Center. Pencahayaan dan kondisi lapangan sangat mendukung sesi latihan intensif.',
    sortOrder: 2,
    image: 'resources/assets/icons/ulasan-malang-tennis-academy-ubsc.avif'
  },
  {
    authorName: 'Brawijaya Badminton Club',
    authorRole: 'Komunitas Olahraga',
    quote: 'Pelayanan staf yang ramah dan fasilitas ganti yang bersih membuat pengalaman olahraga kami semakin menyenangkan.',
    sortOrder: 3,
    image: 'resources/assets/icons/testimonial-ub-sport-center.avif'
  }
]

export async function seedNews() {
  console.log('Berita & kategori berita')

  let categoriesCreated = 0
  for (const category of NEWS_CATEGORIES) {
    const before = await prisma.newsCategory.findUnique({ where: { slug: category.slug }, select: { id: true } })
    await prisma.newsCategory.upsert({ where: { slug: category.slug }, update: { name: category.name }, create: category })
    if (!before) categoriesCreated++
  }

  // Penulis default: akun Administrator dari seeder users. News.authorId NOT
  // NULL, jadi tanpa akun itu berita tidak bisa dibuat sama sekali.
  const author = await prisma.user.findFirst({
    where: { role: { name: 'Administrator' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true }
  })
  if (!author) {
    console.warn('  ! tidak ada akun Administrator — seeder berita dilewati')
    tally('news', { 'kategori baru': categoriesCreated })
    return
  }

  const categories = await prisma.newsCategory.findMany({ select: { id: true, slug: true } })
  const categoryIdBySlug = new Map(categories.map((c) => [c.slug, c.id]))

  let created = 0
  let mediaCreated = 0

  for (const [index, item] of NEWS_ITEMS.entries()) {
    // Judulnya sengaja berulang di data asli; indeks yang membedakan slug.
    const slug = `${slugify(item.title)}-${index + 1}`
    const before = await prisma.news.findUnique({ where: { slug }, select: { id: true } })

    const news = await prisma.news.upsert({
      where: { slug },
      update: {},
      create: {
        newsCategoryId: categoryIdBySlug.get(item.category) ?? null,
        authorId: author.id,
        title: item.title,
        slug,
        excerpt: item.title,
        content: `<p>${item.title}</p>`,
        status: 'published',
        publishedAt: new Date(`${item.date}T00:00:00.000Z`)
      }
    })

    if (!before) created++

    const result = await attachMedia({
      modelType: 'News',
      modelId: news.id,
      collectionName: 'thumbnail',
      sourceRelativePath: 'public/assets/images/comingsoon.avif',
      name: item.title
    })
    if (result === 'dibuat') mediaCreated++
  }

  tally('news', { 'kategori baru': categoriesCreated, 'berita baru': created, 'media thumbnail': mediaCreated })
}

export async function seedPromoCarousels() {
  console.log('Promo carousel')
  let created = 0
  let mediaCreated = 0

  for (const item of PROMO_SLIDES) {
    let promo = await prisma.promoCarousel.findFirst({ where: { title: item.title }, select: { id: true } })
    if (!promo) {
      promo = await prisma.promoCarousel.create({ data: { title: item.title, isActive: true, sortOrder: item.sortOrder }, select: { id: true } })
      created++
    }

    const result = await attachMedia({
      modelType: 'PromoCarousel',
      modelId: promo.id,
      collectionName: 'slide',
      sourceRelativePath: `public/assets/images/${item.file}`,
      name: item.title,
      orderColumn: item.sortOrder
    })
    if (result === 'dibuat') mediaCreated++
  }

  tally('promo_carousels', { baru: created, 'media slide': mediaCreated })
}

export async function seedSponsorLogos() {
  console.log('Logo sponsor')
  let created = 0
  let mediaCreated = 0

  for (const item of SPONSORS) {
    let sponsor = await prisma.sponsorLogo.findFirst({ where: { name: item.name }, select: { id: true } })
    if (!sponsor) {
      sponsor = await prisma.sponsorLogo.create({ data: { name: item.name, isActive: true, sortOrder: item.sortOrder }, select: { id: true } })
      created++
    }

    const result = await attachMedia({
      modelType: 'SponsorLogo',
      modelId: sponsor.id,
      collectionName: 'logo',
      sourceRelativePath: `public/assets/icons/${item.file}`,
      name: item.name,
      orderColumn: item.sortOrder
    })
    if (result === 'dibuat') mediaCreated++
  }

  tally('sponsor_logos', { baru: created, 'media logo': mediaCreated })
}

export async function seedReels() {
  console.log('Reels')

  // Laravel memakai `if (Reel::count() > 0) return;` — sekali isi, tidak
  // pernah ditambah lagi. Perilaku itu dipertahankan.
  const existing = await prisma.reel.count()
  if (existing > 0) {
    tally('reels', { 'sudah ada': existing })
    return
  }

  let created = 0
  let mediaCreated = 0
  let mediaMissing = 0

  // PRESISI TIMESTAMP — bukan kosmetik, ini yang menentukan urutan kartu ReelsSection.
  //
  // Laravel `timestamps()` menulis DATETIME presisi DETIK, jadi kelima reel hasil seeder jatuh pada detik
  // yang SAMA PERSIS. Pada `Reel::active()->latest()` (= ORDER BY created_at DESC) seluruhnya seri, dan
  // MySQL mengembalikan baris seri dalam urutan PK auto-increment menaik — sehingga Laravel merender
  // reel 1, 2, 3, 4, 5. Diverifikasi ke database `ubsc`: kelimanya bernilai '2026-09-09 13:01:29'.
  //
  // Prisma memetakan DateTime ke DATETIME(3). Tanpa createdAt eksplisit, tiap baris mendapat milidetik
  // yang berbeda, tidak ada lagi seri, dan `DESC` mengembalikannya TERBALIK: 5, 4, 3, 2, 1.
  //
  // Menyamakan createdAt kelimanya TIDAK menyelesaikan masalah — pada seri penuh, urutan yang tersisa
  // ditentukan PK, dan PK di sini uuid v4 yang acak. Jadi timestamp diberikan MENURUN sesuai urutan
  // REELS: elemen pertama paling baru, sehingga `ORDER BY createdAt DESC` menghasilkan 1, 2, 3, 4, 5 —
  // urutan render Laravel, secara deterministik.
  const reelBase = new Date()

  for (const [index, item] of REELS.entries()) {
    const reel = await prisma.reel.create({
      data: { title: item.title, isActive: true, createdAt: new Date(reelBase.getTime() - index * 1000) }
    })
    created++

    for (const media of [
      { collectionName: 'thumbnail', path: `public/assets/reels/${item.thumb}` },
      { collectionName: 'video', path: `public/assets/reels/${item.video}` }
    ]) {
      const result = await attachMedia({
        modelType: 'Reel',
        modelId: reel.id,
        collectionName: media.collectionName,
        sourceRelativePath: media.path,
        name: `${item.title} ${item.index}`,
        orderColumn: item.index
      })
      if (result === 'dibuat') mediaCreated++
      if (result === 'tanpa-berkas') mediaMissing++
    }
  }

  tally('reels', { baru: created, media: mediaCreated, 'media tanpa berkas': mediaMissing })
}

export async function seedInfoBanners() {
  console.log('Info banner')

  // Laravel: `if (InfoBanner::count() > 0) return;`
  const existing = await prisma.infoBanner.count()
  if (existing > 0) {
    tally('info_banners', { 'sudah ada': existing })
    return
  }

  await prisma.infoBanner.createMany({ data: INFO_BANNERS.map((item) => ({ ...item, isActive: true })) })
  tally('info_banners', { baru: INFO_BANNERS.length })
}

export async function seedTestimonials() {
  console.log('Testimoni')
  let created = 0
  let mediaCreated = 0

  for (const item of TESTIMONIALS) {
    let testimonial = await prisma.testimonial.findFirst({ where: { authorName: item.authorName }, select: { id: true } })
    if (!testimonial) {
      testimonial = await prisma.testimonial.create({
        data: { authorName: item.authorName, authorRole: item.authorRole, quote: item.quote, isActive: true, sortOrder: item.sortOrder },
        select: { id: true }
      })
      created++
    }

    const result = await attachMedia({
      modelType: 'Testimonial',
      modelId: testimonial.id,
      collectionName: 'image',
      sourceRelativePath: item.image,
      name: item.authorName,
      orderColumn: item.sortOrder
    })
    if (result === 'dibuat') mediaCreated++
  }

  tally('testimonials', { baru: created, 'media image': mediaCreated })
}
