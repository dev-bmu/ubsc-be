import { Prisma } from '@prisma/client'
import { prismaClient } from '../application/database'
import { TX_OPTIONS } from '../application/transaction'
import { ResponseError } from '../error/response-error'
import { addDays, dateOnlyToString, jakartaDate, jakartaWallTimeToUtc } from '../utils/clock'
import { accurateCustomerId, customerNumber, rupiahPlain, transferTotal } from '../utils/money'
import { buildXlsx, XlsxCell } from '../utils/xlsx'
import { AccurateExportValidation } from '../validation/accurate-export-validation'
import { Validation } from '../validation/Validation'
import { accurateCashAccountNo } from './manual-payment-services'

// ============================================================================
// === Export Excel untuk Accurate (PRD tambahan 2026-09, bagian 6; catatan client 2026-09-28) ===
// ============================================================================
// Tiga berkas per rentang tanggal, mengikuti template impor Accurate dari finance, diimpor berurutan:
//   1. Pelanggan  — "Template Impor Pelanggan": semua pelanggan yang muncul di faktur rentang itu.
//                   Diimpor lebih dulu supaya CUSTOMER NO di faktur pasti ada di Accurate.
//   2. Faktur     — "Template" faktur penjualan: setiap transaksi yang DIBUAT di rentang itu, lunas
//                   maupun belum (keputusan client). Satu transaksi = satu faktur bernomor invoice
//                   UBSC (mencegah impor ganda, dan jadi rujukan PAYMENT NUMBER penerimaan).
//                   SATU baris item per faktur seharga total transfer (harga + biaya admin + kode
//                   unik) — client tidak mau biaya admin dan kode unik jadi baris item terpisah.
//   3. Penerimaan — "Template" penerimaan penjualan (pelunasan): setiap transaksi yang LUNAS (paidAt)
//                   di rentang itu, termasuk yang fakturnya dibuat sebelum rentang. Satu penerimaan
//                   per faktur, nomor `PP-<invoice>` (impor ulang ditolak Accurate), akun Kas/Bank dari
//                   setting `accurate_cash_account_no`, PAYING BANK selalu QRIS.
//
// ID pelanggan Accurate 'WEB.0001' (User.accurateSequence) terbit di sini, saat pelanggan pertama kali
// masuk export, sehingga counternya hanya berisi pelanggan yang benar-benar punya penjualan.

/** Kolom BRANCH faktur — ditetapkan client. */
export const ACCURATE_BRANCH = '1. UBSC - Jasa Cabang Olahraga'

/** Pelanggan generik untuk transaksi tanpa akun (walk-in FO). Counter pelanggan mulai dari 1, jadi 0 aman. */
export const WALK_IN_CUSTOMER = { id: 'WEB.0000', name: 'Pelanggan Umum (Walk-in)' }

/**
 * Nomor barang/jasa tetap di Accurate untuk membership manual (tanpa paket) — finance membuat item
 * dengan nomor PERSIS ini (sekali saja). Fasilitas dan paket memakai kolom accurateItemNo (tarif umum)
 * / accurateItemNoWarga (tarif Warga UB) masing-masing, dipilih dari Transaction.priceCategory.
 */
export const ACCURATE_ITEMS = { membership: 'UBSC-MEMBERSHIP' }

