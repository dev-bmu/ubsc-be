import { MAIL_FROM_NAME } from '../config'
import { formatRupiah } from '../../shared/format'
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
const ACCENT = '#D50000'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface LayoutInput {
  heading: string
  bodyHtml: string
  ctaLabel?: string
  ctaUrl?: string
  footerNote?: string
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
    Email ini dikirim otomatis oleh ${escapeHtml(MAIL_FROM_NAME)}. Mohon tidak membalas email ini.
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
// Dipakai ManualPayment.approve() di Fase 3.

export function paymentApprovedTemplate(input: {
  to: string
  name: string
  receiptNumber: string
  amount: number
  description: string
  url?: string
}): MailInput {
  const heading = 'Pembayaran Anda telah dikonfirmasi'
  const body = `Halo ${escapeHtml(input.name)},<br><br>
    Pembayaran Anda sudah kami terima dan diverifikasi.<br><br>
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:22px">
      <tr><td style="color:#5b6472;padding-right:16px">No. Kuitansi</td><td style="font-weight:600">${escapeHtml(input.receiptNumber)}</td></tr>
      <tr><td style="color:#5b6472;padding-right:16px">Jumlah</td><td style="font-weight:600">${escapeHtml(formatRupiah(input.amount))}</td></tr>
      <tr><td style="color:#5b6472;padding-right:16px">Untuk</td><td style="font-weight:600">${escapeHtml(input.description)}</td></tr>
    </table>`

  return {
    to: input.to,
    subject: `Pembayaran dikonfirmasi (${input.receiptNumber}) — UB Sport Center`,
    template: 'payment-approved',
    html: layout({ heading, bodyHtml: body, ctaLabel: input.url ? 'Lihat Riwayat Booking' : undefined, ctaUrl: input.url }),
    text: `Halo ${input.name},\n\nPembayaran Anda sudah kami terima dan diverifikasi.\n\nNo. Kuitansi : ${input.receiptNumber}\nJumlah       : ${formatRupiah(input.amount)}\nUntuk        : ${input.description}\n${input.url ? `\nRiwayat booking: ${input.url}\n` : ''}\n— ${MAIL_FROM_NAME}`
  }
}

// ===== 4. Pembayaran ditolak =====

export function paymentRejectedTemplate(input: {
  to: string
  name: string
  receiptNumber: string
  amount: number
  reason: string
  url?: string
}): MailInput {
  const heading = 'Pembayaran Anda belum dapat kami terima'
  const body = `Halo ${escapeHtml(input.name)},<br><br>
    Mohon maaf, bukti pembayaran Anda belum dapat kami verifikasi.<br><br>
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:22px">
      <tr><td style="color:#5b6472;padding-right:16px">No. Kuitansi</td><td style="font-weight:600">${escapeHtml(input.receiptNumber)}</td></tr>
      <tr><td style="color:#5b6472;padding-right:16px">Jumlah</td><td style="font-weight:600">${escapeHtml(formatRupiah(input.amount))}</td></tr>
    </table>
    <div style="margin-top:16px;padding:12px 16px;background:#fff5f5;border-left:3px solid ${ACCENT};color:#7a1f1f">
      <strong>Alasan:</strong> ${escapeHtml(input.reason)}
    </div>`

  return {
    to: input.to,
    subject: `Pembayaran belum diterima (${input.receiptNumber}) — UB Sport Center`,
    template: 'payment-rejected',
    html: layout({
      heading,
      bodyHtml: body,
      ctaLabel: input.url ? 'Unggah Ulang Bukti' : undefined,
      ctaUrl: input.url,
      footerNote: 'Bila Anda merasa ini keliru, hubungi petugas kami di meja depan UB Sport Center.'
    }),
    text: `Halo ${input.name},\n\nMohon maaf, bukti pembayaran Anda belum dapat kami verifikasi.\n\nNo. Kuitansi : ${input.receiptNumber}\nJumlah       : ${formatRupiah(input.amount)}\nAlasan       : ${input.reason}\n${input.url ? `\nUnggah ulang bukti: ${input.url}\n` : ''}\nBila Anda merasa ini keliru, hubungi petugas kami di meja depan.\n\n— ${MAIL_FROM_NAME}`
  }
}
