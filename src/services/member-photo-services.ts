import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { Prisma } from '@prisma/client'
import sharp from 'sharp'
import type { AdminMemberPhotoIndexDto, MemberPhotoReviewDto, MemberPhotoStateDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { UPLOAD_DIR } from '../config'
import { IMAGE_PIPELINE, UPLOAD_LIMITS } from '../config/upload'
import { ResponseError } from '../error/response-error'
import { now } from '../utils/clock'
import { logger } from '../utils/logger'
import { customerNumber } from '../utils/money'
import { MemberPhotoValidation } from '../validation/member-photo-validation'
import { Validation } from '../validation/Validation'
import { timeAgoId } from './dashboard-services'

// ============================================================================
// === Foto member — unggah oleh pelanggan, tinjau oleh staff (PRD tambahan 2026-09, 4.5) ===
// ============================================================================
// Foto wajah yang dicocokkan FO dengan orang di depannya saat check-in gym. Keputusan client: foto
// baru berlaku setelah disetujui staff. Mengunggah ulang selalu kembali ke 'pending' — foto yang belum
// dilihat staff tidak boleh mewarisi persetujuan foto lama.
//
// Pipeline gambarnya sama dengan avatar dan bukti transfer (decode + tulis ULANG oleh sharp, EXIF
// dibuang); yang berbeda hanya tujuannya: uploads/members, publik tapi bernama acak.

const MEMBER_PHOTO_URL_PREFIX = '/uploads/members/'
const PUBLIC_ROOT = (): string => resolve(process.cwd(), UPLOAD_DIR)
const MEMBERS_DIR = (): string => resolve(PUBLIC_ROOT(), 'members')

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp'])
const { maxBytes, maxWidth, maxHeight } = UPLOAD_LIMITS.MEMBER_PHOTO
export const MEMBER_PHOTO_TOO_LARGE_MESSAGE = 'Ukuran foto maksimal 10 MB.'

export interface UploadedMemberPhoto {
  buffer: Buffer
  originalname: string
}

function photoRejection(message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { photo: [message] })
}

/** Validasi ISI berkas (bukan ekstensi/Content-Type klien), lalu encode ulang ke WebP. */
async function encodeMemberPhoto(buffer: Buffer): Promise<Buffer> {
  if (buffer.length > maxBytes)
    throw new ResponseError(413, MEMBER_PHOTO_TOO_LARGE_MESSAGE, 'PAYLOAD_TOO_LARGE', { photo: [MEMBER_PHOTO_TOO_LARGE_MESSAGE] })

  const limitInputPixels = maxWidth * maxHeight
  const meta = await sharp(buffer, { limitInputPixels })
    .metadata()
    .catch(() => null)
  if (!meta) throw photoRejection('Foto harus berupa gambar.')
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw photoRejection('Format foto tidak didukung. Gunakan JPG, PNG, atau WEBP.')
  if ((meta.width ?? 0) > maxWidth || (meta.height ?? 0) > maxHeight) {
    throw photoRejection(`Resolusi foto terlalu besar. Maksimal ${maxWidth} x ${maxHeight} piksel.`)
  }

  return sharp(buffer, { limitInputPixels })
    .rotate()
    .resize({ width: IMAGE_PIPELINE.MAX_EDGE, height: IMAGE_PIPELINE.MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: IMAGE_PIPELINE.WEBP_QUALITY })
    .toBuffer()
}

/**
 * Hapus berkas foto lama — hanya yang benar-benar ditulis modul ini. Nilai kolom berasal dari DB,
 * jadi pagar containment wajib (pola yang sama dengan unlinkOwnedAvatar). Tidak pernah melempar.
 */
function unlinkOwnedPhoto(url: string | null): void {
  if (!url || !url.startsWith(MEMBER_PHOTO_URL_PREFIX)) return
  const full = resolve(MEMBERS_DIR(), url.slice(MEMBER_PHOTO_URL_PREFIX.length))
  const within = relative(MEMBERS_DIR(), full)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    logger.warn(`Path foto member di luar uploads/members, dilewati: ${url}`)
    return
  }
  try {
    if (existsSync(full)) unlinkSync(full)
  } catch (error) {
    logger.warn(`Gagal menghapus foto member lama ${url}: ${(error as Error).message}`)
  }
}

