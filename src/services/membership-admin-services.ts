import { MembershipStatus, Prisma } from '@prisma/client'
import type {
  AdminMembershipDto,
  AdminMembershipIndexDto,
  AdminMembershipPlanDto,
  AdminMembershipPlanIndexDto,
  CustomerHitDto,
  MembershipHistoryDto,
  MembershipTransactionDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ADMIN_URL, LANDING_URL } from '../config'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, formatInstant } from '../utils/clock'
import { logger } from '../utils/logger'
import { sendMailSafe } from '../utils/mailer'
import { membershipActiveTemplate, membershipInvoiceTemplate } from '../utils/mail-templates'
import { customerNumber, parseCustomerNumber, transferTotal } from '../utils/money'
import { isUniqueViolation, withConflictRetry } from '../utils/prisma-errors'
import { MembershipAdminValidation, MembershipPlanInput } from '../validation/membership-admin-validation'
import { Validation } from '../validation/Validation'
import { toFeatures } from './cms-services'
import { priceCategoryFor } from './pricing-services'
import { lockTransaction } from './manual-payment-services'
import { invoiceView } from './invoice-services'
import { approvePayment, MEMBERSHIP_CARD_PATH } from './payment-verification-services'
import { createMembership, renewMembership, writeStatusHistory } from './membership-services'

// ============================================================================
// === Membership admin — port dari Admin\MembershipController + MembershipPlanController ===
// ============================================================================
// Semua aturan siklus hidup (endDate dari paket, nominal, overlap FOR UPDATE, transfer, baris
// riwayat) ada di membership-services.ts — file ini hanya validasi, pemeriksaan `exists:*`/staff,
// dan bentuk DTO transform(). Jangan menduplikasi logika lifecycle di sini.

const ADMIN_BASE = ADMIN_URL.replace(/\/+$/, '')

function fieldError(field: string, message: string): ResponseError {
  return new ResponseError(422, message, 'VALIDATION_ERROR', { [field]: [message] })
}

// ===== Pemuat + transform =====

const PLAN_NAME = { select: { name: true } } as const
const RENEWED_FROM = { select: { id: true, membershipPlan: PLAN_NAME } } as const

const ADMIN_MEMBERSHIP_INCLUDE = {
  user: { select: { name: true, phoneNumber: true, customerSequence: true, memberPhotoPath: true, memberPhotoStatus: true } },
  transaction: true,
  membershipPlan: PLAN_NAME,
  renewedFrom: RENEWED_FROM,
  createdBy: { select: { name: true } },
  histories: {
    // Laravel: ->sortByDesc('created_at') di koleksi.
    orderBy: { createdAt: 'desc' },
    include: {
      membershipPlan: PLAN_NAME,
      transaction: { select: { invoiceNumber: true } },
      renewedFrom: RENEWED_FROM,
      actor: { select: { name: true } }
    }
  }
} satisfies Prisma.MembershipInclude

type AdminMembershipRow = Prisma.MembershipGetPayload<{ include: typeof ADMIN_MEMBERSHIP_INCLUDE }>

/**
 * PENYIMPANGAN UUID yang disengaja: Laravel menulis '#' + str_pad(id, 5, '0') ('#00042'). PK di sini
 * uuid, jadi labelnya 8 karakter pertama uuid dalam huruf besar ('#3F2A9C1B - Paket 3 Bulan').
 */
function renewedFromLabel(renewedFrom: { id: string; membershipPlan: { name: string } | null } | null): string | null {
  if (!renewedFrom) return null
  return `#${renewedFrom.id.slice(0, 8).toUpperCase()} - ${renewedFrom.membershipPlan?.name ?? 'Manual'}`
}

/** Kunci snake_case metadata ditulis writeHistory() — format audit yang sama dengan Laravel. */
function metadataString(metadata: Prisma.JsonValue, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Prisma.JsonObject)[key]
  return typeof value === 'string' ? value : null
}

function transactionDto(t: NonNullable<AdminMembershipRow['transaction']>): MembershipTransactionDto {
  return {
    id: t.id,
    amount: t.amount,
    adminFee: t.adminFee,
    uniqueCode: t.uniqueCode,
    total: transferTotal(t),
    paymentStatus: t.paymentStatus,
    receiptNumber: t.invoiceNumber,
    // Kolom checkout_url Laravel di-drop dari skema (bug 3); diturunkan ke halaman kelola anggota.
    checkoutUrl: `${ADMIN_BASE}/memberships`,
    paidAt: t.paidAt ? formatInstant(t.paidAt, 'Y-m-d H:i') : null
  }
}

