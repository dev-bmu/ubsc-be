import { MAIL_FROM_NAME } from '../config'
import { translatedDate } from './clock'
import { rupiahPlain } from './money'
import type { MailInput } from './mailer'

// ============================================================================
// === Template email ===
// ============================================================================
// Empat email sama seperti Laravel (verifikasi email, reset password, pembayaran disetujui,
// pembayaran ditolak), ditambah membership aktif (PRD tambahan 2026-09, tahap D).
//
// HTML-nya sengaja sederhana: tabel, inline style, tanpa gambar eksternal.
// Klien email bukan browser — Gmail membuang <style>, Outlook merender lewat
// mesin Word, dan flex/grid tidak bisa diandalkan di mana pun. Setiap email
// juga membawa versi text/plain, karena email HTML-saja lebih sering ditandai
// spam.

const BRAND = '#0B1E3B' // navy-900, sama dengan palet landing

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface LayoutInput {
  heading: string
  bodyHtml: string
  ctaLabel?: string
  ctaUrl?: string
  footerNote?: string
  /** true bila isi email mengajak membalas; baris "mohon tidak membalas" di kaki dihilangkan. */
  replyable?: boolean
  /** Diisi = halaman cetak di browser, bukan email: judul tab, tombol cetak, tanpa kaki "email otomatis". */
  pageTitle?: string
}

function layout(input: LayoutInput): string {
  const button = input.ctaUrl
    ? `<tr><td style="padding:24px 0 8px 0">
         <a href="${input.ctaUrl}" style="background:${BRAND};color:#ffffff;display:inline-block;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none">${escapeHtml(input.ctaLabel ?? 'Buka')}</a>
       </td></tr>
       <tr><td style="padding:8px 0;color:#5b6472;font-size:12px;line-height:18px">
         Bila tombol tidak bekerja, salin tautan ini ke browser:<br>
         <span style="color:${BRAND};word-break:break-all">${escapeHtml(input.ctaUrl)}</span>
       </td></tr>`
    : ''

  const footerNote = input.footerNote
    ? `<tr><td style="padding:16px 0 0 0;color:#5b6472;font-size:12px;line-height:18px">${input.footerNote}</td></tr>`
    : ''

  const page = input.pageTitle
    ? {
        head: `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.pageTitle)}</title>
<style>@media print{.no-print{display:none!important}body{background:#ffffff!important;padding:0!important}}</style></head>`,
        toolbar: `<div class="no-print" style="max-width:560px;margin:0 auto 12px;text-align:right">
  <button type="button" onclick="window.print()" style="background:${BRAND};color:#ffffff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer">Cetak / Simpan PDF</button>
</div>`,
        closing: `Dokumen ini dibuat otomatis oleh ${escapeHtml(MAIL_FROM_NAME)}.`
      }
    : null

  return `<!doctype html>
<html lang="id">${page?.head ?? ''}<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a2230">
${page?.toolbar ?? ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
  <tr><td style="padding-bottom:8px;color:${BRAND};font-size:13px;font-weight:700;letter-spacing:1px">UB SPORT CENTER</td></tr>
  <tr><td style="font-size:20px;font-weight:700;padding-bottom:12px">${escapeHtml(input.heading)}</td></tr>
  <tr><td style="font-size:14px;line-height:22px;color:#3a4453">${input.bodyHtml}</td></tr>
  ${button}
  ${footerNote}
  <tr><td style="padding-top:24px;border-top:1px solid #e6e8ec;color:#8b93a1;font-size:12px;line-height:18px">
    ${page?.closing ?? `Email ini dikirim otomatis oleh ${escapeHtml(MAIL_FROM_NAME)}.${input.replyable ? '' : ' Mohon tidak membalas email ini.'}`}
  </td></tr>
</table>
</body></html>`
}

// ===== 1. Verifikasi email =====

