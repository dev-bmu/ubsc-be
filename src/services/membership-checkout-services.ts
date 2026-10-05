import { Prisma } from '@prisma/client'
import type { MembershipCheckoutPreviewDto, MembershipPaymentDetailDto } from '../../shared/contracts'
import { formatCalendarDateIntl } from '../../shared/format'
import { prismaClient } from '../application/database'
import { ResponseError } from '../error/response-error'
import type { UserWithRelations } from '../type/user-request'
import { addDays, addMinutes, dateOnlyToString, jakartaDate, now } from '../utils/clock'
import { MembershipCheckoutValidation } from '../validation/membership-checkout-validation'
import { Validation } from '../validation/Validation'
import { adminFee, attachProof, bankAccount, holdMinutes, isConfigured, qrisSetting, uniqueCodeMax } from './manual-payment-services'
import { currentActiveMembership, openMembershipCheckout } from './membership-services'
import { deletePrivateFile, storePaymentProof } from './payment-proof-services'
import { presentTransferPayment, UploadedFile } from './payment-services'
import { membershipPriceFor, membershipTariffCategory, priceCategoryFor } from './pricing-services'

// ============================================================================
// === Checkout membership lewat web (PRD tambahan 2026-09, tahap C) ===
// ============================================================================
// /pricing -> pilih paket -> login -> foto wajah -> ringkasan -> transfer -> bukti -> staff menyetujui
// -> membership aktif (activatePendingMembership). Mesin transfernya sama dengan booking:
// openTransfer, attachProof, dan antrean verifikasi yang sudah mengenali type 'membership'.
//
// Harga mengikuti kategori pembeli saat checkout (tarif Warga UB butuh identitas terverifikasi), sama
// dengan meja depan — keduanya lewat membershipPriceFor().

const NOT_FOUND = 'Membership tidak ditemukan'

async function activePlan(planId: string) {
  const plan = await prismaClient.membershipPlan.findUnique({
    where: { id: planId },
    select: { id: true, name: true, durationMonths: true, price: true, wargaPrice: true, isActive: true }
  })
  if (!plan || !plan.isActive) throw new ResponseError(404, 'Paket membership tidak ditemukan.')
  return plan
}

function pendingMembershipOf(userId: string) {
  return prismaClient.membership.findFirst({
    where: { userId, status: 'pending_payment' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, membershipPlanId: true, membershipPlan: { select: { name: true } } }
  })
}

/**
 * Keputusan client 2026-10-05: selama membership masih aktif, paket baru (perpanjangan) hanya bisa
 * dibeli di 7 hari terakhir masa aktifnya — cukup untuk menyambung tanpa jeda, tanpa menumpuk paket
 * berbulan-bulan ke depan. Berlaku untuk checkout web; meja depan tetap keputusan staff.
 */
const RENEWAL_WINDOW_DAYS = 7

/** Tanggal ('YYYY-MM-DD') pembelian baru dibuka, atau null bila boleh sekarang. */
function renewalOpensOn(current: { endDate: Date } | null): string | null {
  if (!current) return null
  const opens = addDays(dateOnlyToString(current.endDate), -(RENEWAL_WINDOW_DAYS - 1))
  return jakartaDate() >= opens ? null : opens
}

const longDate = (key: string) => formatCalendarDateIntl(key, { day: 'numeric', month: 'long', year: 'numeric' })

/** Kartu member butuh foto wajah; foto yang ditolak harus diganti dulu. Foto yang menunggu tinjauan boleh. */
function assertMemberPhoto(user: UserWithRelations): void {
  if (user.memberPhotoPath && user.memberPhotoStatus !== 'rejected') return
  const msg =
    user.memberPhotoStatus === 'rejected'
      ? 'Foto wajah Anda ditolak. Unggah foto baru sebelum membeli membership.'
      : 'Unggah foto wajah terlebih dahulu — petugas mencocokkannya saat Anda masuk gym.'
  throw new ResponseError(422, msg, 'VALIDATION_ERROR', { photo: [msg] })
}

// ===== 1. Pratinjau =====

/** GET /api/customer/memberships/checkout/:planId — semua yang tampil sebelum tombol bayar. */
export async function membershipCheckoutPreview(user: UserWithRelations, planId: string): Promise<MembershipCheckoutPreviewDto> {
  const plan = await activePlan(planId)
  const category = priceCategoryFor(user)
  const [fee, codeMax, current, pending] = await Promise.all([
    adminFee(),
    uniqueCodeMax(),
    currentActiveMembership(prismaClient, user.id),
    pendingMembershipOf(user.id)
  ])

  return {
    plan: { id: plan.id, name: plan.name, durationMonths: plan.durationMonths, price: plan.price, wargaPrice: plan.wargaPrice },
    amount: membershipPriceFor(plan, category),
    priceCategory: category,
    identityStatus: user.identityStatus,
    adminFee: fee,
    uniqueCodeMax: codeMax,
    startsAfterCurrent: current ? addDays(dateOnlyToString(current.endDate), 1) : null,
    activeUntil: current ? dateOnlyToString(current.endDate) : null,
    renewalOpensOn: renewalOpensOn(current),
    memberPhotoUrl: user.memberPhotoPath,
    memberPhotoStatus: user.memberPhotoStatus,
    pendingMembershipId: pending?.id ?? null
  }
}

