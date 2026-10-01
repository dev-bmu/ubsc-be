import { randomUUID } from 'crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'path'
import { pipeline } from 'stream/promises'
import sharp from 'sharp'
import { Prisma } from '@prisma/client'
import { prismaClient } from '../application/database'
import { UPLOAD_DIR } from '../config'
import { IMAGE_PIPELINE, UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { logger } from '../utils/logger'
import { MEDIA_SELECT, MediaCollection, MediaModelType, MediaRow, storagePathFor } from './media-services'

// ============================================================================
// === Media — jalur TULIS (unggah admin) ===
// ============================================================================
// media-services.ts hanya BACA + deleteForModel (hapus semua media satu owner). File ini menambah
// jalur tulis yang dulu hanya ada di seeder (attachMedia): unggah gambar admin, encode ulang lewat
// sharp (properti keamanan — berkas yang cuma mengaku gambar tidak selamat melewati decoder), lalu
// tulis ke uploads/media/<uuid>/<nama-kebab>.<ext> + buat baris Media disk:'public'. Tata letaknya
// WAJIB sama dengan attachMedia (prisma/seeders/shared.ts) dan dengan storagePathFor/urlFor.
//
// Sejak Fase 8F file ini juga memegang jalur VIDEO (storePublicVideo, koleksi 'video' milik Reel).
// Jalur itu TIDAK memakai sharp dan tidak menerima Buffer — penjelasan lengkapnya di kepala bagiannya.
//
// Berkas fisik SENGAJA tidak ditulis di dalam $transaction DB (filesystem tidak ikut rollback).
// Pola pemanggil: pastikan owner (Facility/dst) sudah ada, baru attach media — persis alur
// controller Laravel (create -> addMediaFromRequest). Kalau attach gagal, owner tetap ada; user
// tinggal unggah ulang, tidak ada baris DB yatim.

type Db = Prisma.TransactionClient | typeof prismaClient

const PUBLIC_ROOT = (): string => resolve(process.cwd(), UPLOAD_DIR)

// Str::slug() untuk nama berkas web-safe (R9): "Foto Lapangan.JPG" -> "foto-lapangan".
const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp'])
const { maxWidth, maxHeight } = UPLOAD_LIMITS.CMS_IMAGE
const MAX_PIXELS = maxWidth * maxHeight

/** Validasi ISI berkas (bukan ekstensi/Content-Type klien), setara `image|mimes:jpeg,png,webp`. */
async function inspect(buffer: Buffer, field: string): Promise<void> {
  const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
    .metadata()
    .catch(() => null)
  if (!meta) throw new ResponseError(422, 'Berkas harus berupa gambar.', 'VALIDATION_ERROR', { [field]: ['Berkas harus berupa gambar.'] })
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    const msg = 'Format tidak didukung. Gunakan JPG, PNG, atau WEBP.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { [field]: [msg] })
  }
  if ((meta.width ?? 0) > maxWidth || (meta.height ?? 0) > maxHeight) {
    const msg = `Resolusi gambar terlalu besar. Maksimal ${maxWidth} x ${maxHeight} piksel.`
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { [field]: [msg] })
  }
}

function encode(buffer: Buffer, format: 'webp' | 'png'): Promise<Buffer> {
  // .rotate() terapkan orientasi EXIF lalu buang metadata; resize inside + withoutEnlargement.
  const pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: IMAGE_PIPELINE.MAX_EDGE, height: IMAGE_PIPELINE.MAX_EDGE, fit: 'inside', withoutEnlargement: true })
  return format === 'webp' ? pipeline.webp({ quality: IMAGE_PIPELINE.WEBP_QUALITY }).toBuffer() : pipeline.png({ compressionLevel: 9 }).toBuffer()
}

export interface StoreMediaInput {
  modelType: MediaModelType
  modelId: string
  collectionName: MediaCollection
  /** Buffer berkas dari multer memoryStorage. */
  buffer: Buffer
  /** Nama asli berkas dari klien (untuk nama tampilan + basis nama kebab). */
  originalName: string
  /** Nama tampilan (default: basename tanpa ekstensi). */
  displayName?: string
  /** field name untuk pesan error (mis. 'hero', 'gallery', 'unit_image'). */
  field?: string
  orderColumn?: number | null
}

