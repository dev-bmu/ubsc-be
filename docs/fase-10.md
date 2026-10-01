# Fase 10 — Deploy ke VPS

Alur yang dipakai: **remote GitHub baru → push → di VPS `mkdir ubsc` → clone → `npm ci` → nginx**.
Tiga repo (`ubsc-api`, `ubsc-landing`, `ubsc-admin`) di-deploy sebagai empat proses PM2
(`ops/ecosystem.config.js`) di belakang nginx (`ops/nginx/ubsc.conf`).

Tata letak di VPS — ketiga `cwd` di `ecosystem.config.js` dan `alias` di `ubsc.conf` mengacu ke sini:

```
/var/www/ubsc/
├── ubsc-api/        clone repo API   → :4020 + worker cron
├── ubsc-landing/    clone repo landing → :3000  (ubsportcenter.co.id)
├── ubsc-admin/      clone repo admin   → :3001  (dash.ubsportcenter.co.id)
└── media/reels/     video di luar git (docs/media.md), dikirim rsync
```

Domain: `ubsportcenter.co.id` (landing) dan `dash.ubsportcenter.co.id` (admin). Keduanya mem-proxy
`/api` ke API yang sama supaya cookie sesi tetap same-origin. Kalau domainnya lain, ganti di tiga tempat:
`ubsc.conf`, `.env` API (`LANDING_URL`, `ADMIN_URL`, `API_BASE_URL`), dan env PM2 landing/admin.

---

## 0. Di mesin lokal — commit dan push

Ketiga repo lokal belum punya remote, dan commit terakhirnya masih Fase 3. Semua pekerjaan Fase 4–8
plus PRD tambahan masih uncommitted. Buat tiga repo kosong di GitHub (private), lalu per repo:

```bash
cd ubsc-api            # ulangi untuk ubsc-landing dan ubsc-admin
git add -A
git commit -m "Fase 4-8 + PRD tambahan 2026-09"
git remote add origin git@github.com:<org>/ubsc-api.git
git push -u origin main
```

Yang tidak boleh ikut (sudah di `.gitignore`, cek dengan `git status` sebelum commit): `.env`,
`.env.local`, `uploads/*`, `storage/private/**`, `storage/mail-preview/`, `dist/`, `.next/`.
`package-lock.json` WAJIB ikut — `npm ci` menolak repo tanpa lockfile.

Media (`../ubsc-media`, 134 MB) tidak ikut git. Pastikan manifest-nya cocok sebelum dikirim nanti:

```bash
cd ubsc-api && ops/scripts/sync-media.sh verify
```

---

## 1. Siapkan VPS (sekali)

Ubuntu 22.04/24.04, user non-root dengan sudo (di bawah dipakai `deploy`).

```bash
# Node 24 (sesuai .nvmrc) lewat nvm, PM2 global
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24 && nvm alias default 24
npm i -g pm2

# nginx, MySQL 8, certbot, rsync
sudo apt update
sudo apt install -y nginx mysql-server certbot python3-certbot-nginx rsync

# folder aplikasi
sudo mkdir -p /var/www/ubsc/media/reels
sudo chown -R deploy:deploy /var/www/ubsc
```

Database:

```sql
CREATE DATABASE ubsc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ubsc'@'localhost' IDENTIFIED BY '<password-kuat>';
GRANT ALL PRIVILEGES ON ubsc.* TO 'ubsc'@'localhost';
FLUSH PRIVILEGES;
```

DNS: A record `ubsportcenter.co.id`, `www`, dan `dash` → IP VPS. Tunggu resolve sebelum certbot.

---

## 2. Clone dan build

```bash
cd /var/www/ubsc
git clone git@github.com:<org>/ubsc-api.git
git clone git@github.com:<org>/ubsc-landing.git
git clone git@github.com:<org>/ubsc-admin.git
```

Catatan `npm ci`: **jangan** set `NODE_ENV=production` saat install. Build butuh devDependencies
(`tsc`, `prisma`, `next`), dan `prisma migrate deploy` butuh CLI-nya setiap deploy. `NODE_ENV=production`
disetel PM2 saat proses jalan, bukan saat install.

### 2a. API

