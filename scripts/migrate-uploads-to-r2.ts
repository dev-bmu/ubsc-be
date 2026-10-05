// ===== Pindahkan berkas unggahan lokal ke Cloudflare R2 (sekali, saat beralih ke STORAGE_DRIVER=r2) =====
//
// 1. Salin seluruh isi UPLOAD_DIR (publik) dan PRIVATE_STORAGE_DIR (privat, kecuali tmp/) ke bucket
//    masing-masing dengan key yang SAMA, sehingga baris Media (uuid + fileName), proofPath, dan
//    identityFilePath langsung menunjuk objek yang benar tanpa diubah.
// 2. Tulis ulang kolom yang menyimpan URL publik bentuk lama '/uploads/...' (avatar, foto member,
//    QRIS, gambar kartu paket) menjadi URL R2 (publicUrl()).
//
// Aman diulang: objek ditimpa dengan isi yang sama, dan hanya baris yang masih '/uploads/...' yang
// ditulis ulang. Berkas lokal TIDAK dihapus — hapus manual setelah situs terverifikasi.
//
// Pemakaian (di server, setelah .env berisi STORAGE_DRIVER=r2 + R2_*):
//   npm run storage:migrate-r2 -- --dry-run   # hitung saja, tanpa unggah/tulis
//   npm run storage:migrate-r2

import { readdirSync, statSync } from 'fs'
import { extname, join, relative, resolve, sep } from 'path'
import { disconnectDatabase, prismaClient } from '../src/application/database'
import { PRIVATE_STORAGE_DIR, STORAGE_DRIVER, UPLOAD_DIR } from '../src/config'
import { publicUrl, putFile, StorageArea } from '../src/utils/storage'

const DRY_RUN = process.argv.includes('--dry-run')

const MIME_BY_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf'
}

/** Semua berkas di bawah `root` sebagai key '/'-separated. Dotfile (.gitkeep) dan folder `skip` dilewati. */
function listFiles(root: string, skip: string[] = []): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (dir === root && skip.includes(entry.name)) continue
        walk(full)
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  try {
    walk(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return out
}

async function uploadArea(area: StorageArea, root: string, skip: string[] = []): Promise<number> {
  const keys = listFiles(root, skip)
  let failed = 0
  for (const key of keys) {
    const full = join(root, key)
    const mime = MIME_BY_EXT[extname(key).toLowerCase()] ?? 'application/octet-stream'
    if (DRY_RUN) {
      console.log(`  [dry-run] ${area}/${key} (${statSync(full).size} byte)`)
      continue
    }
    try {
      await putFile(area, key, full, mime)
      console.log(`  ok ${area}/${key}`)
    } catch (error) {
      failed++
      console.error(`  GAGAL ${area}/${key}: ${(error as Error).message}`)
    }
  }
  console.log(`${area}: ${keys.length} berkas, ${failed} gagal`)
  return failed
}

/** '/uploads/<key>' -> URL R2. Null bila bukan bentuk lama. */
const migrated = (value: string | null): string | null =>
  value?.startsWith('/uploads/') ? publicUrl(decodeURI(value.slice('/uploads/'.length))) : null

async function rewriteUrls(): Promise<void> {
  const users = await prismaClient.user.findMany({
    where: { OR: [{ avatar: { startsWith: '/uploads/' } }, { memberPhotoPath: { startsWith: '/uploads/' } }] },
    select: { id: true, avatar: true, memberPhotoPath: true }
  })
  for (const user of users) {
    const avatar = migrated(user.avatar)
    const memberPhotoPath = migrated(user.memberPhotoPath)
    if (!DRY_RUN) {
      await prismaClient.user.update({
        where: { id: user.id },
        data: { ...(avatar ? { avatar } : {}), ...(memberPhotoPath ? { memberPhotoPath } : {}) }
      })
    }
  }

  const qris = await prismaClient.systemSetting.findUnique({ where: { key: 'payment_qris_image' } })
  const qrisUrl = migrated(qris?.value ?? null)
  if (qrisUrl && !DRY_RUN) await prismaClient.systemSetting.update({ where: { key: 'payment_qris_image' }, data: { value: qrisUrl } })

  const plans = await prismaClient.membershipPlan.findMany({
    where: { cardImageUrl: { startsWith: '/uploads/' } },
    select: { id: true, cardImageUrl: true }
  })
  for (const plan of plans) {
    if (!DRY_RUN) await prismaClient.membershipPlan.update({ where: { id: plan.id }, data: { cardImageUrl: migrated(plan.cardImageUrl) } })
  }

  console.log(`URL ditulis ulang: ${users.length} user, ${qrisUrl ? 1 : 0} QRIS, ${plans.length} paket${DRY_RUN ? ' (dry-run, tidak disimpan)' : ''}`)
}

async function main(): Promise<number> {
  if (STORAGE_DRIVER !== 'r2') {
    console.error('STORAGE_DRIVER bukan r2. Isi STORAGE_DRIVER=r2 dan seluruh R2_* di .env dulu.')
    return 1
  }
  const failed =
    (await uploadArea('public', resolve(process.cwd(), UPLOAD_DIR))) +
    (await uploadArea('private', resolve(process.cwd(), PRIVATE_STORAGE_DIR), ['tmp']))
  if (failed > 0) {
    console.error('Ada berkas yang gagal diunggah; URL di DB TIDAK ditulis ulang. Jalankan ulang setelah penyebabnya beres.')
    return 1
  }
  await rewriteUrls()
  return 0
}

main()
  .then(async (code) => {
    await disconnectDatabase()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error(error)
    await disconnectDatabase()
    process.exit(1)
  })
