#!/usr/bin/env bash
# pasang.sh - pasang sakti CLI + dependensi, lalu arahkan ke `sakti setup`.
#
#   bash pasang.sh                                  # pasang ke ~/.local/share/sakti-cli + npm install + setup
#   bash pasang.sh --dir /opt/sakti                 # pasang ke folder lain
#   bash pasang.sh --model-url http://10.0.0.5:3000/v1 --model Gratis --model-key sk-...
#                                                   # lewati wizard, tulis config langsung
#   bash pasang.sh --tanpa-bin                      # cuma salin, jangan bikin symlink
#   bash pasang.sh --tanpa-dep                      # lewati npm install (WhatsApp native nonaktif)
#   bash pasang.sh --tanpa-setup                    # pasang saja, jangan buka wizard
#   bash pasang.sh --rea                            # pasang REA (rea-agents) + daftarkan MCP
#   bash pasang.sh --reach                          # pasang Agent Reach + skill (butuh uv)
#
# Yang dilakukan: cek node >= 20, salin folder, npm install dependensi
# (baileys + qrcode-terminal untuk WhatsApp native), bikin ~/.local/bin/sakti,
# lalu `sakti setup`. Tanpa TTY: cetak perintah setup, tidak menggantung.

set -euo pipefail

SUMBER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUJUAN="$HOME/.local/share/sakti-cli"
BIN="$HOME/.local/bin"
MODEL_URL=""
MODEL=""
MODEL_KEY=""
BUAT_BIN=1
PASANG_DEP=1
PASANG_REA=0
PASANG_REACH=0
JALAN_SETUP=1

while [ $# -gt 0 ]; do
  butuh_nilai() {
    if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
      echo "argumen $1 butuh nilai" >&2
      exit 2
    fi
  }
  case "$1" in
    --dir) butuh_nilai "$1" "${2:-}"; TUJUAN="$2"; shift 2 ;;
    --bin) butuh_nilai "$1" "${2:-}"; BIN="$2"; shift 2 ;;
    --model-url) butuh_nilai "$1" "${2:-}"; MODEL_URL="$2"; shift 2 ;;
    --model) butuh_nilai "$1" "${2:-}"; MODEL="$2"; shift 2 ;;
    --model-key) butuh_nilai "$1" "${2:-}"; MODEL_KEY="$2"; shift 2 ;;
    --tanpa-bin) BUAT_BIN=0; shift ;;
    --tanpa-dep) PASANG_DEP=0; shift ;;
    --tanpa-setup) JALAN_SETUP=0; shift ;;
    --rea) PASANG_REA=1; shift ;;
    --reach) PASANG_REACH=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done

# 1. Node >= 20 (satu-satunya syarat; tidak ada npm install)
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'PESAN'
Node belum ada. Pasang dulu salah satu:
  Debian/Ubuntu : curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
  Termux/Android: pkg install nodejs-lts
  lain-lain     : https://nodejs.org (butuh >= 20)
PESAN
  exit 1
fi
NODE_BESAR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_BESAR" -lt 20 ]; then
  echo "node $(node -v) terlalu tua; butuh >= 20" >&2
  exit 1
fi
echo "OK  node $(node -v)"

# 2. Salin folder (kecuali kalau memasang di tempat folder itu sendiri)
if [ "$(cd "$SUMBER" && pwd -P)" != "$(mkdir -p "$TUJUAN" && cd "$TUJUAN" && pwd -P)" ]; then
  mkdir -p "$TUJUAN"
  tar -C "$SUMBER" --exclude=.git --exclude=node_modules --exclude=tests --exclude='*.tar.gz' -cf - . | tar -C "$TUJUAN" -xf -
  echo "OK  disalin ke $TUJUAN ($(find "$TUJUAN" -type f | wc -l) berkas)"
else
  echo "OK  sudah ada di $TUJUAN (tidak disalin ulang)"
fi
chmod +x "$TUJUAN/sakti.js" "$TUJUAN/mcp.js" "$TUJUAN/pasang.sh"