// prettier-ignore
const CUSTOMER_HEADER = [
  'Kategori', 'ID Pelanggan', 'Nama', 'Kontak', 'No. Telp. Bisnis', 'Handphone', 'Faximili', 'Email', 'Website', 'Mata uang Utama',
  'Saldo awal per tanggal', 'Saldo awal', 'Mata Uang Saldo', 'Kurs Saldo (Jika Asing)', 'No. Faktur Saldo', 'Cabang Saldo',
  'Syarat Bayar Saldo', 'Penjual Saldo', 'Keterangan', 'Karakter 1', 'Karakter 2', 'Karakter 3', 'Karakter 4', 'Karakter 5',
  'Karakter 6', 'Karakter 7', 'Karakter 8', 'Karakter 9', 'Karakter 10', 'Angka 1', 'Angka 2', 'Angka 3', 'Angka 4', 'Angka 5',
  'Angka 6', 'Angka 7', 'Angka 8', 'Angka 9', 'Angka 10', 'Tanggal 1', 'Tanggal 2', 'Alamat Penagihan', 'Kota', 'Provinsi',
  'Negara', 'Kode Pos', 'Alamat (Pengiriman)', 'Kota (Pengiriman)', 'Provinsi (Pengiriman)', 'Negara (Pengiriman)',
  'Kode Pos (Pengiriman)', 'Kategori Harga', 'Kategori Diskon', 'Syarat Pembayaran', 'Default Penjual', 'Default Penjual 2',
  'Default Penjual 3', 'Default Penjual 4', 'Default Penjual 5', 'Default Diskon (%)', 'Tipe Wajib Pajak', 'Nomor Wajib Pajak',
  'Nama Wajib Pajak', 'ID TKU', 'Tipe Transaksi', 'Detail Transaksi', 'NPPKP', 'Alamat (Pajak)', 'Kota (Pajak)',
  'Provinsi (Pajak)', 'Negara (Pajak)', 'Kode Pos (Pajak)', 'Dipakai di Cabang', 'Default Deskripsi', 'Konsinyasi',
  'Akun Piutang', 'Akun Uang Muka', 'Akun Penjualan', 'Akun Beban Pokok Penjualan ', 'Akun Retur Penjualan',
  'Akun Diskon Barang', 'Akun Diskon Penjualan', 'Default Total Faktur sudah termasuk Pajak', 'Nilai Umur Piutang (hari)',
  'Jumlah Limit Piutang', 'Limit Gabung ke Pelanggan', 'Catatan', 'Nomor VA', 'Non Aktif', 'Gudang Default'
]

