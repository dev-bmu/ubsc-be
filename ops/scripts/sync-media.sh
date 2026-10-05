#!/usr/bin/env bash
#
# ===== sync-media.sh — direktori media bersama (R9) =====
#
# Media berat (video reel, gambar hero, gambar konten) TIDAK masuk git. Berkasnya tinggal di satu
# direktori bersama, dipindahkan dengan rsync, dan yang ikut git hanyalah manifest sha256-nya —
# itu yang membuat isi direktori media bisa diverifikasi meskipun berkasnya sendiri tidak terlacak.
# Penjelasan lengkap dan daftar aset: ../../docs/media.md
#
# Sub-perintah:
#   manifest   Hasilkan atau perbarui manifest sha256 dari isi direktori media.
#   verify     Bandingkan isi direktori media dengan manifest; laporkan selisih, keluar 1 bila beda.
#   push       rsync direktori media lokal ke server.
#   pull       rsync direktori media dari server ke lokal.
#
# Parameter lewat variabel lingkungan (semua punya default):
#   MEDIA_DIR          Direktori media lokal.        Default: <root-repo>/../ubsc-media
#   MEDIA_REMOTE       Tujuan rsync di server.       Default: root@ubsportcenter.co.id:/var/www/ubsc/media
#   MANIFEST_FILE      Lokasi manifest (ikut git).   Default: <root-repo>/ops/media-manifest.txt
#   MEDIA_DELETE       1 = teruskan --delete ke rsync supaya sisi tujuan persis sama. Default: 0
#   MEDIA_DRY_RUN      1 = rsync --dry-run, tidak ada yang benar-benar dipindahkan. Default: 0
#   MEDIA_SKIP_VERIFY  1 = izinkan push meski manifest belum cocok. Default: 0
#   RSYNC_SSH          Perintah ssh untuk rsync -e.  Default: ssh
#
# Contoh:
#   ops/scripts/sync-media.sh manifest
#   MEDIA_DRY_RUN=1 ops/scripts/sync-media.sh push
#   MEDIA_DIR=/d/ubsc-media MEDIA_DELETE=1 ops/scripts/sync-media.sh pull
#
# Catatan Windows: berkas ini WAJIB berakhiran baris LF (.gitattributes sudah memaksa *.sh eol=lf).
# Dengan CRLF, server menolaknya dengan "bad interpreter: /bin/bash^M".
# Bit eksekusinya disetel sekali dengan: git update-index --chmod=+x ops/scripts/sync-media.sh
#
# rsync tidak tersedia di Git Bash bawaan. Jalankan push/pull dari WSL, dari Git Bash yang sudah
# dipasangi rsync, atau langsung di server. Sub-perintah manifest dan verify hanya butuh sha256sum.

set -euo pipefail

# ===== Lokasi =====

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

MEDIA_DIR="${MEDIA_DIR:-$REPO_ROOT/../ubsc-media}"
MEDIA_REMOTE="${MEDIA_REMOTE:-root@ubsportcenter.co.id:/var/www/ubsc/media}"
MANIFEST_FILE="${MANIFEST_FILE:-$REPO_ROOT/ops/media-manifest.txt}"
MEDIA_DELETE="${MEDIA_DELETE:-0}"
MEDIA_DRY_RUN="${MEDIA_DRY_RUN:-0}"
MEDIA_SKIP_VERIFY="${MEDIA_SKIP_VERIFY:-0}"
RSYNC_SSH="${RSYNC_SSH:-ssh}"

# Berkas sampah sistem yang tidak pernah dianggap media.
EXCLUDES=('.DS_Store' 'Thumbs.db' 'desktop.ini' '.gitkeep')

# Satu berkas sementara untuk seluruh skrip, dibersihkan lewat trap EXIT.
# Sengaja BUKAN trap RETURN per fungsi: tanpa `set -o functrace`, trap RETURN tidak terbatas pada
# fungsi tempat ia dipasang dan akan ikut jalan saat fungsi lain selesai, ketika variabelnya sudah
# tidak ada lagi — dan dengan `set -u` itu mematikan skrip di akhir eksekusi yang sebenarnya sukses.
TMP_FILE=''