export function verifyEmailTemplate(input: { to: string; name: string; url: string; expiresInHours: number }): MailInput {
  const heading = 'Verifikasi alamat email Anda'
  const body = `Halo ${escapeHtml(input.name)},<br><br>
    Terima kasih sudah mendaftar di UB Sport Center. Satu langkah lagi: klik tombol di bawah untuk memverifikasi alamat email Anda.`

  return {
    to: input.to,
    subject: 'Verifikasi email — UB Sport Center',
    template: 'verify-email',
    html: layout({
      heading,
      bodyHtml: body,
      ctaLabel: 'Verifikasi Email',
      ctaUrl: input.url,
      footerNote: `Tautan ini berlaku ${input.expiresInHours} jam. Bila Anda tidak merasa mendaftar, abaikan saja email ini.`
    }),
    text: `Halo ${input.name},\n\nVerifikasi alamat email Anda lewat tautan berikut:\n${input.url}\n\nTautan berlaku ${input.expiresInHours} jam. Bila Anda tidak merasa mendaftar, abaikan email ini.\n\n— ${MAIL_FROM_NAME}`
  }
}

// ===== 2. Reset password =====

export function resetPasswordTemplate(input: { to: string; name: string; url: string; expiresInMinutes: number }): MailInput {
  const heading = 'Atur ulang password Anda'
  const body = `Halo ${escapeHtml(input.name)},<br><br>
    Kami menerima permintaan untuk mengatur ulang password akun Anda. Klik tombol di bawah untuk membuat password baru.`

  return {
    to: input.to,
    subject: 'Atur ulang password — UB Sport Center',
    template: 'reset-password',
    html: layout({
      heading,
      bodyHtml: body,
      ctaLabel: 'Atur Ulang Password',
      ctaUrl: input.url,
      footerNote: `Tautan ini berlaku ${input.expiresInMinutes} menit dan hanya bisa dipakai sekali. Bila Anda tidak meminta ini, abaikan email ini — password Anda tidak berubah.`
    }),
    text: `Halo ${input.name},\n\nAtur ulang password akun Anda lewat tautan berikut:\n${input.url}\n\nTautan berlaku ${input.expiresInMinutes} menit dan hanya bisa dipakai sekali.\nBila Anda tidak meminta ini, abaikan email ini — password Anda tidak berubah.\n\n— ${MAIL_FROM_NAME}`
  }
}

// ===== 3. Pembayaran disetujui =====
// Isi mengikuti app/Mail/PaymentApproved.php + emails/payment-approved.blade.php kata per kata.
// Dikirim setelah approve() commit (payment-verification-services).

interface MailBooking {
  facilityName: string
  unitName?: string | null
  /** "YYYY-MM-DD" */
  date: string
  startTime: string
  endTime: string
}

/** Carbon translatedFormat('l, d F Y') + "HH:mm – HH:mm", sama dengan kedua Mailable Laravel. */
function bookingWhen(booking: MailBooking): { date: string; time: string } {
  return { date: translatedDate(booking.date, 'l, d F Y'), time: `${booking.startTime.slice(0, 5)} – ${booking.endTime.slice(0, 5)}` }
}