function historyDto(h: AdminMembershipRow['histories'][number]): MembershipHistoryDto {
  return {
    id: h.id,
    action: h.action,
    planName: h.membershipPlan?.name ?? metadataString(h.metadata, 'plan_name') ?? 'Manual',
    startDate: dateOnlyToString(h.startDate),
    endDate: dateOnlyToString(h.endDate),
    transactionId: h.transactionId,
    receiptNumber: h.transaction ? h.transaction.invoiceNumber : metadataString(h.metadata, 'receipt_number'),
    renewedFromMembershipId: h.renewedFromMembershipId,
    renewedFromLabel: renewedFromLabel(h.renewedFrom),
    actorName: h.actor?.name ?? null,
    actorType: h.actorType,
    amount: h.amount,
    paymentStatus: h.paymentStatus,
    createdAt: formatInstant(h.createdAt, 'Y-m-d H:i')
  }
}

function transformMembership(m: AdminMembershipRow): AdminMembershipDto {
  return {
    id: m.id,
    userId: m.userId,
    customerNumber: m.user ? customerNumber(m.user.customerSequence) : null,
    memberPhotoUrl: m.user?.memberPhotoPath ?? null,
    memberPhotoStatus: m.user?.memberPhotoStatus ?? null,
    membershipPlanId: m.membershipPlanId,
    renewedFromMembershipId: m.renewedFromMembershipId,
    renewedFromLabel: renewedFromLabel(m.renewedFrom),
    createdByName: m.createdBy?.name ?? null,
    createdVia: m.createdVia,
    planName: m.membershipPlan?.name ?? null,
    customerName: m.customerName ?? m.user?.name ?? 'Guest',
    customerPhone: m.user?.phoneNumber ?? null,
    startDate: dateOnlyToString(m.startDate),
    endDate: dateOnlyToString(m.endDate),
    status: m.status,
    transaction: m.transaction ? transactionDto(m.transaction) : null,
    histories: m.histories.map(historyDto)
  }
}

async function loadAdminMembership(id: string): Promise<AdminMembershipDto> {
  const membership = await prismaClient.membership.findUnique({ where: { id }, include: ADMIN_MEMBERSHIP_INCLUDE })
  if (!membership) throw new ResponseError(404, 'Membership tidak ditemukan')
  return transformMembership(membership)
}

// ===== 1. Index — daftar penuh + opsi paket =====

export async function listAdminMemberships(): Promise<AdminMembershipIndexDto> {
  const [memberships, plans] = await Promise.all([
    prismaClient.membership.findMany({
      include: ADMIN_MEMBERSHIP_INCLUDE,
      // Laravel: orderBy('created_at', 'desc')->get() — tanpa paginasi.
      orderBy: { createdAt: 'desc' }
    }),
    prismaClient.membershipPlan.findMany({
      // Laravel: orderBy('sort_order') — seri dipecah urutan penyisipan (lihat cms-services.ts butir 4).
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, price: true, wargaPrice: true, durationMonths: true }
    })
  ])

  return { memberships: memberships.map(transformMembership), plans }
}

// ===== 2. Store / renew =====

async function assertPlanExists(planId: string | null | undefined): Promise<void> {
  if (!planId) return
  const plan = await prismaClient.membershipPlan.findUnique({ where: { id: planId }, select: { id: true } })
  if (!plan) throw fieldError('membershipPlanId', 'Paket membership tidak ditemukan.')
}

export async function createAdminMembership(request: unknown, actorId: string): Promise<AdminMembershipDto> {
  const v = Validation.validate(MembershipAdminValidation.CREATE, request)

  let customerName = v.customerName ?? null
  if (v.userId) {
    // `exists:users,id` lalu findOrFail + abort_if(hasAnyRole(STAFF_ROLES), 422).
    const customer = await prismaClient.user.findUnique({ where: { id: v.userId }, select: { name: true, roleId: true } })
    if (!customer) throw fieldError('userId', 'Akun customer tidak ditemukan.')
    if (customer.roleId !== null) throw new ResponseError(422, 'Akun staff tidak bisa dijadikan member.')
    customerName = customer.name
  }
  await assertPlanExists(v.membershipPlanId)

  const membership = await createMembership({
    userId: v.userId ?? null,
    customerName,
    membershipPlanId: v.membershipPlanId ?? null,
    startDate: v.startDate,
    endDate: v.endDate ?? null,
    amount: v.amount ?? null,
    source: 'admin',
    actorId
  })

  return notifyMembershipDesk(await loadAdminMembership(membership.id))
}