/** Kunci baris user supaya unggah ulang dan keputusan staff tidak saling menyalip. */
async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`
  return tx.user.findUnique({ where: { id: userId }, select: { memberPhotoPath: true, roleId: true } })
}

// ===== 1. Unggah =====

/** POST /api/customer/member-photo — field `photo`. Foto pelanggan menunggu tinjauan staff. */
export function submitMemberPhoto(userId: string, file: UploadedMemberPhoto | undefined): Promise<MemberPhotoStateDto> {
  return storeMemberPhoto(userId, file, 'pending')
}

/**
 * POST /api/admin/identity/:userId/member-photo — foto yang diambil staff di meja depan. Langsung
 * 'approved': staff sendiri yang melihat orangnya saat memotret.
 */
export function captureMemberPhoto(userId: string, file: UploadedMemberPhoto | undefined): Promise<MemberPhotoStateDto> {
  return storeMemberPhoto(userId, file, 'approved')
}

/** Encode + tulis, lalu tukar kolomnya di bawah kunci. Berkas lama dihapus SETELAH commit. */
async function storeMemberPhoto(userId: string, file: UploadedMemberPhoto | undefined, status: 'pending' | 'approved'): Promise<MemberPhotoStateDto> {
  if (!file) throw photoRejection('Pilih foto wajah terlebih dahulu.')

  const data = await encodeMemberPhoto(file.buffer)
  const fileName = `${randomUUID()}.webp`
  mkdirSync(MEMBERS_DIR(), { recursive: true })
  writeFileSync(resolve(MEMBERS_DIR(), fileName), data)
  const url = `${MEMBER_PHOTO_URL_PREFIX}${fileName}`

  let previous: string | null
  try {
    previous = await prismaClient.$transaction(async (tx) => {
      const user = await lockUser(tx, userId)
      if (!user) throw new ResponseError(404, 'Akun tidak ditemukan')
      if (user.roleId !== null) throw new ResponseError(422, 'Akun staff tidak memakai foto member.')
      await tx.user.update({ where: { id: userId }, data: { memberPhotoPath: url, memberPhotoStatus: status } })
      return user.memberPhotoPath
    }, TX_OPTIONS)
  } catch (error) {
    // Baris tidak berubah: berkas yang baru ditulis tidak dirujuk siapa pun.
    unlinkOwnedPhoto(url)
    throw error
  }

  if (previous && previous !== url) unlinkOwnedPhoto(previous)
  return { memberPhotoUrl: url, memberPhotoStatus: status }
}

// ===== 2. Staff: antrean + keputusan =====

const REVIEW_SELECT = {
  id: true,
  name: true,
  email: true,
  phoneNumber: true,
  customerSequence: true,
  memberPhotoPath: true,
  memberPhotoStatus: true,
  updatedAt: true
} satisfies Prisma.UserSelect

type ReviewRow = Prisma.UserGetPayload<{ select: typeof REVIEW_SELECT }>

function presentReview(row: ReviewRow, at: Date): MemberPhotoReviewDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phoneNumber: row.phoneNumber,
    customerNumber: customerNumber(row.customerSequence),
    photoUrl: row.memberPhotoPath ?? '',
    status: row.memberPhotoStatus ?? 'pending',
    updatedAt: timeAgoId(row.updatedAt, at)
  }
}

/** Batas baris antrean. Yang menunggu tinjauan selalu di atas, jadi tidak pernah terpotong duluan. */
const QUEUE_LIMIT = 200

/**
 * GET /api/admin/identity/member-photos. ENUM MySQL diurutkan menurut urutan deklarasinya, jadi
 * memberPhotoStatus ASC = pending, approved, rejected.
 */
export async function listMemberPhotoQueue(): Promise<AdminMemberPhotoIndexDto> {
  const rows = await prismaClient.user.findMany({
    where: { memberPhotoStatus: { not: null }, memberPhotoPath: { not: null } },
    select: REVIEW_SELECT,
    orderBy: [{ memberPhotoStatus: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    take: QUEUE_LIMIT
  })
  const at = now()
  return { users: rows.map((row) => presentReview(row, at)) }
}

/**
 * PATCH /api/admin/identity/:userId/member-photo. Payload membawa photoUrl yang DILIHAT staff: bila
 * pelanggan mengunggah ulang di antara itu, keputusan ditolak 409 — menyetujui foto yang belum pernah
 * dilihat justru menggugurkan gunanya foto ini.
 */
export async function decideMemberPhoto(userId: string, request: unknown): Promise<MemberPhotoReviewDto> {
  const v = Validation.validate(MemberPhotoValidation.DECIDE, request)

  const row = await prismaClient.$transaction(async (tx) => {
    const user = await lockUser(tx, userId)
    if (!user) throw new ResponseError(404, 'User tidak ditemukan')
    if (!user.memberPhotoPath) throw new ResponseError(422, 'User ini belum mengunggah foto member.')
    if (user.memberPhotoPath !== v.photoUrl) {
      throw new ResponseError(409, 'Foto sudah diganti pelanggan. Muat ulang lalu tinjau foto yang baru.', 'CONFLICT')
    }
    return tx.user.update({ where: { id: userId }, data: { memberPhotoStatus: v.status }, select: REVIEW_SELECT })
  }, TX_OPTIONS)

  return presentReview(row, now())
}