cleanup() {
  if [ -n "$TMP_FILE" ]; then
    rm -f -- "$TMP_FILE"
  fi
  return 0
}

trap cleanup EXIT

# ===== Utilitas =====

log() {
  printf '%s\n' "$*" >&2
}

die() {
  printf 'sync-media: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "perintah '$1' tidak ditemukan. $2"
}

# Nama berkas berspasi masih ada sampai rename kebab-case di Fase 9 dijalankan, jadi seluruh skrip ini
# memakai -print0 dan pembacaan per-NUL. Jangan "sederhanakan" menjadi for-loop atas hasil find.
ensure_media_dir() {
  [ -d "$MEDIA_DIR" ] || die "direktori media tidak ada: $MEDIA_DIR (setel MEDIA_DIR atau jalankan 'pull' lebih dulu)"
}

# Memilih implementasi sha256 yang tersedia.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | cut -d' ' -f1
  else
    shasum -a 256 -- "$1" | cut -d' ' -f1
  fi
}

# Ukuran berkas dalam byte. GNU stat dan BSD stat memakai flag berbeda.
size_of() {
  if stat -c %s -- "$1" >/dev/null 2>&1; then
    stat -c %s -- "$1"
  else
    stat -f %z -- "$1"
  fi
}

# Menulis manifest ke stdout. Format per baris: <sha256><2 spasi><ukuran byte><2 spasi><path relatif>.
# Diurutkan LC_ALL=C supaya diff-nya stabil di mesin mana pun.
build_manifest() {
  local find_args=(-type f)
  local name
  for name in "${EXCLUDES[@]}"; do
    find_args+=(! -name "$name")
  done

  local file rel hash size
  while IFS= read -r -d '' file; do
    rel="${file#"$MEDIA_DIR"/}"
    hash="$(sha256_of "$file")"
    size="$(size_of "$file")"
    printf '%s  %s  %s\n' "$hash" "$size" "$rel"
  done < <(find "$MEDIA_DIR" "${find_args[@]}" -print0) | LC_ALL=C sort -k3
}

# ===== Sub-perintah: manifest =====

cmd_manifest() {
  ensure_media_dir
  require_cmd find 'pasang coreutils atau jalankan dari Git Bash.'

  TMP_FILE="$(mktemp)"
  build_manifest >"$TMP_FILE"

  mkdir -p -- "$(dirname -- "$MANIFEST_FILE")"

  local count total
  count="$(wc -l <"$TMP_FILE" | tr -d ' ')"
  total="$(awk '{ s += $2 } END { printf "%d", s + 0 }' "$TMP_FILE")"

  if [ -f "$MANIFEST_FILE" ] && cmp -s "$TMP_FILE" "$MANIFEST_FILE"; then
    log "Manifest sudah mutakhir: $count berkas, $total byte."
    log "  $MANIFEST_FILE"
    return 0
  fi

  cp -- "$TMP_FILE" "$MANIFEST_FILE"
  log "Manifest diperbarui: $count berkas, $total byte."
  log "  $MANIFEST_FILE"
  log ''
  log 'Langkah berikutnya: COMMIT perubahan manifest ini lebih dulu, baru jalankan push.'
  log 'Manifest yang di-commit setelah push membuat jejak perubahannya hilang.'
}

# ===== Sub-perintah: verify =====

cmd_verify() {
  ensure_media_dir
  [ -f "$MANIFEST_FILE" ] || die "manifest belum ada: $MANIFEST_FILE (jalankan 'manifest' lebih dulu)"

  TMP_FILE="$(mktemp)"
  build_manifest >"$TMP_FILE"

  if cmp -s "$TMP_FILE" "$MANIFEST_FILE"; then
    log "Cocok: isi $MEDIA_DIR sama persis dengan manifest."
    return 0
  fi

  log "BEDA: isi $MEDIA_DIR tidak sama dengan manifest."
  log ''
  log 'Baris berawalan "-" hanya ada di manifest (berkas hilang atau berubah isinya),'
  log 'baris berawalan "+" hanya ada di direktori media (berkas baru atau berubah isinya).'
  log ''
  diff -- "$MANIFEST_FILE" "$TMP_FILE" | sed -n 's/^< /- /p; s/^> /+ /p' >&2 || true
  return 1
}