// prettier-ignore
const INVOICE_HEADER = [
  'CUSTOMER NO', 'NUMBER', 'BRANCH', 'DATE', 'TAXABLE', 'ADDRESS', 'TOTAL INCLUDING VAT', 'TAX INVOICE NUMBER',
  'ADVANCE INVOICE', 'INVOICE DISCOUNT (%)', 'INVOICE DISCOUNT (Rp)', 'DESCRIPTION', 'PO NO', 'SHIPPING', 'SHIPPING DATE',
  'FOB', 'PAYMENT TERMS', 'DUE DATE', 'PAYING BANK', 'PAYMENT VALUE',
  ...Array.from({ length: 10 }, (_, i) => `CUSTOM CHARACTER ${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `CUSTOM NUMBER ${i + 1}`),
  'CUSTOM DATE 1', 'CUSTOM DATE 2', 'VA NUMBER', 'ACCOUNT RECEIVABLE NUMBER', 'PAYMENT WITH UNIQUE CODE', 'SUB COMPANY CODE',
  'ITEM:ITEM NO', 'ITEM:QUANTITY', 'ITEM:UNITPRICE', 'ITEM:UNIT', 'ITEM:WAREHOUSE NAME ', 'ITEM:NAME',
  'ITEM:ITEM DISCOUNT (%)', 'ITEM:ITEM DISCOUNT (RP)', 'ITEM:ITEM NOTES', 'ITEM:SALESMAN ID', 'ITEM:DEPT NAME', 'ITEM:PROJECT NO',
  ...Array.from({ length: 15 }, (_, i) => `ITEM:CUSTOM CHARACTER ${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ITEM:CUSTOM NUMBER ${i + 1}`),
  'ITEM:CUSTOM DATE 1', 'ITEM:CUSTOM DATE 2',
  ...Array.from({ length: 10 }, (_, i) => `ITEM:CUSTOM FINANCE CATEGORY ${i + 1}`),
  'ITEM:DELIVERY ORDER NO.', 'ITEM:SALES ORDER NO', 'EXPENSE:ACCOUNT NO', 'EXPENSE:EXPENSE VALUE', 'EXPENSE:EXPENSE NAME',
  'EXPENSE:EXPENSE NOTE', 'EXPENSE:DEPT NAME', 'EXPENSE:PROJECT NO',
  ...Array.from({ length: 10 }, (_, i) => `EXPENSE:FINANCIAL CATEGORY ${i + 1}`),
  'EXPENSE:SALES ORDER NO'
]

// prettier-ignore
const RECEIPT_HEADER = [
  'CUSTOMER NO', 'NUMBER', 'BRANCH', 'DATE', 'EXPENSE ACCOUNT NO', 'DESCRIPTION', 'PAYMENT TOTAL', 'PAYMENT NUMBER',
  'PAYMENT VALUE', 'PAYING BANK', 'DISCOUNT ACCOUNT NO', 'TOTAL DISCOUNT'
]

/** Satu baris template diisi per nama kolom; kolom lain kosong. Nama kolom salah = gagal keras. */
function templateRow(header: string[], values: Record<string, XlsxCell>): XlsxCell[] {
  const row: XlsxCell[] = new Array(header.length).fill(null)
  for (const [column, value] of Object.entries(values)) {
    const index = header.indexOf(column)
    if (index < 0) throw new Error(`Kolom template Accurate tidak dikenal: ${column}`)
    row[index] = value
  }
  return row
}

// ===== Data penjualan =====

const SALE_SELECT = {
  id: true,
  receiptSequence: true,
  invoiceNumber: true,
  createdAt: true,
  paidAt: true,
  amount: true,
  adminFee: true,
  uniqueCode: true,
  paymentStatus: true,
  priceCategory: true,
  user: { select: { id: true, name: true, email: true, phoneNumber: true, customerSequence: true, accurateSequence: true } },
  booking: {
    select: {
      customerName: true,
      bookingDate: true,
      startTime: true,
      endTime: true,
      bookingGroupId: true,
      facility: { select: { name: true, accurateItemNo: true, accurateItemNoWarga: true } }
    }
  },
  membership: {
    select: {
      customerName: true,
      startDate: true,
      endDate: true,
      membershipPlan: { select: { name: true, accurateItemNo: true, accurateItemNoWarga: true } }
    }
  }
} satisfies Prisma.TransactionSelect

type SaleRow = Prisma.TransactionGetPayload<{ select: typeof SALE_SELECT }>

function range(query: unknown): { from: string; to: string } {
  const v = Validation.validate(AccurateExportValidation.RANGE, query)
  const from = v.from ?? jakartaDate()
  return { from, to: v.to ?? from }
}

/**
 * 'created' = transaksi yang dibuat pada rentang WIB [from, to], lunas maupun belum (faktur, pelanggan).
 * 'paid' = transaksi yang lunas pada rentang itu (penerimaan). Batal/kedaluwarsa dan nominal 0 tidak dijual.
 */
function salesIn(from: string, to: string, by: 'created' | 'paid'): Promise<SaleRow[]> {
  const window = { gte: jakartaWallTimeToUtc(from, '00:00'), lt: jakartaWallTimeToUtc(addDays(to, 1), '00:00') }
  return prismaClient.transaction.findMany({
    where: {
      ...(by === 'paid' ? { paidAt: window, paymentStatus: 'PAID' } : { createdAt: window, paymentStatus: { in: ['PAID', 'UNPAID'] } }),
      amount: { gt: 0 },
      OR: [{ bookingId: { not: null } }, { membershipId: { not: null } }]
    },
    orderBy: by === 'paid' ? [{ paidAt: 'asc' }, { receiptSequence: 'asc' }] : [{ receiptSequence: 'asc' }],
    select: SALE_SELECT
  })
}

/**
 * Terbitkan WEB.#### untuk pemilik akun yang belum punya, urut tanggal daftar. Nomor dibagi di bawah
 * satu kunci baris system_settings: dua export bersamaan tidak boleh membagikan nomor yang sama.
 */
async function ensureAccurateIds(sales: SaleRow[]): Promise<void> {
  const userIds = [...new Set(sales.flatMap((s) => (s.user && s.user.accurateSequence === null ? [s.user.id] : [])))]
  if (userIds.length === 0) return

  // Baris kunci dibuat di luar transaksi: INSERT IGNORE di dalamnya memegang kunci S pada baris yang
  // sudah ada, dan dua export yang sama-sama naik ke FOR UPDATE akan saling deadlock.
  await prismaClient.$executeRaw`INSERT IGNORE INTO system_settings (id, \`key\`, value, createdAt, updatedAt) VALUES (UUID(), 'accurate_customer_lock', NULL, NOW(3), NOW(3))`
  await prismaClient.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM system_settings WHERE \`key\` = 'accurate_customer_lock' FOR UPDATE`
    const missing = await tx.user.findMany({
      where: { id: { in: userIds }, accurateSequence: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true }
    })
    const { _max } = await tx.user.aggregate({ _max: { accurateSequence: true } })
    let next = (_max.accurateSequence ?? 0) + 1
    for (const user of missing) await tx.user.update({ where: { id: user.id }, data: { accurateSequence: next++ } })
  }, TX_OPTIONS)

  const assigned = new Map(
    (await prismaClient.user.findMany({ where: { id: { in: userIds } }, select: { id: true, accurateSequence: true } })).map((u) => [
      u.id,
      u.accurateSequence
    ])
  )
  for (const sale of sales) if (sale.user && sale.user.accurateSequence === null) sale.user.accurateSequence = assigned.get(sale.user.id) ?? null
}

async function loadSales(query: unknown, by: 'created' | 'paid' = 'created'): Promise<{ from: string; to: string; sales: SaleRow[] }> {
  const { from, to } = range(query)
  const sales = await salesIn(from, to, by)
  await ensureAccurateIds(sales)
  return { from, to, sales }
}

function customerIdOf(sale: SaleRow): string {
  return sale.user?.accurateSequence ? accurateCustomerId(sale.user.accurateSequence) : WALK_IN_CUSTOMER.id
}

function customerNameOf(sale: SaleRow): string {
  return sale.user?.name ?? sale.membership?.customerName ?? sale.booking?.customerName ?? WALK_IN_CUSTOMER.name
}

function slash(date: string): string {
  const [y, m, d] = date.split('-')
  return `${d}/${m}/${y}`
}

/** Nomor item sesuai tarif transaksi — Accurate memakai item berbeda untuk harga umum dan Warga UB. */
function itemFor(sale: SaleRow, item: { accurateItemNo: string | null; accurateItemNoWarga: string | null }): string | null {
  return sale.priceCategory === 'warga_ub' ? item.accurateItemNoWarga : item.accurateItemNo
}

/** Baris utama faktur: fasilitas atau paket membership. null = nomor item Accurate belum diisi. */
function mainItem(sale: SaleRow): { itemNo: string | null; name: string; label: string; notes: string } {
  const tariff = sale.priceCategory === 'warga_ub' ? ' (Warga UB)' : ' (umum)'
  if (sale.booking) {
    const b = sale.booking
    const when = `${slash(dateOnlyToString(b.bookingDate))} ${b.startTime}-${b.endTime}`
    return {
      itemNo: itemFor(sale, b.facility),
      name: b.facility.name,
      label: `Fasilitas ${b.facility.name}${tariff}`,
      notes: b.bookingGroupId ? `Paket sesi, mulai ${when}` : when
    }
  }
  const m = sale.membership as NonNullable<SaleRow['membership']>
  const plan = m.membershipPlan
  return {
    itemNo: plan ? itemFor(sale, plan) : ACCURATE_ITEMS.membership,
    name: `Membership ${plan?.name ?? 'Gym (manual)'}`,
    label: `Paket membership ${plan?.name ?? '(manual)'}${tariff}`,
    notes: `${slash(dateOnlyToString(m.startDate))} - ${slash(dateOnlyToString(m.endDate))}${sale.user ? ` · ${customerNumber(sale.user.customerSequence)}` : ''}`
  }
}

// ===== 1. Pelanggan =====

export async function accurateCustomerExport(query: unknown): Promise<{ filename: string; buffer: Buffer }> {
  const { from, to, sales } = await loadSales(query)

  const rows = new Map<string, XlsxCell[]>()
  for (const sale of sales) {
    const id = customerIdOf(sale)
    if (rows.has(id)) continue
    const user = sale.user
    rows.set(
      id,
      templateRow(CUSTOMER_HEADER, {
        'ID Pelanggan': id,
        Nama: user?.name ?? WALK_IN_CUSTOMER.name,
        Handphone: user?.phoneNumber ?? null,
        Email: user?.email ?? null,
        'Mata uang Utama': 'IDR',
        Catatan: user ? `No. member ${customerNumber(user.customerSequence)}` : 'Transaksi tanpa akun (walk-in meja depan)'
      })
    )
  }

  return {
    filename: `accurate-pelanggan-${suffix(from, to)}.xlsx`,
    buffer: buildXlsx('Template Impor Pelanggan', CUSTOMER_HEADER, [...rows.values()])
  }
}

// ===== 2. Faktur penjualan =====

export async function accurateInvoiceExport(query: unknown): Promise<{ filename: string; buffer: Buffer }> {
  const { from, to, sales } = await loadSales(query)

  // Nomor item kosong = impor Accurate menolak baris itu. Lebih baik berhenti di sini dengan daftar
  // yang harus diisi daripada finance menemukan faktur yang hilang setelah impor.
  const missing = [...new Set(sales.map(mainItem).flatMap((item) => (item.itemNo ? [] : [item.label])))]
  if (missing.length > 0) {
    const message = `Nomor item Accurate belum diisi untuk: ${missing.join(', ')}. Isi di menu Fasilitas / Paket Membership.`
    throw new ResponseError(422, message, 'VALIDATION_ERROR', { accurateItemNo: [message] })
  }

  const rows = sales.map((sale) => {
    const item = mainItem(sale)
    const unpaid = sale.paymentStatus !== 'PAID'
    // Rincian total tetap tercatat di catatan item supaya finance bisa menelusurinya.
    const breakdown = `Harga ${rupiahPlain(sale.amount)} + admin ${rupiahPlain(sale.adminFee)} + kode unik ${rupiahPlain(sale.uniqueCode ?? 0)}`
    return templateRow(INVOICE_HEADER, {
      'CUSTOMER NO': customerIdOf(sale),
      NUMBER: sale.invoiceNumber,
      BRANCH: ACCURATE_BRANCH,
      DATE: { date: jakartaDate(sale.createdAt) },
      DESCRIPTION: `${item.name} - ${customerNameOf(sale)}${unpaid ? ' (belum lunas)' : ''}`,
      'ITEM:ITEM NO': item.itemNo,
      'ITEM:QUANTITY': 1,
      // Satu baris seharga total transfer — biaya admin dan kode unik tidak dipisah (keputusan client).
      'ITEM:UNITPRICE': transferTotal(sale),
      'ITEM:NAME': item.name,
      'ITEM:ITEM NOTES': `${item.notes} · ${breakdown}`
    })
  })

  return { filename: `accurate-faktur-${suffix(from, to)}.xlsx`, buffer: buildXlsx('Template', INVOICE_HEADER, rows) }
}

// ===== 3. Penerimaan penjualan =====

export async function accurateReceiptExport(query: unknown): Promise<{ filename: string; buffer: Buffer }> {
  // Akun Kas/Bank wajib di template; tanpa itu Accurate menolak seluruh berkas.
  const account = await accurateCashAccountNo()
  if (!account) {
    const message = 'Kode akun Kas/Bank Accurate belum diisi. Isi di menu Pembayaran > Pengaturan Pembayaran.'
    throw new ResponseError(422, message, 'VALIDATION_ERROR', { accurateCashAccountNo: [message] })
  }
  const { from, to, sales } = await loadSales(query, 'paid')

  // Satu penerimaan per faktur (tanpa baris lanjutan multi-faktur). Total dibayar = total transfer faktur.
  const rows = sales.map((sale) => {
    const total = transferTotal(sale)
    return templateRow(RECEIPT_HEADER, {
      'CUSTOMER NO': customerIdOf(sale),
      NUMBER: `PP-${sale.invoiceNumber}`,
      BRANCH: ACCURATE_BRANCH,
      DATE: { date: jakartaDate(sale.paidAt as Date) },
      'EXPENSE ACCOUNT NO': account,
      DESCRIPTION: `Pelunasan ${sale.invoiceNumber} - ${mainItem(sale).name} - ${customerNameOf(sale)}`,
      'PAYMENT TOTAL': total,
      'PAYMENT NUMBER': sale.invoiceNumber,
      'PAYMENT VALUE': total,
      'PAYING BANK': 'QRIS'
    })
  })

  return { filename: `accurate-penerimaan-${suffix(from, to)}.xlsx`, buffer: buildXlsx('Template', RECEIPT_HEADER, rows) }
}

function suffix(from: string, to: string): string {
  return from === to ? from : `${from}_${to}`
}