/**
 * Encode ulang + simpan satu gambar publik, lalu buat baris Media. Mengembalikan baris yang dibuat
 * (bentuk MEDIA_SELECT) sehingga pemanggil bisa langsung urlFor()-nya. Tidak transaksional — panggil
 * setelah owner-nya ada.
 */
export async function storePublicMedia(input: StoreMediaInput): Promise<MediaRow> {
  const field = input.field ?? input.collectionName
  await inspect(input.buffer, field)

  const webp = await encode(input.buffer, 'webp')
  let chosen: { data: Buffer; ext: 'webp' | 'png' } = { data: webp, ext: 'webp' }
  if (webp.length >= input.buffer.length) {
    const png = await encode(input.buffer, 'png')
    if (png.length < webp.length) chosen = { data: png, ext: 'png' }
  }

  const baseName = input.originalName.split(/[/\\]/).pop() ?? input.originalName
  const stem = slugify(baseName.slice(0, baseName.length - extname(baseName).length)) || 'gambar'
  const fileName = `${stem}.${chosen.ext}`
  const uuid = randomUUID()

  const destination = resolve(PUBLIC_ROOT(), 'media', uuid, fileName)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, chosen.data)
  const size = statSync(destination).size

  const row = await prismaClient.media.create({
    data: {
      modelType: input.modelType,
      modelId: input.modelId,
      uuid,
      collectionName: input.collectionName,
      name: input.displayName ?? baseName.replace(/\.[^.]+$/, ''),
      fileName,
      mimeType: chosen.ext === 'png' ? 'image/png' : 'image/webp',
      disk: 'public',
      size,
      orderColumn: input.orderColumn ?? null
    },
    select: MEDIA_SELECT
  })

  logger.info(`Media diunggah: ${input.modelType} ${input.modelId} [${input.collectionName}] ${fileName} (${size} byte)`)
  return row
}

// ============================================================================
// === Video (koleksi 'video' milik Reel) ===
// ============================================================================
// Video TIDAK boleh lewat sharp: tidak ada decoder gambar yang bisa membacanya, dan menahan 50 MB di
// memori (multer memoryStorage) bukan pilihan. Karena itu jalurnya berbeda dari storePublicMedia di
// tiga titik, dan hanya di tiga titik:
//
//   1. Berkasnya tiba sebagai PATH SEMENTARA dari multer diskStorage, bukan Buffer. Berkas itu
//      DIPINDAHKAN (renameSync; fallback stream copy lintas volume), tidak pernah dibaca utuh ke
//      memori — dan dihapus pada JALUR SUKSES MAUPUN GAGAL (blok finally di bawah).
//   2. Tanpa re-encode, "file yang cuma mengaku video" tidak dijinakkan decoder mana pun, jadi ISI
//      berkas disniff sendiri (magic bytes) dan apa pun di luar mp4/webm ditolak 422. Content-Type
//      multipart dan nama berkas dari klien TIDAK dipercaya sama sekali.
//   3. Ekstensi tujuan diturunkan dari hasil sniff, BUKAN dari nama berkas klien — 'video.mp4.php'
//      tidak akan pernah menjadi '.php' di bawah uploads/ yang disajikan express.static.
//
// Selebihnya identik dengan storePublicMedia: tata letak uploads/media/<uuid>/<nama-kebab>.<ext>,
// nama berkas di-slugify, baris Media disk:'public', dan berkas fisik SENGAJA ditulis di luar
// $transaction DB.

/** Byte awal yang cukup untuk kedua container: 'ftyp' ISO BMFF ada di offset 4, DocType EBML di ~<40. */
const VIDEO_SNIFF_BYTES = 64

/**
 * Major brand ISO BMFF yang benar-benar berarti video/mp4. Daftar putih, BUKAN "ada 'ftyp' berarti mp4":
 * HEIC, AVIF, dan MOV memakai kotak 'ftyp' yang sama, dan ketiganya gagal aturan `mimes:mp4,webm`
 * Laravel (Symfony memetakan mime-nya ke heic/avif/mov, bukan mp4).
 */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp4v', 'avc1', 'dash', 'mmp4', 'M4V '])