# ===== Sub-perintah: push / pull =====

rsync_flags() {
  local flags=(-a --human-readable --partial --info=progress2 -e "$RSYNC_SSH")
  local name
  for name in "${EXCLUDES[@]}"; do
    flags+=(--exclude "$name")
  done
  [ "$MEDIA_DELETE" = '1' ] && flags+=(--delete)
  [ "$MEDIA_DRY_RUN" = '1' ] && flags+=(--dry-run)
  printf '%s\n' "${flags[@]}"
}

cmd_push() {
  ensure_media_dir
  require_cmd rsync 'jalankan dari WSL, dari Git Bash yang sudah dipasangi rsync, atau langsung di server.'

  # Push dengan manifest basi berarti server memegang berkas yang tidak tercatat di git.
  if [ "$MEDIA_SKIP_VERIFY" != '1' ]; then
    cmd_verify || die "manifest belum cocok. Jalankan 'manifest', commit hasilnya, lalu push lagi (atau setel MEDIA_SKIP_VERIFY=1)."
  fi

  local flags
  mapfile -t flags < <(rsync_flags)

  log "Push: $MEDIA_DIR/ -> $MEDIA_REMOTE/"
  [ "$MEDIA_DRY_RUN" = '1' ] && log '(dry run — tidak ada berkas yang benar-benar dipindahkan)'
  [ "$MEDIA_DELETE" = '1' ] && log '(--delete aktif — berkas di server yang tidak ada di lokal akan DIHAPUS)'

  rsync "${flags[@]}" -- "$MEDIA_DIR/" "$MEDIA_REMOTE/"
}

cmd_pull() {
  require_cmd rsync 'jalankan dari WSL, dari Git Bash yang sudah dipasangi rsync, atau langsung di server.'

  mkdir -p -- "$MEDIA_DIR"

  local flags
  mapfile -t flags < <(rsync_flags)

  log "Pull: $MEDIA_REMOTE/ -> $MEDIA_DIR/"
  [ "$MEDIA_DRY_RUN" = '1' ] && log '(dry run — tidak ada berkas yang benar-benar dipindahkan)'
  [ "$MEDIA_DELETE" = '1' ] && log '(--delete aktif — berkas lokal yang tidak ada di server akan DIHAPUS)'

  rsync "${flags[@]}" -- "$MEDIA_REMOTE/" "$MEDIA_DIR/"

  log ''
  log "Selesai. Jalankan 'verify' untuk memastikan hasilnya cocok dengan manifest."
}

# ===== Bantuan =====

usage() {
  cat <<'USAGE'
Penggunaan: sync-media.sh <manifest|verify|push|pull>

  manifest   Hasilkan atau perbarui manifest sha256 dari isi direktori media.
  verify     Bandingkan isi direktori media dengan manifest (keluar 1 bila berbeda).
  push       rsync direktori media lokal ke server. Menolak jalan bila manifest belum cocok.
  pull       rsync direktori media dari server ke lokal.

Variabel lingkungan: MEDIA_DIR, MEDIA_REMOTE, MANIFEST_FILE, MEDIA_DELETE,
MEDIA_DRY_RUN, MEDIA_SKIP_VERIFY, RSYNC_SSH. Lihat komentar di kepala berkas ini
dan docs/media.md.
USAGE
}

# ===== Entry point =====

main() {
  local cmd="${1:-}"
  case "$cmd" in
    manifest) cmd_manifest ;;
    verify) cmd_verify ;;
    push) cmd_push ;;
    pull) cmd_pull ;;
    -h | --help | help | '') usage ;;
    *)
      usage >&2
      die "sub-perintah tidak dikenal: $cmd"
      ;;
  esac
}

main "$@"
