// Buang seluruh cache ISR landing (semua tag). Dipakai setelah mengubah data langsung di DB, atau reset + seed.
// Pakai: npm run landing:revalidate
import '../src/config/load-env'
import { LANDING_TAGS, revalidateLanding } from '../src/middleware/revalidate-landing-middleware'

void revalidateLanding(LANDING_TAGS).then((ok) => {
  console.log(
    ok
      ? `Cache landing diperbarui: ${LANDING_TAGS.join(', ')}`
      : 'Gagal — cek LANDING_REVALIDATE_URL dan LANDING_REVALIDATE_SECRET di .env, dan pastikan landing sedang jalan.'
  )
  process.exit(ok ? 0 : 1)
})
