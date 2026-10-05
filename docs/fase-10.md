# Fase 10 — Deploy ke VPS

Alur yang dipakai: **push ke GitHub → di VPS clone → `npm ci` → build → PM2 → nginx**.
Tiga repo di-deploy sebagai empat proses PM2 (`ops/ecosystem.config.js`). Konfigurasi nginx ditempel
sendiri di `/etc/nginx/conf.d/nginx.conf` server, dengan bentuk yang sama seperti aplikasi lain di sana
(isinya di §4).

Tata letak di VPS — `cwd` di `ecosystem.config.js` mengacu ke sini:

```
/var/www/ubsc/be               repo dev-bmu/ubsc-be       → :4010 + worker cron   api.ubsportcenter.co.id
/var/www/ubsc/fe               repo dev-bmu/ubsc-dash-fe  → :3010                 dash.ubsportcenter.co.id
/var/www/apps/ubsc-landing     repo dev-bmu/ubsc-landing  → :3737                 ubsportcenter.co.id
```

Berkas tidak disimpan di VPS. Semuanya di Cloudflare R2 (§2d):

```
bucket publik (mis. ubsc)          reels/*.mp4      video ubsc-media         → cdn.ubsportcenter.co.id/reels/...
                                   uploads/...      CMS, foto member,        → cdn.ubsportcenter.co.id/uploads/...
                                                    avatar, QRIS
bucket privat (mis. ubsc-private)  payment-proofs/  bukti bayar              → hanya lewat API (staff/pemilik)
                                   identity/        dokumen identitas
```

Pastikan port 3737, 3010, dan 4010 bebas sebelum mulai:

```bash
ss -ltnp | grep -E ':(3737|3010|4010)\b' || echo "bebas"
```

Cara request mengalir:

- `ubsportcenter.co.id` dan `dash.ubsportcenter.co.id` → nginx → Next. Next meneruskan `/api/*` dan
  `/uploads/*` ke API (127.0.0.1:4010) lewat `rewrites()`. Browser tetap same-origin, dan itu syarat
  cookie login: cookie refresh httpOnly host-only per domain juga yang memisahkan sesi pelanggan dan staff.
- `api.ubsportcenter.co.id` → nginx → API langsung. Hanya mengikuti struktur FE/BE server ini (cek
  kesehatan, akses langsung); landing dan admin **tidak** memanggil domain ini.
- `cdn.ubsportcenter.co.id` → custom domain bucket R2 publik, tanpa VPS sama sekali. Landing memakainya
  lewat `NEXT_PUBLIC_MEDIA_URL`, API lewat `R2_PUBLIC_URL` (URL unggahan `.../uploads/...`).

---

## 0. Di mesin lokal — commit dan push

Remote ketiga repo memakai alias SSH `github-kantor` (akun GitHub perusahaan):

| Repo lokal     | Remote                                       |
| -------------- | -------------------------------------------- |
| `ubsc-api`     | `git@github-kantor:dev-bmu/ubsc-be.git`      |
| `ubsc-admin`   | `git@github-kantor:dev-bmu/ubsc-dash-fe.git` |
| `ubsc-landing` | `git@github-kantor:dev-bmu/ubsc-landing.git` |

```bash
git add -A && git commit -m "..." && git push -u origin main
```

Yang tidak boleh ikut (sudah di `.gitignore`, cek `git status` sebelum commit): `.env`, `.env.local`,
`uploads/*`, `storage/private/**`, `storage/mail-preview/`, `dist/`, `.next/`.
`package-lock.json` WAJIB ikut — `npm ci` menolak repo tanpa lockfile.

Media (`../ubsc-media`, 134 MB) tidak ikut git. Cek manifest-nya sebelum dikirim:

```bash
cd ubsc-api && ops/scripts/sync-media.sh verify
```

---

## 1. Siapkan VPS (sekali)

Node harus versi 24 (`.nvmrc`). VPS ini sudah punya nginx, PM2, dan certbot untuk aplikasi lain; cek saja:

```bash
node -v          # v24.x — kalau beda: nvm install 24 (aplikasi lain tetap memakai versinya sendiri)
pm2 -v
mysql --version  # MySQL 8
```

Folder:

```bash
mkdir -p /var/www/apps
```

Database. Password dibuat dari huruf, angka, dan `-` saja: lolos kebijakan `validate_password` MySQL
(huruf besar, kecil, angka, simbol) dan tidak perlu di-encode di `DATABASE_URL`.

```bash
echo "Ubsc-$(openssl rand -hex 16)"     # simpan hasilnya
sudo mysql                               # atau: mysql -u root -p
```