// ===== 2. Checkout =====

/**
 * POST /api/customer/memberships. Pembelian yang SAMA yang masih menunggu pembayaran dikembalikan apa
 * adanya (klik dua kali, kembali dari tab lain) — created:false; paket lain ditolak sampai yang
 * menunggu itu selesai atau kedaluwarsa.
 */
export async function startMembershipCheckout(user: UserWithRelations, request: unknown): Promise<{ created: boolean; membershipId: string }> {
  const v = Validation.validate(MembershipCheckoutValidation.START, request)
  const plan = await activePlan(v.membershipPlanId)

  const pending = await pendingMembershipOf(user.id)
  if (pending) {
    if (pending.membershipPlanId === plan.id) return { created: false, membershipId: pending.id }
    const msg = `Anda masih punya pembelian ${pending.membershipPlan?.name ?? 'membership'} yang menunggu pembayaran. Selesaikan atau tunggu hingga kedaluwarsa.`
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
  }

  const current = await currentActiveMembership(prismaClient, user.id)
  const opens = renewalOpensOn(current)
  if (current && opens) {
    const msg = `Membership Anda masih aktif sampai ${longDate(dateOnlyToString(current.endDate))}. Perpanjangan bisa dibeli mulai ${longDate(opens)}.`
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
  }

  assertMemberPhoto(user)
  if (!(await isConfigured())) {
    const msg = 'Pembayaran online sedang tidak tersedia. Silakan daftar di meja depan.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
  }

  const category = priceCategoryFor(user)
  const membership = await openMembershipCheckout({
    userId: user.id,
    customerName: user.name,
    plan,
    amount: membershipPriceFor(plan, category),
    priceCategory: membershipTariffCategory(plan, category),
    holdExpiresAt: addMinutes(now(), await holdMinutes())
  })
  return { created: true, membershipId: membership.id }
}

// ===== 3. Instruksi transfer + unggah bukti =====

const OWNED_INCLUDE = { membershipPlan: { select: { name: true } }, transaction: true } satisfies Prisma.MembershipInclude
type OwnedMembership = Prisma.MembershipGetPayload<{ include: typeof OWNED_INCLUDE }>

/** Membership orang lain dijawab 404, sama seperti booking: tidak membocorkan keberadaannya. */
async function loadOwnedMembership(userId: string, membershipId: string): Promise<OwnedMembership> {
  const membership = await prismaClient.membership.findUnique({ where: { id: membershipId }, include: OWNED_INCLUDE })
  if (!membership || membership.userId !== userId) throw new ResponseError(404, NOT_FOUND)
  if (!membership.transaction) throw new ResponseError(404, 'Pembayaran tidak ditemukan')
  return membership
}

/** Layar saja — yang berwibawa adalah pemeriksaan di bawah kunci di attachProof(). */
function canUploadProof(membership: OwnedMembership): boolean {
  const t = membership.transaction
  if (!t || t.paymentStatus !== 'UNPAID' || t.verificationStatus === 'awaiting') return false
  if (membership.status !== 'pending_payment') return false
  return !t.expiresAt || t.expiresAt.getTime() >= now().getTime()
}

async function presentMembershipPayment(membership: OwnedMembership): Promise<MembershipPaymentDetailDto> {
  const t = membership.transaction as NonNullable<OwnedMembership['transaction']>
  return {
    membership: {
      id: membership.id,
      planName: membership.membershipPlan?.name ?? 'Membership',
      status: membership.status,
      startDate: dateOnlyToString(membership.startDate),
      endDate: dateOnlyToString(membership.endDate),
      holdExpiresAt: t.paymentStatus === 'UNPAID' && !t.proofPath ? (t.expiresAt?.toISOString() ?? null) : null
    },
    payment: presentTransferPayment(t, canUploadProof(membership)),
    bank: await bankAccount(),
    qris: await qrisSetting()
  }
}

/** GET /api/customer/memberships/:membershipId/pembayaran */
export async function membershipPaymentDetail(userId: string, membershipId: string): Promise<MembershipPaymentDetailDto> {
  return presentMembershipPayment(await loadOwnedMembership(userId, membershipId))
}

/** POST /api/customer/memberships/:membershipId/pembayaran/bukti — field `proof`, alur sama dengan booking. */
export async function uploadMembershipProof(
  userId: string,
  membershipId: string,
  file: UploadedFile | undefined
): Promise<MembershipPaymentDetailDto> {
  const membership = await loadOwnedMembership(userId, membershipId)
  const transactionId = (membership.transaction as NonNullable<OwnedMembership['transaction']>).id

  if (!canUploadProof(membership)) {
    const msg = 'Pembayaran ini sudah tidak menerima unggahan bukti.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { proof: [msg] })
  }
  if (!file || file.size === 0) {
    const msg = 'Pilih gambar bukti transfer terlebih dahulu.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { proof: [msg] })
  }

  const storedPath = await storePaymentProof(file.buffer, transactionId)
  try {
    await attachProof(transactionId, storedPath)
  } catch (error) {
    deletePrivateFile(storedPath)
    throw error
  }

  return presentMembershipPayment(await loadOwnedMembership(userId, membershipId))
}
