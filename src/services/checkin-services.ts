import { Prisma, Transaction } from '@prisma/client'
import type { CheckInDetailDto, CheckInIndexDto, DeskBookingDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { checkInUrl } from './payment-services'
import { ResponseError } from '../error/response-error'
import { dateOnly, dateOnlyToString, formatInstant, jakartaDate, now, translatedDate } from '../utils/clock'

import { BookingAdminValidation } from '../validation/booking-admin-validation'
import { Validation } from '../validation/Validation'

// ============================================================================
// === Check-in admin — port dari Admin\CheckInController ===
// ============================================================================
// index (daftar hari ini + cari), show (satu token), store (konfirmasi kehadiran). present() membaca
// pembayaran lewat payableTransaction (lead grup), jadi sesi follower paket tidak terbaca UNPAID.

const CHECKIN_INCLUDE = {
  user: { select: { name: true, email: true, phoneNumber: true, identityStatus: true } },
  facility: { select: { name: true } },
  facilityUnit: { select: { name: true } },
  transaction: true,
  bookingGroup: { select: { transaction: true } },
  checkedInBy: { select: { name: true } }
} satisfies Prisma.BookingInclude

type CheckInRow = Prisma.BookingGetPayload<{ include: typeof CHECKIN_INCLUDE }>

function payableTransaction(booking: {
  transaction: Transaction | null
  bookingGroup: { transaction: Transaction | null } | null
}): Transaction | null {
  return booking.transaction ?? booking.bookingGroup?.transaction ?? null
}

/** Bentuk bersama meja check-in (present() Laravel), tanpa check_in_url / identity_status. */
function presentBase(b: CheckInRow) {
  const tx = payableTransaction(b)
  return {
    id: b.id,
    receiptNumber: tx ? tx.invoiceNumber : `#${b.id}`,
    customer: {
      // present() Laravel MENGUTAMAKAN nama user atas customer_name (kebalikan transformBooking).
      name: b.user?.name ?? b.customerName ?? '-',
      email: b.user?.email ?? null,
      phone: b.user?.phoneNumber ?? b.customerPhone ?? null
    },
    facility: b.facility?.name ?? '-',
    unit: b.facilityUnit?.name ?? null,
    date: translatedDate(dateOnlyToString(b.bookingDate), 'l, d F Y'),
    isToday: dateOnlyToString(b.bookingDate) === jakartaDate(),
    time: `${b.startTime.slice(0, 5)} – ${b.endTime.slice(0, 5)}`,
    status: b.status,
    paymentStatus: tx?.paymentStatus ?? 'UNPAID',
    amount: tx?.amount ?? b.subtotalPrice,
    checkedInAt: b.checkedInAt ? formatInstant(b.checkedInAt, 'd M Y H:i') : null,
    checkedInBy: b.checkedInBy?.name ?? null
  }
}

/** Baris daftar meja: present() + check_in_url (null bila booking tak bertoken). */
function presentDesk(b: CheckInRow): DeskBookingDto {
  return { ...presentBase(b), checkInUrl: checkInUrl(b.checkInToken) }
}

/** Layar konfirmasi: present() + identity_status pelanggan. */
function presentDetail(b: CheckInRow): CheckInDetailDto {
  const base = presentBase(b)
  return { ...base, customer: { ...base.customer, identityStatus: b.user?.identityStatus ?? null } }
}

// ===== 1. Daftar hari ini =====

export async function checkInIndex(query: unknown): Promise<CheckInIndexDto> {
  const { q } = Validation.validate(BookingAdminValidation.CHECKIN_INDEX, query)

  const bookings = await prismaClient.booking.findMany({
    where: { bookingDate: dateOnly(jakartaDate()), status: { not: 'cancelled' } },
    include: CHECKIN_INCLUDE,
    orderBy: { startTime: 'asc' }
  })

  const needle = q.toLowerCase()
  const filtered = bookings.filter((b) => {
    if (q === '') return true
    const tx = payableTransaction(b)
    const haystack = [b.user?.name, b.customerName, b.user?.phoneNumber, b.customerPhone, tx ? tx.invoiceNumber : null, `#${b.id}`]
      .filter((part): part is string => Boolean(part))
      .join(' ')
    return haystack.toLowerCase().includes(needle)
  })

  // Belum hadir + sudah bayar mendahului — itu antrean yang benar-benar berdiri di meja.
  const sortKey = (b: CheckInRow): [number, number, string] => [
    b.checkedInAt ? 1 : 0,
    payableTransaction(b)?.paymentStatus === 'PAID' ? 0 : 1,
    b.startTime.slice(0, 5)
  ]
  const sorted = [...filtered].sort((a, b) => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    if (ka[0] !== kb[0]) return ka[0] - kb[0]
    if (ka[1] !== kb[1]) return ka[1] - kb[1]
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0
  })

  return {
    bookings: sorted.map(presentDesk),
    search: q,
    today: translatedDate(jakartaDate(), 'l, d F Y')
  }
}

// ===== 2. Satu token =====

async function findByToken(token: string): Promise<CheckInRow> {
  const booking = await prismaClient.booking.findFirst({ where: { checkInToken: token }, include: CHECKIN_INCLUDE })
  if (!booking) throw new ResponseError(404, 'Booking tidak ditemukan')
  return booking
}

export async function checkInShow(token: string): Promise<CheckInDetailDto> {
  return presentDetail(await findByToken(token))
}

// ===== 3. Konfirmasi kehadiran =====

/**
 * Set checked_in_at + checked_in_by. TIDAK mengubah status (Laravel pun tidak): staff boleh menerima
 * pelanggan yang bayar tunai di meja — layar sudah menampilkan status pembayaran dengan lantang.
 */
export async function checkInStore(token: string, staffId: string): Promise<CheckInDetailDto> {
  const booking = await findByToken(token)

  if (booking.checkedInAt) {
    throw new ResponseError(409, `Booking ini sudah check-in pada ${formatInstant(booking.checkedInAt, 'd M Y H:i')}.`, 'CONFLICT')
  }

  await prismaClient.booking.update({ where: { id: booking.id }, data: { checkedInAt: now(), checkedInById: staffId } })

  return presentDetail(await findByToken(token))
}
