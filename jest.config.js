// ===== Konfigurasi Jest - ubsc-api =====
// Boilerplate sudah membawa jest + ts-jest + supertest di devDependencies, tapi
// tanpa satu pun file konfigurasi. Ini yang membuatnya bisa dijalankan.

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],

  // Transpile per berkas (isolatedModules di tsconfig.test.json). Error tipe diperiksa terpisah oleh
  // `npm run typecheck`, yang mencakup tests/.
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }]
  },

  // Sekali sebelum seluruh suite: tolak database yang namanya tidak berakhiran
  // _test, lalu prisma migrate deploy ke database itu.
  globalSetup: '<rootDir>/tests/global-setup.ts',

  // Di setiap berkas test, SEBELUM modul aplikasi dimuat: arahkan DATABASE_URL
  // dan folder penyimpanan ke lokasi test. dotenv tidak menimpa nilai ini.
  setupFiles: ['<rootDir>/tests/setup-env.ts'],

  // Satu worker, selalu. Test yang paling penting di repo ini (gate konkurensi
  // booking Fase 3) berbagi satu database nyata; menjalankannya paralel membuat
  // kegagalannya tidak bisa dibedakan dari bug yang sedang dicari.
  maxWorkers: 1,

  // Transaksi interaktif + lock database bisa menunggu lebih lama dari 5 detik
  // bawaan Jest.
  testTimeout: 30000,

  clearMocks: true
}
