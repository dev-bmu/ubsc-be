import { Prisma } from '@prisma/client'
import type { InvoiceDto } from '../../shared/contracts'
import { prismaClient } from '../application/database'
import { LANDING_URL } from '../config'
import { ResponseError } from '../error/response-error'
import { dateOnlyToString, jakartaDate, jakartaHm, translatedDate } from '../utils/clock'
import { invoicePage, InvoiceView } from '../utils/mail-templates'
import { customerNumber, transferTotal } from '../utils/money'
import { bankAccount, groupWhere, qrisSetting } from './manual-payment-services'

// ============================================================================
// === Invoice / kuitansi per transaksi (PRD tambahan 2026-09, catatan client 2026-09-28) ===
// ============================================================================
// Satu transaksi = satu invoice bernomor 'UBSC-X-2026-0001' (Transaction.invoiceNumber). Dipakai pelanggan (riwayat
// pembayaran), FO (meja depan), dan email tagihan membership; HTML-nya disusun mail-templates.ts.

const landing = (path: string) => `${LANDING_URL.replace(/\/+$/, '')}${path}`

/** Paket banyak sesi tetap satu invoice; daftar sesinya dipotong supaya muat satu halaman. */
const MAX_SESSION_LINES = 12

const INVOICE_SELECT = {
  id: true,
  userId: true,
  invoiceNumber: true,
  amount: true,
  adminFee: true,
  uniqueCode: true,
  paymentStatus: true,
  verificationStatus: true,
  createdAt: true,
  paidAt: true,
  user: { select: { name: true, email: true, phoneNumber: true, customerSequence: true } },
  membership: {
    select: { id: true, customerName: true, startDate: true, endDate: true, membershipPlan: { select: { name: true } } }
  },
  booking: { select: { id: true, bookingGroupId: true, customerName: true, customerPhone: true, facility: { select: { name: true } } } }
} satisfies Prisma.TransactionSelect

type InvoiceRow = Prisma.TransactionGetPayload<{ select: typeof INVOICE_SELECT }>

function wibStamp(instant: Date): string {
  return `${translatedDate(jakartaDate(instant), 'd F Y')}, ${jakartaHm(instant)} WIB`
}

function statusOf(t: InvoiceRow): InvoiceView['status'] {
  if (t.paymentStatus === 'PAID') return 'paid'
  if (t.paymentStatus !== 'UNPAID') return 'void'
  return t.verificationStatus === 'awaiting' ? 'awaiting' : 'unpaid'
}

async function itemOf(t: InvoiceRow, status: InvoiceView['status']): Promise<InvoiceView['item']> {
  if (t.membership) {
    const period = `${translatedDate(dateOnlyToString(t.membership.startDate), 'd F Y')} – ${translatedDate(dateOnlyToString(t.membership.endDate), 'd F Y')}`
    return {
      name: `Membership ${t.membership.membershipPlan?.name ?? 'Gym'}`,
      // Tanggal mulai membership yang belum lunas ditetapkan ulang saat pembayarannya disetujui.
      lines: [`Masa aktif ${period}${status === 'unpaid' || status === 'awaiting' ? ' (dihitung ulang saat lunas)' : ''}`]
    }
  }
  if (t.booking) {
    const sessions = await prismaClient.booking.findMany({
      where: groupWhere(t.booking),
      orderBy: { startsAt: 'asc' },
      select: { bookingDate: true, startTime: true, endTime: true, facilityUnit: { select: { name: true } } }
    })
    const lines = sessions
      .slice(0, MAX_SESSION_LINES)
      .map(
        (s) =>
          `${translatedDate(dateOnlyToString(s.bookingDate), 'l, d F Y')} · ${s.startTime} – ${s.endTime}${s.facilityUnit ? ` · ${s.facilityUnit.name}` : ''}`
      )
    if (sessions.length > MAX_SESSION_LINES) lines.push(`… dan ${sessions.length - MAX_SESSION_LINES} sesi lain`)
    return { name: t.booking.facility.name, lines }
  }
  return { name: 'Transaksi', lines: [] }
}

async function loadInvoice(transactionId: string): Promise<{ userId: string | null; view: InvoiceView }> {
  const t = await prismaClient.transaction.findUnique({ where: { id: transactionId }, select: INVOICE_SELECT })
  if (!t) throw new ResponseError(404, 'Transaksi tidak ditemukan')

  const status = statusOf(t)
  const open = status === 'unpaid' || status === 'awaiting'
  const [account, qris] = status === 'unpaid' ? await Promise.all([bankAccount(), qrisSetting()]) : [null, null]
  const payPath = t.membership ? `/membership/${t.membership.id}/pembayaran` : t.booking ? `/booking/${t.booking.id}/pembayaran` : null

  return {
    userId: t.userId,
    view: {
      number: t.invoiceNumber,
      status,
      issuedAt: wibStamp(t.createdAt),
      paidAt: t.paidAt ? wibStamp(t.paidAt) : null,
      customer: {
        name: t.user?.name ?? t.membership?.customerName ?? t.booking?.customerName ?? 'Tamu',
        email: t.user?.email ?? null,
        phone: t.user?.phoneNumber ?? t.booking?.customerPhone ?? null,
        memberNumber: t.membership && t.user ? customerNumber(t.user.customerSequence) : null
      },
      item: await itemOf(t, status),
      amount: t.amount,
      adminFee: t.adminFee,
      uniqueCode: t.uniqueCode ?? 0,
      total: transferTotal(t),
      bank: account?.bank && account.accountNumber ? account : null,
      qris: qris ? { imageUrl: landing(qris.imageUrl), merchantName: qris.merchantName } : null,
      // Tamu tanpa akun tidak bisa membuka halaman bayar landing.
      payUrl: open && t.userId && payPath ? landing(payPath) : null
    }
  }
}

/** Isi email tagihan membership meja depan. */
export async function invoiceView(transactionId: string): Promise<InvoiceView> {
  return (await loadInvoice(transactionId)).view
}

/** GET /api/customer/transactions/:transactionId/invoice — hanya pemilik transaksinya. */
export async function customerInvoice(userId: string, transactionId: string): Promise<InvoiceDto> {
  const { userId: ownerId, view } = await loadInvoice(transactionId)
  if (ownerId !== userId) throw new ResponseError(404, 'Transaksi tidak ditemukan')
  return { number: view.number, html: invoicePage(view) }
}

/** GET /api/admin/payments/:transactionId/invoice — dicetak FO di meja depan. */
export async function staffInvoice(transactionId: string): Promise<InvoiceDto> {
  const { view } = await loadInvoice(transactionId)
  return { number: view.number, html: invoicePage(view) }
}