```sql
CREATE DATABASE ubsc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ubsc'@'localhost' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON ubsc.* TO 'ubsc'@'localhost';
FLUSH PRIVILEGES;
```

Uji lewat TCP, jalur yang dipakai API: `mysql -u ubsc -p -h 127.0.0.1 ubsc -e "SELECT 1"`. Bila ditolak
`Access denied for user 'ubsc'@'127.0.0.1'`, buat juga akun `'ubsc'@'127.0.0.1'` dengan password dan
GRANT yang sama.

DNS: A record `ubsportcenter.co.id`, `www`, `dash`, dan `api` → IP VPS. Tunggu resolve sebelum certbot.
`cdn` TIDAK ke VPS: record-nya dibuat otomatis saat custom domain dihubungkan ke bucket R2 (§2d).

---

## 2. Clone dan build

Repo publik bisa di-clone lewat HTTPS tanpa kunci. Kalau repo dijadikan private, pasang deploy key
(read-only) di VPS dan pakai URL `git@github.com:...`.

```bash
git clone https://github.com/dev-bmu/ubsc-be.git        /var/www/ubsc/be
git clone https://github.com/dev-bmu/ubsc-dash-fe.git   /var/www/ubsc/fe
git clone https://github.com/dev-bmu/ubsc-landing.git   /var/www/apps/ubsc-landing
```

Catatan `npm ci`: **jangan** set `NODE_ENV=production` saat install. Build butuh devDependencies
(`tsc`, `prisma`, `next`), dan `prisma migrate deploy` butuh CLI-nya setiap deploy. `NODE_ENV=production`
disetel PM2 saat proses jalan, bukan saat install.

### 2a. API — `/var/www/ubsc/be`

```bash
cd /var/www/ubsc/be
nano .env                                 # isi seperti contoh di bawah (BUKAN .env.local)
npm ci
npx prisma migrate deploy                 # semua migrasi
npm run build                             # tsc → dist/, tulis contract-hash
npm run seed                              # HANYA deploy pertama: role, permission, akun staff awal
```

API membaca `.env.local` bila ada, selain itu `.env` — tidak digabung (`src/config/load-env.ts`). Di laptop
isinya `.env.local`; di server HANYA `.env`. Templat produksi yang bersih ada di `.env` laptop (tidak
ikut git): salin isinya ke `/var/www/ubsc/be/.env`, lalu ganti semua `<...>`.

`.env` API — nilai produksi yang berbeda dari dev:

| Kunci                                       | Nilai                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                  | `production`                                                                                                                                             |
| `API_BASE_URL`                              | `https://ubsportcenter.co.id` — **bukan** `api.ubsportcenter.co.id`; dipakai untuk tautan email dan redirect OAuth yang harus mendarat di domain landing |
| `LANDING_URL`                               | `https://ubsportcenter.co.id`                                                                                                                            |
| `ADMIN_URL`                                 | `https://dash.ubsportcenter.co.id`                                                                                                                       |
| `DATABASE_URL`                              | `mysql://ubsc:<password>@localhost:3306/ubsc`                                                                                                            |
| `CUSTOMER_ACCESS_TOKEN_SECRET`              | `openssl rand -hex 32` — wajib ≥ 32 karakter di produksi                                                                                                 |
| `STAFF_ACCESS_TOKEN_SECRET`                 | `openssl rand -hex 32` — **harus beda** dari customer                                                                                                    |
| `COOKIE_DOMAIN`                             | kosong (cookie host-only memisahkan sesi landing dan admin — jangan isi `.ubsportcenter.co.id`)                                                          |
| `MAIL_TRANSPORT`                            | `smtp`                                                                                                                                                   |
| `MAIL_PORT` / `MAIL_SECURE`                 | `465` / `true`; bila VPS memblokir 465 pakai `587` / `false` (STARTTLS wajib otomatis)                                                                   |
| `MAIL_PASSWORD`                             | password mailbox `no-reply@ubsportcenter.co.id`                                                                                                          |
| `GOOGLE_REDIRECT_URI`                       | `https://ubsportcenter.co.id/api/auth/customer/google/callback` — daftarkan juga di Google Console                                                       |
| `LANDING_REVALIDATE_URL`                    | `http://127.0.0.1:3737/revalidate` (langsung ke port Next, bukan lewat nginx)                                                                            |
| `LANDING_REVALIDATE_SECRET`                 | `openssl rand -hex 32` — samakan dengan `REVALIDATE_SECRET` landing                                                                                      |
| `SEED_PASSWORD`                             | password akun staff awal; ganti lewat panel setelah login pertama                                                                                        |
| `STORAGE_DRIVER`                            | `r2`                                                                                                                                                     |
| `R2_ACCOUNT_ID`                             | Account ID Cloudflare (halaman R2, kolom kanan)                                                                                                          |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | dari token API R2 (§2d). Rahasia — jangan ditempel ke chat/commit                                                                                        |
| `R2_PUBLIC_BUCKET`                          | bucket yang terhubung ke `cdn.ubsportcenter.co.id`                                                                                                       |
| `R2_PRIVATE_BUCKET`                         | bucket bukti bayar + KTP, harus beda bucket                                                                                                              |
| `R2_PUBLIC_URL`                             | `https://cdn.ubsportcenter.co.id` — sama dengan `NEXT_PUBLIC_MEDIA_URL` landing                                                                          |

