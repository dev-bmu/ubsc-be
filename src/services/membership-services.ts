import { Prisma } from '@prisma/client'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { addDays, addMonths, dateOnly, dateOnlyToString, now } from '../utils/clock'
import { receiptNumber } from '../utils/money'
import { withConflictRetry } from '../utils/prisma-errors'

// ============================================================================
// === MembershipLifecycleService — port dari app/Services ===
// ============================================================================
// Transaksi membership SELALU langsung PAID (dibuat staff di meja depan), dan setiap perubahan
// dicatat ke membership_histories untuk audit.
//
// PENCEGAHAN OVERLAP — perbedaan penting dari Laravel:
// Laravel memakai `Membership::where(overlap)->lockForUpdate()->exists()`. Kalau BELUM ada baris yang
// cocok, tidak ada baris yang terkunci. Di Laravel itu tetap "selamat" hanya karena isolasi bawaan
// MySQL REPEATABLE READ mengambil gap lock pada rentang indeks, sehingga dua create bersamaan berakhir
// deadlock dan salah satunya gagal. Transaksi di sini memakai ReadCommitted (Rewrite.md) — di level
// itu gap lock TIDAK diambil dan dua membership tumpang tindih bisa sama-sama lolos.
// Solusinya: kunci baris `users` milik pelanggan (baris yang PASTI ada) sebelum mengecek. Semua
// operasi membership untuk satu pelanggan kini antre di belakang kunci itu, apa pun level isolasinya.

type Db = Prisma.TransactionClient

export interface CreateMembershipInput {
  userId?: string | null
  customerName?: string | null
  membershipPlanId?: string | null
  startDate: string
  endDate?: string | null
  amount?: number | null
  source?: string | null
  actorId?: string | null
}

export interface RenewMembershipInput {
  membershipPlanId?: string | null
  amount?: number | null
  source?: string | null
  actorId?: string | null
}

async function resolvePlan(tx: Db, planId: string | null | undefined) {
  if (!planId) return null
  const plan = await tx.membershipPlan.findUnique({ where: { id: planId } })
  if (!plan) throw new ResponseError(404, 'Paket membership tidak ditemukan')
  return plan
}

function resolveEndDate(startDate: string, plan: { durationMonths: number } | null, manualEndDate: string | null | undefined): string {
  if (plan) return addMonths(startDate, plan.durationMonths)
  if (!manualEndDate) {
    throw new ResponseError(422, 'Tanggal selesai wajib diisi jika tidak memilih paket.', 'VALIDATION_ERROR', {
      endDate: ['Tanggal selesai wajib diisi jika tidak memilih paket.']
    })
  }
  if (manualEndDate <= startDate) {
    throw new ResponseError(422, 'Tanggal selesai harus setelah tanggal mulai.', 'VALIDATION_ERROR', {
      endDate: ['Tanggal selesai harus setelah tanggal mulai.']
    })
  }
  return manualEndDate
}

function resolveAmount(plan: { price: number } | null, manualAmount: number | null | undefined): number {
  if (plan) return plan.price
  return Math.max(0, Math.trunc(manualAmount ?? 0))
}

