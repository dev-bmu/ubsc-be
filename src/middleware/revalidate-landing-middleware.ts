import { RequestHandler } from 'express'
import { LANDING_REVALIDATE_SECRET, LANDING_REVALIDATE_URL } from '../config'
import { logger } from '../utils/logger'

// ===== Revalidasi cache halaman landing setelah tulis admin =====
// Halaman publik landing di-ISR (2-10 menit). Tanpa ini, fasilitas yang dinonaktifkan admin tetap tampil
// sampai cache kedaluwarsa (catatan client 2026-09-28). Dipasang per mount di private-api.ts: setiap
// tulis (bukan GET) yang sukses meminta landing membuang tag cache terkait. Fire-and-forget — landing
// yang mati tidak boleh menggagalkan tulis admin; halamannya tetap segar sendiri saat ISR habis.

/** Tag fetch di ubsc-landing/src/services/server.ts. */
export type LandingTag = 'home' | 'facilities' | 'booking-facilities' | 'membership-plans' | 'news' | 'booking-reviews' | 'seo'

export function revalidateLanding(tags: LandingTag[]): void {
  if (!LANDING_REVALIDATE_URL || !LANDING_REVALIDATE_SECRET) return
  void fetch(LANDING_REVALIDATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-revalidate-secret': LANDING_REVALIDATE_SECRET },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(5000)
  })
    .then((res) => {
      if (!res.ok) logger.warn(`Revalidasi landing ditolak (HTTP ${res.status}) untuk ${tags.join(', ')}`)
    })
    .catch((error: unknown) => logger.warn(`Revalidasi landing gagal: ${(error as Error).message}`))
}

export function revalidateLandingAfterWrite(tags: LandingTag[]): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.on('finish', () => {
        if (res.statusCode < 400) revalidateLanding(tags)
      })
    }
    next()
  }
}
