import { z } from 'zod'

// ===== Validasi keputusan foto member (panel staff) =====
// Keberadaan user dan kecocokan photoUrl dengan foto yang tersimpan dicek di service, di bawah kunci.

const PHOTO_REQUIRED = 'Foto yang ditinjau wajib disertakan.'

export class MemberPhotoValidation {
  /** PATCH /api/admin/identity/:userId/member-photo */
  static readonly DECIDE = z.object({
    status: z.enum(['approved', 'rejected'], { error: 'Status tidak valid.' }),
    photoUrl: z.string({ error: PHOTO_REQUIRED }).trim().min(1, { error: PHOTO_REQUIRED }).max(255, { error: PHOTO_REQUIRED })
  })
}