export async function renewAdminMembership(id: string, request: unknown, actorId: string): Promise<AdminMembershipDto> {
  const v = Validation.validate(MembershipAdminValidation.RENEW, request)
  await assertPlanExists(v.membershipPlanId)

  const renewal = await renewMembership(id, {
    membershipPlanId: v.membershipPlanId ?? null,
    amount: v.amount ?? null,
    source: 'admin',
    actorId
  })

  return notifyMembershipDesk(await loadAdminMembership(renewal.id))
}

/**
 * "Tandai Lunas" FO: transfer membership meja depan sudah terlihat di mutasi. Jalurnya sama dengan
 * menyetujui bukti di antrean pembayaran (approvePayment) — membership aktif dan email kartu member
 * terkirim — tetapi digerbangi izin kelola membership, bukan izin verifikasi pembayaran.
 */
export async function markMembershipPaid(id: string, staffId: string): Promise<AdminMembershipDto> {
  const membership = await prismaClient.membership.findUnique({ where: { id }, select: { transaction: { select: { id: true } } } })
  if (!membership?.transaction) throw new ResponseError(404, 'Transaksi membership tidak ditemukan')
  await approvePayment(membership.transaction.id, staffId)
  return loadAdminMembership(id)
}

/**
 * Email ke pemilik akun setelah FO membuat / memperpanjang membership. Menunggu pembayaran = tagihan
 * (invoice yang sama dengan layar FO); nominal 0 = langsung kartu member. Email dikirim `void` —
 * kegagalan SMTP tidak boleh menggagalkan membership yang sudah tersimpan, dan invoice-nya tetap ada
 * di layar FO dan dashboard pelanggan.
 */
async function notifyMembershipDesk(dto: AdminMembershipDto): Promise<AdminMembershipDto> {
  if (!dto.userId || !dto.customerNumber) return dto
  const user = await prismaClient.user.findUnique({ where: { id: dto.userId }, select: { email: true, name: true } })
  if (!user?.email) return dto

  const t = dto.transaction
  if (dto.status === 'pending_payment' && t) {
    try {
      void sendMailSafe(membershipInvoiceTemplate({ to: user.email, name: user.name, invoice: await invoiceView(t.id) }))
    } catch (error) {
      logger.error(`Email tagihan membership ${dto.id} gagal disusun: ${(error as Error).message}`)
    }
    return dto
  }
  void sendMailSafe(
    membershipActiveTemplate({
      to: user.email,
      name: user.name,
      planName: dto.planName ?? 'Membership',
      startDate: dto.startDate,
      endDate: dto.endDate,
      customerNumber: dto.customerNumber,
      payment: t && t.total > 0 && t.receiptNumber ? { receiptNumber: t.receiptNumber, total: t.total } : null,
      cardUrl: `${LANDING_URL.replace(/\/+$/, '')}${MEMBERSHIP_CARD_PATH}`
    })
  )
  return dto
}

// ===== 3. Customer typeahead =====

/** Hanya akun customer (roleId null) — staff tidak pernah muncul di picker. Maks 8, urut nama. */
export async function searchCustomers(query: unknown): Promise<CustomerHitDto[]> {
  const { q } = Validation.validate(MembershipAdminValidation.CUSTOMER_SEARCH, query)
  // mb_strlen — hitung code point, bukan unit UTF-16.
  if ([...q].length < 2) return []

  // `contains` Prisma sudah meng-escape % dan _ (padanan addcslashes Laravel). Nomor member
  // ('UB-7K3F-92QX', boleh tanpa strip) dicocokkan persis, bukan contains.
  const sequence = parseCustomerNumber(q)
  const users = await prismaClient.user.findMany({
    where: {
      roleId: null,
      OR: [
        { name: { contains: q } },
        { email: { contains: q } },
        { phoneNumber: { contains: q } },
        ...(sequence !== null ? [{ customerSequence: sequence }] : [])
      ]
    },
    orderBy: { name: 'asc' },
    take: 8,
    select: { id: true, name: true, email: true, phoneNumber: true, identityCategory: true, identityStatus: true, customerSequence: true }
  })

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phoneNumber,
    identityStatus: u.identityStatus,
    customerNumber: customerNumber(u.customerSequence),
    priceCategory: priceCategoryFor(u)
  }))
}