`PORT` tidak perlu diisi di `.env`; PM2 menyetelnya (4010). `MEDIA_DIR` juga tidak perlu: video
produksi disajikan R2 lewat `cdn.ubsportcenter.co.id`.

Seed hanya sekali. Menjalankannya lagi di DB yang sudah terisi tidak dibutuhkan dan, kalau `SEED_DEMO`
aktif, menambah data contoh. Setelah seed: login ke admin, ganti password semua akun staff, unggah gambar
QRIS di Pembayaran → Pengaturan Pembayaran, dan isi nomor item Accurate per fasilitas/paket.

### 2b. Landing — `/var/www/apps/ubsc-landing`

```bash
cd /var/www/apps/ubsc-landing
cp .env.example .env.local && nano .env.local
npm ci
npm run build
```

`.env.local` landing:

| Kunci                   | Nilai                                       |
| ----------------------- | ------------------------------------------- |
| `API_BASE_URL`          | `http://127.0.0.1:4010`                     |
| `NEXT_PUBLIC_SITE_URL`  | `https://ubsportcenter.co.id`               |
| `NEXT_PUBLIC_MEDIA_URL` | `https://cdn.ubsportcenter.co.id`           |
| `REVALIDATE_SECRET`     | sama dengan `LANDING_REVALIDATE_SECRET` API |

Tiga kunci pertama dibaca saat **build** — mengubah nilainya berarti build ulang.

`UBSC_API_LOCAL_PATH` tidak dipakai di server: variabel ini hanya dibaca `npm run sync:contracts` di
laptop pengembang (menyalin `ubsc-api/shared/*.ts` ke `src/types/contracts/`). Salinan kontrak sudah ikut
git, jadi build tidak membutuhkannya. Boleh dihapus dari `.env.local` produksi.

### 2c. Admin — `/var/www/ubsc/fe`

```bash
cd /var/www/ubsc/fe
cp .env.example .env.local && nano .env.local
npm ci
npm run build
```

`.env.local` admin: `API_BASE_URL=http://127.0.0.1:4010`, `NEXT_PUBLIC_ADMIN_URL=https://dash.ubsportcenter.co.id`.

### 2d. Cloudflare R2 (CDN + semua unggahan)

Sekali, di dashboard Cloudflare:

1. **Bucket publik** (mis. `ubsc`): upload 8 video `ubsc-media` ke folder `reels/`
   (`reels/hero.mp4`, `reels/Footer.mp4`, ...). Settings → Custom Domains → hubungkan
   `cdn.ubsportcenter.co.id` (hapus dulu record DNS `cdn` lama bila ada). `r2.dev` biarkan nonaktif.
2. **Bucket privat** (mis. `ubsc-private`): TANPA custom domain, TANPA r2.dev.
3. **Token API**: R2 → Manage API tokens → Create → izin **Object Read & Write**, batasi ke kedua bucket.
   Salin Access Key ID + Secret Access Key langsung ke `.env` API (§2a).
4. **CORS untuk unduhan PNG E-card**: Rules → Transform Rules → Modify Response Header → jika hostname
   sama dengan `cdn.ubsportcenter.co.id`, set header statis `Access-Control-Allow-Origin: *`. Tanpa ini
   E-card tetap terunduh, tapi tanpa foto member.

Objek `uploads/` dikirim API dengan `Cache-Control: public, max-age=31536000, immutable` — nama berkasnya
selalu acak dan tidak pernah ditimpa. Video `reels/` di-cache sesuai aturan Cloudflare; mengganti video
dengan nama yang sama butuh purge cache URL-nya.

**Pindah dari disk ke R2** (server yang sudah berjalan dengan berkas di `uploads/` + `storage/private/`):

