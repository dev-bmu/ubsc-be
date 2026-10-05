import { copyFileSync, existsSync, mkdirSync, openAsBlob, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { AwsClient } from 'aws4fetch'
import {
  PRIVATE_STORAGE_DIR,
  R2_ACCESS_KEY_ID,
  R2_ACCOUNT_ID,
  R2_PRIVATE_BUCKET,
  R2_PUBLIC_BUCKET,
  R2_PUBLIC_URL,
  R2_SECRET_ACCESS_KEY,
  STORAGE_DRIVER,
  UPLOAD_DIR
} from '../config'
import { ResponseError } from '../error/response-error'
import { logger } from './logger'

// ============================================================================
// === Penyimpanan berkas: disk lokal (dev/test) atau Cloudflare R2 (produksi) ===
// ============================================================================
// Satu-satunya jalan service menulis, membaca, dan menghapus berkas unggahan. Dua area:
//
//   public  -> gambar/video CMS, foto member, avatar, QRIS. URL-nya publik (publicUrl()).
//              lokal: UPLOAD_DIR (disajikan express.static /uploads)
//              r2:    bucket R2_PUBLIC_BUCKET dengan prefiks 'uploads/', disajikan custom domain
//                     R2_PUBLIC_URL (cdn.ubsportcenter.co.id) — media statis ubsc-media tinggal di
//                     bucket yang sama di bawah 'reels/'.
//   private -> bukti bayar dan dokumen identitas. Tidak punya URL; hanya dibaca API (readObject).
//              lokal: PRIVATE_STORAGE_DIR
//              r2:    bucket R2_PRIVATE_BUCKET, tanpa domain publik.
//
// Key selalu relatif terhadap akar areanya, mis. 'media/<uuid>/foto.webp' atau
// 'payment-proofs/<transactionId>/<acak>.webp'. Key berasal juga dari kolom DB, jadi setiap operasi
// lewat checkedKey(): '..', path absolut, dan backslash ditolak sebelum menyentuh disk atau bucket.

export type StorageArea = 'public' | 'private'

/** Prefiks objek publik di bucket R2 — dan path URL-nya. Berkas statis ubsc-media ada di 'reels/'. */
const PUBLIC_PREFIX = 'uploads'

/** Nama berkas selalu acak (uuid/acak), isinya tidak pernah berubah di tempat -> aman di-cache setahun. */
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'

const R2_TIMEOUT_MS = 60_000

function checkedKey(key: string): string {
  const segments = key.split('/')
  if (!key || key.includes('\\') || key.includes('\0') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    logger.warn(`STORAGE_KEY_DITOLAK: ${key}`)
    throw new ResponseError(400, 'Path berkas tidak valid')
  }
  return key
}

// ===== URL publik =====

const publicBase = (): string => (STORAGE_DRIVER === 'r2' ? `${(R2_PUBLIC_URL ?? '').replace(/\/+$/, '')}/${PUBLIC_PREFIX}` : `/${PUBLIC_PREFIX}`)

/**
 * URL publik sebuah key area public. Lokal: relatif '/uploads/...' (same-origin lewat rewrite Next).
 * R2: absolut 'https://cdn.ubsportcenter.co.id/uploads/...'. encodeURI menjaga '/' tetap pemisah.
 */
export function publicUrl(key: string): string {
  return `${publicBase()}/${encodeURI(checkedKey(key))}`
}

/**
 * Kebalikan publicUrl() untuk URL yang tersimpan di DB (avatar, foto member, QRIS): key-nya bila URL
 * itu milik kita DAN berada di folder `folder`, selain itu null. Menerima bentuk lama '/uploads/...'
 * (sebelum pindah ke R2) maupun bentuk sekarang. URL eksternal (avatar Google) selalu null — tidak
 * pernah dihapus.
 */
export function ownedPublicKey(url: string | null | undefined, folder: string): string | null {
  if (!url) return null
  const prefix = [`${publicBase()}/`, `/${PUBLIC_PREFIX}/`].find((p) => url.startsWith(p))
  if (!prefix) return null
  try {
    const key = decodeURI(url.slice(prefix.length))
    return key.startsWith(`${folder}/`) ? checkedKey(key) : null
  } catch {
    return null
  }
}

// ===== Driver lokal =====

const localRoot = (area: StorageArea): string => resolve(process.cwd(), area === 'public' ? UPLOAD_DIR : PRIVATE_STORAGE_DIR)

/** Path absolut di dalam akar area. Pagar containment kedua setelah checkedKey (mis. 'C:/x' di Windows). */
function localPath(area: StorageArea, key: string): string {
  const root = localRoot(area)
  const full = resolve(root, checkedKey(key))
  const within = relative(root, full)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    logger.warn(`STORAGE_KEY_DITOLAK: ${key}`)
    throw new ResponseError(400, 'Path berkas tidak valid')
  }
  return full
}