export function paymentApprovedTemplate(input: {
  to: string
  receiptNumber: string
  /**
   * Nominal yang ditransfer (harga + biaya admin + kode unik). Laravel memakai $transaction->amount;
   * sejak ada biaya admin, angka itu tidak lagi sama dengan yang dikirim pelanggan.
   */
  amount: number
  booking: (MailBooking & { url: string }) | null
}): MailInput {
  const amount = rupiahPlain(input.amount)
  const when = input.booking ? bookingWhen(input.booking) : null
  const unit = input.booking?.unitName ? ` · ${escapeHtml(input.booking.unitName)}` : ''

  const bookingHtml =
    input.booking && when
      ? `<br><br><strong>${escapeHtml(input.booking.facilityName)}</strong>${unit}<br>
    ${escapeHtml(when.date)} · ${escapeHtml(when.time)}<br><br>
    Saat datang, tunjukkan QR tiket di halaman reservasi kepada petugas untuk check-in.`
      : ''

  const bookingText =
    input.booking && when
      ? `\n\n${input.booking.facilityName}${input.booking.unitName ? ` · ${input.booking.unitName}` : ''}\n${when.date} · ${when.time}\n\nSaat datang, tunjukkan QR tiket di halaman reservasi kepada petugas untuk check-in.\n\nLihat Tiket & QR: ${input.booking.url}`
      : ''

  return {
    to: input.to,
    subject: `Pembayaran ${input.receiptNumber} dikonfirmasi — UB Sport Center`,
    template: 'payment-approved',
    html: layout({
      heading: 'Pembayaran dikonfirmasi',
      bodyHtml: `Transfer untuk <strong>${escapeHtml(input.receiptNumber)}</strong> sebesar <strong>${escapeHtml(amount)}</strong> sudah kami terima dan reservasi Anda kini <strong>terkonfirmasi</strong>.${bookingHtml}`,
      ctaLabel: input.booking ? 'Lihat Tiket & QR' : undefined,
      ctaUrl: input.booking?.url,
      footerNote: `Sampai jumpa di lapangan,<br>${escapeHtml(MAIL_FROM_NAME)}`
    }),
    text: `Pembayaran dikonfirmasi\n\nTransfer untuk ${input.receiptNumber} sebesar ${amount} sudah kami terima dan reservasi Anda kini terkonfirmasi.${bookingText}\n\nSampai jumpa di lapangan,\n${MAIL_FROM_NAME}`
  }
}

// ===== 4. Bukti transfer ditolak =====
// Isi mengikuti app/Mail/PaymentRejected.php + emails/payment-rejected.blade.php kata per kata.

export function paymentRejectedTemplate(input: {
  to: string
  receiptNumber: string
  reason: string
  booking: MailBooking | null
  /** Tombol "Pesan Ulang" — halaman /booking landing. */
  bookingUrl: string
}): MailInput {
  const when = input.booking ? bookingWhen(input.booking) : null

  const bookingHtml =
    input.booking && when
      ? `<br><br>Reservasi <strong>${escapeHtml(input.booking.facilityName)}</strong> pada ${escapeHtml(when.date)} · ${escapeHtml(when.time)} telah dibatalkan dan slotnya dilepas kembali.`
      : ''
  const bookingText =
    input.booking && when
      ? `\n\nReservasi ${input.booking.facilityName} pada ${when.date} · ${when.time} telah dibatalkan dan slotnya dilepas kembali.`
      : ''

  const closing = 'Jika Anda yakin dana sudah terkirim, balas email ini atau hubungi kami — kami akan bantu cek mutasinya. Untuk memesan kembali:'

  return {
    to: input.to,
    subject: `Bukti transfer ${input.receiptNumber} ditolak — UB Sport Center`,
    template: 'payment-rejected',
    html: layout({
      heading: 'Bukti transfer ditolak',
      bodyHtml: `Bukti transfer untuk <strong>${escapeHtml(input.receiptNumber)}</strong> tidak dapat kami cocokkan dengan mutasi rekening.<br><br>
    <strong>Alasan:</strong> ${escapeHtml(input.reason)}${bookingHtml}<br><br>
    ${escapeHtml(closing)}`,
      ctaLabel: 'Pesan Ulang',
      ctaUrl: input.bookingUrl,
      footerNote: `Terima kasih,<br>${escapeHtml(MAIL_FROM_NAME)}`,
      // Email ini justru MENGAJAK pelanggan membalas — baris "mohon tidak membalas" akan membantahnya.
      replyable: true
    }),
    text: `Bukti transfer ditolak\n\nBukti transfer untuk ${input.receiptNumber} tidak dapat kami cocokkan dengan mutasi rekening.\n\nAlasan: ${input.reason}${bookingText}\n\n${closing}\n${input.bookingUrl}\n\nTerima kasih,\n${MAIL_FROM_NAME}`
  }
}