async function ensureNoOverlappingActiveMembership(
  tx: Db,
  userId: string | null | undefined,
  startDate: string,
  endDate: string,
  allowedPreviousId?: string
) {
  if (!userId) return

  // Kunci baris pelanggan — lihat catatan di atas berkas.
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`

  const overlap = await tx.membership.count({
    where: {
      userId,
      status: 'active',
      ...(allowedPreviousId ? { id: { not: allowedPreviousId } } : {}),
      startDate: { lte: dateOnly(endDate) },
      endDate: { gte: dateOnly(startDate) }
    }
  })

  if (overlap > 0) {
    const msg = 'User ini masih memiliki membership aktif pada periode tersebut. Gunakan perpanjang atau upgrade agar masa aktif tidak bertabrakan.'
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
  }
}

async function createPaidTransaction(tx: Db, membershipId: string, userId: string | null, amount: number) {
  return tx.transaction.create({
    data: { membershipId, userId, amount, method: 'manual', paymentStatus: 'PAID', paidAt: now() }
  })
}

async function writeHistory(
  tx: Db,
  membershipId: string,
  transaction: { id: string; amount: number; paymentStatus: string; receiptSequence: number } | null,
  action: string,
  actorId: string | null | undefined,
  actorType: string
) {
  const m = await tx.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { membershipPlan: { select: { name: true } } } })
  await tx.membershipHistory.create({
    data: {
      membershipId: m.id,
      userId: m.userId,
      membershipPlanId: m.membershipPlanId,
      transactionId: transaction?.id ?? null,
      renewedFromMembershipId: m.renewedFromMembershipId,
      actorId: actorId ?? null,
      actorType,
      action,
      startDate: m.startDate,
      endDate: m.endDate,
      amount: transaction?.amount ?? null,
      paymentStatus: transaction?.paymentStatus ?? null,
      // Kunci snake_case dipertahankan — ini format data audit yang sama dengan Laravel.
      metadata: { plan_name: m.membershipPlan?.name ?? null, receipt_number: transaction ? receiptNumber(transaction.receiptSequence) : null }
    }
  })
}

export async function createMembership(input: CreateMembershipInput) {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      const plan = await resolvePlan(tx, input.membershipPlanId)
      const startDate = input.startDate
      const endDate = resolveEndDate(startDate, plan, input.endDate)
      const amount = resolveAmount(plan, input.amount)
      const userId = input.userId ?? null

      await ensureNoOverlappingActiveMembership(tx, userId, startDate, endDate)

      const membership = await tx.membership.create({
        data: {
          userId,
          customerName: input.customerName ?? null,
          membershipPlanId: plan?.id ?? null,
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
          status: 'active',
          createdById: input.actorId ?? null,
          createdVia: input.source ?? 'admin'
        }
      })

      const transaction = await createPaidTransaction(tx, membership.id, userId, amount)
      await writeHistory(tx, membership.id, transaction, 'created', input.actorId, input.source ?? 'admin')
      return membership
    }, TX_OPTIONS)
  )
}

export async function renewMembership(sourceMembershipId: string, input: RenewMembershipInput) {
  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memberships WHERE id = ${sourceMembershipId} FOR UPDATE`
      const source = await tx.membership.findUnique({ where: { id: sourceMembershipId } })
      if (!source) throw new ResponseError(404, 'Membership tidak ditemukan')
      if (source.status === 'cancelled') {
        const msg = 'Membership yang dibatalkan tidak dapat diperpanjang.'
        throw new ResponseError(422, msg, 'VALIDATION_ERROR', { membership: [msg] })
      }

      const plan = await resolvePlan(tx, input.membershipPlanId ?? source.membershipPlanId)
      const startDate = addDays(dateOnlyToString(source.endDate), 1)
      const endDate = resolveEndDate(startDate, plan, null)
      const amount = resolveAmount(plan, input.amount)

      await ensureNoOverlappingActiveMembership(tx, source.userId, startDate, endDate, source.id)

      const renewal = await tx.membership.create({
        data: {
          userId: source.userId,
          customerName: source.customerName,
          membershipPlanId: plan?.id ?? null,
          renewedFromMembershipId: source.id,
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
          status: 'active',
          createdById: input.actorId ?? null,
          createdVia: input.source ?? 'admin'
        }
      })

      const transaction = await createPaidTransaction(tx, renewal.id, source.userId, amount)
      await writeHistory(tx, renewal.id, transaction, 'renewed', input.actorId, input.source ?? 'admin')
      return renewal
    }, TX_OPTIONS)
  )
}

/** Catat perubahan status (batal, kedaluwarsa, dsb.) — dipakai panel admin di Fase 8. */
export async function writeStatusHistory(membershipId: string, action: string, actorId?: string | null) {
  await prismaClient.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({
      where: { membershipId },
      select: { id: true, amount: true, paymentStatus: true, receiptSequence: true }
    })
    await writeHistory(tx, membershipId, transaction, action, actorId, 'admin')
  }, TX_OPTIONS)
}
