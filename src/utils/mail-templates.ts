import { MAIL_FROM_NAME } from '../config'
import { translatedDate } from './clock'
import { rupiahPlain } from './money'
import type { MailInput } from './mailer'

// ============================================================================
// === Template email ===
// ============================================================================
// Empat email, sama seperti Laravel: verifikasi email, reset password,
// pembayaran disetujui, pembayaran ditolak.
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

  return `<!doctype html>
<html lang="id"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a2230">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
  <tr><td style="padding-bottom:8px;color:${BRAND};font-size:13px;font-weight:700;letter-spacing:1px">UB SPORT CENTER</td></tr>
  <tr><td style="font-size:20px;font-weight:700;padding-bottom:12px">${escapeHtml(input.heading)}</td></tr>
  <tr><td style="font-size:14px;line-height:22px;color:#3a4453">${input.bodyHtml}</td></tr>
  ${button}
  ${footerNote}
  <tr><td style="padding-top:24px;border-top:1px solid #e6e8ec;color:#8b93a1;font-size:12px;line-height:18px">
    Email ini dikirim otomatis oleh ${escapeHtml(MAIL_FROM_NAME)}.${input.replyable ? '' : ' Mohon tidak membalas email ini.'}
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
  /** Nominal booking TANPA kode unik — Laravel memakai $transaction->amount. */
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
