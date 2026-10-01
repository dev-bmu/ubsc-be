import { z } from 'zod'

// ===== Validasi checkout membership lewat web (tahap C) =====
// Keberadaan & status aktif paketnya dicek di service.

const PLAN_REQUIRED = 'Pilih paket membership.'

export class MembershipCheckoutValidation {
  /** POST /api/customer/memberships */
  static readonly START = z.object({
    membershipPlanId: z.string({ error: PLAN_REQUIRED }).trim().min(1, { error: PLAN_REQUIRED }).max(64, { error: 'ID paket tidak valid.' })
  })
}
