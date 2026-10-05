import { existsSync } from 'fs'
import { resolve } from 'path'
import { config } from 'dotenv'

// ===== Pemuat berkas environment =====
// Dua berkas, DIPILIH SATU — tidak digabung:
//   .env.local -> laptop pengembang (DB dev, STORAGE_DRIVER=local, dst.)
//   .env       -> server produksi (bersih, hanya nilai produksi)
// Bila .env.local ada, hanya berkas itu yang dibaca. Sengaja tidak digabung seperti Next: kunci yang
// lupa ditulis di .env.local tidak boleh diam-diam memakai nilai produksi (DATABASE_URL, R2, SMTP)
// dari laptop. Konsekuensinya: JANGAN pernah menaruh .env.local di server.
//
// Var yang sudah ada di environment proses (PM2, shell, jest setup-env) selalu menang — dotenv
// tidak menimpanya. Diimpor PALING AWAL oleh setiap entry point: app.ts, worker.ts, config/env.ts,
// prisma.config.ts, dan seeder.

const local = resolve(process.cwd(), '.env.local')

/** Berkas env yang benar-benar dibaca proses ini. */
export const ENV_FILE = existsSync(local) ? local : resolve(process.cwd(), '.env')

config({ path: ENV_FILE, quiet: true })
