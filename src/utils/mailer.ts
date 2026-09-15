import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import nodemailer, { Transporter } from 'nodemailer'
import { prismaClient } from '../application/database'
import {
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  MAIL_HOST,
  MAIL_PASSWORD,
  MAIL_PORT,
  MAIL_PREVIEW_DIR,
  MAIL_SECURE,
  MAIL_TIMEOUT_MS,
  MAIL_TRANSPORT,
  MAIL_USER
} from '../config'
import { logger } from './logger'

// ============================================================================
// === Mailer ===
// ============================================================================
// Empat sifat yang di-port dari Laravel dan TIDAK boleh hilang:
//
//  1. Port 465 dengan TLS implisit, bukan 587. Alasannya didokumentasikan di
//     .env.example Laravel: di 587, handshake STARTTLS tidak dibatasi socket
//     timeout, dan handshake yang macet menggantung request sampai prosesnya
//     dimatikan.
//  2. Kirim SETELAH transaksi bisnis commit. Setiap penulisan sudah permanen
//     sebelum email berangkat, jadi kegagalan SMTP tidak pernah muncul sebagai
//     500 setelah pembayaran benar-benar disetujui.
//  3. Kirim DI LUAR $transaction. Timeout SMTP 10 detik di dalam transaksi
//     mem-pin koneksi pool dan menahan row lock selama itu.
//  4. Kegagalan TIDAK dilempar. Di Node taruhannya lebih tinggi daripada di
//     PHP: satu unhandled rejection bisa menjatuhkan proses. sendMailSafe()
//     karenanya tidak pernah reject — pemanggilnya menulis
//     `void sendMailSafe(...)`, dan ESLint no-floating-promises yang menjaga
//     `void`-nya jujur.
//
// Tambahan di luar Laravel: setiap kiriman tercatat di tabel email_logs
// (status, attempts, lastError) sehingga staff bisa melihat dan memicu ulang
// kiriman gagal dari panel admin. Pengganti murah untuk queue, dan cukup pada
// volume ini.

export type MailTemplate = 'verify-email' | 'reset-password' | 'payment-approved' | 'payment-rejected'

export interface MailInput {
  to: string
  subject: string
  template: MailTemplate
  html: string
  text: string
}

let transporter: Transporter | null = null

function getTransporter(): Transporter {
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    // true = TLS implisit sejak byte pertama (port 465). Jangan diubah ke
    // false + STARTTLS tanpa membaca alasan nomor 1 di atas.
    secure: MAIL_SECURE,
    auth: MAIL_USER && MAIL_PASSWORD ? { user: MAIL_USER, pass: MAIL_PASSWORD } : undefined,
    // Tiga batas terpisah: koneksi TCP, greeting SMTP, dan socket idle. Tanpa
    // ketiganya, server yang menerima koneksi lalu diam akan menggantung
    // selamanya.
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS
  })

  return transporter
}

function fromAddress(): string {
  const address = MAIL_FROM_ADDRESS || MAIL_USER || 'no-reply@ubsportcenter.co.id'
  return `"${MAIL_FROM_NAME}" <${address}>`
}

/**
 * Transport 'log': tulis berkas .eml ke MAIL_PREVIEW_DIR alih-alih mengirim.
 * Ini pengganti Mailpit pada mesin pengembangan tanpa Docker. Formatnya RFC822
 * asli — berkasnya bisa dibuka klien mail mana pun beserta header-nya, bukan
 * sekadar potongan HTML.
 */
function writePreview(input: MailInput, messageId: string): string {
  const dir = resolve(process.cwd(), MAIL_PREVIEW_DIR)
  mkdirSync(dir, { recursive: true })

  const boundary = `----ubsc-${messageId}`
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${stamp}__${input.template}__${input.to.replace(/[^a-zA-Z0-9@._-]/g, '_')}.eml`
  const path = join(dir, fileName)

  const eml = [
    `From: ${fromAddress()}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@ubsportcenter.co.id>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    input.html,
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n')

  writeFileSync(path, eml, 'utf8')
  return path
}