```bash
cd /var/www/ubsc/be
nano .env                                        # STORAGE_DRIVER=r2 + keenam R2_*
npm run storage:migrate-r2 -- --dry-run          # daftar berkas yang akan diunggah
npm run storage:migrate-r2                       # unggah + tulis ulang URL lama '/uploads/...' di DB
pm2 restart ubsc-api ubsc-worker
```

Skrip aman diulang. Berkas lokal tidak dihapus; setelah gambar, video reels, bukti bayar, dan dokumen
identitas terbuka normal, `uploads/` dan `storage/private/` (kecuali `tmp/`) boleh dihapus.

---

## 3. PM2

```bash
cd /var/www/ubsc/be
pm2 start ops/ecosystem.config.js
pm2 save               # menyimpan daftar proses, termasuk aplikasi lain yang sudah jalan
pm2 status             # ubsc-api, ubsc-worker, ubsc-landing, ubsc-admin semuanya online
```

`pm2 startup` dan `pm2-logrotate` kemungkinan sudah terpasang untuk aplikasi lain; cek `pm2 ls` dan
`pm2 module:list`.

Cek dari dalam VPS sebelum menyentuh nginx:

```bash
curl -s http://127.0.0.1:4010/api/health
curl -s http://127.0.0.1:3737/api/health      # lewat rewrite landing -> API
curl -sI http://127.0.0.1:3010/login | head -1
```

Env PM2 (`NODE_ENV`, `TZ`, `PORT`, URL publik) ada di `ecosystem.config.js`, bukan di `.env`. Setelah
mengubah berkas itu: `pm2 restart ops/ecosystem.config.js --update-env`.

---

## 4. nginx

Ambil sertifikat dulu — blok 443 di bawah merujuk berkasnya, jadi `nginx -t` gagal kalau belum ada.
`certonly` tidak mengubah `nginx.conf`:

```bash
sudo certbot certonly --nginx -d ubsportcenter.co.id -d www.ubsportcenter.co.id
sudo certbot certonly --nginx -d dash.ubsportcenter.co.id
sudo certbot certonly --nginx -d api.ubsportcenter.co.id
```

Lalu tempel ke bagian bawah `/etc/nginx/conf.d/nginx.conf`:

```nginx
###################### UBSC ############################
########## FE (landing) ##########
server {
    listen 80;
    listen [::]:80;
    server_name ubsportcenter.co.id www.ubsportcenter.co.id; # the hostname
    return 302 https://$server_name$request_uri; ## all traffic through port 80 will be forwarded to 443
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    ssl_certificate         /etc/letsencrypt/live/ubsportcenter.co.id/fullchain.pem; #path to your public key
    ssl_certificate_key     /etc/letsencrypt/live/ubsportcenter.co.id/privkey.pem; #path to your private key
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_name ubsportcenter.co.id www.ubsportcenter.co.id; # the hostname
    location / {
    client_max_body_size 12m;
    proxy_pass http://127.0.0.1:3737; # ubsc-landing
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    # Memberitahu aplikasi backend IP asli pengguna
    proxy_set_header X-Real-IP $remote_addr;
    # Memberitahu aplikasi backend daftar IP (termasuk proxy)
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Memberitahu aplikasi backend protokol asli (http/https)
    proxy_set_header X-Forwarded-Proto $scheme;
    }
}

########## FE (dashboard) ##########
server {
    listen 80;
    listen [::]:80;
    server_name dash.ubsportcenter.co.id; # the hostname
    return 302 https://$server_name$request_uri; ## all traffic through port 80 will be forwarded to 443
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    ssl_certificate         /etc/letsencrypt/live/dash.ubsportcenter.co.id/fullchain.pem; #path to your public key
    ssl_certificate_key     /etc/letsencrypt/live/dash.ubsportcenter.co.id/privkey.pem; #path to your private key
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_name dash.ubsportcenter.co.id; # the hostname
    location / {
    client_max_body_size 12m;
    proxy_pass http://127.0.0.1:3010; # ubsc-admin
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    # Memberitahu aplikasi backend IP asli pengguna
    proxy_set_header X-Real-IP $remote_addr;
    # Memberitahu aplikasi backend daftar IP (termasuk proxy)
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Memberitahu aplikasi backend protokol asli (http/https)
    proxy_set_header X-Forwarded-Proto $scheme;
    }
}

######### BE #########
server {
    listen 80;
    listen [::]:80;
    server_name api.ubsportcenter.co.id; # the hostname
    return 302 https://$server_name$request_uri; ## all traffic through port 80 will be forwarded to 443
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    ssl_certificate         /etc/letsencrypt/live/api.ubsportcenter.co.id/fullchain.pem; #path to your public key
    ssl_certificate_key     /etc/letsencrypt/live/api.ubsportcenter.co.id/privkey.pem; #path to your private key
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_name api.ubsportcenter.co.id; # the hostname
    location / {
    client_max_body_size 12m;
    proxy_pass http://127.0.0.1:4010; # ubsc-api
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    # Memberitahu aplikasi backend IP asli pengguna
    proxy_set_header X-Real-IP $remote_addr;
    # Memberitahu aplikasi backend daftar IP (termasuk proxy)
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Memberitahu aplikasi backend protokol asli (http/https)
    proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`cdn.ubsportcenter.co.id` tidak punya blok nginx: domain itu dilayani langsung oleh R2. Bila blok CDN
lama masih ada di `nginx.conf`, hapus bloknya dulu, `nginx -t && systemctl reload nginx`, baru
`certbot delete --cert-name cdn.ubsportcenter.co.id` (urutan terbalik membuat `nginx -t` gagal).

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`client_max_body_size 12m` wajib — default nginx 1 MB, sedangkan bukti bayar/foto member sampai 10 MB.
Perpanjangan sertifikat otomatis lewat timer certbot yang sudah ada (`certbot renew --dry-run` untuk cek).

Next tidak menambah `X-Forwarded-For` saat meneruskan `/api`, jadi `trust proxy 1` di API tetap membaca
IP asli yang ditulis nginx (rate limit per IP tetap benar), baik lewat landing/dashboard maupun `api.`.

---

## 5. Verifikasi setelah live

- `https://ubsportcenter.co.id/api/health`, `https://dash.ubsportcenter.co.id/api/health`, dan
  `https://api.ubsportcenter.co.id/api/health` → `{"status":"ok"}`.
