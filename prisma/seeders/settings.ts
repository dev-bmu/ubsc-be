import { prisma, tally } from './shared'

// ============================================================================
// === Pengaturan sistem + jadwal booking ===
// ============================================================================
// Laravel TIDAK punya seeder untuk kedua tabel ini — isinya tumbuh dari panel
// admin. Tapi keduanya master data yang tanpanya sistem baru tidak bisa dipakai
// sama sekali: tanpa rekening tujuan, halaman pembayaran transfer manual tidak
// punya nomor untuk ditampilkan; tanpa BookingSchedule yang terbuka, tidak ada
// satu pun tanggal yang bisa di-booking.
//
// Nilainya diambil dari database `ubsc` yang sedang berjalan. Rekeningnya
// memang placeholder di sana — labelnya "(DUMMY)" dipertahankan apa adanya
// supaya jelas bahwa itu HARUS diganti sebelum produksi, bukan angka asli yang
// kebetulan terlihat aneh.

const SETTINGS: { key: string; value: string }[] = [
  { key: 'payment_bank_name', value: 'BCA' },
  { key: 'payment_bank_account_number', value: '1234567890' },
  { key: 'payment_bank_account_holder', value: 'UB Sport Center (DUMMY)' },
  // Lama hold booking sebelum dilepas cron payments:release-expired.
  { key: 'payment_hold_minutes', value: '120' }
]

export async function seedSystemSettings() {
  console.log('Pengaturan sistem')
  let created = 0

  for (const setting of SETTINGS) {
    const before = await prisma.systemSetting.findUnique({ where: { key: setting.key }, select: { id: true } })
    // Nilai yang sudah diubah staff TIDAK ditimpa — seeder tidak boleh
    // mengembalikan nomor rekening produksi ke placeholder.
    await prisma.systemSetting.upsert({ where: { key: setting.key }, update: {}, create: setting })
    if (!before) created++
  }

  tally('system_settings', { baru: created, total: SETTINGS.length })
}

export async function seedBookingSchedules() {
  console.log('Jadwal booking')

  // Buka bulan berjalan dan bulan berikutnya supaya sistem langsung bisa
  // dipakai setelah seed. Tanggal diambil dari jam proses; TZ setiap proses
  // sudah dipatok Asia/Jakarta lewat PM2 (R13).
  const now = new Date()
  const months = [
    { month: now.getMonth() + 1, year: now.getFullYear() },
    { month: now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2, year: now.getMonth() + 2 > 12 ? now.getFullYear() + 1 : now.getFullYear() }
  ]

  let created = 0
  for (const item of months) {
    const before = await prisma.bookingSchedule.findUnique({
      where: { month_year: { month: item.month, year: item.year } },
      select: { id: true }
    })
    await prisma.bookingSchedule.upsert({
      where: { month_year: { month: item.month, year: item.year } },
      // Jangan menimpa isOpen atau closedDates yang sudah diatur staff.
      update: {},
      create: { month: item.month, year: item.year, isOpen: true, closedDates: [] }
    })
    if (!before) created++
  }

  tally('booking_schedules', { baru: created, bulan: months.map((m) => `${m.month}/${m.year}`).length })
}
