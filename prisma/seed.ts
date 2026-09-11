import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { ADMINISTRATOR_ROLE, ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../shared/permissions'

// ============================================================================
// === SEED FASE 0 ===
// ============================================================================
// Isi: 16 permission, 5 role staff beserta matriksnya, dan satu akun
// Administrator. Cukup untuk login di kedua aplikasi Next; master data domain
// (fasilitas, harga, membership plan, konten CMS) menyusul di Fase 1.
//
// Dua aturan yang tidak boleh dilanggar:
//  - Daftar permission dan matriks role dibaca dari shared/permissions.ts,
//    TIDAK diduplikasi di sini. Dua salinan berarti dua kebenaran, dan yang
//    salah baru ketahuan saat ada staff yang kehilangan menu.
//  - Semua penulisan lewat Prisma, tidak pernah raw SQL (R2). relationMode
//    "prisma" membuat integritas ditegakkan client-side saja, jadi raw SQL di
//    seeder melewati satu-satunya pemeriksaan yang tersisa.
//
// Idempoten: aman dijalankan berulang kali. Password akun yang SUDAH ADA tidak
// pernah ditimpa.
// ============================================================================

function createAdapter(urlString: string) {
  const url = new URL(urlString)
  return new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || undefined
  })
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL belum di-set')

const prisma = new PrismaClient({ adapter: createAdapter(databaseUrl) })

const SEED_ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || 'admin@ubsportcenter.co.id').trim().toLowerCase()
const SEED_ADMIN_NAME = 'Administrator UBSC'
const SEED_PASSWORD = process.env.SEED_PASSWORD || 'password123'

// ===== Permission =====

async function seedPermissions() {
  console.log(`Seeding ${ALL_PERMISSIONS.length} permission...`)

  for (const permission of ALL_PERMISSIONS) {
    const data = { code: permission.code, name: permission.name, description: permission.description }
    await prisma.permission.upsert({ where: { code: permission.code }, update: { name: data.name, description: data.description }, create: data })
  }
}

// ===== Role + matriks role-permission =====

async function seedRoles() {
  const roleNames = Object.keys(ROLE_PERMISSIONS)
  console.log(`Seeding ${roleNames.length} role staff: ${roleNames.join(', ')}`)

  for (const name of roleNames) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } })
  }
}

async function seedRolePermissions() {
  console.log('Seeding matriks role-permission...')

  const permissions = await prisma.permission.findMany({ select: { id: true, code: true } })
  const idByCode = new Map(permissions.map((permission) => [permission.code, permission.id]))

  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      const permissionId = idByCode.get(code)
      if (!permissionId) {
        console.warn(`  ! permission "${code}" untuk role "${roleName}" tidak ada di tabel permissions — dilewati`)
        continue
      }

      // @@unique([roleName, permissionId]) membuat upsert ini aman dijalankan ulang.
      await prisma.rolePermission.upsert({
        where: { roleName_permissionId: { roleName, permissionId } },
        update: {},
        create: { roleName, permissionId }
      })
    }
  }
}

// ===== Akun Administrator =====

async function seedAdministrator() {
  const role = await prisma.role.findUnique({ where: { name: ADMINISTRATOR_ROLE } })
  if (!role) throw new Error(`Role "${ADMINISTRATOR_ROLE}" tidak ditemukan — periksa ROLE_PERMISSIONS di shared/permissions.ts`)

  const passwordHash = bcrypt.hashSync(SEED_PASSWORD, 10)

  // Password hanya di-set saat akun dibuat: jangan menimpa password yang sudah
  // diganti sendiri oleh administrator.
  await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: { name: SEED_ADMIN_NAME, roleId: role.id, isLocked: false, failedLogins: 0 },
    create: { email: SEED_ADMIN_EMAIL, name: SEED_ADMIN_NAME, password: passwordHash, roleId: role.id }
  })

  console.log(`Akun administrator: ${SEED_ADMIN_EMAIL} — password "${SEED_PASSWORD}" (hanya berlaku bila akun baru dibuat)`)
}

async function main() {
  await seedPermissions()
  await seedRoles()
  await seedRolePermissions()
  await seedAdministrator()
  console.log('Seed selesai.')
}

// TODO Fase 1: 15 seeder Laravel yang belum diport — FacilityCategory,
// Facility, FacilityUnit, FacilityPrice, BookingSchedule, MembershipPlan,
// NewsCategory, News, PromoCarousel, SponsorLogo, Reel, Testimonial,
// InfoBanner, SystemSetting, dan akun contoh untuk kelima role staff.

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
