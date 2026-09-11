import { Request } from 'express'
import { Prisma } from '@prisma/client'
import { TokenAudience } from '../utils/jwt'

// ===== Request yang sudah melewati auth middleware =====
// Relasi yang di-include sengaja hanya `role`: Cluster / Unit / Division dari
// boilerplate dibuang karena UBSC tidak punya struktur organisasi itu.
// `role` bernilai null untuk customer.

export type UserWithRelations = Prisma.UserGetPayload<{
  include: { role: true }
}>

export interface UserRequest extends Request {
  user?: UserWithRelations
  permissions?: string[]
  /** Audience yang meloloskan request ini — diisi createAuthRequired(). */
  audience?: TokenAudience
}