function localDelete(area: StorageArea, key: string): void {
  const full = localPath(area, key)
  if (existsSync(full)) unlinkSync(full)
  // Direktori per-berkas (media/<uuid>/) ikut hilang bila kosong. rmdir non-rekursif: gagal
  // (ENOTEMPTY) bila masih berisi, jadi tidak pernah menghapus berkas milik siapa pun.
  const dir = dirname(full)
  if (dir !== localRoot(area) && existsSync(dir)) {
    try {
      rmdirSync(dir)
    } catch {
      // masih berisi berkas lain — biarkan
    }
  }
}

// ===== Driver R2 (S3 API, ditandatangani aws4fetch) =====

let r2Client: AwsClient | null = null
const r2 = (): AwsClient =>
  (r2Client ??= new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: R2_SECRET_ACCESS_KEY ?? '',
    service: 's3',
    region: 'auto',
    retries: 3
  }))

function r2Url(area: StorageArea, key: string): string {
  const bucket = area === 'public' ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET
  const objectKey = area === 'public' ? `${PUBLIC_PREFIX}/${checkedKey(key)}` : checkedKey(key)
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
}

async function r2Put(area: StorageArea, key: string, body: Blob, contentType: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': contentType }
  if (area === 'public') headers['Cache-Control'] = PUBLIC_CACHE_CONTROL
  const res = await r2().fetch(r2Url(area, key), { method: 'PUT', body, headers, signal: AbortSignal.timeout(R2_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`R2 PUT ${area}/${key} gagal: ${res.status} ${(await res.text()).slice(0, 200)}`)
}

async function r2Delete(area: StorageArea, key: string): Promise<void> {
  try {
    const res = await r2().fetch(r2Url(area, key), { method: 'DELETE', signal: AbortSignal.timeout(R2_TIMEOUT_MS) })
    if (!res.ok && res.status !== 404) logger.warn(`R2 DELETE ${area}/${key} gagal: ${res.status}`)
  } catch (error) {
    logger.warn(`R2 DELETE ${area}/${key} gagal: ${(error as Error).message}`)
  }
}

// ===== API =====

/** Tulis berkas yang sudah ada di memori (gambar hasil encode sharp, PDF identitas). */
export async function putObject(area: StorageArea, key: string, data: Buffer, contentType: string): Promise<void> {
  // Blob, bukan Buffer: tipe BodyInit fetch tidak menerima Buffer, dan Blob membawa Content-Length.
  if (STORAGE_DRIVER === 'r2') return r2Put(area, key, new Blob([new Uint8Array(data)], { type: contentType }), contentType)
  const full = localPath(area, key)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, data)
}

/**
 * Salin berkas di disk (video sementara dari multer, aset seeder) ke penyimpanan. Sumbernya TIDAK
 * dihapus — itu urusan pemanggil. Ke R2 dikirim sebagai Blob berbasis berkas: tidak pernah dibaca
 * utuh ke memori, dan Content-Length-nya diketahui (PutObject menolak upload tanpa panjang).
 */
export async function putFile(area: StorageArea, key: string, sourcePath: string, contentType: string): Promise<void> {
  if (STORAGE_DRIVER === 'r2') return r2Put(area, key, await openAsBlob(sourcePath, { type: contentType }), contentType)
  const full = localPath(area, key)
  mkdirSync(dirname(full), { recursive: true })
  copyFileSync(sourcePath, full)
}

/** Isi berkas, atau null bila tidak ada. Untuk berkas privat kecil (bukti bayar, dokumen identitas). */
export async function readObject(area: StorageArea, key: string): Promise<Buffer | null> {
  if (STORAGE_DRIVER === 'r2') {
    const res = await r2().fetch(r2Url(area, key), { signal: AbortSignal.timeout(R2_TIMEOUT_MS) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`R2 GET ${area}/${key} gagal: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const full = localPath(area, key)
  return existsSync(full) ? readFileSync(full) : null
}

/**
 * Hapus berkas. Tidak pernah melempar: dipanggil SETELAH commit atau saat membersihkan unggahan yang
 * gagal, dan berkas yang sudah hilang atau key yang ditolak bukan error milik user.
 *
 * ponytail: di R2 penghapusan berjalan di latar (fire-and-forget) supaya signature tetap sinkron di
 * semua pemanggil; proses yang mati di tengah jalan meninggalkan objek yatim yang tidak dirujuk
 * siapa pun. Tambah sapuan objek yatim bila itu mulai berarti.
 */
export function deleteObjects(area: StorageArea, keys: readonly string[]): void {
  for (const key of keys) {
    try {
      if (STORAGE_DRIVER === 'r2') {
        checkedKey(key)
        void r2Delete(area, key)
      } else {
        localDelete(area, key)
      }
    } catch (error) {
      logger.warn(`Gagal menghapus berkas ${area}/${key}: ${(error as Error).message}`)
    }
  }
}
