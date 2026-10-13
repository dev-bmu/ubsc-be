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
// Berasal dari app/Mail/PaymentApproved.php; jadwal kini kotak menonjol yang memuat SEMUA sesi paket
// (Laravel hanya menyebut lead). Dikirim setelah approve() commit (payment-verification-services).

interface MailSession {
  unitName?: string | null
  /** "YYYY-MM-DD" */
  date: string
  startTime: string
  endTime: string
}

interface MailBooking extends MailSession {
  facilityName: string
}

/** Satu transaksi = satu fasilitas, satu sesi atau lebih (paket kelas). */
interface MailSchedule {
  facilityName: string
  sessions: MailSession[]
}

/** "Senin, 6 Oktober 2026" + "14:00 – 15:00" — tanggal panjang Indonesia, tanpa nol di depan hari. */
function bookingWhen(session: MailSession): { date: string; time: string } {
  return { date: translatedDate(session.date, 'l, j F Y'), time: `${session.startTime.slice(0, 5)} – ${session.endTime.slice(0, 5)}` }
}

function sessionLine(session: MailSession): string {
  const when = bookingWhen(session)
  return `${when.date} · ${when.time}${session.unitName ? ` · ${session.unitName}` : ''}`
}

/**
 * Kotak jadwal yang menonjol: tanggal besar, satu baris per sesi, "Sesi 1 dari 2" untuk paket. Pelanggan
 * sering hanya memindai email — jadwal tidak boleh tenggelam di paragraf. 'void' = abu-abu dicoret
 * (jadwal lama / reservasi batal).
 */
