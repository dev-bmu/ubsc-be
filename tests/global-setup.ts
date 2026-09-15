import { execSync } from 'child_process'
import { assertTestDatabase, TEST_DATABASE_URL } from './test-database'

// ===== Global setup Jest =====
// Sekali per run: pastikan skema database test sama dengan migrasi terbaru. Database-nya sendiri
// dibuat manual sekali (lihat docs/fase-3.md) — script ini tidak pernah membuat atau menghapus database.

export default function globalSetup(): void {
  assertTestDatabase(TEST_DATABASE_URL)
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'pipe' })
}
