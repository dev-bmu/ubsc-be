import { Prisma } from '@prisma/client'
import type {
  GymCheckInLookupDto,
  GymCheckInVerdict,
  GymDeskDto,
  GymVisitReportDto,
  GymVisitRowDto,
  MembershipBriefDto,
  MembershipCardDto
} from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import type { UserWithRelations } from '../type/user-request'
import { addDays, dateOnly, dateOnlyToString, jakartaDate, jakartaHm, now, weekdayOf } from '../utils/clock'
import { customerNumber, parseCustomerNumber } from '../utils/money'
import { withConflictRetry } from '../utils/prisma-errors'
import { GymValidation, MAX_REPORT_DAYS } from '../validation/gym-validation'
import { Validation } from '../validation/Validation'

// ============================================================================
// === Gym: kartu member, meja check-in, analitik (PRD tambahan 2026-09, tahap D) ===
// ============================================================================
// Scanner barcode hanya "mengetik" isi kodenya lalu Enter, jadi scan dan ketik manual adalah satu jalur:
// nomor member (customerNumber) masuk ke lookup. FO melihat foto + vonis dulu, baru mencatat — seluruh
// gunanya foto adalah dicocokkan manusia dengan orang di depannya.
//
// Batas harian (setting gym_visit_max_per_day, default 1; 0 = tanpa batas) ditegakkan di bawah kunci
// baris users milik member: kunci dulu, hitung, baru tulis (pola yang sama dengan membership). Dua scan
// beruntun di dua komputer FO antre di kunci itu. Keputusan client: FO boleh mengizinkan masuk ulang
// dengan alasan, dan alasannya tercatat di baris kunjungan.

type Reader = Pick<Prisma.TransactionClient, 'user' | 'membership' | 'gymVisit'>

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_GYM_VISITS_PER_DAY = 1

/** Batas kunjungan per member per hari; 0 = tanpa batas. */
export async function gymVisitMaxPerDay(): Promise<number> {
  const row = await prismaClient.systemSetting.findUnique({ where: { key: 'gym_visit_max_per_day' }, select: { value: true } })
  const configured = Math.trunc(Number(row?.value ?? DEFAULT_GYM_VISITS_PER_DAY))
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_GYM_VISITS_PER_DAY
}

// ===== Bentuk baris =====

const PLAN = { membershipPlan: { select: { name: true } } } satisfies Prisma.MembershipInclude
type MembershipWithPlan = Prisma.MembershipGetPayload<{ include: typeof PLAN }>

function brief(m: MembershipWithPlan | null): MembershipBriefDto | null {
  if (!m) return null
  return {
    id: m.id,
    planName: m.membershipPlan?.name ?? 'Membership',
    startDate: dateOnlyToString(m.startDate),
    endDate: dateOnlyToString(m.endDate),
    status: m.status
  }
}

const VISIT_INCLUDE = {
  user: { select: { name: true, customerSequence: true } },
  membership: { select: PLAN },
  checkedInBy: { select: { name: true } }
} satisfies Prisma.GymVisitInclude
type VisitRow = Prisma.GymVisitGetPayload<{ include: typeof VISIT_INCLUDE }>

function visitRow(v: VisitRow): GymVisitRowDto {
  return {
    id: v.id,
    customerNumber: customerNumber(v.user.customerSequence),
    memberName: v.user.name,
    planName: v.membership.membershipPlan?.name ?? 'Membership',
    visitDate: dateOnlyToString(v.visitDate),
    time: jakartaHm(v.checkedInAt),
    checkedInBy: v.checkedInBy?.name ?? '-',
    source: v.source === 'scan' ? 'scan' : 'manual',
    isOverride: v.isOverride,
    overrideReason: v.overrideReason
  }
}

/** Membership yang memberi akses pada tanggal itu: status active dan rentangnya mencakup tanggal itu. */
function coveringMembership(db: Reader, userId: string, day: string) {
  return db.membership.findFirst({
    where: { userId, status: 'active', startDate: { lte: dateOnly(day) }, endDate: { gte: dateOnly(day) } },
    orderBy: { endDate: 'desc' },
    include: PLAN
  })
}

// ===== Vonis meja check-in =====

const MEMBER_SELECT = { id: true, name: true, customerSequence: true, memberPhotoPath: true, memberPhotoStatus: true } satisfies Prisma.UserSelect
type MemberRow = Prisma.UserGetPayload<{ select: typeof MEMBER_SELECT }>

interface Evaluation {
  verdict: GymCheckInVerdict
  member: MemberRow | null
  membership: MembershipWithPlan | null
  visitsToday: VisitRow[]
  maxPerDay: number
}