/** Magic EBML (Matroska/WebM). DocType-nya masih harus 'webm' — .mkv ditolak. */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

function videoRejection(field: string, message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { [field]: [message] })
}

/**
 * Validasi ISI berkas (bukan ekstensi/Content-Type klien), setara `mimes:mp4,webm`. Mengembalikan
 * ekstensi + mimeType yang akan DIPAKAI di disk dan di kolom Media.
 */
function sniffVideo(path: string, field: string): { ext: 'mp4' | 'webm'; mimeType: string } {
  const head = Buffer.alloc(VIDEO_SNIFF_BYTES)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, head, 0, VIDEO_SNIFF_BYTES, 0)
  } finally {
    closeSync(fd)
  }
  const bytes = head.subarray(0, read)

  // ISO BMFF: <ukuran box 4 byte>'ftyp'<major brand 4 byte>.
  if (read >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp' && MP4_BRANDS.has(bytes.toString('latin1', 8, 12))) {
    return { ext: 'mp4', mimeType: 'video/mp4' }
  }

  // Matroska: magic EBML lalu elemen DocType. 'webm' selalu berada di header awal; 'matroska' tidak cocok.
  if (read >= 4 && bytes.subarray(0, 4).equals(EBML_MAGIC) && bytes.includes('webm', 4, 'latin1')) {
    return { ext: 'webm', mimeType: 'video/webm' }
  }

  throw videoRejection(field, 'Format video tidak didukung. Gunakan MP4 atau WebM.')
}

