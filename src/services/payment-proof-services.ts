import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import sharp from 'sharp'
import { PRIVATE_STORAGE_DIR } from '../config'
import { IMAGE_PIPELINE, UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { logger } from '../utils/logger'

// ============================================================================
// === Bukti transfer — port dari app/Support/PaymentProofStorage.php ===
// ============================================================================
// Disimpan di storage/private, TIDAK PERNAH di uploads/ publik: ini dokumen bank yang memperlihatkan
// nomor rekening dan saldo. Dibaca kembali lewat controller yang memeriksa siapa yang meminta.
//
// Berkas SELALU di-decode dan ditulis ulang, tidak pernah disalin. Itu properti KEAMANAN sekaligus
// ukuran: berkas yang hanya mengaku gambar tidak selamat melewati decoder, dan apa pun di luar piksel
// (EXIF, payload di ekor berkas) tidak pernah sampai disk.

const PRIVATE_ROOT = () => resolve(process.cwd(), PRIVATE_STORAGE_DIR)

/**
 * Path relatif (dari kolom DB) -> path absolut di dalam storage/private.
 *
 * WAJIB dilewati SETIAP akses berkas privat. Nilai kolom proofPath/identityFilePath berasal dari DB;
 * kalau suatu saat berisi "../../.env" (bug, impor data, atau baris yang disunting tangan), tanpa
 * pagar ini server akan menyajikan berkas apa pun di disk.
 */
export function resolvePrivate(relativePath: string): string {
  const root = PRIVATE_ROOT()
  if (!relativePath || isAbsolute(relativePath)) throw new ResponseError(400, 'Path berkas tidak valid')
  const full = resolve(root, relativePath)
  const rel = relative(root, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || full !== resolve(root, rel)) {
    logger.warn(`PATH_TRAVERSAL_DITOLAK: ${relativePath}`)
    throw new ResponseError(400, 'Path berkas tidak valid')
  }
  return full
}

/** Hapus berkas privat; tidak pernah melempar (berkas yang sudah hilang bukan error). */
export function deletePrivateFile(relativePath: string): void {
  try {
    const full = resolvePrivate(relativePath)
    if (existsSync(full)) unlinkSync(full)
  } catch (e) {
    logger.warn(`Gagal menghapus berkas privat ${relativePath}: ${(e as Error).message}`)
  }
}

export function privateFileExists(relativePath: string): boolean {
  try {
    return existsSync(resolvePrivate(relativePath))
  } catch {
    return false
  }
}

/** Content-Type dari berkas yang benar-benar kita tulis. */
export function proofMimeFor(path: string): string {
  return path.endsWith('.png') ? 'image/png' : 'image/webp'
}

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp'])

/**
 * Validasi isi berkas — bukan ekstensi, bukan header Content-Type klien. Setara aturan Laravel
 * `image|mimes:jpeg,jpg,png,webp|dimensions:max_width=6000,max_height=6000`.
 */
async function inspect(buffer: Buffer) {
  const { maxWidth, maxHeight } = UPLOAD_LIMITS.PAYMENT_PROOF
  // limitInputPixels menolak decompression bomb SEBELUM piksel dialokasikan. Tipe metadata sengaja
  // diinferensi, bukan `sharp.Metadata`: sharp 0.35 membawa deklarasi .d.cts (namespace) dan .d.mts
  // (named export) yang berbeda, dan resolver ts-jest tidak selalu memilih yang sama dengan tsc.
  const meta = await sharp(buffer, { limitInputPixels: maxWidth * maxHeight })
    .metadata()
    .catch(() => null)
  if (!meta) {
    throw new ResponseError(422, 'Bukti transfer harus berupa gambar.', 'VALIDATION_ERROR', { proof: ['Bukti transfer harus berupa gambar.'] })
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    const msg = 'Format tidak didukung. Gunakan JPG, PNG, atau WEBP.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { proof: [msg] })
  }
  if ((meta.width ?? 0) > maxWidth || (meta.height ?? 0) > maxHeight) {
    const msg = 'Resolusi gambar terlalu besar. Maksimal 6000 x 6000 piksel.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { proof: [msg] })
  }
}

function encode(buffer: Buffer, format: 'webp' | 'png'): Promise<Buffer> {
  // .rotate() tanpa argumen: terapkan orientasi EXIF lalu buang metadatanya. Sharp tidak menyalin
  // metadata ke keluaran kecuali diminta withMetadata(), jadi EXIF tidak ikut ke disk.
  const pipeline = sharp(buffer, { limitInputPixels: UPLOAD_LIMITS.PAYMENT_PROOF.maxWidth * UPLOAD_LIMITS.PAYMENT_PROOF.maxHeight })
    .rotate()
    .resize({ width: IMAGE_PIPELINE.MAX_EDGE, height: IMAGE_PIPELINE.MAX_EDGE, fit: 'inside', withoutEnlargement: true })
  return format === 'webp' ? pipeline.webp({ quality: IMAGE_PIPELINE.WEBP_QUALITY }).toBuffer() : pipeline.png({ compressionLevel: 9 }).toBuffer()
}

/**
 * Encode ulang dan simpan. Mengembalikan path relatif terhadap storage/private.
 *
 * WebP target utama — cocok untuk foto kamera maupun tangkapan layar m-banking. Sumber yang sudah
 * kecil dan sangat mudah dikompresi bisa jadi sedikit lebih besar sebagai WebP; fallback PNG lossless
 * membatasi seberapa besar, sama seperti Laravel:
 *   webp < asli          -> webp
 *   png  < webp          -> png
 *   selain itu           -> webp
 */
export async function storePaymentProof(buffer: Buffer, transactionId: string): Promise<string> {
  await inspect(buffer)

  const stem = randomBytes(18).toString('base64url')
  const directory = `payment-proofs/${transactionId}`

  const webp = await encode(buffer, 'webp')
  let chosen: { data: Buffer; ext: 'webp' | 'png' } = { data: webp, ext: 'webp' }
  if (webp.length >= buffer.length) {
    const png = await encode(buffer, 'png')
    if (png.length < webp.length) chosen = { data: png, ext: 'png' }
  }

  const relativePath = `${directory}/${stem}.${chosen.ext}`
  const full = resolvePrivate(relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, chosen.data)
  logger.info(`Bukti transfer disimpan: ${relativePath} (${buffer.length} -> ${statSync(full).size} byte)`)
  return relativePath
}

/** Pemisah path sistem, diekspor untuk test path traversal. */
export const PATH_SEPARATOR = sep