```bash
cd /var/www/ubsc/ubsc-api
cp .env.example .env && nano .env        # isi sesuai tabel di bawah
npm ci
npx prisma migrate deploy                 # semua migrasi, termasuk 20260928*
npm run build                             # tsc → dist/, tulis contract-hash
npm run seed                              # HANYA deploy pertama: role, permission, akun staff awal
```

`.env` API — nilai produksi yang berbeda dari dev:

| Kunci | Nilai |
|---|---|
| `NODE_ENV` | `production` |
| `API_BASE_URL` | `https://ubsportcenter.co.id` (API hidup di bawah `/api` domain landing) |
| `LANDING_URL` | `https://ubsportcenter.co.id` |
| `ADMIN_URL` | `https://dash.ubsportcenter.co.id` |
| `DATABASE_URL` | `mysql://ubsc:<password>@localhost:3306/ubsc` |
| `CUSTOMER_ACCESS_TOKEN_SECRET` | `openssl rand -hex 32` — wajib ≥ 32 karakter di produksi |
| `STAFF_ACCESS_TOKEN_SECRET` | `openssl rand -hex 32` — **harus beda** dari customer |
| `COOKIE_DOMAIN` | kosong (cookie host-only memisahkan sesi landing dan admin — jangan isi `.ubsportcenter.co.id`) |
| `MAIL_TRANSPORT` | `smtp` |
| `MAIL_PORT` / `MAIL_SECURE` | `465` / `true`; bila VPS memblokir 465 pakai `587` / `false` (STARTTLS wajib otomatis) |
| `MAIL_PASSWORD` | password mailbox `no-reply@ubsportcenter.co.id` |
| `MEDIA_DIR` | `/var/www/ubsc/media` |
| `GOOGLE_REDIRECT_URI` | `https://ubsportcenter.co.id/api/auth/customer/google/callback` — daftarkan juga di Google Console |
| `LANDING_REVALIDATE_URL` | `http://127.0.0.1:3000/revalidate` (langsung ke port Next, bukan lewat nginx) |
| `LANDING_REVALIDATE_SECRET` | `openssl rand -hex 32` — samakan dengan `REVALIDATE_SECRET` landing |
| `SEED_PASSWORD` | password akun staff awal; ganti lewat panel setelah login pertama |

Seed hanya sekali. Menjalankannya lagi di DB yang sudah terisi tidak dibutuhkan dan, kalau `SEED_DEMO`
aktif, menambah data contoh. Setelah seed: login ke admin, ganti password semua akun staff, isi rekening
tujuan transfer di Pembayaran → Pengaturan, dan isi nomor item Accurate per fasilitas/paket.

### 2b. Landing

```bash
cd /var/www/ubsc/ubsc-landing
cp .env.example .env.local && nano .env.local
npm ci
npm run build
```

`.env.local` landing: `API_BASE_URL=http://127.0.0.1:4020`, `NEXT_PUBLIC_SITE_URL=https://ubsportcenter.co.id`,
`REVALIDATE_SECRET=<sama dengan LANDING_REVALIDATE_SECRET>`. `UBSC_API_LOCAL_PATH` boleh tetap `../ubsc-api`
(hanya dipakai `sync:contracts`, tidak jalan di server). `NEXT_PUBLIC_*` dibaca saat **build** — ubah
nilainya berarti build ulang.

### 2c. Admin

```bash
cd /var/www/ubsc/ubsc-admin
cp .env.example .env.local && nano .env.local
npm ci
npm run build
```

`.env.local` admin: `API_BASE_URL=http://127.0.0.1:4020`, `NEXT_PUBLIC_ADMIN_URL=https://dash.ubsportcenter.co.id`.

### 2d. Media

Dari mesin lokal (WSL, karena butuh rsync), tujuan default skrip sudah `deploy@ubsportcenter.co.id:/srv/ubsc/media`
— arahkan ke tata letak di atas:

```bash
cd ubsc-api
MEDIA_REMOTE=deploy@<ip-vps>:/var/www/ubsc/media MEDIA_DRY_RUN=1 ops/scripts/sync-media.sh push
MEDIA_REMOTE=deploy@<ip-vps>:/var/www/ubsc/media ops/scripts/sync-media.sh push
```

Lalu di VPS: `MEDIA_DIR=/var/www/ubsc/media ops/scripts/sync-media.sh verify` harus keluar 0.

---

## 3. PM2