- `curl -sI https://cdn.ubsportcenter.co.id/reels/hero.mp4` → `200`, `Content-Type: video/mp4`.
- Beranda: video hero, footer, reels CMS, dan gambar fasilitas/berita tampil (Network tab: semuanya dari
  `cdn.ubsportcenter.co.id`).
- Bukti bayar dan dokumen identitas terbuka di admin (dibaca API dari bucket privat). URL bucket privat
  tidak pernah muncul di browser.
- Daftar akun baru → email verifikasi masuk → klik tautan → `/verifikasi-email` sukses. Gagal kirim terlihat di
  `pm2 logs ubsc-api` sebagai `[mail] ... GAGAL`.
- Login admin → ubah fasilitas → beranda landing langsung berubah (revalidasi). Kalau tidak, cek
  `pm2 logs ubsc-api | grep -i revalidasi`.
- Unggah foto member → tampil dari `cdn.ubsportcenter.co.id/uploads/members/...`; QRIS tampil di halaman bayar.
- Unduh E-card PNG di dashboard pelanggan → foto member ikut tergambar (butuh aturan CORS §2d).
- Booking → halaman bayar → unggah bukti → setujui di admin → email "Pembayaran dikonfirmasi".
- `pm2 logs ubsc-worker` menunjukkan sweep `payments:release-expired` tiap menit.

---

## 6. Update berikutnya

```bash
cd /var/www/ubsc/be && git pull && npm ci && npx prisma migrate deploy && npm run build \
  && pm2 restart ubsc-api ubsc-worker

cd /var/www/apps/ubsc-landing && git pull && npm ci && npm run build && pm2 restart ubsc-landing
cd /var/www/ubsc/fe && git pull && npm ci && npm run build && pm2 restart ubsc-admin
```

Urutannya penting bila kontrak berubah: API dulu, baru kedua Next. `npm run build` API juga menulis
`dist/shared/contract-hash.json`; hash-nya harus sama dengan `src/types/contracts/.contract-hash` di
landing dan admin yang di-deploy bersamanya.

Downtime per restart hanya detik (PM2 fork mode, satu instance). Untuk nol downtime perlu dua
instance per app plus `pm2 reload` — di luar lingkup VPS tunggal (R15).

---

## 7. Yang belum dikerjakan (Fase 9, hardening)

- Diet aset: video 134 MB belum di-encode ulang.
- Backup DB terjadwal (`mysqldump` + cron). Berkas sudah di R2; objek yatim (hapus di latar yang gagal)
  belum disapu.
- Rotasi log nginx dan pemantauan (uptime, ruang disk).
- Rate limit di nginx untuk `/api/auth/*` sebagai lapisan di luar express-rate-limit.
