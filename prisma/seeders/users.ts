import bcrypt from 'bcryptjs'
import { prisma, SEED_PASSWORD, tally } from './shared'

// ============================================================================
// === AdminUserSeeder.php ===
// ============================================================================
// Lima akun staff, satu per role, persis seperti di Laravel. Berguna untuk
// menguji matriks permission: login sebagai kelima role dan bandingkan item
// sidebar + badge "Locked".
//
// Password hanya di-set saat akun DIBUAT. Akun yang sudah ada tidak pernah
// ditimpa — seeder yang mereset password orang setiap kali dijalankan adalah
// cara yang rapi untuk mengunci administrator dari sistemnya sendiri.

interface StaffSeed {
  name: string
  email: string
  role: string
}

const STAFF: StaffSeed[] = [
  { name: 'Admin UBSC', email: 'admin@ubsc.id', role: 'Administrator' },
  { name: 'Manager UBSC', email: 'manager@ubsc.id', role: 'Manager' },
  { name: 'Finance UBSC', email: 'finance@ubsc.id', role: 'Finance' },
  { name: 'Staff Front Office', email: 'stafffo@ubsc.id', role: 'Staff Front Office' },
  { name: 'Staff Central', email: 'staffcentral@ubsc.id', role: 'Staff Central' }
]

export async function seedStaffUsers() {
  console.log('Akun staff')

  const roles = await prisma.role.findMany({ select: { id: true, name: true } })
  const roleIdByName = new Map(roles.map((role) => [role.name, role.id]))

  const passwordHash = bcrypt.hashSync(SEED_PASSWORD, 10)
  let created = 0
  let updated = 0

  for (const staff of STAFF) {
    const roleId = roleIdByName.get(staff.role)
    if (!roleId) {
      console.warn(`  ! role "${staff.role}" tidak ditemukan — akun ${staff.email} dilewati`)
      continue
    }

    const email = staff.email.trim().toLowerCase()
    const before = await prisma.user.findUnique({ where: { email }, select: { id: true } })

    await prisma.user.upsert({
      where: { email },
      // Role dan status kunci disinkronkan ulang; nama dan password tidak disentuh.
      update: { roleId, isLocked: false, failedLogins: 0 },
      create: {
        email,
        name: staff.name,
        password: passwordHash,
        roleId,
        // Akun staff dibuat oleh administrator, bukan lewat pendaftaran publik,
        // jadi emailnya dianggap terverifikasi sejak awal — sama seperti Laravel.
        emailVerifiedAt: new Date()
      }
    })

    if (before) updated++
    else created++
  }

  tally('users', { baru: created, diperbarui: updated })
  if (created > 0) {
    console.log(`  Password akun baru: "${SEED_PASSWORD}" (ubah lewat SEED_PASSWORD; akun lama tidak pernah ditimpa)`)
  }
}