const VERDICT_MESSAGE: Record<Exclude<GymCheckInVerdict, 'ok'>, string> = {
  not_found: 'Nomor member tidak ditemukan.',
  no_active_membership: 'Member ini tidak punya membership yang berlaku hari ini.',
  photo_not_approved: 'Foto member belum disetujui. Cocokkan wajahnya lalu setujui fotonya, atau ambil foto baru.',
  already_checked_in: 'Member ini sudah check-in hari ini. Isi alasan untuk mengizinkan masuk ulang.'
}

/** Urutan pemeriksaan = urutan yang harus diselesaikan FO: nomor, membership, foto, batas harian. */
async function evaluate(db: Reader, code: string, day: string, maxPerDay: number): Promise<Evaluation> {
  const sequence = parseCustomerNumber(code)
  const member = sequence === null ? null : await db.user.findFirst({ where: { customerSequence: sequence, roleId: null }, select: MEMBER_SELECT })
  if (!member) return { verdict: 'not_found', member: null, membership: null, visitsToday: [], maxPerDay }

  const visitsToday = await db.gymVisit.findMany({
    where: { userId: member.id, visitDate: dateOnly(day) },
    include: VISIT_INCLUDE,
    orderBy: { checkedInAt: 'asc' }
  })
  const covering = await coveringMembership(db, member.id, day)
  if (!covering) {
    const latest = await db.membership.findFirst({
      where: { userId: member.id },
      orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
      include: PLAN
    })
    return { verdict: 'no_active_membership', member, membership: latest, visitsToday, maxPerDay }
  }

  let verdict: GymCheckInVerdict = 'ok'
  if (member.memberPhotoStatus !== 'approved' || !member.memberPhotoPath) verdict = 'photo_not_approved'
  else if (maxPerDay > 0 && visitsToday.length >= maxPerDay) verdict = 'already_checked_in'
  return { verdict, member, membership: covering, visitsToday, maxPerDay }
}

function presentLookup(e: Evaluation): GymCheckInLookupDto {
  return {
    verdict: e.verdict,
    member: e.member
      ? {
          userId: e.member.id,
          customerNumber: customerNumber(e.member.customerSequence),
          name: e.member.name,
          photoUrl: e.member.memberPhotoPath,
          photoStatus: e.member.memberPhotoStatus
        }
      : null,
    membership: brief(e.membership),
    visitsToday: e.visitsToday.map(visitRow),
    maxPerDay: e.maxPerDay
  }
}

// ===== 1. Meja check-in =====

/** GET /api/admin/gym/checkin/lookup?code= — langkah pertama: tampilkan, belum mencatat. */
export async function lookupGymMember(query: unknown): Promise<GymCheckInLookupDto> {
  const { code } = Validation.validate(GymValidation.LOOKUP, query)
  return presentLookup(await evaluate(prismaClient, code, jakartaDate(), await gymVisitMaxPerDay()))
}

/**
 * POST /api/admin/gym/checkin — langkah kedua. Vonis dihitung ULANG di bawah kunci: yang dilihat FO
 * beberapa detik lalu bisa sudah basi (member yang sama baru dicatat di komputer lain).
 * Hanya 'already_checked_in' yang boleh dilewati, dan hanya dengan alasan.
 */
export async function recordGymVisit(staffId: string, request: unknown): Promise<GymCheckInLookupDto> {
  const v = Validation.validate(GymValidation.CHECK_IN, request)
  const maxPerDay = await gymVisitMaxPerDay()
  const sequence = parseCustomerNumber(v.code)

  return withConflictRetry(() =>
    prismaClient.$transaction(async (tx) => {
      if (sequence !== null) await tx.$queryRaw`SELECT id FROM users WHERE customerSequence = ${sequence} FOR UPDATE`

      const at = now()
      const day = jakartaDate(at)
      const e = await evaluate(tx, v.code, day, maxPerDay)
      const override = e.verdict === 'already_checked_in' && Boolean(v.overrideReason)

      if (e.verdict !== 'ok' && !override) {
        const message = VERDICT_MESSAGE[e.verdict as Exclude<GymCheckInVerdict, 'ok'>]
        const field = e.verdict === 'already_checked_in' ? 'overrideReason' : 'code'
        throw new ResponseError(409, message, 'CONFLICT', { [field]: [message] })
      }

      await tx.gymVisit.create({
        data: {
          userId: (e.member as MemberRow).id,
          membershipId: (e.membership as MembershipWithPlan).id,
          visitDate: dateOnly(day),
          checkedInAt: at,
          checkedInById: staffId,
          source: v.source,
          isOverride: override,
          overrideReason: override ? (v.overrideReason ?? null) : null
        }
      })

      return presentLookup(await evaluate(tx, v.code, day, maxPerDay))
    }, TX_OPTIONS)
  )
}