```bash
cd /var/www/ubsc/ubsc-api
pm2 start ops/ecosystem.config.js
pm2 save
pm2 startup            # jalankan perintah sudo yang dicetaknya → autostart saat reboot
pm2 install pm2-logrotate
pm2 status             # ubsc-api, ubsc-worker, ubsc-landing, ubsc-admin semuanya online
```

Cek dari dalam VPS sebelum menyentuh nginx:

```bash
curl -s http://127.0.0.1:4020/api/health
curl -sI http://127.0.0.1:3000/ | head -1
curl -sI http://127.0.0.1:3001/login | head -1
```

Env PM2 (`NODE_ENV`, `TZ`, `PORT`, URL publik) ada di `ecosystem.config.js`, bukan di `.env`. Setelah
mengubah berkas itu: `pm2 restart ops/ecosystem.config.js --update-env`.

---

## 4. nginx

Konfigurasi ada di `ops/nginx/ubsc.conf`. Karena nginx-mu memakai `/etc/nginx/conf.d/nginx.conf`,
pilih salah satu:

```bash
# (a) include — berkas ikut ter-update tiap git pull
echo 'include /var/www/ubsc/ubsc-api/ops/nginx/ubsc.conf;' | sudo tee -a /etc/nginx/conf.d/nginx.conf
# (b) atau salin isinya ke dalam nginx.conf
```

Pastikan tidak ada `server_name` yang sama di blok lain, lalu:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d ubsportcenter.co.id -d www.ubsportcenter.co.id -d dash.ubsportcenter.co.id
```

Certbot menulis blok `listen 443 ssl` dan redirect 80→443 sendiri. Kalau memakai cara (a), certbot
mengubah berkas di dalam checkout; commit perubahan itu atau pindah ke cara (b) setelahnya.

Yang dikerjakan nginx (bukan Node) di produksi: `/uploads/*` dari `ubsc-api/uploads/`, `/assets/reels/*`
dari `media/reels/`, dan `/api/*` ke :4020. `rewrites()` di kedua `next.config.ts` hanya jalur dev.

---

## 5. Verifikasi setelah live

- `https://ubsportcenter.co.id/api/health` → `{"status":"ok"}`; `https://dash.ubsportcenter.co.id/api/health` sama.
- Daftar akun baru → email verifikasi masuk → klik tautan → `/verifikasi-email` sukses. Gagal kirim terlihat di
  `pm2 logs ubsc-api` sebagai `[mail] ... GAGAL`.
- Login admin → ubah fasilitas → beranda landing langsung berubah (revalidasi). Kalau tidak, cek
  `pm2 logs ubsc-api | grep -i revalidasi`.
- Video hero/footer/reels tampil (`/assets/reels/hero.mp4` → 200 dari nginx).
- Unggah foto member → tampil di `/uploads/members/...`.
- Booking → halaman bayar → unggah bukti → setujui di admin → email "Pembayaran dikonfirmasi".
- `pm2 logs ubsc-worker` menunjukkan sweep `payments:release-expired` tiap menit.

---

## 6. Update berikutnya

```bash
cd /var/www/ubsc/ubsc-api && git pull && npm ci && npx prisma migrate deploy && npm run build \
  && pm2 restart ubsc-api ubsc-worker

cd /var/www/ubsc/ubsc-landing && git pull && npm ci && npm run build && pm2 restart ubsc-landing
cd /var/www/ubsc/ubsc-admin   && git pull && npm ci && npm run build && pm2 restart ubsc-admin
```

Urutannya penting bila kontrak berubah: API dulu, baru kedua Next. `npm run build` API juga menulis
`dist/shared/contract-hash.json`; hash-nya harus sama dengan `src/types/contracts/.contract-hash` di
landing dan admin yang di-deploy bersamanya.

Downtime per restart hanya detik (PM2 fork mode, satu instance). Untuk nol downtime perlu dua
instance per app plus `pm2 reload` — di luar lingkup VPS tunggal (R15).

---

## 7. Yang belum dikerjakan (Fase 9, hardening)

- Diet aset: video 134 MB belum di-encode ulang; `/assets/reels` masih dari disk, belum CDN.
- Backup DB terjadwal (`mysqldump` + cron) dan backup `uploads/` + `storage/private/`.
- Rotasi log nginx dan pemantauan (uptime, ruang disk).
- Rate limit di nginx untuk `/api/auth/*` sebagai lapisan di luar express-rate-limit.