/** Pindahkan berkas sementara ke tujuan. rename dulu; lintas volume (EXDEV) jatuh ke salin STREAMING. */
async function moveInto(tempPath: string, destination: string): Promise<void> {
  try {
    renameSync(tempPath, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await pipeline(createReadStream(tempPath), createWriteStream(destination))
  unlinkSync(tempPath)
}

/** Hapus berkas sementara bila masih ada. Tidak pernah melempar — kegagalan bersih-bersih bukan error user. */
function discardTempFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (error) {
    logger.warn(`Gagal menghapus berkas sementara ${path}: ${(error as Error).message}`)
  }
}

/**
 * Ukuran + isi berkas video, setara aturan `mimes:mp4,webm|max:51200` Laravel. Melempar 422/413 yang
 * SAMA dengan yang dilempar saat penyimpanan — ini fungsi yang sama, dipakai dua kali.
 *
 * WAJIB dipanggil pemanggil SEBELUM baris pemiliknya dibuat. Di Laravel validasi selesai sebelum
 * `Reel::create()`, jadi video palsu berarti TIDAK ADA yang tersimpan. Tanpa pemeriksaan di depan,
 * sniff baru gagal setelah baris + thumbnail terlanjur ditulis dan menyisakan reel yatim.
 */
export function assertVideoAcceptable(tempPath: string, maxBytes: number, field: string): { ext: 'mp4' | 'webm'; mimeType: string } {
  const uploadedSize = statSync(tempPath).size
  if (uploadedSize === 0) throw videoRejection(field, 'Berkas video kosong.')
  if (uploadedSize > maxBytes) throw videoRejection(field, `Ukuran video maksimal ${Math.floor(maxBytes / (1024 * 1024))} MB.`)

  return sniffVideo(tempPath, field)
}

export interface StoreVideoInput {
  modelType: MediaModelType
  modelId: string
  collectionName: MediaCollection
  /** Path berkas sementara dari multer diskStorage. DIPINDAHKAN, tidak pernah dibaca utuh ke memori. */
  tempPath: string
  /** Nama asli berkas dari klien — HANYA dipakai sebagai nama tampilan + basis nama kebab, tidak pernah ekstensi. */
  originalName: string
  displayName?: string
  /** field name untuk pesan error (mis. 'video'). */
  field?: string
  /** Batas ukuran efektif dalam byte — pagar terakhir setelah `limits.fileSize` multer. */
  maxBytes: number
  orderColumn?: number | null
}

/**
 * Simpan satu video publik (pindah berkas + sniff isi) lalu buat baris Media. Mengembalikan baris yang
 * dibuat (bentuk MEDIA_SELECT) sehingga pemanggil bisa langsung urlFor()-nya. Tidak transaksional —
 * panggil setelah owner-nya ada, sama seperti storePublicMedia.
 */
export async function storePublicVideo(input: StoreVideoInput): Promise<MediaRow> {
  const field = input.field ?? input.collectionName

  try {
    const { ext, mimeType } = assertVideoAcceptable(input.tempPath, input.maxBytes, field)

    const baseName = input.originalName.split(/[/\\]/).pop() ?? input.originalName
    const stem = slugify(baseName.slice(0, baseName.length - extname(baseName).length)) || 'video'
    const fileName = `${stem}.${ext}`
    const uuid = randomUUID()

    const destination = resolve(PUBLIC_ROOT(), 'media', uuid, fileName)
    mkdirSync(dirname(destination), { recursive: true })
    await moveInto(input.tempPath, destination)
    const size = statSync(destination).size

    const row = await prismaClient.media.create({
      data: {
        modelType: input.modelType,
        modelId: input.modelId,
        uuid,
        collectionName: input.collectionName,
        name: input.displayName ?? baseName.replace(/\.[^.]+$/, ''),
        fileName,
        mimeType,
        disk: 'public',
        size,
        orderColumn: input.orderColumn ?? null
      },
      select: MEDIA_SELECT
    })

    logger.info(`Video diunggah: ${input.modelType} ${input.modelId} [${input.collectionName}] ${fileName} (${size} byte)`)
    return row
  } finally {
    // Sukses: rename sudah memindahkannya, existsSync false, no-op. Gagal di titik mana pun (ukuran,
    // sniff, salin, INSERT): berkas sementara tidak boleh tertinggal di storage/private/tmp.
    discardTempFile(input.tempPath)
  }
}

/** Hapus semua baris media satu owner PADA SATU koleksi (mis. 'hero'). Mengembalikan baris terhapus. */
export async function deleteMediaCollection(
  modelType: MediaModelType,
  modelId: string,
  collectionName: MediaCollection,
  db: Db = prismaClient
): Promise<MediaRow[]> {
  const rows = await db.media.findMany({ where: { modelType, modelId, collectionName }, select: MEDIA_SELECT })
  if (rows.length === 0) return []
  await db.media.deleteMany({ where: { modelType, modelId, collectionName } })
  return rows
}

/** Hapus satu baris media berdasarkan id (mis. satu gambar galeri). Null bila tidak ada. */
export async function deleteMediaRow(mediaId: string, db: Db = prismaClient): Promise<MediaRow | null> {
  const row = await db.media.findUnique({ where: { id: mediaId }, select: MEDIA_SELECT })
  if (!row) return null
  await db.media.delete({ where: { id: mediaId } })
  return row
}

/**
 * Hapus berkas fisik untuk sekumpulan baris media. Dipanggil SETELAH commit (penghapusan berkas
 * tidak bisa rollback). Tidak pernah melempar — berkas yang sudah hilang bukan error. Path selalu
 * di bawah uploads/ (pagar containment terhadap baris DB yang tercemar).
 */
export function unlinkMediaFiles(rows: readonly MediaRow[]): void {
  const root = PUBLIC_ROOT()
  for (const row of rows) {
    const rel = storagePathFor(row)
    if (!rel) continue
    const full = resolve(root, rel)
    const within = relative(root, full)
    if (within.startsWith('..') || isAbsolute(within)) {
      logger.warn(`Media path di luar uploads/, dilewati: ${rel}`)
      continue
    }
    try {
      if (existsSync(full)) unlinkSync(full)
      // Tiap media punya direktori uuid-nya SENDIRI (uploads/media/<uuid>/<nama>), jadi direktori itu
      // ikut mati bersama berkasnya. rmdir non-rekursif: gagal (ENOTEMPTY) kalau ternyata masih berisi,
      // jadi ia tidak akan pernah menghapus berkas milik siapa pun. Tanpa ini, tiap penghapusan
      // meninggalkan direktori kosong di uploads/media selamanya.
      const dir = dirname(full)
      if (relative(root, dir) !== '' && existsSync(dir)) rmdirSync(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'ENOENT') continue
      logger.warn(`Gagal menghapus berkas media ${rel}: ${(error as Error).message}`)
    }
  }
}