// ===== 5. Membership aktif (tahap D) =====
// Dikirim saat membership mulai berlaku bagi pemilik akun: transfer online disetujui, atau dibuat /
// diperpanjang di meja depan. Isinya nomor member + tautan ke kartu di dashboard — kartu yang dipindai
// petugas saat masuk gym.

export function membershipActiveTemplate(input: {
  to: string
  name: string
  planName: string
  /** 'YYYY-MM-DD'. */
  startDate: string
  endDate: string
  customerNumber: string
  /** Pembayaran yang baru diterima; null bila tidak ada yang perlu dikonfirmasi (mis. nominal 0). */
  payment: { receiptNumber: string; total: number } | null
  cardUrl: string
}): MailInput {
  const start = translatedDate(input.startDate, 'd F Y')
  const end = translatedDate(input.endDate, 'd F Y')
  const paidHtml = input.payment
    ? `Pembayaran <strong>${escapeHtml(input.payment.receiptNumber)}</strong> sebesar <strong>${escapeHtml(rupiahPlain(input.payment.total))}</strong> sudah kami terima.<br><br>`
    : ''
  const paidText = input.payment ? `Pembayaran ${input.payment.receiptNumber} sebesar ${rupiahPlain(input.payment.total)} sudah kami terima.\n\n` : ''
  const howTo =
    'Saat masuk gym, tunjukkan kartu member dari menu Membership Gym di website agar petugas memindai QR-nya, atau sebutkan nomor member Anda. Pastikan foto wajah di profil Anda sudah disetujui.'

  return {
    to: input.to,
    subject: `Membership ${input.planName} — ${input.customerNumber} — UB Sport Center`,
    template: 'membership-active',
    html: layout({
      heading: 'Membership Anda siap dipakai',
      bodyHtml: `Halo ${escapeHtml(input.name)},<br><br>${paidHtml}Membership <strong>${escapeHtml(input.planName)}</strong> Anda berlaku <strong>${escapeHtml(start)} – ${escapeHtml(end)}</strong>.<br><br>
    Nomor member: <strong style="font-size:18px;letter-spacing:1px">${escapeHtml(input.customerNumber)}</strong><br><br>
    ${escapeHtml(howTo)}`,
      ctaLabel: 'Lihat Kartu Member',
      ctaUrl: input.cardUrl,
      footerNote: `Selamat berlatih,<br>${escapeHtml(MAIL_FROM_NAME)}`
    }),
    text: `Halo ${input.name},\n\n${paidText}Membership ${input.planName} Anda berlaku ${start} – ${end}.\n\nNomor member: ${input.customerNumber}\n\n${howTo}\n\nLihat kartu member: ${input.cardUrl}\n\nSelamat berlatih,\n${MAIL_FROM_NAME}`
  }
}

// ===== 6. Invoice (tagihan / kuitansi) =====
// Satu isi untuk tiga tempat: email tagihan membership meja depan, halaman cetak pelanggan (riwayat
// pembayaran), dan halaman cetak FO. Karena ikut dikirim sebagai email, bentuknya tetap tabel + inline
// style. "Unduh" = tombol cetak browser → Simpan sebagai PDF; tidak ada pustaka PDF di server.

export interface InvoiceView {
  /** Nomor invoice 'UBSC-X-2026-0001' — juga nomor faktur di export Accurate. */
  number: string
  status: 'paid' | 'awaiting' | 'unpaid' | 'void'
  /** Sudah diformat WIB, mis. '28 September 2026, 07:47 WIB'. */
  issuedAt: string
  paidAt: string | null
  customer: { name: string; email: string | null; phone: string | null; memberNumber: string | null }
  item: { name: string; lines: string[] }
  amount: number
  adminFee: number
  uniqueCode: number
  total: number
  /** Rekening tujuan — hanya untuk tagihan yang belum dibayar DAN bila QRIS belum diunggah. */
  bank: { bank: string; accountNumber: string; accountHolder: string } | null
  /** QRIS statis merchant (URL gambar ABSOLUT, supaya tampil di email) — untuk tagihan belum dibayar. */
  qris: { imageUrl: string; merchantName: string | null } | null
  /** Halaman bayar/unggah bukti di landing; null untuk tamu tanpa akun atau yang sudah selesai. */
  payUrl: string | null
}