/** GET /api/admin/gym/checkin — log hari ini di samping meja. */
export async function gymDesk(): Promise<GymDeskDto> {
  const today = jakartaDate()
  const visits = await prismaClient.gymVisit.findMany({
    where: { visitDate: dateOnly(today) },
    include: VISIT_INCLUDE,
    orderBy: { checkedInAt: 'desc' },
    take: 100
  })
  return { today, visits: visits.map(visitRow) }
}

/** Untuk saran di dashboard: kunjungan tercatat hari ini. */
export function gymVisitsOn(day: string): Promise<number> {
  return prismaClient.gymVisit.count({ where: { visitDate: dateOnly(day) } })
}

// ===== 2. Analitik =====

const WEEKDAY_INDEX: Record<string, number> = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 }
const REPORT_LOG_LIMIT = 500

/** GET /api/admin/gym/visits — kedatangan per jam (jawaban "rame jam berapa"), pola mingguan, log. */
export async function gymVisitReport(query: unknown): Promise<GymVisitReportDto> {
  const v = Validation.validate(GymValidation.REPORT, query)
  const from = v.from ?? v.to ?? jakartaDate()
  const to = v.to ?? from

  const days: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day)
  if (days.length > MAX_REPORT_DAYS) {
    const msg = `Rentang laporan maksimal ${MAX_REPORT_DAYS} hari.`
    throw new ResponseError(422, msg, 'VALIDATION_ERROR', { to: [msg] })
  }

  const rows = await prismaClient.gymVisit.findMany({
    where: { visitDate: { gte: dateOnly(from), lte: dateOnly(to) } },
    include: VISIT_INCLUDE,
    orderBy: { checkedInAt: 'desc' }
  })

  const hourly = Array.from({ length: 24 }, () => 0)
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const perDay = new Map(days.map((day) => [day, 0]))
  for (const row of rows) {
    const hour = Number(jakartaHm(row.checkedInAt).slice(0, 2))
    const day = dateOnlyToString(row.visitDate)
    hourly[hour]++
    heatmap[WEEKDAY_INDEX[weekdayOf(day)]][hour]++
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }

  const peak = Math.max(...hourly)
  return {
    range: { from, to },
    summary: {
      totalVisits: rows.length,
      uniqueMembers: new Set(rows.map((row) => row.userId)).size,
      averagePerDay: Math.round((rows.length / days.length) * 10) / 10,
      peakHour: peak > 0 ? hourly.indexOf(peak) : null,
      overrides: rows.filter((row) => row.isOverride).length
    },
    hourly,
    heatmap,
    daily: [...perDay].map(([date, visits]) => ({ date, visits })),
    visits: rows.slice(0, REPORT_LOG_LIMIT).map(visitRow)
  }
}

// ===== 3. Kartu member (pelanggan) =====

/** GET /api/customer/membership-card */
export async function membershipCard(user: UserWithRelations): Promise<MembershipCardDto> {
  const today = jakartaDate()
  const base = {
    customerNumber: customerNumber(user.customerSequence),
    name: user.name,
    photoUrl: user.memberPhotoPath,
    photoStatus: user.memberPhotoStatus
  }

  const covering = await coveringMembership(prismaClient, user.id, today)
  if (covering) {
    const photoOk = user.memberPhotoStatus === 'approved' && Boolean(user.memberPhotoPath)
    const daysRemaining = Math.round((covering.endDate.getTime() - dateOnly(today).getTime()) / DAY_MS) + 1
    return { ...base, membership: brief(covering), state: photoOk ? 'active' : 'photo_required', daysRemaining }
  }

  const upcoming = await prismaClient.membership.findFirst({
    where: { userId: user.id, status: 'active', startDate: { gt: dateOnly(today) } },
    orderBy: { startDate: 'asc' },
    include: PLAN
  })
  if (upcoming) return { ...base, membership: brief(upcoming), state: 'upcoming', daysRemaining: null }

  const pending = await prismaClient.membership.findFirst({
    where: { userId: user.id, status: 'pending_payment' },
    orderBy: { createdAt: 'desc' },
    include: PLAN
  })
  if (pending) return { ...base, membership: brief(pending), state: 'pending_payment', daysRemaining: null }

  const latest = await prismaClient.membership.findFirst({
    where: { userId: user.id },
    orderBy: [{ endDate: 'desc' }, { createdAt: 'desc' }],
    include: PLAN
  })
  return { ...base, membership: brief(latest), state: latest ? 'expired' : 'none', daysRemaining: null }
}