function scheduleHtml(label: string, schedule: MailSchedule, tone: 'active' | 'void' = 'active'): string {
  const c =
    tone === 'active'
      ? { bg: '#eef4fb', border: '#c9d8ec', label: BRAND, text: '#1a2230', strike: '' }
      : { bg: '#f4f5f7', border: '#e0e3e8', label: '#8b93a1', text: '#8b93a1', strike: 'text-decoration:line-through;' }
  const total = schedule.sessions.length
  const rows = schedule.sessions
    .map((s, i) => {
      const when = bookingWhen(s)
      return `<tr><td style="padding:10px 0;border-top:1px solid ${c.border}">
      ${total > 1 ? `<div style="font-size:12px;font-weight:700;color:${c.label}">SESI ${i + 1} DARI ${total}</div>` : ''}
      <div style="font-size:18px;line-height:26px;font-weight:700;color:${c.text};${c.strike}">${escapeHtml(when.date)}</div>
      <div style="font-size:15px;line-height:22px;color:${c.text};${c.strike}">Pukul <strong>${escapeHtml(when.time)}</strong>${s.unitName ? ` · ${escapeHtml(s.unitName)}` : ''}</div>
    </td></tr>`
    })
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:${c.bg};border:1px solid ${c.border};border-radius:10px">
  <tr><td style="padding:14px 18px 4px">
    <div style="font-size:12px;font-weight:700;letter-spacing:1px;color:${c.label}">${escapeHtml(label)}${total > 1 ? ` · PAKET ${total} SESI` : ''}</div>
    <div style="font-size:16px;font-weight:700;color:${c.text};padding:4px 0 8px">${escapeHtml(schedule.facilityName)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </td></tr>
</table>`
}

function scheduleText(label: string, schedule: MailSchedule): string {
  const total = schedule.sessions.length
  const lines = schedule.sessions.map((s, i) => `${total > 1 ? `Sesi ${i + 1} dari ${total}: ` : ''}${sessionLine(s)}`)
  return `${label}${total > 1 ? ` (Paket ${total} sesi)` : ''}\n${schedule.facilityName}\n${lines.join('\n')}`
}

export function paymentApprovedTemplate(input: {
  to: string
  receiptNumber: string
  /**
   * Nominal yang ditransfer (transferTotal: harga + kode unik, + biaya admin transaksi lama). Laravel
   * memakai $transaction->amount; angka itu tidak sama dengan yang dikirim pelanggan.
   */
  amount: number
  booking: (MailSchedule & { url: string }) | null
}): MailInput {
  const amount = rupiahPlain(input.amount)
  const qr =
    input.booking && input.booking.sessions.length > 1
      ? 'Setiap sesi punya QR tiket sendiri. Saat datang, buka halaman reservasi dan tunjukkan QR sesi hari itu kepada petugas untuk check-in.'
      : 'Saat datang, tunjukkan QR tiket di halaman reservasi kepada petugas untuk check-in.'

  const bookingHtml = input.booking ? `${scheduleHtml('JADWAL ANDA', input.booking)}${escapeHtml(qr)}` : ''

  const bookingText = input.booking ? `\n\n${scheduleText('JADWAL ANDA', input.booking)}\n\n${qr}\n\nLihat Tiket & QR: ${input.booking.url}` : ''

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
// Berasal dari app/Mail/PaymentRejected.php; sesi yang dibatalkan ditampilkan semuanya (paket).

export function paymentRejectedTemplate(input: {
  to: string
  receiptNumber: string
  reason: string
  booking: MailSchedule | null
  /** Tombol "Pesan Ulang" — halaman /booking landing. */
  bookingUrl: string
}): MailInput {
  const cancelled = 'Reservasi berikut telah dibatalkan dan slotnya dilepas kembali:'
  const bookingHtml = input.booking
    ? `<br><br>${escapeHtml(cancelled)}${scheduleHtml('RESERVASI DIBATALKAN', input.booking, 'void')}`
    : '<br><br>'
  const bookingText = input.booking ? `\n\n${cancelled}\n\n${scheduleText('RESERVASI DIBATALKAN', input.booking)}` : ''

  const closing = 'Jika Anda yakin dana sudah terkirim, balas email ini atau hubungi kami — kami akan bantu cek mutasinya. Untuk memesan kembali:'

  return {
    to: input.to,
    subject: `Bukti transfer ${input.receiptNumber} ditolak — UB Sport Center`,
    template: 'payment-rejected',
    html: layout({
      heading: 'Bukti transfer ditolak',
      bodyHtml: `Bukti transfer untuk <strong>${escapeHtml(input.receiptNumber)}</strong> tidak dapat kami cocokkan dengan mutasi rekening.<br><br>
    <strong>Alasan:</strong> ${escapeHtml(input.reason)}${bookingHtml}
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
  const start = translatedDate(input.startDate, 'j F Y')
  const end = translatedDate(input.endDate, 'j F Y')
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
  /** Biaya admin transaksi lama (0 sejak 2026-10-08) — barisnya hanya muncul bila > 0. */
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

// ===== 7. Jadwal reservasi dipindah staff =====
// Dikirim setelah rescheduleBooking() commit, hanya untuk pelanggan terdaftar (walk-in dihubungi FO lewat
// nomor di respons). Harga dan QR tidak berubah. Sesi paket tidak punya halaman bayar sendiri, jadi
// tombolnya ke riwayat booking, bukan /booking/:id/pembayaran.

export function bookingRescheduledTemplate(input: {
  to: string
  name: string
  before: MailBooking
  after: MailBooking
  reason: string | null
  url: string
}): MailInput {
  const before = sessionLine(input.before)
  const after = sessionLine(input.after)
  const facility = input.after.facilityName
  const qr = 'QR check-in Anda tetap berlaku — tunjukkan QR yang sama kepada petugas saat datang.'
  const arrow = `<div style="text-align:center;font-size:12px;font-weight:700;letter-spacing:1px;color:#8b93a1">&#8595; DIPINDAH KE &#8595;</div>`

  return {
    to: input.to,
    subject: `Jadwal reservasi Anda diubah – ${facility}`,
    template: 'booking-rescheduled',
    html: layout({
      heading: 'Jadwal reservasi Anda diubah',
      bodyHtml: `Halo ${escapeHtml(input.name)},<br><br>Petugas kami memindahkan jadwal reservasi <strong>${escapeHtml(facility)}</strong> Anda. Mohon datang sesuai <strong>JADWAL BARU</strong>.
    ${scheduleHtml('JADWAL LAMA', { facilityName: input.before.facilityName, sessions: [input.before] }, 'void')}
    ${arrow}
    ${scheduleHtml('JADWAL BARU', { facilityName: facility, sessions: [input.after] })}${input.reason ? `<strong>Alasan:</strong> ${escapeHtml(input.reason)}<br><br>` : ''}
    ${escapeHtml(qr)}`,
      ctaLabel: 'Lihat Riwayat Booking',
      ctaUrl: input.url,
      footerNote: `Sampai jumpa di lapangan,<br>${escapeHtml(MAIL_FROM_NAME)}`
    }),
    text: `Halo ${input.name},\n\nPetugas kami memindahkan jadwal reservasi ${facility} Anda. Mohon datang sesuai JADWAL BARU.\n\nJADWAL LAMA (tidak berlaku): ${before}\nJADWAL BARU: ${after}${input.reason ? `\n\nAlasan: ${input.reason}` : ''}\n\n${qr}\n\nLihat riwayat booking: ${input.url}\n\nSampai jumpa di lapangan,\n${MAIL_FROM_NAME}`
  }
}