const INVOICE_STATUS: Record<InvoiceView['status'], { label: string; color: string }> = {
  paid: { label: 'LUNAS', color: '#059669' },
  awaiting: { label: 'MENUNGGU VERIFIKASI', color: '#0284c7' },
  unpaid: { label: 'BELUM DIBAYAR', color: '#d97706' },
  void: { label: 'DIBATALKAN', color: '#6b7280' }
}

function invoiceHtml(v: InvoiceView): string {
  const status = INVOICE_STATUS[v.status]
  const muted = 'color:#5b6472;font-size:12px'
  const line = 'border-top:1px solid #e6e8ec'
  const money = (label: string, amount: number) =>
    `<tr><td style="padding:4px 0;color:#5b6472">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right">${escapeHtml(rupiahPlain(amount))}</td></tr>`
  const customer = [v.customer.name, v.customer.memberNumber && `No. member ${v.customer.memberNumber}`, v.customer.email, v.customer.phone]
    .filter((s): s is string => Boolean(s))
    .map(escapeHtml)
    .join('<br>')
  // QRIS statis: pelanggan memindai lalu mengetik nominal sendiri (keputusan client 2026-10-01).
  const qris = v.qris
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px">
  <tr><td style="padding:16px;text-align:center">
    <img src="${escapeHtml(v.qris.imageUrl)}" alt="QRIS ${escapeHtml(v.qris.merchantName ?? 'UB Sport Center')}" width="240" style="display:block;margin:0 auto 10px;width:240px;max-width:100%;height:auto;background:#ffffff;border-radius:8px">
    ${v.qris.merchantName ? `<div style="font-size:12px;color:#7c2d12;margin-bottom:8px">QRIS a.n. <strong>${escapeHtml(v.qris.merchantName)}</strong></div>` : ''}
    <div style="font-size:13px;line-height:20px;color:#7c2d12;text-align:left">
      Scan QRIS ini dengan aplikasi m-banking atau e-wallet, lalu ketik nominal <strong>tepat ${escapeHtml(rupiahPlain(v.total))}</strong>
      (sampai 3 digit terakhir — kode unik membuat pembayaran Anda bisa dicocokkan). Setelah bayar, unggah bukti lewat tautan
      pembayaran atau tunjukkan ke petugas.
    </div>
  </td></tr>
</table>`
    : ''
  const bank =
    !v.qris && v.bank
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px">
  <tr><td style="padding:14px 16px;font-size:13px;line-height:20px;color:#7c2d12">
    Transfer <strong>tepat ${escapeHtml(rupiahPlain(v.total))}</strong> (sampai 3 digit terakhir) ke<br>
    <strong>${escapeHtml(v.bank.bank)} ${escapeHtml(v.bank.accountNumber)}</strong> a.n. ${escapeHtml(v.bank.accountHolder)}<br>
    Kode unik membuat transfer Anda bisa dicocokkan. Setelah transfer, unggah bukti lewat tautan pembayaran atau tunjukkan ke petugas.
  </td></tr>
</table>`
      : ''

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#1a2230">
  <tr>
    <td style="padding-bottom:14px;vertical-align:top"><strong>${escapeHtml(v.number)}</strong><br>
      <span style="${muted}">Diterbitkan ${escapeHtml(v.issuedAt)}${v.paidAt ? `<br>Dibayar ${escapeHtml(v.paidAt)}` : ''}</span></td>
    <td style="padding-bottom:14px;text-align:right;vertical-align:top">
      <span style="display:inline-block;padding:4px 10px;border:1px solid ${status.color};border-radius:999px;color:${status.color};font-size:11px;font-weight:700;letter-spacing:1px">${status.label}</span></td>
  </tr>
  <tr><td colspan="2" style="padding:12px 0 4px;${line};${muted}">Ditagihkan kepada</td></tr>
  <tr><td colspan="2" style="padding-bottom:12px;line-height:20px">${customer}</td></tr>
  <tr><td colspan="2" style="padding:12px 0 2px;${line};font-weight:700">${escapeHtml(v.item.name)}</td></tr>
  <tr><td colspan="2" style="padding-bottom:10px;${muted};line-height:18px">${v.item.lines.map(escapeHtml).join('<br>')}</td></tr>
  ${money('Harga', v.amount)}
  ${v.adminFee > 0 ? money('Biaya admin', v.adminFee) : ''}
  ${v.uniqueCode > 0 ? money('Kode unik', v.uniqueCode) : ''}
  <tr><td style="padding:10px 0;${line};font-weight:700">Total</td>
    <td style="padding:10px 0;${line};text-align:right;font-weight:700;font-size:18px">${escapeHtml(rupiahPlain(v.total))}</td></tr>
</table>${qris}${bank}`
}

/** Halaman cetak invoice (dibuka frontend di tab baru). */
export function invoicePage(v: InvoiceView): string {
  return layout({
    heading: v.status === 'paid' ? 'Kuitansi Pembayaran' : 'Invoice',
    bodyHtml: invoiceHtml(v),
    ctaLabel: v.payUrl ? 'Bayar / Unggah Bukti' : undefined,
    ctaUrl: v.payUrl ?? undefined,
    pageTitle: `${v.number} — UB Sport Center`
  })
}

/**
 * Tagihan membership yang didaftarkan petugas di meja depan: membership baru aktif setelah transfernya
 * ditandai lunas. Email ini salinan — invoice yang sama tampil di layar FO dan di dashboard pelanggan,
 * jadi email yang tidak sampai tidak menghentikan apa pun.
 */
export function membershipInvoiceTemplate(input: { to: string; name: string; invoice: InvoiceView }): MailInput {
  const v = input.invoice
  const bank = v.qris
    ? `\nBayar lewat QRIS: scan QR di email ini atau di halaman pembayaran, lalu ketik nominal tepat ${rupiahPlain(v.total)}.`
    : v.bank
      ? `\nTransfer tepat ${rupiahPlain(v.total)} ke ${v.bank.bank} ${v.bank.accountNumber} a.n. ${v.bank.accountHolder}.`
      : ''
  return {
    to: input.to,
    subject: `Tagihan ${v.number} — ${v.item.name} — UB Sport Center`,
    template: 'membership-invoice',
    html: layout({
      heading: 'Tagihan membership',
      bodyHtml: `Halo ${escapeHtml(input.name)},<br><br>Membership Anda sudah didaftarkan petugas dan <strong>aktif setelah pembayaran diterima</strong>.<br><br>${invoiceHtml(v)}`,
      ctaLabel: v.payUrl ? 'Bayar / Unggah Bukti' : undefined,
      ctaUrl: v.payUrl ?? undefined,
      footerNote: `Terima kasih,<br>${escapeHtml(MAIL_FROM_NAME)}`
    }),
    text: `Halo ${input.name},\n\nMembership Anda sudah didaftarkan petugas dan aktif setelah pembayaran diterima.\n\n${v.number}\n${v.item.name}\n${v.item.lines.join('\n')}\nTotal: ${rupiahPlain(v.total)}${bank}${v.payUrl ? `\n\nBayar / unggah bukti: ${v.payUrl}` : ''}\n\nTerima kasih,\n${MAIL_FROM_NAME}`
  }
}
