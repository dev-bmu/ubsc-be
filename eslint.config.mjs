// ===== ESLint flat config - ubsc-api =====
// Boilerplate BE tidak membawa config ESLint sama sekali, sehingga script `lint`
// di sana selalu gagal. File ini menutup celah itu sekaligus memasang dua pagar
// yang disebut daftar risiko: no-floating-promises (R8) dan larangan raw DELETE (R2).

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

// ===== Pola selector untuk larangan raw DELETE (R2) =====
// Ditulis sebagai konstanta supaya polanya tidak disalin-tempel lalu melenceng.
// Sengaja tanpa satu pun backslash: `[$]` menggantikan `\$`, dan `(^|[^a-z_])`
// menggantikan batas kata `\b`. Alasannya, isi selector ini adalah string JS -
// backslash di dalamnya gampang termakan satu lapis escape dan berubah diam-diam
// jadi karakter kontrol, sehingga aturannya berhenti cocok tanpa ada yang sadar.
const PRISMA_RAW_METHOD = '/^[$](executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe)$/'
const CONTAINS_DELETE = '/(^|[^a-z_])delete([^a-z_]|$)/i'
const RAW_DELETE_MESSAGE =
  'R2: raw DELETE dilarang. relationMode="prisma" menghapus semua foreign key di level database dan menegakkan integritas di sisi client, jadi $executeRaw/$queryRaw mem-bypass-nya dan meninggalkan orphan row. Hapus lewat prisma.<model>.delete/deleteMany, dan panggil media-services.deleteForModel() di setiap jalur delete owner.'

export default tseslint.config(
  // ===== Yang tidak pernah di-lint =====
  // uploads/ dan storage/ berisi berkas unggahan user, logs/ berisi rotasi winston,
  // prisma/migrations/ dihasilkan Prisma - tidak ada satu pun yang layak di-lint.
  {
    ignores: ['dist/**', 'node_modules/**', 'uploads/**', 'storage/**', 'logs/**', 'prisma/migrations/**', 'coverage/**']
  },

  // ===== TypeScript dengan type-aware linting =====
  // projectService memakai layanan project TypeScript, bukan daftar tsconfig manual.
  // allowDefaultProject menampung prisma.config.ts yang berada di root dan memang
  // sengaja tidak masuk "include" tsconfig.
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['prisma.config.ts']
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // R8: mailer dikirim dengan `void sendMailSafe(...)` setelah transaksi commit.
      // Tanpa aturan ini, promise yang lupa di-`void`/`await` berubah jadi unhandled
      // rejection, dan unhandled rejection di Node menjatuhkan seluruh proses API.
      '@typescript-eslint/no-floating-promises': 'error',

      // R2: relationMode = "prisma" menghapus semua foreign key dan cascade di level
      // database. Integritas hanya ditegakkan Prisma di sisi client, dan emulasi itu
      // di-bypass total oleh raw SQL. Satu raw DELETE meninggalkan orphan row yang
      // tidak akan pernah ketahuan sampai laporan salah hitung.
      // Tiga selector: tagged template, argumen string, dan argumen template literal.
      // SELECT ... FOR UPDATE (R1) tetap boleh - yang dilarang hanya yang ber-DELETE.
      'no-restricted-syntax': [
        'error',
        {
          selector: `TaggedTemplateExpression[tag.property.name=${PRISMA_RAW_METHOD}] TemplateElement[value.raw=${CONTAINS_DELETE}]`,
          message: RAW_DELETE_MESSAGE
        },
        {
          selector: `CallExpression[callee.property.name=${PRISMA_RAW_METHOD}] Literal[value=${CONTAINS_DELETE}]`,
          message: RAW_DELETE_MESSAGE
        },
        {
          selector: `CallExpression[callee.property.name=${PRISMA_RAW_METHOD}] TemplateElement[value.raw=${CONTAINS_DELETE}]`,
          message: RAW_DELETE_MESSAGE
        }
      ],

      // Parameter yang sengaja tidak dipakai diawali garis bawah. Terutama untuk
      // errorMiddleware Express yang wajib bertanda tangan 4 argumen: (err, req, res, _next).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  },

  // ===== tests/ =====
  // tests/ di luar "include" tsconfig (supaya tidak ikut ter-emit ke dist/), jadi
  // layanan project tidak mengenalinya. Matikan aturan type-aware di sini saja.
  // TODO Fase 1: kalau test butuh aturan type-aware juga, tambahkan tsconfig.eslint.json
  // yang meng-include tests/ lalu hapus blok ini.
  {
    files: ['tests/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked]
  },

  // ===== Berkas config berformat JS =====
  // jest.config.js dan eslint.config.mjs bukan bagian project TypeScript.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly'
      }
    }
  },

  // ===== Prettier terakhir =====
  // Wajib paling bawah: tugasnya mematikan aturan ESLint yang bertabrakan dengan
  // format Prettier. Kalau ada blok setelah ini, aturan formatnya hidup lagi.
  eslintConfigPrettier
)
