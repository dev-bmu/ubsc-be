import '../../src/config/load-env'
import { createHash, randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { extname, join } from 'path'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { dateOnlyToString, jakartaWallTimeToUtc } from '../../src/utils/clock'
import { putFile } from '../../src/utils/storage'

// ============================================================================
// === Infrastruktur bersama untuk seluruh seeder ===
// ============================================================================
// Satu Prisma client, satu helper media, satu set util. Semua penulisan lewat
// Prisma — TIDAK PERNAH raw SQL (R2): relationMode "prisma" membuat integritas
// ditegakkan client-side saja, jadi raw SQL di seeder melewati satu-satunya
// pemeriksaan yang tersisa.

function createAdapter(urlString: string) {
  const url = new URL(urlString)
  return new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || undefined
  })
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL belum di-set')

export const prisma = new PrismaClient({ adapter: createAdapter(databaseUrl) })

// ===== Konfigurasi =====

/** Password untuk akun contoh yang BARU dibuat. Akun lama tidak pernah ditimpa. */
export const SEED_PASSWORD = process.env.SEED_PASSWORD || 'password123'

/**
 * Data demo (booking + review contoh) hanya ikut bila SEED_DEMO=true.
 * Menyimpang dari Laravel, yang selalu menjalankan BookingSeeder lewat
 * DatabaseSeeder — dan karenanya menanam 20 booking palsu ke database mana pun
 * yang kebetulan di-seed, termasuk produksi.
 */
export const SEED_DEMO = String(process.env.SEED_DEMO || '').toLowerCase() === 'true'

/**
 * Folder aset aplikasi Laravel lama, sumber gambar untuk baris Media.
 * Bila tidak ada, baris Media tetap dibuat tapi berkasnya tidak tersalin —
 * gambarnya akan 404, terlihat, dan bisa diperbaiki dengan menjalankan ulang
 * seeder setelah env ini diarahkan dengan benar.
 */
export const LEGACY_ASSETS_DIR = process.env.LEGACY_ASSETS_DIR || 'C:/IT BMU/BMU-LANDINGPAGE/UBSC-LARAVEL'

// ===== Util =====

/** Setara Str::slug() Laravel untuk teks ASCII: 'BMU Karate' -> 'bmu-karate'. */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Nama berkas aman untuk web (R9). Nama berspasi seperti "reels ubsc 1.mp4"
 * menjadi "reels-ubsc-1.mp4": %20 merusak cache key CDN dan url() di CSS.
 */
export function kebabFileName(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  const base = fileName.slice(0, fileName.length - ext.length)
  return `${slugify(base)}${ext}`
}

const MIME_BY_EXT: Record<string, string> = {
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function mimeFor(fileName: string): string | null {
  return MIME_BY_EXT[extname(fileName).toLowerCase()] ?? null
}

/** Tanggal polos (tanpa jam) untuk kolom @db.Date. */
export function dateOnly(value: string | Date): Date {
  const d = typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`) : value
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Gabungkan tanggal kalender + jam dinding JAKARTA menjadi instan UTC, untuk Booking.startsAt/endsAt.
 *
 * Versi Fase 1 memakai Date.UTC(jam) langsung — jam Jakarta dibaca sebagai jam UTC, sehingga setiap
 * startsAt/endsAt demo bergeser 7 jam ke depan. Sekarang lewat satu implementasi yang sama dengan API.
 */
export function combineDateTime(date: Date, time: string): Date {
  return jakartaWallTimeToUtc(dateOnlyToString(date), time)
}

// ===== Media =====

interface AttachMediaInput {
  modelType: string
  modelId: string
  collectionName: string
  /** Path relatif terhadap LEGACY_ASSETS_DIR, mis. 'public/assets/images/foo.avif'. */
  sourceRelativePath: string
  /** Nama tampilan. Default: nama berkas tanpa ekstensi. */
  name?: string
  orderColumn?: number
}

/**
 * Meniru `if ($model->getMedia($c)->isEmpty()) { $model->addMedia(...) }` di
 * seeder Laravel: bila koleksi itu sudah punya isi, tidak melakukan apa-apa.
 * Itu yang membuat seluruh seeder idempoten.
 *
 * Tata letak penyimpanan: key area public 'media/<uuid>/<nama-kebab>' (src/utils/storage.ts —
 * disk lokal atau bucket R2, sesuai STORAGE_DRIVER). Folder per-uuid menghilangkan tabrakan nama
 * sepenuhnya, dan URL publiknya tetap terbaca manusia (.../uploads/media/<uuid>/reels-ubsc-1.mp4).
 */
export async function attachMedia(input: AttachMediaInput): Promise<'dibuat' | 'dilewati' | 'tanpa-berkas'> {
  const existing = await prisma.media.findFirst({
    where: { modelType: input.modelType, modelId: input.modelId, collectionName: input.collectionName }
  })
  if (existing) return 'dilewati'

  const absoluteSource = join(LEGACY_ASSETS_DIR, input.sourceRelativePath)

  // Berkas sumber tidak ada -> TIDAK membuat baris Media sama sekali, persis
  // seperti `if (file_exists($path))` di seeder Laravel. Baris Media yang
  // menunjuk berkas tidak ada lebih buruk daripada tidak ada baris: ia lolos
  // semua pemeriksaan lalu merender gambar rusak di halaman publik.
  // Kasus nyata: SC-Mart.png memang tidak pernah ada di repo Laravel, dan
  // database lamanya pun hanya punya 4 dari 5 logo sponsor.
  if (!existsSync(absoluteSource)) {
    console.warn(`  ! berkas tidak ada, baris Media tidak dibuat: ${input.sourceRelativePath}`)
    return 'tanpa-berkas'
  }

  const originalName = input.sourceRelativePath.split(/[/\\]/).pop() as string
  const fileName = kebabFileName(originalName)
  const uuid = randomUUID()

  const size = statSync(absoluteSource).size
  await putFile('public', `media/${uuid}/${fileName}`, absoluteSource, mimeFor(fileName) ?? 'application/octet-stream')

  await prisma.media.create({
    data: {
      modelType: input.modelType,
      modelId: input.modelId,
      uuid,
      collectionName: input.collectionName,
      name: input.name ?? originalName.replace(/\.[^.]+$/, ''),
      fileName,
      mimeType: mimeFor(fileName),
      disk: 'public',
      size,
      orderColumn: input.orderColumn ?? null,
      // Jejak asal berkas — berguna saat memverifikasi hasil impor aset (R9).
      customProperties: { seededFrom: input.sourceRelativePath }
    }
  })

  return 'dibuat'
}

/** Ringkasan hitungan yang dicetak tiap seeder. */
export function tally(label: string, counts: Record<string, number>) {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}: ${n}`)
  console.log(`  ${label} — ${parts.length ? parts.join(', ') : 'tidak ada perubahan'}`)
}

/** Fingerprint stabil, dipakai bila sebuah seeder perlu kunci deterministik. */
export function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)
}
