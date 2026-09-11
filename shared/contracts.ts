// ===== Kontrak respons API UBSC (SUMBER KEBENARAN) =====
//
// Tipe di file ini dipakai tiga repo sekaligus: ubsc-api menulisnya, ubsc-landing dan
// ubsc-admin menyalinnya lewat npm run sync:contracts. Isinya murni tipe — tidak ada nilai
// runtime — supaya bisa diimpor dengan import type dan hilang total saat build FE.
//
// Baca shared/README.md sebelum menambah apa pun di sini: satu field baru = tiga commit.

import type { PermissionCode } from './permissions'

// ===== Envelope =====
//
// Menyimpang dari boilerplate yang mengembalikan { errors: "<string>" } dengan seluruh
// ZodError ter-serialisasi di dalam satu string. Bentuk itu tidak bisa dipakai ~40 form
// aplikasi ini: pesan error tidak punya tempat menempel per field. Envelope di bawah punya
// peta fields, dan satu helper applyApiErrors(error, form) di FE memetakannya ke setError.

/** Meta paginasi. Selalu di level envelope, tidak pernah di dalam data. */
export interface ApiMeta {
  page: number
  perPage: number
  total: number
  lastPage: number
}

export interface ApiSuccess<T> {
  success: true
  data: T
  meta?: ApiMeta
}

/**
 * Isi error. code dibaca mesin (FE bercabang di atasnya), message dibaca manusia dan SELALU
 * bahasa Indonesia, fields hanya ada pada VALIDATION_ERROR, requestId ikut masuk log winston
 * sehingga keluhan user bisa ditelusuri ke satu baris log.
 */
export interface ApiErrorBody {
  code: ErrorCode
  message: string
  fields?: Record<string, string[]>
  requestId?: string
}

export interface ApiFailure {
  success: false
  error: ApiErrorBody
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

/**
 * Respons daftar ter-paginasi: data berisi array, meta wajib ada.
 * Contoh pemakaian nanti: PaginatedData<BookingDto>.
 */
export interface PaginatedData<T> extends ApiSuccess<T[]> {
  meta: ApiMeta
}

// ===== Kode error =====
//
// Union ini WAJIB sama persis dengan ERROR_CODES di src/utils/respond.ts. Di sanalah
// nilainya hidup sebagai konstanta runtime; di sini hanya bayangannya sebagai tipe, karena
// file ini sengaja bebas nilai runtime agar aman disalin ke repo Next.
// Menambah kode berarti menyentuh dua file, lalu npm run sync:contracts di kedua repo Next.

export type ErrorCode =
  | 'VALIDATION_ERROR' // 422 — payload gagal validasi Zod, selalu disertai fields
  | 'UNAUTHENTICATED' // 401 — tidak ada sesi, token kedaluwarsa, atau audience tidak cocok
  | 'FORBIDDEN' // 403 — sesi sah tapi permission kurang
  | 'NOT_FOUND' // 404 — resource tidak ada, atau bukan milik pemanggil
  | 'CONFLICT' // 409 — bentrok status, misal membership tumpang tindih
  | 'RATE_LIMITED' // 429 — melewati batas percobaan login/booking
  | 'PAYLOAD_TOO_LARGE' // 413 — unggahan melebihi batas multer
  | 'HOLD_LAPSED' // 409 — hold pembayaran sudah lewat saat bukti masuk (Fase 3)
  | 'PENDING_TOTAL_EXHAUSTED' // 409 — 25 percobaan kode nominal unik habis (Fase 3, R11)
  | 'SERVICE_UNAVAILABLE' // 502/503/504 — dependensi luar (DB, SMTP, Google) sedang tidak bisa dihubungi; boleh dicoba lagi
  | 'INTERNAL_ERROR' // 500 — pesan generik; detail hanya masuk log, tidak pernah ke klien

// ===== Meta & health =====

export interface HealthDto {
  status: 'ok' | 'degraded'
  service: string
  /** ISO-8601 UTC. Opsional karena /api/health dangkal tidak perlu menyentuh apa pun. */
  timestamp?: string
}

/**
 * Balasan GET /api/meta/contract-hash.
 *
 * hash        sha256 deterministik atas isi folder shared/ (lihat src/utils/contract-hash.ts)
 * files       nama file yang ikut dihitung, urut — supaya selisih salinan bisa ditunjuk
 * generatedAt ISO-8601 UTC, waktu hash dihitung pertama kali di proses ini
 *
 * Kedua app Next memanggil endpoint ini saat boot dev dan console.warn bila berbeda dengan
 * hash salinannya. Itu yang mengubah drift kontrak dari bug misterius di produksi (R12)
 * jadi peringatan di terminal.
 */
export interface ContractHashDto {
  hash: string
  files: string[]
  generatedAt: string
}

// ===== Auth =====
//
// Dua audience terpisah, masing-masing punya cookie, secret JWT, dan claim aud sendiri.
// Token customer ditolak di route staff dan sebaliknya — itu properti yang diuji di Fase 1.

export type AuthAudience = 'customer' | 'staff'

/**
 * Identitas pemakai yang dikembalikan endpoint auth dan dipegang AuthContext di kedua app Next.
 *
 * role null untuk customer: mereka bukan staf dan tidak punya baris role sama sekali.
 * permissions selalu ada, array kosong untuk customer. Keduanya hanya untuk UX di FE —
 * gate yang sesungguhnya selalu dijalankan server lewat requirePermission per baris route.
 */
export interface AuthUserDto {
  id: string
  name: string
  email: string
  role: string | null
  permissions: PermissionCode[]
}

/** Balasan endpoint login/refresh/me. Access token hidup di memori JS, tidak pernah di localStorage. */
export interface AuthSessionDto {
  user: AuthUserDto
  audience: AuthAudience
  accessToken: string
  /** Detik sampai accessToken kedaluwarsa, untuk penjadwalan refresh single-flight di FE. */
  expiresIn: number
}

// ===== DTO domain =====
//
// TODO Fase 1: UserDto, RoleDto, PermissionDto (layar Role & Access + Internal Users).
// TODO Fase 3: FacilityDto, FacilityUnitDto, FacilityPricingDto, SlotDto, BookingDto,
//              TransactionDto — beserta enum status yang dipakai bersama FE.
// TODO Fase 6: MembershipDto, MembershipPlanDto, IdentityDto, ReviewDto.
// TODO Fase 5: NewsDto, PromoDto, ReelDto, SponsorDto, TestimonialDto, AnnouncementDto.
//
// Aturannya sama untuk semuanya: DTO ditulis DI SINI lebih dulu, baru service API
// mengembalikannya. Setiap penambahan atau perubahan field WAJIB diikuti
// npm run sync:contracts di ubsc-landing DAN ubsc-admin pada commit yang sama-sama
// di-review, kalau tidak /api/meta/contract-hash akan mulai berteriak saat boot dev.