/**
 * POST /api/admin/customers — akun minimal untuk walk-in supaya ia punya nomor member, foto, dan
 * kartu. Tanpa password: pelanggan mengambil alih akunnya lewat "lupa password".
 */
export async function createCustomerAccount(request: unknown): Promise<CustomerHitDto> {
  const v = Validation.validate(MembershipAdminValidation.CUSTOMER_CREATE, request)
  const taken = 'Email sudah terdaftar. Cari akunnya di kolom pencarian.'

  try {
    const user = await prismaClient.user.create({
      data: { name: v.name, email: v.email, phoneNumber: v.phoneNumber ?? null, password: null },
      select: { id: true, name: true, email: true, phoneNumber: true, identityCategory: true, identityStatus: true, customerSequence: true }
    })
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phoneNumber,
      identityStatus: user.identityStatus,
      customerNumber: customerNumber(user.customerSequence),
      priceCategory: priceCategoryFor(user)
    }
  } catch (error) {
    if (isUniqueViolation(error, 'email')) throw fieldError('email', taken)
    throw error
  }
}

// ===== 4. Update status + destroy (soft-cancel) =====

/**
 * Tulis status; bila `cancelled` dan transaksinya masih UNPAID, tandai FAILED. Riwayat ditulis SETELAH
 * commit lewat writeStatusHistory() (transaksinya sendiri), sama seperti urutan Laravel.
 * Baris transaksi dikunci dulu supaya pengecekan UNPAID dan penulisan FAILED tidak disalip keputusan
 * pembayaran yang berjalan bersamaan.
 */
async function applyMembershipStatus(id: string, status: MembershipStatus, action: string, actorId: string): Promise<AdminMembershipDto> {
  await withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { id }, select: { id: true, status: true, transaction: { select: { id: true } } } })
      if (!membership) throw new ResponseError(404, 'Membership tidak ditemukan')
      // Membership online aktif lewat persetujuan transfer, bukan lewat ubah status manual.
      if (membership.status === 'pending_payment' && status !== 'cancelled') {
        const msg = 'Membership ini menunggu pembayaran dan aktif otomatis saat transfernya disetujui. Hanya bisa dibatalkan.'
        throw new ResponseError(422, msg, 'VALIDATION_ERROR', { status: [msg] })
      }

      const transactionId = membership.transaction?.id ?? null
      if (status === 'cancelled' && transactionId) await lockTransaction(tx, transactionId)

      await tx.membership.update({ where: { id }, data: { status } })

      if (status === 'cancelled' && transactionId) {
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: { paymentStatus: true } })
        if (transaction?.paymentStatus === 'UNPAID') {
          await tx.transaction.update({ where: { id: transactionId }, data: { paymentStatus: 'FAILED', pendingTotal: null } })
        }
      }
    }, TX_OPTIONS)
  )

  await writeStatusHistory(id, action, actorId)
  return loadAdminMembership(id)
}

export async function updateMembershipStatus(id: string, request: unknown, actorId: string): Promise<AdminMembershipDto> {
  const v = Validation.validate(MembershipAdminValidation.UPDATE_STATUS, request)
  return applyMembershipStatus(id, v.status, 'status_changed', actorId)
}

/** Soft-cancel — tidak pernah hard-delete. */
export async function destroyMembership(id: string, actorId: string): Promise<AdminMembershipDto> {
  return applyMembershipStatus(id, 'cancelled', 'cancelled', actorId)
}

// ============================================================================
// === Paket membership — port Admin\MembershipPlanController ===
// ============================================================================

const PLAN_SELECT = {
  id: true,
  name: true,
  description: true,
  publicBadge: true,
  savingsLabel: true,
  ctaLabel: true,
  cardImageUrl: true,
  price: true,
  wargaPrice: true,
  accurateItemNo: true,
  accurateItemNoWarga: true,
  durationMonths: true,
  features: true,
  isActive: true,
  sortOrder: true,
  _count: { select: { memberships: { where: { status: 'active' } } } }
} satisfies Prisma.MembershipPlanSelect

type PlanRow = Prisma.MembershipPlanGetPayload<{ select: typeof PLAN_SELECT }>

