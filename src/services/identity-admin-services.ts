import { Prisma } from '@prisma/client'
import { basename, extname } from 'path'
import type { AdminIdentityIndexDto, IdentityUserDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { ResponseError } from '../error/response-error'
import { now } from '../utils/clock'
import { IdentityAdminValidation } from '../validation/identity-admin-validation'
import { Validation } from '../validation/Validation'
import { timeAgoId } from './dashboard-services'
import { privateFileExists, resolvePrivate } from './payment-proof-services'
import type { ProofFile } from './payment-services'

// ============================================================================
// === Antrean verifikasi identitas — port Admin\IdentityQueueController ===
// ============================================================================
// Ketiga aksi Laravel (index / verify / document) dipetakan satu-satu. Semuanya digerbangi
// `authorize('verify-identity')` = PERMISSIONS.IDENTITY_VERIFY, dicek di baris route.
//
// Dokumen identitas adalah berkas PRIVAT (KTP/KTM) — tidak pernah di-mount publik. Setiap pembacaan
// wajib lewat resolvePrivate(): nilai identityFilePath berasal dari DB dan tanpa pagar itu kolom yang
// berisi "../../.env" akan membuat server menyajikan berkas apa pun di disk.

// ===== Pemuat + present() =====

/** Padanan ->select([...]) Laravel — persis sembilan kolom yang sama, tidak lebih. */
const QUEUE_SELECT = {
  id: true,
  name: true,
  email: true,
  phoneNumber: true,
  identityCategory: true,
  identityNumber: true,
  identityStatus: true,
  identityFilePath: true,
  updatedAt: true
} satisfies Prisma.UserSelect

type IdentityRow = Prisma.UserGetPayload<{ select: typeof QUEUE_SELECT }>

/** `filled($user->identity_file_path)` — null, '' dan spasi-saja sama-sama dianggap TIDAK ada berkas. */
function hasDocumentPath(path: string | null): boolean {
  return (path ?? '').trim() !== ''
}

/** map(fn (User $user) => [...]) Laravel. */
function presentUser(user: IdentityRow, at: Date): IdentityUserDto {
  const hasDocument = hasDocumentPath(user.identityFilePath)

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phoneNumber: user.phoneNumber,
    identityCategory: user.identityCategory,
    identityNumber: user.identityNumber,
    identityStatus: user.identityStatus,
    hasDocument,
    // route('admin.identity.document') Laravel -> path relatif terhadap baseURL axios admin ('/api'),
    // sama seperti proofUrl di booking-admin-services.ts / payment-admin-services.ts.
    documentUrl: hasDocument ? `/admin/identity/${user.id}/document` : null,
    // `$user->updated_at->diffForHumans()` dengan APP_LOCALE=id -> "2 jam yang lalu".
    updatedAt: timeAgoId(user.updatedAt, at)
  }
}

// ===== 1. Index — antrean penuh =====

/**
 * `User::whereNotIn('identity_status', ['unverified'])->latest('updated_at')->get()` — TANPA paginasi,
 * persis seperti Laravel (halaman admin memfilter/mencari di sisi klien).
 *
 * Kunci urut kedua createdAt DESC adalah TAMBAHAN: Laravel hanya memberi satu kunci, jadi dua baris
 * dengan updated_at identik (mis. hasil migrasi/seed) keluar dalam urutan yang tidak ditentukan.
 * Tambahan ini tidak mengubah himpunan maupun urutan utama, hanya membuat hasilnya deterministik.
 */
export async function listIdentityQueue(): Promise<AdminIdentityIndexDto> {
  const at = now()

  const users = await prismaClient.user.findMany({
    where: { identityStatus: { notIn: ['unverified'] } },
    select: QUEUE_SELECT,
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
  })

  return { users: users.map((user) => presentUser(user, at)) }
}

// ===== 2. Verify — setujui / tolak =====

/**
 * Laravel membalas `back()->with('success', ...)`; di sini dibalas BARIS YANG SUDAH DIPERBARUI dalam
 * bentuk IdentityUserDto (transform yang sama dengan index) supaya panel bisa menambal satu baris
 * tabelnya tanpa memuat ulang seluruh antrean.
 *
 * `filled($validated['identity_category'] ?? null)`: kolom identityCategory HANYA ditulis bila
 * nilainya benar-benar ada. Absen, null, dan '' (sudah jadi null di validasi) sama-sama membiarkan
 * kategori pilihan user saat registrasi apa adanya — staff hanya "mengoreksi bila perlu".
 *
 * User yang tidak ada -> 404, padanan route-model binding Laravel.
 */
export async function verifyIdentity(userId: string, request: unknown): Promise<IdentityUserDto> {
  const v = Validation.validate(IdentityAdminValidation.VERIFY, request)

  const existing = await prismaClient.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'User tidak ditemukan')

  const data: Prisma.UserUpdateInput = { identityStatus: v.status }
  if (v.identityCategory) data.identityCategory = v.identityCategory

  // updatedAt dibumikan otomatis oleh @updatedAt — sama seperti $user->update() Laravel, sehingga baris
  // yang baru diputuskan naik ke puncak antrean.
  const updated = await prismaClient.user.update({ where: { id: userId }, data, select: QUEUE_SELECT })

  return presentUser(updated, now())
}

// ===== 3. Document — stream berkas privat =====

/**
 * Content-Type dari EKSTENSI berkas.
 *
 * proofMimeFor() di payment-proof-services.ts hanya mengenal png/webp karena bukti transfer selalu
 * kita encode ulang sendiri. Dokumen identitas TIDAK demikian: jalur unggahnya (profil customer)
 * belum diport — Fase 6 — sehingga berkas yang ada di disk masih apa pun yang ditulis Laravel
 * (jpg/jpeg/png/webp/pdf). Ekstensi tak dikenal jatuh ke application/octet-stream: browser akan
 * mengunduhnya alih-alih menebak-nebak dan menjalankan sesuatu.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

function identityMimeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Nama berkas untuk header Content-Disposition — basename seperti Storage::response() Laravel.
 * Tanda kutip dan baris baru dibuang: nilainya berasal dari DB dan disisipkan ke header yang dikutip,
 * jadi karakter itu bisa memecah headernya (header injection).
 */
function documentFileName(path: string): string {
  const name = basename(path).replace(/["\\\r\n]/g, '')
  return name === '' ? 'dokumen-identitas' : name
}

/**
 * GET /api/admin/identity/:userId/document — dua abort_unless Laravel, berurutan:
 *   1. kolomnya kosong                -> 404 'No document uploaded.'
 *   2. berkasnya tidak ada di disk    -> 404 'Document not found on disk.'
 * Pesannya diterjemahkan ke bahasa Indonesia mengikuti konvensi repo ini.
 *
 * privateFileExists() memanggil resolvePrivate() di dalamnya dan mengembalikan false bila pagar path
 * traversal menolak — path yang mencurigakan berhenti di cabang 404 dan tidak pernah sampai disajikan.
 */
export async function identityDocumentFile(userId: string): Promise<ProofFile> {
  const user = await prismaClient.user.findUnique({ where: { id: userId }, select: { identityFilePath: true } })
  if (!user) throw new ResponseError(404, 'User tidak ditemukan')

  const path = (user.identityFilePath ?? '').trim()
  if (path === '') throw new ResponseError(404, 'Dokumen identitas belum diunggah')
  if (!privateFileExists(path)) throw new ResponseError(404, 'Dokumen identitas tidak ditemukan di penyimpanan')

  return {
    absolutePath: resolvePrivate(path),
    mime: identityMimeFor(path),
    fileName: documentFileName(path)
  }
}