# 2b. Dependensi: inti sakti tetap stdlib, tetapi WhatsApp native butuh
# baileys + qrcode-terminal. Dipasang di TUJUAN, bukan di folder sumber.
if [ "$PASANG_DEP" = "1" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "npm install dependensi (baileys, qrcode-terminal) ..."
    if (cd "$TUJUAN" && npm install --omit=dev --no-audit --no-fund --loglevel=error); then
      echo "OK  dependensi terpasang di $TUJUAN/node_modules"
    else
      echo "!   npm install gagal (jaringan/registry). Inti sakti tetap jalan; WhatsApp native nonaktif." >&2
    fi
  else
    echo "!   npm tidak ada; lewati dependensi WhatsApp. Inti sakti tetap jalan." >&2
  fi
else
  echo "!   --tanpa-dep: dependensi tidak dipasang (WhatsApp native nonaktif)"
fi

# 2c. REA opsional (paket besar ~324 MB di ~/.sakti-cli/rea, bukan di repo).
if [ "$PASANG_REA" = "1" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "memasang REA (rea-agents) ..."
    if "$TUJUAN/sakti.js" rea pasang; then
      "$TUJUAN/sakti.js" rea mcp-pasang || echo "!   MCP REA belum terdaftar; jalankan: $TUJUAN/sakti.js rea mcp-pasang" >&2
    else
      echo "!   REA gagal dipasang (Node/registry). Sakti tetap jalan tanpa REA." >&2
    fi
  else
    echo "!   npm tidak ada; lewati REA. Pasang nanti: $TUJUAN/sakti.js rea pasang" >&2
  fi
else
  echo "!   REA tidak dipasang; pasang nanti: $TUJUAN/sakti.js rea pasang"
fi

# 2d. Agent Reach opsional: CLI Python + skill untuk agen.
if [ "$PASANG_REACH" = "1" ]; then
  echo "memasang Agent Reach ..."
  if "$TUJUAN/sakti.js" reach pasang; then
    "$TUJUAN/sakti.js" reach setup >/tmp/sakti-reach-setup.log 2>&1 \
      && echo "OK  Agent Reach + skill terpasang" \
      || echo "!   Agent Reach terpasang, tetapi setup belum selesai; lihat /tmp/sakti-reach-setup.log" >&2
  else
    echo "!   Agent Reach gagal dipasang (butuh uv/registry). Sakti tetap jalan." >&2
  fi
else
  echo "!   Agent Reach tidak dipasang; pasang nanti: $TUJUAN/sakti.js reach pasang"
fi

# 3. Launcher `sakti`
if [ "$BUAT_BIN" = "1" ]; then
  mkdir -p "$BIN"
  ln -sfn "$TUJUAN/sakti.js" "$BIN/sakti"
  echo "OK  launcher $BIN/sakti -> $TUJUAN/sakti.js"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) echo "!   $BIN belum ada di PATH. Tambahkan: export PATH=\"$BIN:\$PATH\"" ;;
  esac
fi

# 4. Konfigurasi model + arahkan ke wizard.
#    - bendera --model-url: tulis config langsung (cocok untuk CI/skrip), tanpa wizard
#    - config sudah ada   : jangan timpa; beri tahu cara mengubah
#    - belum ada          : buka `sakti setup` (TTY) atau cetak perintahnya
CFG="$HOME/.sakti-cli/config.json"
if [ -n "$MODEL_URL" ]; then
  mkdir -p "$(dirname "$CFG")"
  node - "$CFG" "$MODEL_URL" "$MODEL" "$MODEL_KEY" <<'NODE'
const fs = require('node:fs');
const [berkas, baseUrl, model, apiKey] = process.argv.slice(2);
let lama = {};
try { lama = JSON.parse(fs.readFileSync(berkas, 'utf8')) || {}; } catch (galat) {
  // Config rusak: cadangkan dulu - isi lama (kanal, fallbacks) jangan lenyap tanpa jejak.
  try { if (fs.existsSync(berkas)) fs.renameSync(berkas, berkas + '.rusak-' + Date.now()); } catch { /* berkas sudah tidak ada */ }
  lama = {};
}
const baru = Object.assign(lama, { baseUrl: baseUrl.replace(/\/+$/, '') });
if (model) baru.model = model;
if (apiKey) baru.apiKey = apiKey;
// 0600 langsung saat tulis: dulu 0644 dulu baru chmod - kunci terbaca proses
// lain di jendela itu, dan chmod gagal = diam di 0644 selamanya.
fs.writeFileSync(berkas, JSON.stringify(baru, null, 1) + '\n', { mode: 0o600 });
NODE
  chmod 600 "$CFG" 2>/dev/null || true
  echo "OK  bendera model diberikan; wizard setup dilewati"
elif [ -f "$CFG" ]; then
  echo "OK  config sudah ada: $CFG (tidak diubah)"
  echo "    ubah kapan saja: $TUJUAN/sakti.js setup"
elif [ "$JALAN_SETUP" = "1" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo
    echo "=== sakti setup ==="
    "$TUJUAN/sakti.js" setup || echo "!   setup belum selesai; jalankan lagi: $TUJUAN/sakti.js setup" >&2
  else
    echo
    echo "!   config belum ada dan tidak ada TTY. Jalankan:"
    echo "      $TUJUAN/sakti.js setup"
  fi
else
  echo "!   --tanpa-setup: config belum ada. Jalankan nanti: $TUJUAN/sakti.js setup"
fi

# 5. Periksa hasilnya
echo "--- doctor"
"$TUJUAN/sakti.js" doctor || true
echo
echo "Selesai. Coba: sakti run \"sebutkan folder kerja ini\""
