// ===== Konfigurasi Jest - ubsc-api =====
// Boilerplate sudah membawa jest + ts-jest + supertest di devDependencies, tapi
// tanpa satu pun file konfigurasi. Ini yang membuatnya bisa dijalankan.

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],

  // Satu worker, selalu. Test yang paling penting di repo ini (gate konkurensi
  // booking Fase 3) berbagi satu database nyata; menjalankannya paralel membuat
  // kegagalannya tidak bisa dibedakan dari bug yang sedang dicari.
  maxWorkers: 1,

  // Transaksi interaktif + lock database bisa menunggu lebih lama dari 5 detik
  // bawaan Jest.
  testTimeout: 30000,

  clearMocks: true
}
