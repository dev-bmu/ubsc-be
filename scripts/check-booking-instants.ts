// ===== Pemeriksa invarian kolom turunan booking (bug 11, R13) =====
//
// Booking.startsAt / endsAt adalah denormalisasi dari bookingDate + startTime / endTime dalam jam
// JAKARTA, dan menjadi satu-satunya kolom yang boleh dipakai query rentang waktu. Kalau keduanya
// melenceng — penulis yang lupa memperbaruinya, import data Laravel, atau seeder Fase 1 yang dulu
// membaca jam Jakarta sebagai UTC — review dan laporan diam-diam memakai jam yang salah 7 jam.
//
// Sekalian memeriksa checkInToken: hook `creating` Laravel memberi SETIAP booking token, dan booking
// PAID tanpa token tidak punya tiket QR.
//
// Pemakaian:
//   npm run check:booking-instants            laporkan saja; exit 1 bila ada yang melenceng
//   npm run check:booking-instants -- --fix   perbaiki lewat Prisma (tidak pernah raw SQL, R2)

import { disconnectDatabase, prismaClient } from '../src/application/database'
import { dateOnlyToString, jakartaWallTimeToUtc } from '../src/utils/clock'
import { randomAlphanumeric } from '../src/utils/random'

const BATCH = 500

const main = async (): Promise<number> => {
  const fix = process.argv.includes('--fix')
  let cursor: string | undefined
  let checked = 0
  let wrongInstants = 0
  let missingTokens = 0

  for (;;) {
    const rows = await prismaClient.booking.findMany({
      select: { id: true, bookingDate: true, startTime: true, endTime: true, startsAt: true, endsAt: true, checkInToken: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    })
    if (rows.length === 0) break

    for (const row of rows) {
      checked++
      const date = dateOnlyToString(row.bookingDate)
      const startsAt = jakartaWallTimeToUtc(date, row.startTime)
      const endsAt = jakartaWallTimeToUtc(date, row.endTime)
      const instantsWrong = row.startsAt.getTime() !== startsAt.getTime() || row.endsAt.getTime() !== endsAt.getTime()
      const tokenMissing = !row.checkInToken

      if (instantsWrong) wrongInstants++
      if (tokenMissing) missingTokens++

      if (fix && (instantsWrong || tokenMissing)) {
        await prismaClient.booking.update({
          where: { id: row.id },
          data: { ...(instantsWrong ? { startsAt, endsAt } : {}), ...(tokenMissing ? { checkInToken: randomAlphanumeric(32) } : {}) }
        })
      }
    }

    cursor = rows[rows.length - 1].id
  }

  process.stdout.write(`Booking diperiksa: ${checked}\n`)
  process.stdout.write(`  startsAt/endsAt melenceng: ${wrongInstants}${fix && wrongInstants ? ' (diperbaiki)' : ''}\n`)
  process.stdout.write(`  checkInToken kosong:       ${missingTokens}${fix && missingTokens ? ' (diisi)' : ''}\n`)

  return !fix && (wrongInstants > 0 || missingTokens > 0) ? 1 : 0
}

main()
  .then(async (code) => {
    await disconnectDatabase()
    process.exit(code)
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`Pemeriksaan gagal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    await disconnectDatabase()
    process.exit(2)
  })
