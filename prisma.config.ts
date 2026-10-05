// .env.local (laptop) atau .env (server) — pilihan yang sama dengan API (src/config/load-env.ts).
// Penting: migrate di laptop tidak boleh membaca DATABASE_URL produksi dari .env.
import './src/config/load-env'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Seeder ditulis TypeScript, menyimpang dari boilerplate yang memakai seed.js.
    // Alasannya: matriks 16 permission x 5 role harus punya satu sumber kebenaran
    // di shared/permissions.ts, dan seeder wajib mengimpornya langsung - bukan
    // menyalin ulang daftarnya. Salinan kedua pasti melenceng (R12).
    //
    // Runner-nya tsx, sama seperti seluruh script TypeScript di package.json.
    // JANGAN mengembalikannya ke ts-node dan JANGAN menambahkan flag
    // --compiler-options di sini: baik cmd.exe maupun sh membuang tanda kutip
    // ganda di dalamnya, sehingga runner menerima JSON rusak dan mati dengan
    // SyntaxError sebelum seeder sempat jalan. tsx tidak membutuhkannya sama
    // sekali - dia memetakan spesifier .js ke .ts sendiri, baik untuk import
    // statis maupun dinamis, jadi tsconfig "module": "Node16" tetap utuh.
    seed: 'tsx prisma/seed.ts'
  },
  datasource: {
    url: env('DATABASE_URL')
  }
})