/** Pemetaan identik listMembershipPlans() (cms-services.ts), termasuk `features ?? []`, plus nomor item Accurate. */
function planDto(plan: PlanRow): AdminMembershipPlanDto {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    publicBadge: plan.publicBadge,
    savingsLabel: plan.savingsLabel,
    ctaLabel: plan.ctaLabel,
    cardImageUrl: plan.cardImageUrl,
    price: plan.price,
    wargaPrice: plan.wargaPrice,
    durationMonths: plan.durationMonths,
    features: toFeatures(plan.features),
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    activeMembersCount: plan._count.memberships,
    accurateItemNo: plan.accurateItemNo,
    accurateItemNoWarga: plan.accurateItemNoWarga
  }
}

async function loadPlan(id: string): Promise<AdminMembershipPlanDto> {
  const plan = await prismaClient.membershipPlan.findUnique({ where: { id }, select: PLAN_SELECT })
  if (!plan) throw new ResponseError(404, 'Paket membership tidak ditemukan')
  return planDto(plan)
}

/** SEMUA paket (aktif & nonaktif) — beda dari listMembershipPlans() publik yang memfilter isActive. */
export async function listAdminMembershipPlans(): Promise<AdminMembershipPlanIndexDto> {
  const plans = await prismaClient.membershipPlan.findMany({
    select: PLAN_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  })
  return { plans: plans.map(planDto) }
}

/**
 * $data Laravel hanya berisi key yang ADA di request: field absen = undefined = kolom tidak disentuh
 * (create jatuh ke default DB). features null -> SQL NULL (Prisma.DbNull), bukan json 'null'.
 */
function planData(v: MembershipPlanInput) {
  return {
    name: v.name,
    description: v.description,
    publicBadge: v.publicBadge,
    savingsLabel: v.savingsLabel,
    ctaLabel: v.ctaLabel,
    cardImageUrl: v.cardImageUrl,
    price: v.price,
    wargaPrice: v.wargaPrice,
    accurateItemNo: v.accurateItemNo,
    accurateItemNoWarga: v.accurateItemNoWarga,
    durationMonths: v.durationMonths,
    features: v.features === null ? Prisma.DbNull : v.features,
    isActive: v.isActive,
    sortOrder: v.sortOrder
  }
}

export async function createMembershipPlan(request: unknown): Promise<AdminMembershipPlanDto> {
  const v = Validation.validate(MembershipAdminValidation.PLAN, request)
  const plan = await prismaClient.membershipPlan.create({ data: planData(v), select: { id: true } })
  return loadPlan(plan.id)
}

export async function updateMembershipPlan(id: string, request: unknown): Promise<AdminMembershipPlanDto> {
  const v = Validation.validate(MembershipAdminValidation.PLAN, request)
  const existing = await prismaClient.membershipPlan.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new ResponseError(404, 'Paket membership tidak ditemukan')

  await prismaClient.membershipPlan.update({ where: { id }, data: planData(v) })
  return loadPlan(id)
}

/**
 * Tolak bila masih ada anggota AKTIF. Selain itu hapus.
 *
 * FK Laravel `memberships.membership_plan_id` dan `membership_histories.membership_plan_id` keduanya
 * `->nullOnDelete()` (migrasi 2026_04_30_000003 & 2026_05_21_000002): membership expired/cancelled dan
 * riwayatnya TETAP ada, hanya tautan paketnya jadi NULL. relationMode="prisma" tidak punya FK/cascade di
 * DB, jadi SET NULL itu ditiru manual di transaksi yang sama sebelum paket dihapus. Nama paket di riwayat
 * tetap terbaca lewat metadata.plan_name (fallback historyDto).
 */
export async function destroyMembershipPlan(id: string): Promise<{ id: string }> {
  await withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM membership_plans WHERE id = ${id} FOR UPDATE`
      if (rows.length === 0) throw new ResponseError(404, 'Paket membership tidak ditemukan')

      // pending_payment ikut dihitung: paket harus masih ada saat transfernya disetujui.
      const count = await tx.membership.count({ where: { membershipPlanId: id, status: { in: ['active', 'pending_payment'] } } })
      if (count > 0) {
        const msg = `Paket tidak dapat dihapus karena masih memiliki ${count} anggota aktif atau menunggu pembayaran.`
        throw new ResponseError(422, msg, 'VALIDATION_ERROR', { plan: [msg] })
      }

      await tx.membership.updateMany({ where: { membershipPlanId: id }, data: { membershipPlanId: null } })
      await tx.membershipHistory.updateMany({ where: { membershipPlanId: id }, data: { membershipPlanId: null } })
      await tx.membershipPlan.delete({ where: { id } })
    }, TX_OPTIONS)
  )

  return { id }
}
