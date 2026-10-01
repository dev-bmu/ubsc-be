import { z } from 'zod'

// ===== Validasi notification center admin (Fase 8G) =====
// Port aturan $request->validate() di Admin\NotificationController::markRead dan ::clearRead —
// keduanya IDENTIK, jadi satu schema dipakai bersama:
//   'ids'   => ['nullable', 'array']
//   'ids.*' => ['string', 'max:160']
//
// `ids` boleh ABSEN, `null`, atau array kosong. Ketiganya berarti hal yang sama di service:
// "pakai default" — semua item terlihat untuk markRead, semua item yang SUDAH read untuk clearRead
// (lihat `?:` PHP di AdminNotificationCenter, yang memang menganggap array kosong sebagai falsy).
// Karena itu tidak ada `.min(1)` di sini: array kosong sah dan bermakna.
//
// Tidak ada pagar panjang array: Laravel juga tidak punya, dan id yang tidak dikenal disaring di
// service terhadap daftar item yang sedang terlihat — bukan disimpan mentah-mentah.

export class NotificationAdminValidation {
  /** POST /api/admin/notifications/read dan POST /api/admin/notifications/clear-read */
  static readonly IDS = z.object({
    ids: z
      .array(z.string({ error: 'Setiap id notifikasi harus berupa teks.' }).max(160, { error: 'Id notifikasi maksimal 160 karakter.' }), {
        error: 'Daftar id notifikasi tidak valid.'
      })
      .nullish()
  })
}

export type NotificationIdsInput = z.infer<typeof NotificationAdminValidation.IDS>