/**
 * Kirim email. TIDAK PERNAH melempar dan TIDAK PERNAH reject.
 *
 * Pemanggilan yang benar, setelah transaksi bisnis commit:
 *
 *     void sendMailSafe({ to, subject, template, html, text })
 *
 * Mengembalikan id baris email_logs supaya pemanggil bisa merujuknya bila
 * perlu; id-nya null hanya bila pencatatan log itu sendiri gagal.
 */
export function sendMailSafe(input: MailInput): Promise<string | null> {
  const delivery = deliver(input)
  pending.add(delivery)
  void delivery.finally(() => pending.delete(delivery))
  return delivery
}

/**
 * Kiriman `void` yang masih berjalan. Kiriman itu sengaja HIDUP LEBIH LAMA dari request-nya, jadi
 * drain HTTP saat shutdown tidak menunggunya — tanpa daftar ini, $disconnect memotong kiriman di
 * tengah jalan dan baris email_logs-nya tertinggal 'pending' atau salah tercatat gagal.
 */
const pending = new Set<Promise<string | null>>()

/**
 * Tunggu kiriman yang masih berjalan, dengan batas waktu. true bila semua selesai. Dipanggil app.ts
 * setelah drain HTTP dan SEBELUM pool database ditutup; juga oleh test sebelum $disconnect.
 */
export async function waitForPendingMail(timeoutMs: number): Promise<boolean> {
  if (pending.size === 0) return true
  const settled = Promise.allSettled(Array.from(pending)).then(() => true)
  const timedOut = new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), timeoutMs)
    timer.unref()
  })
  return Promise.race([settled, timedOut])
}

async function deliver(input: MailInput): Promise<string | null> {
  let logId: string | null = null

  try {
    const log = await prismaClient.emailLog.create({
      data: { toEmail: input.to, subject: input.subject, template: input.template, status: 'pending', attempts: 0 }
    })
    logId = log.id
  } catch (error) {
    // Kalau pencatatan gagal pun, pengiriman tetap dicoba: email verifikasi
    // yang sampai lebih berharga daripada baris log yang rapi.
    logger.error(`email_logs gagal ditulis untuk ${input.template} -> ${input.to}: ${(error as Error).message}`)
  }

  try {
    if (MAIL_TRANSPORT === 'log') {
      const messageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const path = writePreview(input, messageId)
      logger.info(`[mail:log] ${input.template} -> ${input.to} ditulis ke ${path}`)
    } else {
      await getTransporter().sendMail({
        from: fromAddress(),
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html
      })
      logger.info(`[mail:smtp] ${input.template} -> ${input.to} terkirim`)
    }

    if (logId) {
      await prismaClient.emailLog.update({
        where: { id: logId },
        data: { status: 'sent', attempts: { increment: 1 }, sentAt: new Date(), lastError: null }
      })
    }
  } catch (error) {
    const message = (error as Error).message ?? 'Kesalahan tidak diketahui'
    logger.error(`[mail] ${input.template} -> ${input.to} GAGAL: ${message}`)

    if (logId) {
      try {
        await prismaClient.emailLog.update({ where: { id: logId }, data: { status: 'failed', attempts: { increment: 1 }, lastError: message } })
      } catch (logError) {
        logger.error(`email_logs gagal diperbarui: ${(logError as Error).message}`)
      }
    }
  }

  return logId
}

/**
 * Kirim ulang satu baris email_logs yang gagal. Dipakai tombol "kirim ulang"
 * di panel admin (Fase 8). Isi email TIDAK disimpan di tabel log — hanya
 * metadatanya — jadi pemanggil wajib menyusun ulang html/text dari template.
 */
export async function markRetry(logId: string): Promise<void> {
  await prismaClient.emailLog.update({ where: { id: logId }, data: { status: 'pending', lastError: null } })
}

/** Dipakai test dan shutdown: tutup pool koneksi SMTP bila pernah dibuka. */
export function closeMailer(): void {
  transporter?.close()
  transporter = null
}
