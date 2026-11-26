#!/usr/bin/env node
// `sakti` - CLI agen terminal yang BERDIRI SENDIRI.
//
// Menggabungkan tiga hal, tanpa memanggil biner mana pun:
//   - dari Sakti Bot : alat berkas/uji/terminal/ingatan/tugas, aturan
//                      "bukti bukan klaim", dan gaya jawab ringkas;
//   - dari pi        : agen koding berulang dengan alat, sesi yang bisa
//                      dilanjutkan, mode cetak, folder kerja = cwd;
//   - dari Hermes    : keahlian (SKILL.md), ingatan awet + ingatan inti,
//                      pencarian riwayat sesi, terus terang soal batas.
//
// Mesinnya ada di lib/: model.js (klien OpenAI-compatible + streaming SSE),
// agent.js (giliran agen), alat.js (tabel alat), sesi.js, skill.js, lokal.js.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ALAT, ambilAntreanPanggil, cariAlat, jalanAntreanPanggil, jalankanAlat, konteks } from './lib/alat.js';
import { BATAS_RIWAYAT_BAWAAN, putaran } from './lib/agent.js';
import { EFFORT_SAH, effortAman, kemampuanModel, konfigModel, normalEffort, perluSegarkanKatalog, periksaModelTurunan, probeReasoning, ringkasKemampuan, ringkasModelTurunan, simpanKatalog, simpanModel, sinkronKatalog, ujiModel, umurKatalog, urlKatalog, berkasKonfig } from './lib/model.js';
import { peringatanTimpa, rapikanUrl } from './lib/pengaturan.js';
import { bacaState, berkasState, tulisState, ubahState } from './lib/lokal.js';
import { bacaBiaya, ringkasBiaya, statistikBiaya } from './lib/biaya.js';
import { modeIzin, setModeIzin } from './lib/izin.js';
import { bacaSesi, cabangSesi, cariSesi, daftarSesi, eksporSesi, hapusSesi, idSesiSah, imporSesi, sesiBaru, sesiJson, sesiTerakhir } from './lib/sesi.js';
import { arsipkanSkill, bacaSkill, daftarSkill, folderSkill, pinSkill, skillCocok, statusSkill } from './lib/skill.js';
import { cariWeb } from './lib/cariweb.js';
import { buatPetunjuk } from './lib/petunjuk.js';
import { daftarPerintah as daftarPerintahKustom, folderPerintah, hapusPerintah, rangkaiPerintah, tulisPerintah } from './lib/perintah.js';
import { bacaHook, berkasHook } from './lib/hook.js';
import { mesinLuar } from './lib/gabung.js';
import { tutupSekarang as tutupMcp } from './lib/mcp-klien.js';
import { MODE_ROOM, deteksiMode, jalankanRoom, modeRoomTersimpan, urutkanNamaPeserta, workerParalel } from './lib/room.js';
import { aturBawaan, aturRoom, bacaBot, botBawaan, botDiRoom, daftarBot, folderBot, hapusBot, konteksBot, namaSah, promptBot, promptKoordinatorTim, ringkasBot, simpanBot, urutkanMasuk } from './lib/bot.js';
import { SUBAGEN, pilihSubagen, ringkasSubagen, workerSubagen } from './lib/subagen.js';
import { workspace, modeLayar } from './lib/tui.js';
import { TINGKAT_RUTE, tingkatSah, nilaiTingkat, formatRute, ruteAktif } from './lib/rute.js';
import { serve } from './lib/serve.js';
import { buatPengirim, serveKanal } from './lib/kanal.js';
import { ringkasHasil } from './lib/ringkas-hasil.js';
import { ringkasSetup, setupInteraktif, susunKonfig } from './lib/setup.js';
import { pindaiSampah, ringkasSampah, sapuSampah } from './lib/bersih.js';
import { daftarPelajaran, hapusPelajaran, pelajaranAktif } from './lib/pelajaran.js';
import { folderAuthWa, jalanWa } from './lib/wa.js';
import { rawatLokal, rawatOtomatis, ringkasRawat, tarikAman } from './lib/rawat.js';
import { ikonAlat } from './lib/ikon.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Proxy: Node >= 24 hanya membaca HTTP(S)_PROXY bila diberi --use-env-proxy.
// Tanpa ini, di jaringan berkantong semua panggilan model/cari web menembus
// langsung lalu gagal. Re-exec sekali; SAKTI_PROXY_MATI=1 mematikannya.
if (Number(process.versions.node.split('.')[0]) >= 24
  && !process.env.SAKTI_PROXY_MATI
  && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
  && process.env.SAKTI_PROXY_REEXEC !== '1'
  && !process.execArgv.includes('--use-env-proxy')
  && process.argv[1]) {
  const anak = spawnSync(process.execPath, ['--use-env-proxy', ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: Object.assign({}, process.env, { SAKTI_PROXY_REEXEC: '1' }) });
  process.exit(anak.status == null ? 1 : anak.status);
}

const VERSI = '3.36.0';
const TTY = Boolean(process.stdin.isTTY);
/** Bendera boolean yang boleh datang sebagai `--x` atau `--x=true`. */
const benar = (nilai) => nilai === true || nilai === 'true';
const ALIAS = { ls: 'daftar', cat: 'baca', sh: 'terminal', bash: 'terminal', test: 'uji', ingat: 'ingatan', mkdir: 'folder', mv: 'pindah', cp: 'salin', skrip: 'jalankan', patch: 'edit' };
const AKSI_SESI = new Set(['daftar', 'list', 'baru', 'new', 'baca', 'cari', 'hapus', 'cabang', 'ekspor', 'import', 'impor']);
const BENDERA_UMUM = ['cwd', 'help', 'model', 'model-url', 'model-key', 'effort', 'max-tokens', 'batas-riwayat', 'batas-token', 'maks-langkah', 'rute', 'rute-tingkat', 'sesi', 'lanjut', 'cetak', 'izin', 'port', 'host', 'worker', 'token', 'json', 'penuh', 'sanitasi', 'hari', 'lampirkan', 'judul', 'proyek', 'timpa', 'keterangan', 'serve', 'version', 'v', 'no-warna', 'nomor', 'sesi-prefix',
  // `sakti mcp tambah <nama> --command=… --url=…` (opencode `mcp add`)
  'command', 'url', 'args', 'env', 'headers',
  // `--alat=baca,cari` (subset skema alat per giliran; lihat sempitAlat)
  'alat',
  // `--nalar` / `--nalar=tampil`: jejak penalaran (thinking) di stderr.
  'nalar',
  // `sakti bersih --hapus`: benar-benar menghapus, bukan pratinjau.
  // `sakti pelajaran --batas=<n>`: berapa baris ditampilkan.
  'hapus', 'batas', 'profil-alat', 'fallback', 'pull', 'ya', 'auth', 'izin', 'grup', 'paksa', 'tanpa-tanya', 'tanpa-bin', 'tanpa-dep',
  // `sakti sesi bersih --lebih=<hari>`: retensi sesi lama.
  'lebih',
  // `sakti setup` non-interaktif: --url= --key= --model= --gateway=…
  'url', 'key', 'gateway', 'gateway-token', 'gateway-port', 'gateway-host', 'tanpa-setup', 'tanpa-tanya'];

// Bendera yang MEMANG tidak dipakai sendirian dan tidak perlu divonis salah.
const BENDERA_BERSAMA = new Set(['lanjut', 'cetak', 'json', 'sanitasi', 'penuh', 'token', 'host', 'port', 'rute-tingkat', 'batas-riwayat', 'batas-token', 'maks-langkah', 'max-tokens', 'model-url', 'model-key']);

// Bendera yang TIDAK pernah mengambil nilai berikutnya. Tanpa daftar ini
// `sakti run --json "halo"` menelan "halo" sebagai nilai --json lalu protes
// "run butuh pesan" (terukur).
const BENDERA_BOOL = new Set(['lanjut', 'cetak', 'json', 'sanitasi', 'penuh', 'help', 'no-warna', 'warna', 'stream', 'diam', 'verbose', 'nalar',
  // Bendera mode tanpa nilai. Tanpa ini `--tanpa-setup "halo"` menelan pesan,
  // `--grup 628…` mematikan mode grup dan membuang nomornya.
  'tanpa-setup', 'tanpa-tanya', 'tanpa-bin', 'tanpa-dep', 'grup', 'hapus', 'timpa', 'proyek', 'pull', 'ya', 'paksa']);

// Bendera yang WAJIB punya nilai. Kalau nilainya tidak ada (akhir argv atau
// diikuti bendera lain), simpan '' alih-alih `true` supaya `--port` tidak
// berubah jadi port 1 dan `--sesi` tidak menjadi sesi bernama "true".
// 'auth' & 'serve' di sini (bukan BOOL): dulu `--auth /jalur` menelan true dan
// `/jalur` jadi token posisi yang dibuang - sesi WA terbuka di folder bawaan
// tanpa galat apa pun.
const BENDERA_NILAI = new Set(['cwd', 'model', 'model-url', 'model-key', 'effort', 'max-tokens', 'batas-riwayat', 'batas-token', 'maks-langkah', 'rute', 'rute-tingkat', 'sesi', 'sesi-prefix', 'izin', 'port', 'host', 'worker', 'token', 'hari', 'lampirkan', 'judul', 'keterangan', 'command', 'url', 'args', 'env', 'headers', 'alat', 'batas', 'profil-alat', 'fallback', 'nomor', 'lebih', 'gateway', 'gateway-token', 'gateway-port', 'gateway-host', 'sub', 'nama', 'nama-bot', 'auth', 'serve']);

/** Argumen array di baris perintah: JSON kalau berbentuk JSON, kalau tidak pisah koma. */
function uraiArray(teks) {
  const isi = String(teks == null ? '' : teks).trim();
  if (isi.startsWith('[')) {
    try { const nilai = JSON.parse(isi); if (Array.isArray(nilai)) return nilai; } catch { /* jatuh ke pemisah koma */ }
  }
  return isi.split(',').map((satu) => satu.trim()).filter(Boolean);
}

function nilaiFlag(argv) {
  const flag = {};
  const sisa = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // `--` = akhir bendera: sisanya argumen posisi apa adanya (termasuk yang
    // berawalan -). Dulu `--` diperlakukan sebagai nilai/posisi biasa.
    if (arg === '--') { sisa.push(...argv.slice(i + 1)); break; }
    if (arg === '--help' || arg === '-h' || arg === '--bantuan' || arg === 'bantuan') { flag.help = true; continue; }
    if (arg === '--version' || arg === '-v') { flag.version = true; continue; }
    if (arg === '-p') { flag.cetak = true; continue; }
    const cocok = /^--?([a-zA-Z][a-zA-Z0-9-]*)(?:=([\s\S]*))?$/.exec(arg);
    if (!cocok) { sisa.push(arg); continue; }
    const nama = cocok[1];
    if (cocok[2] !== undefined) { flag[nama] = cocok[2]; flag['__dash_' + nama] = true; continue; }
    const berikut = argv[i + 1];
    if (!BENDERA_BOOL.has(nama) && berikut !== undefined && !berikut.startsWith('--')) { flag[nama] = berikut; flag['__dash_' + nama] = true; i += 1; }
    else { flag[nama] = BENDERA_NILAI.has(nama) ? '' : true; flag['__dash_' + nama] = true; }
  }
  return { flag, sisa };
}

/** Bendera mentah (nama+nilai) untuk diteruskan ke CLI luar (REA/Reach). */
function flagMentah(flag) {
  const keluar = [];
  for (const kunci of Object.keys(flag || {})) {
    if (!kunci.startsWith('__dash_')) continue;
    const nama = kunci.slice('__dash_'.length);
    const nilai = flag[nama];
    if (nilai === true) keluar.push('--' + nama);
    // Dua token, bukan `--nama=nilai`: program luar (Agent Reach/REA) menerima
    // keduanya, tetapi bentuk `=` memecah uji dan beberapa parser CLI.
    else if (nilai !== '') keluar.push('--' + nama, String(nilai));
  }
  return keluar;
}

function bantu() {
  return [
    'sakti ' + VERSI + ' - agen terminal mandiri: alat Sakti Bot + agen gaya pi + ingatan/skill gaya Hermes',
    '',
    'Workspace (layar penuh, seperti pi/Hermes):',
    '  sakti                      buka workspace: transkrip, kotak masukan, panel, palet /',
    '  Enter kirim · Tab lengkapi · Ctrl+O panel · Ctrl+T rinci/ringkas (alat/skill/ingatan/tugas/chatroom)',
    '  /chatroom daftar room & pesan · /sesi <id> pindah room · /ringkas simpan ingatan',
    '  /indikator unicode|ascii|emoji gaya indikator kerja · /biaya [hari] biaya token · /alat subset alat',
    '  /nalar tampil|sembunyi penalaran (thinking) model · /nalar = balik setelan · tersimpan di config',
    '  /pengaturan 10 setelan interaktif: model, effort, token, rute, izin, worker, alat, indikator, room, warna',
    '  /warna [nama] warna font teks: bawaan putih abu hijau cyan biru ungu kuning oranye merah pink',
    '  /bot panel bot · /bot baru <nama> prompt="…" · /bot <nama> masuk/lepas room',
    '  !perintah jalan bash langsung · PgUp/PgDn/Ctrl+Y/Ctrl+B gulir · Ctrl+G dasar · Ctrl+C hentikan / keluar',
    '',
    'Agen:',
    '  sakti                      mulai percakapan interaktif',
    '  sakti chat [pesan]         sama; ada pesan = satu giliran lalu keluar',
    '  sakti run "<pesan>"        sekali jalan, jawaban ke stdout (skrip/pipa)',
    '  sakti --lanjut             lanjutkan sesi terakhir',
    '  sakti --sesi <id>          lanjutkan sesi tertentu',
    '',
    'Alat langsung (biner nyata di mesin ini, bukan tiruan):',
    '  sakti ffmpeg aksi=probe masuk=klip.mp4      probe|ukur|potong|transcode|audio|gif|frame|gabung',
    '  sakti chromium aksi=screenshot url=https://… keluar=layar.png   juga pdf|dom|teks|versi',
    '  sakti node kode="console.log(1)"             JS ESM, top-level await (alias js/javascript)',
    '  sakti python kode="print(1)"                 alias dari py (python3 juga)',
    '  sakti git aksi=status|commit pesan="…"|push paksa=true|reset mode=hard   (paksa/hard WAJIB konfirmasi, ref refs/sakti/selamat-*)',
    '  sakti http url=https://api metode=POST token=… badan=\'{"x":1}\'    GET/POST/PUT/PATCH/DELETE',
    '  sakti db sumber=data.db sql="select * from t" [tulis=true]           SQLite bawaan, Postgres/MySQL via psql/mysql',
    '  sakti layanan aksi=start|stop|restart|cek|log nama=nginx mesin=systemd|pm2|docker   (stop/restart ditanya)',
    '  sakti paket aksi=audit|install|daftar mesin=npm|pip|apt   ·   sakti lint aksi=lint|format|typecheck perbaiki=true',
    '  sakti env kunci=TOKEN (rahasia diredaksi)   ·   sakti json/csv sumber=d.json|csv jalur=items filter="umur>20" urut=nama:desc',
    '',
    'Riwayat & keahlian:',
    '  sakti sesi                 daftar sesi',
    '  sakti sesi baca <id>       isi sesi',
    '  sakti sesi cari "<teks>"   cari di semua sesi',
    '  sakti sesi hapus <id>',
    '  sakti sesi cabang [id] [sampai]   salin sesi ke sesi baru (jalur alternatif)',
    '  sakti sesi ekspor [id] [--penuh] ekspor sesi ke Markdown di folder kerja',
    '  sakti skill                daftar keahlian (SKILL.md) yang terbaca',
    '  sakti skill baca <nama>    tampilkan isi keahlian',
    '  sakti skill cocok "<teks>"  keahlian yang akan aktif sendiri untuk tugas itu',
    '  sakti skill curator [status|arsipkan <nama>|pin <nama>]   pemakaian keahlian; arsip, bukan hapus',
    '',
    'Ingatan, jadwal & pemulihan:',
    '  sakti khazanah checkpoint | kembalikan <id>    salinan berkas sebelum ditimpa/dihapus (otomatis)',
    '  sakti khazanah ingat teks="..." | cari query="..."   potongan jawaban yang bisa ditemukan lagi tanpa model',
    '  sakti khazanah pemicu nama=<n> menit=<m> perintah="<pesan>"   jadwal yang jalan saat agen dipakai',
    '  sakti cariweb "<kata kunci>"         cari di web tanpa kunci API (keyless)',
    '  sakti web <url> [aksi=ekstrak|periksa]   baca halaman jadi teks, atau periksa status/tautan',
    '  sakti rencana aksi=lihat|tulis|gabung|hapus items=\'[{...}]\'   rencana kerja lintas giliran',
    '  sakti petunjuk aksi=lihat|tulis          AGENTS.md folder kerja (ikut otomatis ke prompt)',
    '  sakti init [nama proyek]                buat kerangka AGENTS.md di folder kerja',
    '  sakti perintah [aksi]                   perintah kustom: daftar|lihat|tulis|hapus <nama> [isi] [--proyek]',
    '  Mode room: bawaan TIM (koordinator membagi tugas); "solo" = satu bot; "paralel" = semua paralel; "berurutan" = semua serial',
    '  --worker=<n>                            pekerja bersamaan saat paralel DAN subagen (1-12; subagen bawaan 4)',
    '  SAKTI_WORKER_SUBAGEN=<n>               batas subagen bersamaan kalau tidak lewat --worker',
    '  sakti ingatan lihat | tambah "<teks>"',
    '  sakti mind daftar | tambah "<teks>"',
    '  sakti tugas daftar | simpan <nama> "<perintah>" | jalankan <nama> | hapus <nama>',
    '',
    'Alat langsung (tanpa model):',
    ...ALAT.map((alat) => '  ' + alat.name.padEnd(9) + alat.description.split('.')[0].slice(0, 76)),
    '',
    'Model & lain-lain:',
    '  sakti model                          model/endpoint + katalog endpoint ini (auto segar)',
    '  sakti model <nama>                   pilih model aktif untuk endpoint sekarang',
    '  sakti model katalog                  tarik ulang GET /models sekarang juga',
    '  sakti model reasoning                uji tingkat effort/max_tokens yang didukung endpoint + simpan',
    '  sakti model set --model=<id> [--model-url=<url>] [--model-key=<kunci>]',
    '  sakti model tes                      uji endpoint + kunci sekarang (katalog atau chat 1 token)',
    '  sakti env                            folder kerja, ingatan, sesi, skill',
    '  sakti doctor                         periksa node, endpoint model, skill, ingatan, spill, cari web',
    '  sakti setup                          wizard: endpoint (preset/kustom), API key, model, gateway chat',
    '  sakti setup --url= --key= --model=   non-interaktif untuk skrip/CI',
    '  sakti setup --gateway=telegram --gateway-token=… --gateway-port=4318   gateway tersimpan di config',
    '  sakti rawat [periksa|perbaiki|update|auto on|off]   rawat diri: izin/folder/hook/sampah + tarik update kode',
    '  sakti bersih [hapus]                 sampah spill/checkpoint/tmp (pratinjau bawaan; sesi/ingatan tidak disentuh)',
    '  sakti pelajaran [mati|hidup|hapus]   pelajaran otomatis dari giliran yang memakai alat (ingatan)',
    '  sakti serve [port] [--host 0.0.0.0]   HTTP: POST /chat (NDJSON mengalir), GET /sehat, GET /sesi',
    '  sakti wa [--nomor 628xxx] [--auth <folder>] [--sesi-prefix wa-] [--izin <nomor,...>] [--grup]   WhatsApp native: QR/pairing code -> serve /chat',
    '  sakti kanal [port] [--serve <url>]   gateway chat: POST /kanal/telegram|generik -> serve /chat',
    '  --izin auto|ask|never                izin alat berisiko (auto bawaan; ask tanya, never tolak)',
    '  --nalar[=tampil|sembunyi]            jejak penalaran (thinking) di stderr; bawaan sembunyi',
    '  sakti alat                           daftar alat + skema',
    '  sakti mcp                            server MCP di stdio',
    '  sakti rea [status|pasang|mcp|mcp-pasang|<perintah REA>]   integrasi REA (reverse engineering)',
    '  sakti reach [status|pasang|setup|<perintah Agent Reach>]     internet Agent Reach (X, Reddit, YouTube, dll.)',
    '',
    '  sakti rute                         smart route: ringan=minimal, sulit=ultra (auto bawaan)',
    '  sakti rute on|off|auto|<tingkat>   on/off, lepas patok, atau patok satu tingkat (minimal..ultra)',
    '  --rute=off --rute-tingkat=<n>      matikan / patok tingkat dari baris perintah',
    '',
    'Bendera: --cwd <folder>  --model <id>  --model-url <url>  --model-key <key>  --effort <level>  --max-tokens=<n|0>  --batas-riwayat=<n>  --batas-token=<n>  --maks-langkah=<n>  --alat=<a,b|semua>  --rute=on|off  --rute-tingkat=<n>  --izin <auto|ask|never>  --nalar  --port <n>  --help  --version',
    '',
    'Bot chatroom (pengaturan di ~/.sakti-cli/bots/<nama>.json):',
    '  sakti bot                              daftar bot + siapa yang di room',
    '  sakti bot baru riset prompt="kamu analis data" model=Gratis suhu=0.2 alat=baca,cari',
    '  sakti bot set riset prompt="…"         ubah pengaturan (gabung, bukan timpa)',
    '  sakti bot masuk riset | lepas riset | room | hapus riset',
    '  bot yang masuk room ikut menjawab tiap pesanmu di chatroom, berurutan, dengan nama masing-masing',
    '',
    'Isolasi & interop (pinjaman opencode/codex/hermes):',
    '  sakti kerja aksi=buat nama=<n>        worktree git terpisah di ~/.sakti-cli/kerja/<n>, cabang sakti/<n>',
    '  sakti kerja aksi=daftar|gabung|hapus nama=<n>    merge balik menolak kalau worktree masih kotor',
    '  sakti tambal berkas=src/a.js tambalan="@@ -3,2 +3,3 @@ ..." [terapkan=false]   patch atomik, gagal kalau konteks beda',
    '  sakti delegasi tugas="..." mesin=codex|opencode|claude   teruskan tugas ke CLI agen yang terpasang',
    '  sakti doctor                         juga melaporkan mesin luar yang terdeteksi',
    '',
    'Subagen & worker (lib/subagen.js):',
    '  sakti subagen                          daftar peran subagen (peran · alat · kapan dipakai) + worker efektif',
    '  sakti subagen pilih "<teks tugas>"     peran mana yang dipilih otomatis untuk tugas itu',
    '  sakti delegasi peran=auto tugas="..."  subagen berperan, riwayat bersih, yang dibalikkan jawabannya saja',
    '  sakti delegasi banyak=\'[{"peran":"peneliti","tugas":".."},{"peran":"penguji","tugas":".."}]\'   beberapa tugas PARALEL',
    '  sakti bot set riset worker=3           giliran bot itu memakai 3 subagen/rekan bersamaan (1-12)',
    '',
    'Berkas (gaya pi/Hermes):',
    '  sakti edit src/a.js cari="lama" ganti="baru"     ganti satu blok, tampilkan diff',
    '  sakti edit src/a.js --editan=\'[{"cari":"x","ganti":"y"}]\'   banyak editan sekali jalan',
    '  sakti tulis catatan.md teks="isi"   ·  sakti folder src/baru  ·  sakti folder src aksi=daftar',
    '  sakti pindah lama.txt baru.txt      ·  sakti salin src/ cadangan/src/  ·  sakti hapus dalam-hapus/',
    '  sakti jalankan skrip/deploy.sh      ·  sakti jalankan main.py argumen="--cepat"',
    '',
    'Contoh:',
    '  sakti run "pasang dependensi, jalankan uji, laporkan hasilnya"',
    '  sakti terminal "npm install"',
    '  sakti uji uji/hitung.test.js',
    '  sakti update                         segarkan katalog model + indeks skill',
    '  sakti tugas simpan build "npm run build && npm test"'
  ].join('\n');
}

/* ------------------------------------------------------------- agen -- */

const DIM = '\x1b[2m';
const ULANG = '\x1b[0m';
const MERAH = '\x1b[31m';

function ringkas(nilai, batas = 70) {
  return String(nilai).replace(/\s+/g, ' ').slice(0, batas);
}

function jejakAlat(nama, argumen) {
  const isi = Object.entries(argumen || {}).map(([k, v]) => k + '=' + String(v).slice(0, 60).replace(/\n/g, ' ')).join(' ');
  process.stderr.write(DIM + '  → ' + ikonAlat(nama) + ' ' + nama + (isi ? ' ' + isi : '') + ULANG + '\n');
}

/** Satu baris hasil alat - umpan balik langsung, bukan animasi. */
function jejakHasil(nama, isi) {
  // Alasan yang sama dengan TUI: baris pertama saja tidak cukup, dan galat yang
  // muncul di tengah keluaran shell dulu dilaporkan sebagai "hasil" hijau.
  const r = ringkasHasil(nama, isi);
  const pertama = r.daftar.map((b) => b.trim()).filter(Boolean)[0] || '(kosong)';
  process.stderr.write(DIM + '    ' + (r.gagal ? MERAH + 'gagal: ' : 'hasil: ') + ringkas(pertama, 100) + DIM + '  · ' + r.label + ULANG + '\n');
}

/** Satu giliran sekali-jalan (mode cetak / pipa): jawaban ke stdout, jejak ke stderr. */
async function satuGiliran(pesan, { sesiId, konfModel, ctx, kendali, worker, json = false, nalar = false }) {
  const mulai = Date.now();
  let langkahKe = 0;
  let akhirBaris = true;
  // `--json`: satu objek per baris (NDJSON) seperti `codex exec --json` /
  // `opencode run --format json`. Dipakai skrip; manusia tetap dapat teks.
  const emit = (peristiwa) => { if (json) process.stdout.write(JSON.stringify(Object.assign({ sesi: sesiId }, peristiwa)) + '\n'); };
  emit({ tipe: 'mulai', pesan, model: konfModel && konfModel.model });
  // Urutan peserta menurut `urutan` eksplisit lalu urutan masuk room (bukan
  // abjad/tugas), sama di CLI, TUI, dan HTTP. Bot pertama mengerjakan lebih dulu
  // bila serial; mode solo/serial/paralel dipilih otomatis dari isi pesan.
  const semua = urutkanNamaPeserta(botDiRoom(sesiId), bacaBot);
  const dasarDaftar = semua.length ? semua : [null];
  const mode = deteksiMode(pesan, dasarDaftar.length, dasarDaftar);
  const daftar = mode.peserta.length ? mode.peserta : dasarDaftar;
  const banyak = daftar.length > 1;
  const tim = mode.tim === true && daftar.length === 1 && dasarDaftar.length > 1;
  if (tim) process.stderr.write(DIM + '  tim · koordinator ' + daftar[0] + ' · rekan: ' + dasarDaftar.filter((n) => n && n !== daftar[0]).join(', ') + ULANG + '\n');
  else if (banyak) process.stderr.write(DIM + '  ' + daftar.length + ' bot · ' + (mode.paralel ? 'paralel' : 'berurutan') + ' · ' + daftar.join(' -> ') + ULANG + '\n');
  else if (semua.length > 1) process.stderr.write(DIM + '  solo: ' + daftar[0] + ' (' + mode.alasan + ')' + ULANG + '\n');

  let kodeGagal = 0;
  const { hasil: hasilRoom, rangkum, worker: dipakai } = await jalankanRoom({
    daftar,
    worker: mode.paralel ? workerParalel(worker, daftar.length) : 1,
    sinyal: kendali && kendali.signal,
    buat: async (namaBot, indeks) => {
      const bot = namaBot ? bacaBot(namaBot) : null;
      // Jejak penalaran per bot: satu baris pembuka `✻ nalar:` per sambungan.
      let sedangNalar = false;
      // Label per bot ditulis SEKALI per blok, bukan tiap flush delta (~64
      // karakter): tanpa ini jawaban multi-bot dipenuhi "Bot A: ... Bot A: ...".
      let labelBot = false;
      const labelRekan = new Set();
      if (banyak) process.stderr.write(DIM + '  ' + (indeks + 1) + '. ' + namaBot + ' ...' + ULANG + '\n');
      try {
        return await putaran({
          pesan,
          sesiId,
          // `pesertaGiliran` mencegah alat `panggil` memanggil ulang bot yang
          // sudah menjawab di giliran ini (jawaban jadi dobel).
          ctx: Object.assign(konteksBot(ctx, bot), {
            pesertaGiliran: daftar,
            panggilLangsung: tim,
            onSubDelta: (namaRekan, teks) => {
              if (json) { emit({ tipe: 'delta', teks, dari: namaRekan }); return; }
              if (banyak && !labelRekan.has(namaRekan)) { process.stdout.write('\n' + namaRekan + ': '); labelRekan.add(namaRekan); }
              process.stdout.write(teks);
            },
            onSubAlat: (namaRekan, namaAlat, argumen) => {
              langkahKe += 1;
              if (json) emit({ tipe: 'alat', nama: namaAlat, argumen, dari: namaRekan });
              else jejakAlat('[' + langkahKe + '] ' + namaRekan + ' · ' + namaAlat, argumen);
            },
            onSubHasilAlat: (namaRekan, namaAlat, isi) => {
              if (json) emit({ tipe: 'hasil', nama: namaAlat, teks: String(isi).slice(0, 4000), dari: namaRekan });
              else jejakHasil(namaAlat, isi);
            }
          }),
          konfModel,
          sinyal: kendali && kendali.signal,
          tanpaUser: indeks !== 0,
          label: namaBot || undefined,
          promptEkstra: bot ? promptBot(bot) + (tim ? '\n\n' + promptKoordinatorTim(bot, dasarDaftar.filter(Boolean).map((n) => bacaBot(n)).filter(Boolean)) : '') : '',
          alat: bot && bot.alat && bot.alat.length
            ? (!bot.alat.includes('panggil') ? [...bot.alat, 'panggil'] : bot.alat)
            : undefined,
          model: bot ? bot.model : undefined,
          onNalar: (teks) => {
            // Jejak penalaran: `--json` selalu membawa delta (skrip butuh semua),
            // manusia hanya melihatnya kalau `--nalar`/config nalar=tampil.
            if (json) { emit({ tipe: 'nalar', teks, dari: namaBot || undefined }); return; }
            if (!nalar) return;
            if (!sedangNalar) {
              process.stderr.write((akhirBaris ? '' : '\n') + DIM + '  ✻ nalar: ' + ULANG);
              sedangNalar = true;
              akhirBaris = false;
            }
            process.stderr.write(DIM + teks + ULANG);
            akhirBaris = teks.endsWith('\n');
          },
          onDelta: (teks) => {
            if (json) { emit({ tipe: 'delta', teks, dari: namaBot || undefined }); return; }
            if (sedangNalar) { process.stderr.write('\n'); sedangNalar = false; akhirBaris = true; }
            // Tiap bot dapat label di stdout agar jawabannya tidak tertukar.
            if (banyak && !labelBot) { process.stdout.write('\n' + namaBot + ': '); labelBot = true; }
            akhirBaris = teks.endsWith('\n');
            process.stdout.write(teks);
          },
          onAlat: (nama, argumen) => {
            langkahKe += 1;
            if (json) { emit({ tipe: 'alat', nama, argumen, dari: namaBot || undefined }); return; }
            jejakAlat('[' + langkahKe + '] ' + (namaBot ? namaBot + ' · ' : '') + nama, argumen);
          },
          onHasilAlat: (nama, isi) => { if (json) emit({ tipe: 'hasil', nama, teks: String(isi).slice(0, 4000) }); else jejakHasil(nama, isi); },
          modeIzin: modeIzin(),
          // Tanpa TTY tidak ada yang bisa ditanya: mode ask berlaku sebagai tolak.
          tanyaIzin: TTY ? undefined : async () => 't',
          // Jaringan putus: obrol() menyambung ulang sendiri; ini hanya jejaknya.
          onStatus: (teks) => process.stderr.write((akhirBaris ? '' : '\n') + DIM + '  ' + teks + ULANG + '\n'),
          // Tingkat rute yang dibayar giliran ini - di --cetak tanpa TUI tidak ada
          // /rute untuk bertanya, jadi ia ditulis ke stderr bersama jejak lain.
          onRute: (keputusan) => process.stderr.write((akhirBaris ? '' : '\n') + DIM + '  ' + formatRute(keputusan) + ULANG + '\n')
        }).then((hasilPutaran) => {
          // Giliran yang berhenti karena galat (mis. model mati, `galat`
          // diisi putaran) tetap ditandai supaya `sakti run` tidak keluar 0.
          if (hasilPutaran && hasilPutaran.galat) kodeGagal = 1;
          return hasilPutaran;
        });
      } finally {
        if (langkahKe) process.stderr.write((akhirBaris ? '' : '\n') + DIM + '  (' + ((Date.now() - mulai) / 1000).toFixed(1) + ' dtk, ' + langkahKe + ' panggilan alat)' + ULANG + '\n');
      }
    }
  });

  // Kegagalan per bot dilaporkan, tidak menutupi bot lain.
  for (const baris of rangkum.baris) {
    if (json) emit({ tipe: 'galat', teks: baris });
    else process.stderr.write(MERAH + '  ' + baris + ULANG + '\n');
  }
  if (banyak) {
    process.stderr.write(DIM + '  ' + rangkum.berhasil + '/' + daftar.length + ' bot menjawab · ' + dipakai + ' worker' +
      (rangkum.gagal ? ' · ' + rangkum.gagal + ' gagal' : '') + ULANG + '\n');
  }
  // Panggilan antar-bot dari giliran ini diantrekan. Giliran selesai, sekarang
  // giliran MEREKA: jawabannya ditulis ke sesi (tanpa mengulang pesan pengguna)
  // dan dicetak sesudah jawaban utama. Tanpa ini antrean hilang saat proses
  // sekali-jalan keluar, dan bot target tidak pernah menjawab.
  let gelombangAntre = 0;
  while (ambilAntreanPanggil(sesiId).length && gelombangAntre < 4) {
    gelombangAntre += 1;
    let hasilAntre;
    try {
      hasilAntre = await jalanAntreanPanggil(sesiId, {
        konfModel, cwd: ctx.cwd, worker,
        modeIzin: modeIzin(),
        tanyaIzin: TTY ? undefined : async () => 't'
      });
    } catch (galatAntre) {
      process.stderr.write(MERAH + '  panggilan rekan gagal: ' + String((galatAntre && galatAntre.message) || galatAntre) + ULANG + '\n');
      break;
    }
    for (const blok of hasilAntre || []) {
      if (json) emit({ tipe: 'panggilan', teks: blok });
      else process.stdout.write(DIM + '  (panggilan rekan)' + ULANG + '\n' + blok + '\n');
    }
  }
  // Status untuk kode keluar: satu bot gagal, atau giliran berhenti karena
  // galat (batas langkah / alat berulang / model tidak terjangkau) = gagal.
  const ok = hasilRoom.filter((s) => s && s.ok);
  emit({
    tipe: 'selesai',
    berhasil: ok.length,
    total: daftar.length,
    panggilan: langkahKe,
    ms: Date.now() - mulai,
    teks: banyak ? ok.map((s) => s.hasil) : (hasilRoom[0] && hasilRoom[0].hasil)
  });
  return {
    teks: banyak ? ok.map((s) => s.hasil) : (hasilRoom[0] && hasilRoom[0].hasil),
    berhasil: ok.length,
    total: daftar.length,
    kode: ok.length === daftar.length && ok.length > 0 && !kodeGagal ? 0 : 1
  };
}

async function modeAgen(pesanAwal, { flag, ctx, konfModel }) {
  // --json berlaku untuk satu giliran sekali-jalan; TUI penuh tetap manusia.
  const json = flag.json === true || flag.json === 'true';
  // Jejak penalaran di stderr: `--nalar`, `--nalar=tampil`, atau config
  // `nalar: "tampil"`. Bawaan sembunyi - penalaran bukan jawaban.
  const nalarCli = String(flag.nalar || process.env.SAKTI_NALAR || (konfModel && konfModel.nalar) || '').toLowerCase() === 'tampil'
    || flag.nalar === true;
  let sesiId = flag.sesi || null;
  if (!sesiId && (flag.lanjut === true || flag.lanjut === 'true')) sesiId = sesiTerakhir();
  // Sesi baru mewarisi room sesi terakhir. Tanpa ini `sakti chat "..."` selalu
  // memulai room KOSONG, sehingga bot yang sudah didaftarkan tak pernah dipanggil
  // - pengguna melihat jawaban satu agen padahal room berisi 3-4 bot.
  if (!sesiId) {
    // Baca sesi terakhir SEBELUM membuat sesi baru: sesiBaru() langsung menjadi
    // sesi terbaru, jadi urutan lama selalu mewarisi room kosong.
    const terakhir = sesiTerakhir();
    const baru = sesiBaru({ judul: pesanAwal || '' }).id;
    const warisan = terakhir ? botDiRoom(terakhir) : [];
    if (warisan.length) aturRoom(baru, warisan);
    sesiId = baru;
  }
  if (flag.izin) setModeIzin(flag.izin);

  if (pesanAwal) {
    /* Satu kali-jalan: child MCP (`rea mcp` dsb) memegang pipe dan menahan event
       loop, jadi proses CLI menggantung setelah jawaban tercetak kalau tidak
       ditutup (terukur: `sakti run` + rea mcp = exit 124, mcp kosong = exit 1).
       `finally` menutup juga saat model melempar galat. */
    try {
      const hasil = await satuGiliran(pesanAwal, { sesiId, konfModel, ctx, worker: flag.worker != null ? Number(flag.worker) : undefined, json, nalar: nalarCli });
      if (!json) process.stdout.write('\n');
      // Tanpa ini `sakti run` keluar 0 walau model tidak terjangkau / bot gagal,
      // sehingga skrip dan CI menganggap pekerjaan beres (terukur: exit=0 saat
      // endpoint mati). Jejak galat tetap di stderr.
      if (hasil && hasil.kode) process.exitCode = 1;
    } finally {
      tutupMcp();
    }
    return;
  }

  if (!TTY) {
    const potongan = [];
    for await (const bagian of process.stdin) potongan.push(bagian);
    const pesan = Buffer.concat(potongan).toString('utf8').trim();
    if (!pesan) { console.error('tidak ada pesan (stdin kosong)'); process.exit(2); }
    try {
      const hasil = await satuGiliran(pesan, { sesiId, konfModel, ctx, worker: flag.worker != null ? Number(flag.worker) : undefined, json, nalar: nalarCli });
      if (!json) process.stdout.write('\n');
      if (hasil && hasil.kode) process.exitCode = 1;
    } finally {
      tutupMcp();
    }
    return;
  }

  // stdout dipipa / TERM=dumb: layar penuh merusak keluaran. Jatuh ke mode
  // baris: baca pesan dari stdin sampai EOF (Ctrl+D), jawab sekali.
  const mode = modeLayar({ stdinTTY: TTY, stdoutTTY: Boolean(process.stdout.isTTY), term: process.env.TERM, noColor: process.env.NO_COLOR });
  if (!mode.layarPenuh) {
    process.stderr.write('sakti: layar penuh tidak tersedia (stdout bukan TTY atau TERM=dumb). Ketik pesan, akhiri Ctrl+D.\n');
    const potongan = [];
    for await (const bagian of process.stdin) potongan.push(bagian);
    const pesan = Buffer.concat(potongan).toString('utf8').trim();
    if (!pesan) { console.error('tidak ada pesan'); process.exit(2); }
    try {
      const hasil = await satuGiliran(pesan, { sesiId, konfModel, ctx, worker: flag.worker != null ? Number(flag.worker) : undefined, json, nalar: nalarCli });
      process.stdout.write('\n');
      if (hasil && hasil.kode) process.exitCode = 1;
    } finally { tutupMcp(); }
    return;
  }

  await workspace({
    ctx, konfModel, sesiId, versi: VERSI,
    worker: flag.worker != null ? Number(flag.worker) : undefined
  });
}

/* -------------------------------------------------------- tampilan -- */

function barisModel(konf) {
  const daftarKatalog = Array.isArray(konf.models) ? konf.models : [];
  const kem = kemampuanModel(konf);
  const effortDiminta = normalEffort(konf.effort);
  const effortKirim = effortAman(konf.effort, kem);
  const catatanEffort = effortDiminta && effortKirim !== effortDiminta
    ? '  → dikirim ' + (effortKirim || 'tanpa effort') + ' (ditolak endpoint)'
    : '';
  const katalog = daftarKatalog.length
    ? daftarKatalog.length + ' model untuk ' + konf.baseUrl + '  · disegarkan ' + umurKatalog(konf.katalogWaktu) + '  · sakti model katalog'
    : (Number(konf.katalogCoba) > 0
      ? '/models tidak tersedia untuk ' + konf.baseUrl + '  · dicek ' + umurKatalog(konf.katalogCoba) + '  · sakti model katalog'
      : 'belum ada untuk endpoint ini  · sakti model katalog');
  return [
    'model   : ' + konf.model,
    'endpoint: ' + konf.baseUrl,
    'kunci   : ' + (konf.apiKey ? 'ada (' + konf.apiKey.length + ' karakter)' : 'kosong'),
    'effort  : ' + (konf.effort || 'none (tidak dikirim)') + '  · pilih: ' + EFFORT_SAH.join('|') + catatanEffort,
    'reasoning: ' + (ringkasKemampuan(kemampuanModel(konf)) || 'belum diuji · sakti model reasoning'),
    'keluaran: ' + (konf.maxTokens > 0 ? konf.maxTokens + ' (max_tokens)' : 'serahkan ke server') + '  · --max-tokens=<n|0>',
    'riwayat : ' + (konf.batasRiwayat || BATAS_RIWAYAT_BAWAAN) + ' pesan dikirim ke model  · --batas-riwayat=<n>',
    'langkah : ' + (konf.maksLangkah > 0 ? konf.maksLangkah + ' panggilan model per giliran' : 'tanpa batas (unlimited)') + '  · --maks-langkah=<n|0>',
    'rute    : ' + (ruteAktif(konf)
      ? ('on · tingkat ' + (konf.ruteTingkat ? 'patok ' + tingkatSah(konf.ruteTingkat) : 'auto (minimal..ultra)') + ' · ' + TINGKAT_RUTE.join('|') + ' · --rute=off --rute-tingkat=<n>')
      : 'off · pakai effort/max-tokens manual'),
    'token   : ' + (konf.batasToken ? konf.batasToken + ' token konteks (aktif)' : 'tanpa batas token') + '  · --batas-token=<n>',
    'alat    : ' + (konf.alat ? konf.alat.split(',').filter(Boolean).length + ' dikirim ke model (' + konf.alat + ') · --alat=semua untuk semua' : 'semua ' + ALAT.length + ' alat dikirim ke model  · --alat=baca,cari hemat token'),
    'katalog : ' + katalog,
    'berkas  : ' + konf.berkas
  ].join('\n');
}

/** Bangun perubahan config dari bendera `sakti model [set] --…`. */
function baruDariFlag(flag = {}) {
  const baru = {};
  if (typeof flag.model === 'string') baru.model = flag.model;
  if (typeof flag['model-url'] === 'string') {
    try { baru.baseUrl = rapikanUrl(flag['model-url']); } catch (galat) { return { baru, galat: 'model-url tidak sah: ' + String((galat && galat.message) || galat) }; }
  }
  if (typeof flag['model-key'] === 'string') baru.apiKey = flag['model-key'];
  if (typeof flag.effort === 'string') {
    const pilihan = normalEffort(flag.effort);
    if (!pilihan) return { baru, galat: 'effort tidak dikenal: ' + flag.effort + ' · pilih: ' + EFFORT_SAH.join('|') };
    baru.effort = pilihan;
  }
  if (flag['max-tokens'] != null) {
    const angka = Number(flag['max-tokens']);
    if (!Number.isFinite(angka) || angka < 0) return { baru, galat: 'max-tokens harus angka >= 0 (0 = serahkan ke server)' };
    baru.maxTokens = Math.floor(angka);
  }
  if (flag['maks-langkah'] != null) {
    const teks = String(flag['maks-langkah']).trim().toLowerCase();
    if (['0', 'off', 'false', 'no', 'unlimited', 'tanpa-batas'].includes(teks)) {
      baru.maksLangkah = 0;
    } else {
      const angka = Math.floor(Number(flag['maks-langkah']));
      if (!Number.isFinite(angka) || angka < 1 || angka > 400) return { baru, galat: 'maks-langkah harus 0 (tanpa batas) atau angka 1..400' };
      baru.maksLangkah = angka;
    }
  }
  // `--alat=baca,cari` (atau `semua` = lepas batasan). Nama divonis di sini,
  // bukan dibuang diam-diam: salah ketik alat berarti giliran kehilangan alat.
  if (flag.alat != null) {
    const teks = String(flag.alat).trim();
    if (!teks || teks === 'semua' || teks === 'all' || teks === '*') {
      baru.alat = '';
    } else {
      const asing = teks.split(',').map((s) => s.trim()).filter(Boolean).filter((nama) => !cariAlat(ALIAS[nama] || nama));
      if (asing.length) return { baru, galat: 'alat tidak dikenal: ' + asing.join(', ') + ' · lihat: sakti alat' };
      baru.alat = teks;
    }
  }
  return { baru };
}

/** Model turunan yang ikut bergantung endpoint: murah, fallback, model bot. */
function turunanModel(konf = {}) {
  const daftar = [];
  const murah = String(process.env.SAKTI_MODEL_MURAH || '').trim();
  if (murah) daftar.push({ label: 'model murah (SAKTI_MODEL_MURAH)', model: murah });
  for (const [i, satu] of (Array.isArray(konf.fallbacks) ? konf.fallbacks : []).entries()) {
    if (satu && satu.model) daftar.push({ label: 'fallback ' + (i + 1), model: satu.model, baseUrl: satu.baseUrl });
  }
  for (const bot of daftarBot()) if (bot && bot.model) daftar.push({ label: 'bot ' + bot.nama, model: bot.model });
  return daftar;
}

/** Peringatan model turunan: hanya yang terbukti tidak ada di katalognya. */
function cetakTurunan(konf) {
  for (const baris of ringkasModelTurunan(periksaModelTurunan(konf, turunanModel(konf)))) {
    console.error('  ! ' + baris + ' · cek: sakti model katalog');
  }
}

function tampilSesi() {
  const rows = daftarSesi();
  if (!rows.length) { console.log('belum ada sesi'); return; }
  for (const row of rows) {
    console.log(row.id + '  ' + String(row.pesan).padStart(3) + ' pesan  ' + new Date(row.waktu).toISOString().slice(0, 16).replace('T', ' ') + '  ' + row.judul);
  }
}

function tampilSkill(nama) {
  if (!nama) {
    const semua = daftarSkill();
    if (!semua.length) { console.log('tidak ada SKILL.md di: ' + (folderSkill().join(', ') || '(tidak ada folder skill)')); return; }
    for (const satu of semua) console.log(satu.nama + '  ' + satu.deskripsi.slice(0, 100));
    console.log('\n(' + semua.length + ' keahlian; folder: ' + folderSkill().join(', ') + ')');
    return;
  }
  const hasil = bacaSkill(nama);
  // Keahlian yang diminta tapi tidak ada = galat, bukan jawaban sukses.
  if (!hasil) { console.error('keahlian tidak ditemukan: ' + nama); process.exitCode = 1; return; }
  console.log(hasil.teks);
}

/* ------------------------------------------------------- non-agen -- */

function pasangArgv(alat, kata, flag) {
  const args = {};
  const kunci = Object.keys(alat.parameters.properties || {});
  let posisi = 0;
  for (const [nama, nilai] of Object.entries(flag)) {
    // Bendera umum dilewati, KECUALI namanya parameter alat ini: `sakti web
    // --url=… aksi=periksa` dulu membuang --url lalu protes "kurang: url".
    const cocokNama = kunci.find((k) => k.toLowerCase() === nama.toLowerCase());
    if (BENDERA_UMUM.includes(nama) && !cocokNama) continue;
    const target = cocokNama || (kunci.includes(nama) ? nama : undefined);
    if (!target) continue;
    const tipe = alat.parameters.properties[target].type;
    args[target] = tipe === 'number' ? Number(nilai) : tipe === 'boolean' ? nilai === true || nilai === 'true' : nilai;
  }
  for (const potongan of kata) {
    // `kunci=nilai` (tanpa --) hanya untuk kunci yang dikenal alat ini;
    // token lain tetap jadi argumen posisi supaya perintah seperti `bot` utuh.
    const pasangan = /^([a-zA-Z][a-zA-Z0-9_-]*)=([\s\S]*)$/.exec(potongan);
    if (pasangan) {
      const namaPasangan = kunci.find((k) => k.toLowerCase() === pasangan[1].toLowerCase()) || (pasangan[1] === 'path' && kunci.includes('path') ? 'path' : null);
      if (namaPasangan) {
        const tipePasangan = alat.parameters.properties[namaPasangan].type;
        args[namaPasangan] = tipePasangan === 'number' ? Number(pasangan[2]) : tipePasangan === 'boolean' ? pasangan[2] === 'true' : tipePasangan === 'array' ? uraiArray(pasangan[2]) : pasangan[2];
        continue;
      }
    }
    while (posisi < kunci.length && args[kunci[posisi]] !== undefined) posisi += 1;
    if (posisi >= kunci.length) break;
    const nama = kunci[posisi];
    const tipe = alat.parameters.properties[nama].type;
    if (tipe === 'number') args[nama] = Number(potongan);
    else if (tipe === 'boolean') args[nama] = potongan === 'true';
    else if (tipe === 'array') args[nama] = potongan.split(',').map((s) => s.trim()).filter(Boolean);
    else args[nama] = potongan;
    posisi += 1;
  }
  return { args, kurang: (alat.parameters.required || []).filter((nama) => args[nama] === undefined) };
}

/* -------------------------------------------------------- perbarui -- */

/** `sakti update`: segarkan katalog model dari endpoint + indeks skill,
 *  lalu laporkan keadaan diri. Meniru `pi update` (self/source/catalog). */
/**
 * `sakti update --pull`: tarik kode dari git. Hanya fast-forward, hanya repo
 * bersih, dan hanya dengan persetujuan eksplisit (TTY menjawab, atau --ya).
 * Ini TIDAK menyentuh config/sesi/ingatan - hanya berkas program.
 */
async function tarikKode(flag = {}) {
  const jalurGit = spawnSync('git', ['-C', DIR, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (jalurGit.status !== 0) throw new Error('bukan repo git: ' + DIR);
  const kotor = spawnSync('git', ['-C', DIR, 'status', '--porcelain'], { encoding: 'utf8' });
  if (String(kotor.stdout || '').trim() && flag.paksa !== true) {
    throw new Error('repo punya perubahan lokal; commit/stash dulu, atau --paksa (tidak disarankan)');
  }
  if (flag.ya !== true) {
    if (!TTY) throw new Error('tanpa TTY: tambahkan --ya untuk menarik kode');
    const jawab = await tanyaSetup('tarik kode terbaru dari git? (y/t)', { bawaan: 't' });
    if (!/^y/i.test(String(jawab || '').trim())) { console.log('dibatalkan'); return; }
  }
  const hasil = spawnSync('git', ['-C', DIR, 'pull', '--ff-only'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const teks = String(hasil.stdout || '') + String(hasil.stderr || '');
  if (hasil.status !== 0) throw new Error('git pull gagal: ' + teks.trim().slice(0, 400));
  console.log(teks.trim() || 'sudah terbaru');
  console.log('kode diperbarui; jalankan ulang sakti. config/sesi/ingatan tidak disentuh.');
}

async function perbarui(arga, konfModel) {
  const baris = ['sakti ' + VERSI + ' · node ' + process.version + ' · ' + process.platform];
  const bagian = new Set([(arga || 'semua').toLowerCase()]);

  // 1. katalog model
  if (bagian.has('semua') || bagian.has('model')) {
    // Satu jalur dengan `/model tes` dan doctor: /models kalau ada, kalau
    // tidak ketahuan bahwa endpoint hanya melayani chat. Timeout dilonggarkan
    // karena katalog 80 model di proksi lokal bisa >8 detik saat sibuk.
    // Katalog disimpan PER ENDPOINT, jadi ganti endpoint = katalognya sendiri.
    const hasil = await sinkronKatalog(konfModel, { paksa: true, waktu: 15000 });
    if (!hasil.ok) {
      baris.push('model: gagal menyegarkan katalog (' + hasil.pesan + ') - model aktif tetap ' + konfModel.model);
    } else {
      baris.push('model: ' + hasil.katalog.length + ' tersedia dari ' + hasil.url + ' (' + hasil.ms + 'ms, dipakai: ' + konfModel.model + ')');
      if (!hasil.katalog.includes(konfModel.model)) baris.push('  ! model aktif tidak ada di katalog; pilih dengan sakti model <nama>');
    }
  }

  // 2. indeks skill
  if (bagian.has('semua') || bagian.has('skill')) {
    const semua = daftarSkill();
    baris.push('skill: ' + semua.length + ' terbaca dari ' + (folderSkill().join(', ') || '(tidak ada folder)'));
  }

  // 3. diri sendiri
  if (bagian.has('semua') || bagian.has('diri') || bagian.has('self')) {
    const akar = path.dirname(new URL(import.meta.url).pathname);
    const punyaGit = fs.existsSync(path.join(akar, '..', '.git'));
    const besar = (() => {
      try { return fs.readdirSync(path.join(akar, 'lib')).length; } catch { return 0; }
    })();
    baris.push('berkas: ' + besar + ' modul di ' + path.join(akar, 'lib'));
    baris.push('pembaruan: ' + (punyaGit ? 'ada .git - jalankan git pull di ' + path.resolve(akar, '..') : 'tanpa git - perbarui dengan menyalin folder, dependensi nol (hanya stdlib node)'));
    baris.push('node minimal: 20 · terpasang: ' + process.versions.node + (Number(process.versions.node.split('.')[0]) >= 20 ? ' (cukup)' : ' (TERLALU TUA)'));
  }

  console.log(baris.join('\n'));
}

/* ---------------------------------------------------------- doctor -- */

/** `sakti doctor`: periksa hal yang sering bikin agen diam-diam rusak.
 *  Tiap baris: OK / BERMASALAH + bukti singkat. Tidak ada perbaikan otomatis. */
async function doctor(konfModel, ctx, { json = false } = {}) {
  const baris = [];
  // Untuk --json: status mentah per pemeriksaan (nama, ok, pesan, ms).
  const rinci = [];
  const uji = async (nama, fn) => {
    // Pemeriksaan jaringan bisa puluhan detik (ada rantai cadangan). Tanpa
    // penanda, `doctor` tampak menggantung sehingga orang membunuhnya sebelum
    // hasilnya keluar. Penanda ditulis ke stderr agar tidak mengotori keluaran.
    const mulai = Date.now();
    if (!json && process.stderr.isTTY) process.stderr.write('periksa ' + nama + ' ... ');
    try {
      const hasil = await fn();
      const lama = Date.now() - mulai;
      baris.push('OK ' + nama + ': ' + hasil + (lama > 1000 ? ' (' + (lama / 1000).toFixed(1) + 's)' : ''));
      rinci.push({ nama, ok: true, pesan: String(hasil), ms: lama });
      if (!json && process.stderr.isTTY) process.stderr.write('ok\n');
    } catch (galat) {
      const lama = Date.now() - mulai;
      baris.push('BERMASALAH ' + nama + ': ' + String((galat && galat.message) || galat) + (lama > 1000 ? ' (' + (lama / 1000).toFixed(1) + 's)' : ''));
      rinci.push({ nama, ok: false, pesan: String((galat && galat.message) || galat), ms: lama });
      if (!json && process.stderr.isTTY) process.stderr.write('bermasalah\n');
    }
  };

  await uji('node', async () => {
    const besar = Number(process.versions.node.split('.')[0]);
    if (besar < 20) throw new Error('versi ' + process.version + ' terlalu tua (butuh >= 20)');
    return process.version + (besar < 22 ? ' · alat db SQLite butuh >= 22; pakai psql/mysql atau upgrade' : '');
  });

  await uji('endpoint model', async () => {
    // Uji jalur nyata: /models kalau ada, kalau tidak /chat/completions satu
    // token. Dulu /v1/models diasumsikan selalu ada, jadi proksi yang hanya
    // menyediakan chat dilaporkan BERMASALAH padahal bisa dipakai.
    const hasil = await ujiModel(konfModel);
    if (!hasil.ok) throw new Error(hasil.pesan + ' (' + hasil.baseUrl + ')');
    if (Array.isArray(hasil.katalog) && hasil.katalog.length) {
      if (!hasil.katalog.includes(konfModel.model)) throw new Error('model aktif "' + konfModel.model + '" tidak ada di katalog (' + hasil.katalog.length + ' model)');
      // Model turunan (murah/fallback/bot) juga harus ada di katalog endpoint
      // tempat ia dipakai; dipakai katalog LIVE dari respons ini, bukan config.
      const konfCek = Object.assign({}, konfModel, { models: hasil.katalog });
      const salah = ringkasModelTurunan(periksaModelTurunan(konfCek, turunanModel(konfCek)));
      return konfModel.model + ' terdaftar di ' + urlKatalog(konfModel.baseUrl) + ' (' + hasil.katalog.length + ' model)'
        + (salah.length ? ' · catatan: ' + salah.join('; ') : '');
    }
    return konfModel.baseUrl + ' menjawab lewat ' + hasil.tahap + ' (' + hasil.ms + 'ms) · katalog /models tidak tersedia';
  });

  await uji('keahlian', async () => {
    const dari = folderSkill();
    const semua = daftarSkill();
    if (!dari.length) throw new Error('tidak ada folder skill yang ada di disk');
    if (!semua.length) throw new Error('folder ada tapi tidak ada SKILL.md: ' + dari.join(', '));
    return semua.length + ' SKILL.md dari ' + dari.join(', ');
  });

  await uji('berkas ingatan', async () => {
    const jalur = berkasState();
    tulisState(bacaState());
    return jalur + ' bisa ditulis' + (fs.existsSync(jalur) ? '' : ' (baru dibuat)');
  });

  await uji('mcp', async () => {
    // Server MCP yang tidak menutup koneksinya menahan proses CLI (gejala:
    // jawaban tercetak lalu menggantung). Laporkan jumlah koneksi hidup supaya
    // kebocoran terlihat sebelum jadi laporan pengguna.
    const klien = await import('./lib/mcp-klien.js');
    const server = klien.daftarServer();
    return server.length + ' server (' + server.filter((satu) => satu.aktif).length + ' aktif) · koneksi hidup ' + klien.aktifKoneksi();
  });

  await uji('rea', async () => {
    const rea = await import('./lib/rea.js');
    const st = rea.statusRea();
    if (!st.ada) return 'belum terpasang (opsional: sakti rea pasang)';
    const mcp = (await import('./lib/mcp-klien.js')).daftarServer().find((satu) => satu.nama === 'rea');
    return (st.versi || 'terpasang') + ' · ' + st.launcher.berkas + ' · MCP ' + (mcp && mcp.aktif !== false ? 'aktif' : 'belum didaftarkan');
  });

  await uji('reach', async () => {
    const reach = await import('./lib/reach.js');
    const st = reach.statusReach();
    if (!st.ada) return 'belum terpasang (opsional: sakti reach pasang)';
    const skill = path.join(process.env.HOME || '/root', '.hermes', 'skills', 'agent-reach', 'SKILL.md');
    return (st.versi || 'terpasang') + ' · ' + st.jalur + ' · skill ' + (fs.existsSync(skill) ? 'terpasang' : 'belum');
  });

  await uji('folder spill', async () => {
    const folder = process.env.SAKTI_CLI_SPILL || path.join(process.env.HOME || '/root', '.sakti-cli', 'spill');
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  });

  await uji('folder kerja', async () => {
    if (!fs.existsSync(ctx.cwd)) throw new Error('tidak ada: ' + ctx.cwd);
    fs.accessSync(ctx.cwd, fs.constants.W_OK);
    return ctx.cwd + ' bisa ditulis';
  });

  await uji('cari web', async () => {
    const hasil = await cariWeb('node js', { maks: 1, waktu: 15000 });
    if (!hasil.length) throw new Error('tidak ada hasil');
    return hasil[0].url;
  });

  // Hook yang JSON-nya cacat dulu diam-diam diabaikan; doctor yang mengatakannya.
  await uji('hook alat', async () => {
    const jalur = berkasHook();
    if (!fs.existsSync(jalur)) return 'belum ada (' + jalur + '), hook mati';
    const mentah = fs.readFileSync(jalur, 'utf8');
    try { JSON.parse(mentah); }
    catch (galat) { throw new Error('JSON cacat di ' + jalur + ': ' + galat.message); }
    const isi = bacaHook();
    const tahap = ['pra', 'pasca'].filter((t) => isi[t] && typeof isi[t] === 'object');
    const jumlah = tahap.reduce((n, t) => n + Object.keys(isi[t]).length, 0);
    return jalur + ' (' + jumlah + ' entri: ' + (tahap.join('+') || 'kosong') + ')';
  });

  await uji('mesin agen luar', async () => {
    const ada = mesinLuar();
    if (!ada.length) return 'tidak ada (codex/opencode/claude) - delegasi tetap jalan dengan mesin=lokal';
    return ada.map((m) => m.nama + ' -> ' + m.jalur).join(', ');
  });

  await uji('perintah kustom', async () => {
    const semua = daftarPerintahKustom();
    const folder = folderPerintah();
    if (!semua.length) return 'belum ada (' + folder + ')';
    return semua.length + ' perintah dari ' + folder + ': ' + semua.map((s) => '/' + s.nama).join(' ');
  });

  // Config berisi kunci API: izin longgar = kunci bisa dibaca proses lain.
  await uji('config & izin', async () => {
    const jalur = konfModel.berkas;
    if (!fs.existsSync(jalur)) return 'belum ada (' + jalur + ') - jalankan sakti setup';
    const mode = fs.statSync(jalur).mode & 0o777;
    if (mode & 0o077) throw new Error('izin ' + mode.toString(8) + ' terlalu longgar (ada kunci API): chmod 600 ' + jalur);
    return jalur + ' (' + mode.toString(8) + ')';
  });

  // Gateway dari setup: salah simpan = `sakti kanal` mati saat dipakai.
  await uji('gateway chat', async () => {
    const kanal = konfModel.kanal;
    if (!kanal) return 'tidak dipakai';
    if (!['telegram', 'whatsapp', 'generik'].includes(kanal.jenis)) throw new Error('jenis tidak dikenal: ' + kanal.jenis);
    const port = Number(kanal.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('port tidak sah: ' + kanal.port);
    if (kanal.jenis === 'telegram' && !kanal.token) throw new Error('telegram tanpa bot token');
    return kanal.jenis + ' · http://' + (kanal.host || '127.0.0.1') + ':' + port + (kanal.token ? ' · token tersimpan' : '');
  });

  await uji('ingatan & pelajaran', async () => {
    const state = bacaState();
    const semua = Array.isArray(state.ingatan) ? state.ingatan : [];
    const pel = semua.filter((row) => row && row.jenis === 'pelajaran');
    return semua.length + ' ingatan · ' + pel.length + ' pelajaran otomatis'
      + ((state.mind || []).length ? ' · ' + state.mind.length + ' inti' : '')
      + (pelajaranAktif(konfModel) ? '' : ' · otomatis MATI');
  });

  await uji('skema alat', async () => {
    const { skemaAlat } = await import('./lib/agent.js');
    const teks = JSON.stringify(skemaAlat());
    return ALAT.length + ' alat · ~' + Math.round(teks.length / 4) + ' token per panggilan'
      + (konfModel.alat ? ' · subset aktif: ' + konfModel.alat : ' · pakai --alat= untuk hemat');
  });

  baris.push('');
  const adaMasalah = baris.some((satu) => satu.startsWith('BERMASALAH'));
  baris.push(adaMasalah ? 'ada yang perlu dibetulkan (lihat baris BERMASALAH)' : 'semua siap');
  if (json) {
    process.stdout.write(JSON.stringify({ ok: !adaMasalah, versi: VERSI, pemeriksaan: rinci }, null, 1) + '\n');
    if (adaMasalah) process.exitCode = 1;
    return;
  }
  console.log(baris.join('\n'));
  // CI membaca kode keluar: `doctor` yang menemukan masalah bukan sukses.
  if (adaMasalah) process.exitCode = 1;
}

/* ------------------------------------------------------------- bot -- */

/** `sakti bot …`: buat/atur bot lalu masukkan ke chatroom (sesi). */
function modeBot(kata, ctx, opsi = {}) {
  const aksi = kata[0] || 'daftar';
  // Tanpa `--sesi`, perintah bot bekerja pada room BAWAAN, bukan sesi terakhir.
  // Dulu `bot masuk` menulis ke sesi lama sementara `sakti chat` selalu membuat
  // sesi baru, jadi bot yang "dimasukkan" tak pernah dipanggil sama sekali.
  const sesiId = (kata.length > 1 && aksi === 'room' && kata[1]) || opsi.sesi || null;

  if (aksi === 'daftar') {
    const semua = daftarBot();
    if (!semua.length) { console.log('belum ada bot di ' + folderBot() + '\nbuat: sakti bot baru riset prompt="kamu analis data"'); return; }
    const room = sesiId ? botDiRoom(sesiId) : [];
    for (const bot of semua) console.log(ringkasBot(bot, room) + (bot.prompt ? '\n    ' + bot.prompt.replace(/\s+/g, ' ').slice(0, 100) : ''));
    console.log('\n(' + semua.length + ' bot · folder ' + folderBot() + ' · room ' + (sesiId || '-') + ': ' + (room.join(', ') || 'kosong') + ')');
    return;
  }
  if (aksi === 'urut') {
    // Urutan bicara menurut tugas. Angka kecil bicara lebih dulu.
    const room = urutkanNamaPeserta(botDiRoom(sesiId), bacaBot);
    if (!room.length) { console.log('room ' + sesiId + ' kosong - hanya kamu'); return; }
    room.forEach((nama, i) => {
      const satu = bacaBot(nama);
      const tugas = (satu && satu.tugas) || '-';
      const urut = satu && Number.isFinite(Number(satu.urutan)) ? Number(satu.urutan) : 'bawaan';
      console.log((i + 1) + '. ' + nama + '  tugas=' + tugas + '  urutan=' + urut);
    });
    console.log('\nubah: sakti bot set <nama> tugas=qa urutan=10');
    return;
  }
  if (aksi === 'baru') {
    const nama = kata[1];
    if (!nama) { console.error('butuh nama: sakti bot baru riset prompt="kamu …"'); process.exit(2); }
    const nilai = {};
    const sisaToken = [];
    for (const potongan of kata.slice(2)) {
      const pisah = potongan.indexOf('=');
      if (pisah > 0) nilai[potongan.slice(0, pisah)] = potongan.slice(pisah + 1);
      else sisaToken.push(potongan);
    }
    const prompt = nilai.prompt || sisaToken.join(' ');
    delete nilai.prompt;
    const bot = simpanBot(nama, Object.assign(nilai, { prompt }));
    if (sesiId) aturRoom(sesiId, botDiRoom(sesiId).concat([bot.nama]));
    else {
      // Tanpa `--sesi`, bot baru otomatis jadi bagian room BAWAAN: setiap
      // `sakti chat` baru mewarisi room ini. Dulu bot baru tidak masuk
      // mana-mana, jadi sesi berikutnya tidak punya bot bawaan sama sekali.
      aturBawaan([...new Set(botBawaan().concat([namaSah(bot.nama)]))]);
      console.log('room bawaan: ' + botBawaan().join(', '));
    }
    console.log('bot dibuat: ' + bot.nama + ' (' + folderBot() + '/' + bot.nama + '.json)');
    if (sesiId) console.log('room ' + sesiId + ': ' + botDiRoom(sesiId).join(', '));
    return;
  }
  if (aksi === 'set') {
    const nama = kata[1];
    if (!nama) { console.error('butuh nama: sakti bot set riset prompt="…" model=… alat=baca,cari'); process.exit(2); }
    const nilai = {};
    for (const potongan of kata.slice(2)) {
      const pisah = potongan.indexOf('=');
      if (pisah > 0) nilai[potongan.slice(0, pisah)] = potongan.slice(pisah + 1);
    }
    console.log(JSON.stringify(simpanBot(nama, nilai), null, 1));
    return;
  }
  if (aksi === 'hapus') {
    const nama = kata[1];
    if (!nama) { console.error('butuh nama: sakti bot hapus riset'); process.exit(2); }
    hapusBot(nama);
    // Bandingkan tergolisi: room menyimpan slug (namaSah), `nama` bisa nama
    // tampilan. Dulu "Sulhan" !== "sulhan" -> bot sampah tetap tercatat di room.
    if (sesiId) aturRoom(sesiId, botDiRoom(sesiId).filter((satu) => satu !== namaSah(nama)));
    console.log('bot dihapus: ' + nama);
    return;
  }
  if (aksi === 'masuk' || aksi === 'lepas' || aksi === 'room') {
    // Tanpa `--sesi`, yang diubah adalah room BAWAAN: itulah yang dipakai
    // setiap `sakti chat` baru. Dulu perubahan masuk ke satu sesi sekali pakai,
    // sehingga `sakti chat` berikutnya memanggil agen tunggal dan bot-bot itu
    // seolah tidak pernah dipanggil.
    const kunci = sesiId || null;
    const bacaRoom = () => (kunci ? botDiRoom(kunci) : botBawaan());
    if (aksi === 'room') {
      const label = kunci ? 'room ' + kunci : 'room bawaan';
      console.log(label + ': ' + (bacaRoom().join(', ') || '(kosong - hanya kamu)'));
      return;
    }
    // Beberapa nama sekaligus: `sakti bot masuk riset kode`. `semua` = semua bot
    // di disk; `lepas semua` mengosongkan room.
    let nama = kata.slice(1).filter(Boolean);
    // `daftarBot()` mengembalikan nama TERGOLISI (namaSah: huruf kecil, slug),
    // sedangkan isi room disimpan dalam bentuk yang sama — jadi `semua` harus
    // dinormalisasi dulu. Dulu `bot lepas semua` membandingkan "Sulhan" dengan
    // "sulhan" di room: tak pernah cocok, lepas diam-diam gagal (exit 0).
    if (nama.length === 1 && nama[0] === 'semua') nama = daftarBot().map((satu) => namaSah(satu.nama));
    // Nama yang diketik juga bisa nama tampilan ("Eny"): lepas satu bot harus
    // TEPAT mengeluarkan bot itu saja - bukan gagal diam-diam sampai pengguna
    // terpaksa `lepas semua` dan SEMUA bot keluar dari room.
    else nama = urutkanMasuk(nama);
    if (!nama.length) { console.error('butuh nama bot: sakti bot ' + aksi + ' riset [kode ...] | semua'); process.exit(2); }
    const hilang = nama.filter((satu) => !bacaBot(satu));
    if (hilang.length) { console.error('bot tidak ada: ' + hilang.join(', ')); process.exit(2); }
    const sekarang = bacaRoom();
    const mau = aksi === 'masuk';
    const berikut = mau ? [...new Set(sekarang.concat(nama))] : sekarang.filter((satu) => !nama.includes(satu));
    const akhir = kunci ? aturRoom(kunci, berikut) : aturBawaan(berikut);
    console.log((kunci ? 'room ' + kunci : 'room bawaan') + ': ' + (akhir.join(', ') || '(kosong)'));
    return;
  }
  console.error('aksi tidak dikenal: ' + aksi + ' (daftar|baru|set|hapus|masuk|lepas|room)');
  process.exit(2);
}

// Perintah tingkat atas (bukan alat). Disimpan di sini karena `bantu()` hanya
// mencetak teks; daftar ini dipakai juga oleh skrip completion.
const PERINTAH = ['chat', 'run', 'serve', 'wa', 'kanal', 'rawat', 'sesi', 'biaya', 'ingatan', 'bot', 'skill', 'rencana',
  'doctor', 'help', 'completion', 'mcp', 'rea', 'reach', 'uji', 'status', 'model', 'khazanah', 'room', 'alat',
  'init', 'env', 'perintah', 'petunjuk', 'subagen', 'update', 'upgrade', 'perbarui',
  'bersih', 'pelajaran', 'bersihkan', 'setup'];

/** Skrip penyelesaian shell. Sumber tunggal = PERINTAH + ALAT + alias. */
function skripCompletion(shell, { perintah, alat, alias }) {
  // Bendera umum ikut disarankan; `bersih` adalah aksi `sakti sesi`.
  const kata = [...new Set([...perintah, ...alat, ...alias, ...BENDERA_UMUM.map((b) => '--' + b), 'bersih'])].sort();
  const daftar = kata.join(' ');
  if (shell === 'fish') {
    return 'complete -c sakti -f -a "' + daftar + '"\n';
  }
  if (shell === 'powershell' || shell === 'pwsh') {
    // codex `completion` mendukung PowerShell; bentuknya Register-ArgumentCompleter.
    return 'Register-ArgumentCompleter -Native -CommandName sakti -ScriptBlock {\n' +
      '  param($wordToComplete, $commandAst, $cursorPosition)\n' +
      '  $kata = \'' + daftar + '\' -split \' \'\n' +
      '  $kata | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {\n' +
      '    [System.Management.Automation.CompletionResult]::new($_, $_, \'ParameterValue\', $_)\n' +
      '  }\n' +
      '}\n';
  }
  if (shell === 'zsh') {
    return '#compdef sakti\n_sakti() {\n  local -a k\n  k=(' + daftar + ')\n  _describe \'perintah sakti\' k\n}\ncompdef _sakti sakti\n';
  }
  if (shell !== 'bash') {
    return '# shell tidak didukung: pakai bash, zsh, atau fish\n';
  }
  return '_sakti() {\n  local cur="${COMP_WORDS[COMP_CWORD]}"\n  COMPREPLY=( $(compgen -W "' + daftar + '" -- "$cur") )\n}\ncomplete -F _sakti sakti\n';
}

/* ------------------------------------------------------------- setup -- */

/** Pertanyaan biasa lewat readline; nilai bawaan ditampilkan di [kurung]. */
async function tanyaSetup(pertanyaan, { bawaan = '' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const jawab = String(await rl.question(pertanyaan + (bawaan ? ' [' + bawaan + ']' : '') + ': ')).trim();
    return jawab || bawaan;
  } finally {
    rl.close();
  }
}

/**
 * Pertanyaan rahasia: input dimatikan gema-nya (raw mode) supaya API key / bot
 * token tidak tertinggal di layar atau scrollback. Tanpa TTY jatuh ke baris biasa.
 */
async function tanyaRahasia(pertanyaan, { bawaan = '' } = {}) {
  if (!process.stdin.isTTY) return tanyaSetup(pertanyaan, { bawaan });
  process.stderr.write(pertanyaan + (bawaan ? ' [Enter = pakai yang tersimpan]' : '') + ': ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((selesai) => {
    let buf = '';
    const bersih = () => {
      try { process.stdin.setRawMode(false); } catch { /* bukan TTY */ }
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    const onData = (bagian) => {
      for (const ch of String(bagian)) {
        if (ch === '\r' || ch === '\n') { bersih(); process.stderr.write('\n'); return selesai(buf || bawaan); }
        if (ch === '\u0003') { bersih(); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * `sakti setup` - interaktif (TTY) atau non-interaktif lewat bendera.
 * Hasil selalu ditulis ke config (0600) lalu diuji sekali; endpoint yang mati
 * dilaporkan sebagai peringatan, bukan membatalkan penyimpanan.
 */
async function modeSetup(flag) {
  const cetak = (teks = '') => console.log(teks);
  let hasil;
  try {
    if (flag.url || flag.key || flag.model) {
      const gateway = flag.gateway
        ? {
          jenis: flag.gateway,
          token: flag['gateway-token'] || '',
          port: Number(flag['gateway-port']) || 4318,
          host: flag['gateway-host'] || '127.0.0.1',
          serve: typeof flag.serve === 'string' && flag.serve ? flag.serve : 'http://127.0.0.1:4317'
        }
        : { jenis: 'none' };
      hasil = susunKonfig({ url: flag.url || '', key: flag.key || '', model: flag.model || '', gateway, fallbacks: flag.fallback || '' });
    } else {
      if (!TTY) {
        console.error('setup interaktif butuh terminal. Non-interaktif: sakti setup --url=<url> --key=<kunci> --model=<id> [--gateway=telegram --gateway-token=<token>]');
        process.exitCode = 2;
        return;
      }
      hasil = await setupInteraktif({
        tanya: (pertanyaan, opsi = {}) => (opsi.rahasia ? tanyaRahasia(pertanyaan, opsi) : tanyaSetup(pertanyaan, opsi)),
        cetak,
        konfAwal: konfigModel()
      });
    }
  } catch (galat) {
    const pesan = String((galat && galat.message) || galat);
    // Ctrl+D / Ctrl+C bukan kegagalan setup: beri kalimat yang tidak bikin panik.
    if (/aborted|Ctrl\+D|dibatalkan/i.test(pesan)) {
      console.error('setup dibatalkan; config tidak diubah');
      process.exitCode = 1;
      return;
    }
    console.error('setup gagal: ' + pesan);
    process.exitCode = 2;
    return;
  }
  if (!hasil) { console.error('setup dibatalkan'); process.exitCode = 1; return; }

  simpanModel(hasil.nilai);
  const konf = konfigModel();
  console.log('');
  console.log(ringkasSetup(hasil.nilai));
  console.log('berkas   : ' + konf.berkas + ' (mode 0600)');
  for (const baris of hasil.catatan || []) console.log('catatan  : ' + baris);

  console.log('');
  console.log('menguji koneksi ...');
  const uji = await ujiModel(konf, { waktu: 12000 });
  console.log((uji.ok ? 'OK koneksi: ' : 'GAGAL koneksi: ') + uji.pesan + (uji.ms ? ' (' + uji.ms + 'ms)' : ''));

  console.log('');
  console.log('berikutnya:');
  console.log('  sakti                         buka workspace TUI');
  console.log('  sakti doctor                  periksa endpoint/kunci/skill sekaligus');
  if (hasil.nilai.kanal) {
    console.log('  sakti serve --port=4317       server agen (dipakai kanal)');
    console.log(hasil.nilai.kanal.jenis === 'whatsapp'
      ? '  sakti wa                      WhatsApp native: scan QR (auth ~/.sakti-cli/wa-auth)'
      : '  sakti kanal                   gateway ' + hasil.nilai.kanal.jenis + ' di http://' + hasil.nilai.kanal.host + ':' + hasil.nilai.kanal.port);
    if (hasil.nilai.kanal.jenis === 'telegram') console.log('  (token bot tersimpan di config; webhook Telegram diarahkan ke /kanal/telegram)');
    if (hasil.nilai.kanal.jenis === 'whatsapp') console.log('  (bridge WhatsApp POST {teks,dari} ke /kanal/generik)');
  }
}

async function main() {
  const { flag, sisa } = nilaiFlag(process.argv.slice(2));
  const ctx = konteks({
    cwd: typeof flag.cwd === 'string' ? flag.cwd : undefined,
    worker: flag.worker != null ? Number(flag.worker) : undefined
  });
  let konfModel = konfigModel(flag);
  // --version selalu menang; --help setelah subperintah juga menang supaya
  // `sakti init --help` tidak menulis berkas dan `sakti model --help` tidak
  // memanggil jaringan. `setup` tetap punya jalur bantuan sendiri.
  if (flag.version) { console.log(VERSI); return; }
  if (flag.help && sisa[0] !== 'setup') { console.log(bantu()); return; }
    // `sakti completion bash|zsh|fish` - ditangani sebelum vonis bendera supaya
  // skrip penyelesaian tidak perlu tahu apa pun soal sisa CLI.
  if (sisa[0] === 'completion') {
    const cangkang = String(sisa[1] || 'bash').toLowerCase();
    if (!['bash', 'zsh', 'fish', 'powershell', 'pwsh'].includes(cangkang)) {
      console.error('shell tidak didukung: ' + sisa[1] + ' · pilih: bash | zsh | fish | powershell');
      process.exit(2);
    }
    process.stdout.write(skripCompletion(cangkang, { perintah: PERINTAH, alat: ALAT.map((a) => a.name), alias: Object.keys(ALIAS) }));
    return;
  }

const perintah = sisa[0] || (flag.help ? 'help' : 'chat');
  const kata = sisa.slice(1);

  // `sakti -p "<pesan>"` didokumentasikan sebagai mode sekali-jalan berpesan
  // (README & riwayat sejak 2.x), tapi `-p` hanya menyalakan flag.cetak lalu
  // "pesan" diperlakukan sebagai NAMA PERINTAH -> "tidak ada perintah atau alat
  // bernama". Dengan pesan posisi + flag cetak, rutekan ke mode run.
  if (flag.cetak === true && sisa.length && !PERINTAH.includes(sisa[0]) && !cariAlat(ALIAS[sisa[0]] || sisa[0])) {
    const lampiran = uraiArray(flag.lampirkan).flatMap((jalur) => {
      try {
        const isi = fs.readFileSync(jalur, 'utf8');
        return ['--- ' + jalur + ' ---\n' + (isi.length > 20000 ? isi.slice(0, 20000) + '\n[...dipotong ' + isi.length + ' byte]' : isi)];
      } catch (galat) {
        console.error('lampiran gagal dibaca: ' + jalur + ' (' + galat.message + ')');
        process.exitCode = 1;
        return [];
      }
    });
    const pesan = [lampiran.join('\n\n'), sisa.join(' ').trim()].filter(Boolean).join('\n\n');
    if (pesan) { await modeAgen(pesan, { flag, ctx, konfModel }); return; }
  }

  // Rawat diri saat startup (maks sekali/6 jam): perbaiki izin/folder/hook,
  // bersihkan sampah, lalu tarik update kode bila repo bersih + ada remote.
  // Dilewati di uji/CI (state/config diarahkan ke temp) dan saat dimatikan.
  if (['chat', 'run', 'serve'].includes(perintah)
    && !process.env.SAKTI_CLI_STATE && !process.env.SAKTI_CLI_CONFIG
    && !/^(1|true|ya)$/i.test(String(process.env.SAKTI_RAWAT_MATI || ''))) {
    try {
      const laporan = rawatOtomatis();
      const ringkas = laporan.dilewati ? '' : ringkasRawat(laporan);
      if (ringkas && !/^mesin: bersih · kode: terbaru/.test(ringkas)) process.stderr.write('rawat: ' + ringkas + '\n');
    } catch (galat) {
      if (flag.penuh === true) process.stderr.write('rawat gagal: ' + String((galat && galat.message) || galat) + '\n');
    }
  }

  // Bendera asing dulu ditelan diam-diam: `--sesion=abc` dijalankan sebagai sesi
  // baru, `--bantuan-tidak-ada` jadi "tidak ada pesan (stdin kosong)". Salah
  // ketik harus berisik, bukan jadi perilaku lain.
  // Kunci `kunci=nilai` milik alat juga masuk `flag` - hanya bendera berawalan
  // `--` yang bisa divonis, dan itu sudah dicatat nilaiFlag sebagai `__dash_*`.
  // Alat generik (`sakti baca --offset=5`) menerima nama kunci apa pun, jadi
  // vonis hanya untuk perintah yang BUKAN alat.
  // Perintah yang meneruskan argumen ke program luar (REA, Agent Reach) boleh
  // membawa flag sendiri seperti --json/--limit; jangan divonis sebagai typo.
  const teruskanFlag = ['rea', 'reach'].includes(perintah);
  const asingDash = Object.keys(flag).filter((nama) => nama.startsWith('__dash_') && flag[nama] === true)
    .map((nama) => nama.slice('__dash_'.length))
    .filter((nama) => !teruskanFlag && !BENDERA_UMUM.includes(nama) && !BENDERA_BERSAMA.has(nama) && !cariAlat(ALIAS[perintah] || perintah));
  if (asingDash.length) {
    console.error('bendera tidak dikenal: ' + asingDash.map((n) => '--' + n).join(', ') + '\nlihat: sakti help');
    process.exit(2);
  }

  // Pertama kali pakai: belum ada berkas config dan belum ada kunci dari env.
  // Tanyakan endpoint sekali (TTY saja), lalu lanjut ke chat. Dilewati dengan
  // --tanpa-setup atau SAKTI_SETUP_MATI=1 supaya skrip tidak pernah menggantung.
  if (perintah === 'chat' && !kata.length && !flag['tanpa-setup']
    && !/^(1|true|ya)$/i.test(String(process.env.SAKTI_SETUP_MATI || ''))) {
    const adasBerkas = (() => { try { return fs.existsSync(berkasKonfig()); } catch { return false; } })();
    if (!adasBerkas && !konfModel.apiKey && !process.env.SAKTI_MODEL_KEY && !process.env.SAKTI_MODEL_URL) {
      if (TTY) {
        console.log('Belum ada endpoint tersimpan. Setup singkat dulu (Ctrl+C untuk batal).');
        await modeSetup(flag);
        // Wizard baru menulis config; konfModel di atas dibaca SEBELUM config
        // ada. Tanpa muat ulang, TUI langsung jalan dengan endpoint bawaan.
        konfModel = konfigModel(flag);
      } else {
        console.error('petunjuk: isi dulu endpoint + API key dengan `sakti setup --url=... --key=... --model=...`');
      }
    }
  }

  switch (perintah) {
    case 'rawat':
    case 'rawatan': {
      const sub = String(kata[0] || '').toLowerCase();
      if (['auto', 'otomatis'].includes(sub)) {
        const nilai = !['off', 'mati', '0', 'false'].includes(String(kata[1] || '').toLowerCase());
        simpanModel({ autoRawat: nilai, autoUpdate: nilai });
        console.log('rawat otomatis: ' + (nilai ? 'hidup (update kode + perbaikan ringan)' : 'mati'));
        return;
      }
      if (['update', 'tarik', 'pull'].includes(sub)) {
        const hasil = tarikAman();
        if (benar(flag.json)) { console.log(JSON.stringify(hasil, null, 1)); return; }
        console.log(hasil.ok
          ? (hasil.sudahTerbaru ? 'kode sudah terbaru (' + String(hasil.ke || '').slice(0, 8) + ')' : 'kode diperbarui ' + String(hasil.dari || '').slice(0, 8) + ' -> ' + String(hasil.ke).slice(0, 8) + ' · ' + (hasil.berubah || []).length + ' berkas' + (hasil.rollback ? ' · ROLLBACK' : ''))
          : 'update tidak dijalankan: ' + (hasil.alasan || '?'));
        process.exitCode = hasil.ok ? 0 : 1;
        return;
      }
      const perbaiki = sub !== 'periksa' && sub !== 'check';
      const hasil = rawatLokal({ perbaiki });
      if (benar(flag.json)) { console.log(JSON.stringify(hasil, null, 1)); return; }
      console.log('rawat · ' + (perbaiki ? 'perbaiki' : 'periksa'));
      for (const satu of hasil.perbaikan || []) console.log('  OK ' + satu);
      for (const satu of hasil.temuan || []) console.log('  !  ' + satu);
      if (!(hasil.perbaikan || []).length && !(hasil.temuan || []).length) console.log('  bersih, tidak ada yang perlu diperbaiki');
      if (sub === 'laporan' || sub === 'status') {
        const laporan = rawatOtomatis({ paksa: false });
        console.log(ringkasRawat(laporan));
      }
      return;
    }
    case 'help':
      console.log(bantu());
      return;
    case 'setup':
      if (flag.help) { console.log(bantu()); return; }
      await modeSetup(flag);
      return;
    case 'bersih':
    case 'bersihkan': {
      // Hanya sampah milik alat (spill/checkpoint/tmp). Sesi, keahlian, ingatan,
      // config tidak pernah disentuh - lihat catatan di lib/bersih.js.
      const hapus = benar(flag.hapus) || ['hapus', 'bersihkan', 'jalankan'].includes(String(kata[0] || '').toLowerCase());
      const hasil = hapus ? sapuSampah({}) : pindaiSampah({});
      if (benar(flag.json)) { console.log(JSON.stringify(hasil, null, 1)); return; }
      console.log(ringkasSampah(hasil));
      for (const satu of hasil.item || []) {
        console.log('  ' + satu.jenis + ' · ' + satu.alasan + ' · ' + satu.jalur + ' (' + Math.max(0, Math.round(satu.byte / 1024)) + ' KiB)');
      }
      if (!hapus) console.log('pratinjau saja; pakai: sakti bersih hapus');
      return;
    }
    case 'pelajaran': {
      const sub = String(kata[0] || '').toLowerCase();
      if (['mati', 'off', '0'].includes(sub)) { simpanModel({ pelajaran: 'mati' }); console.log('pelajaran otomatis: mati'); return; }
      if (['hidup', 'on', '1'].includes(sub)) { simpanModel({ pelajaran: 'otomatis' }); console.log('pelajaran otomatis: hidup'); return; }
      if (['hapus', 'lupakan'].includes(sub)) {
        const kataCari = kata.slice(1).join(' ').trim();
        const semua = ['semua', 'all', '*'].includes(kataCari.toLowerCase());
        if (!kataCari) {
          console.error('hapus butuh kata atau "semua": sakti pelajaran hapus <kata> | sakti pelajaran hapus semua');
          process.exitCode = 2;
          return;
        }
        const n = hapusPelajaran({ cari: semua ? '' : kataCari, semua });
        console.log('pelajaran dihapus: ' + n + (semua ? ' (semua)' : ' (cocok "' + kataCari + '")'));
        return;
      }
      const rows = daftarPelajaran(bacaState(), { batas: Number(flag.batas) || 20 });
      console.log('pelajaran otomatis: ' + (pelajaranAktif(konfModel) ? 'hidup' : 'mati') + ' · ' + rows.length + ' terbaru');
      for (const row of rows) console.log('  ' + (Number(row.ulang) > 1 ? '(' + row.ulang + 'x) ' : '') + String(row.teks || ''));
      if (!rows.length) console.log('  (belum ada) - muncul sendiri setelah giliran yang memakai alat');
      return;
    }
    case 'bot':
    case 'bots':
      modeBot(kata, ctx, { sesi: typeof flag.sesi === 'string' ? flag.sesi : null });
      return;
    case 'subagen':
    case 'subagents': {
      const aksi = String(kata[0] || '').toLowerCase();
      if (aksi === 'pilih') {
        const teks = kata.slice(1).join(' ');
        if (!teks) { console.error('butuh teks tugas: sakti subagen pilih "perbaiki bug login"'); process.exit(2); }
        // `peran=auto` tidak pernah memilih peran yang bisa menulis. Tampilkan
        // pilihan auto yang SEBENARNYA (baca-saja), lalu sebut kandidat tulis
        // secara terpisah supaya tidak menjanjikan koder/penguji terpakai.
        for (const satu of pilihSubagen(teks, { maks: 5, hanyaBaca: true })) console.log(satu.nama.padEnd(12) + 'skor=' + satu.skor);
        const penulis = pilihSubagen(teks, { maks: 3, hanyaBaca: false, daftar: SUBAGEN.filter((s) => s.tulis) });
        if (penulis.length && penulis[0].skor > 0) {
          console.log('peran yang bisa menulis (hanya lewat peran= / penuh=true): ' +
            penulis.filter((s) => s.skor > 0).map((s) => s.nama + '(' + s.skor + ')').join(', '));
        }
        return;
      }
      console.log(ringkasSubagen({ semua: true }));
      console.log('\nworker subagen: ' + (workerSubagen(ctx.worker, 12) || '?') + ' bersamaan · setel SAKTI_WORKER_SUBAGEN, --worker=<n>, /worker di TUI, atau worker=<n> di bot');
      console.log('pakai: sakti delegasi peran=auto tugas="..."   ·   sakti delegasi banyak=\'[{"peran":"peneliti","tugas":".."}]\'');
      return;
    }
    case 'serve': {
      const port = Number(flag.port) || Number(kata[0]) || 4317;
      const host = typeof flag.host === 'string' ? flag.host : '127.0.0.1';
      const { server, port: dipakai } = await serve({ port, host, cwd: ctx.cwd, konfModel, muatKonf: () => konfigModel(flag), versi: VERSI, worker: ctx.worker, token: flag.token });
      console.log('sakti serve: http://' + host + ':' + dipakai + '  (POST /chat, GET /sehat, GET /sesi)');
      console.log('auth: ' + ((flag.token || process.env.SAKTI_TOKEN) ? 'token wajib (Authorization: Bearer <token>)' : 'tanpa token (loopback saja)'));
      console.log('hentikan: Ctrl+C');
      // Tetap hidup sampai dihentikan. Server WAJIB ditutup: promise sinyal saja
      // tidak melepas handle listen, jadi proses menggantung setelah Ctrl+C
      // (terukur: SIGINT -> proses masih hidup). Tutup koneksi keep-alive dulu
      // supaya `close` tidak menunggu klien yang tidak pernah selesai.
      await new Promise((selesai) => {
        const tutup = () => selesai();
        process.once('SIGINT', tutup);
        process.once('SIGTERM', tutup);
      });
      await new Promise((selesai) => {
        try { server.closeAllConnections && server.closeAllConnections(); } catch { /* versi lama */ }
        server.close(() => selesai());
        setTimeout(selesai, 2000).unref();
      });
      return;
    }
    case 'wa': {
      // WhatsApp native (Baileys): pairing QR, pesan masuk -> serve /chat,
      // balasan -> WhatsApp. `sakti serve` tetap sumber kebenaran agen.
      const kanalWa = (konfModel && konfModel.kanal) || {};
      const serveWa = typeof flag.serve === 'string' && flag.serve ? flag.serve : (kanalWa.serve || 'http://127.0.0.1:4317');
      const tokenWa = typeof flag.token === 'string' ? flag.token : (process.env.SAKTI_TOKEN || '');
      const izinWa = uraiArray(flag.izin).length
        ? uraiArray(flag.izin)
        : String(process.env.SAKTI_WA_IZIN || '').split(',').map((s) => s.trim()).filter(Boolean);
      const klien = await jalanWa({
        serve: serveWa,
        token: tokenWa,
        authDir: typeof flag.auth === 'string' && flag.auth ? flag.auth : folderAuthWa(),
        izin: izinWa,
        grup: flag.grup === true,
        nomor: typeof flag.nomor === 'string' ? flag.nomor : '',
        sesiPrefix: typeof flag['sesi-prefix'] === 'string' ? flag['sesi-prefix'] : 'wa-'
      });
      console.log('WhatsApp native · auth: ' + klien.authDir + ' · serve: ' + serveWa);
      if (!izinWa.length) console.log('izin: semua pengirim (batasi dengan --izin=628xx,628yy bila perlu)');
      await new Promise((selesai) => {
        const tutup = () => { klien.berhenti(); selesai(); };
        process.once('SIGINT', tutup);
        process.once('SIGTERM', tutup);
      });
      return;
    }
    case 'kanal': {
      // Nilai bawaan dari `sakti setup` (config.kanal): port/host/token/serve.
      // Bendera tetap menang supaya satu mesin bisa menjalankan dua kanal.
      const kanalKonf = (konfModel && konfModel.kanal) || {};
      const port = Number(flag.port) || Number(kata[0]) || Number(kanalKonf.port) || 4318;
      const host = typeof flag.host === 'string' ? flag.host : (kanalKonf.host || '127.0.0.1');
      const tujuan = typeof flag.serve === 'string' && flag.serve ? flag.serve : (kanalKonf.serve || 'http://127.0.0.1:4317');
      // Dua rahasia berbeda, jangan dicampur:
      //   token   = auth webhook masuk (Bearer / X-Sakti-Token)
      //   rahasia = secret_token Telegram (header X-Telegram-Bot-Api-Secret-Token)
      //   bot     = token bot untuk MENGIRIM balasan
      const token = typeof flag.token === 'string' ? flag.token : '';
      const rahasia = kanalKonf.rahasia || '';
      const kirim = kanalKonf.token ? buatPengirim({ token: kanalKonf.token }) : undefined;
      const { server, port: dipakai } = await serveKanal({ port, host, serve: tujuan, token, rahasia, kirim });
      console.log('sakti kanal: http://' + host + ':' + dipakai + '  -> ' + tujuan + '/chat');
      console.log('rute: POST /kanal/telegram, POST /kanal/generik, GET /sehat');
      if (rahasia) console.log('verifikasi webhook: header X-Telegram-Bot-Api-Secret-Token (dari config, tidak dicetak)');
      if (kanalKonf.token) console.log('balasan ' + (kanalKonf.jenis || 'telegram') + ': bot token dari config dipakai');
      console.log('hentikan: Ctrl+C');
      await new Promise((selesai) => {
        const tutup = () => selesai();
        process.once('SIGINT', tutup);
        process.once('SIGTERM', tutup);
      });
      // Sama seperti `serve`: tutup handle listen, kalau tidak proses menggantung.
      await new Promise((selesai) => {
        try { server.closeAllConnections && server.closeAllConnections(); } catch { /* versi lama */ }
        server.close(() => selesai());
        setTimeout(selesai, 2000).unref();
      });
      return;
    }
    case 'update':
    case 'upgrade':
    case 'perbarui':
      if (flag.pull === true) { await tarikKode(flag); return; }
      await perbarui(kata[0], konfModel);
      return;
    case 'chat':
    case 'agen': {
      const pesan = kata.join(' ').trim();
      await modeAgen(pesan || null, { flag, ctx, konfModel });
      return;
    }
    case 'run':
    case 'p': {
      // `--lampirkan=berkas` (boleh koma) menempelkan isi berkas ke pesan,
      // seperti `codex exec --image` / `opencode run -f`. Dipotong 20k/berkas
      // supaya model tidak kaget dan biaya tetap terkira.
      const lampiran = uraiArray(flag.lampirkan).flatMap((jalur) => {
        try {
          const isi = fs.readFileSync(jalur, 'utf8');
          return ['--- ' + jalur + ' ---\n' + (isi.length > 20000 ? isi.slice(0, 20000) + '\n[...dipotong ' + isi.length + ' byte]' : isi)];
        } catch (galat) {
          console.error('lampiran gagal dibaca: ' + jalur + ' (' + galat.message + ')');
          process.exitCode = 1;
          return [];
        }
      });
      const pesan = [lampiran.join('\n\n'), kata.join(' ').trim()].filter(Boolean).join('\n\n');
      if (!pesan) { console.error('sakti run butuh pesan: sakti run "jalankan uji"'); process.exit(2); }
      await modeAgen(pesan, { flag, ctx, konfModel });
      return;
    }
    case 'sesi': {
      const aksi = kata[0] || 'daftar';
      // `sakti sesi baru [judul]` sudah lama dipakai skrip/uji (dan `sakti chat`
      // menyimpan sesi kosong dengan judul) tapi baru sekarang punya jalur
      // eksplisit: tanpa ini `sesi baru` jatuh ke vonis "aksi tidak dikenal".
      if (aksi === 'baru' || aksi === 'new') {
        const judul = typeof flag.judul === 'string' ? flag.judul : kata.slice(1).join(' ');
        const meta = sesiBaru({ judul });
        console.log('sesi dibuat: ' + meta.id + (meta.judul ? ' · ' + meta.judul : ''));
        return;
      }
      if (aksi === 'baca') {
        const isi = bacaSesi(kata[1] || sesiTerakhir());
        // Sesi yang diminta tapi tidak ada = galat, bukan jawaban sukses.
        if (!isi.length) { console.error('sesi kosong atau tidak ada: ' + (kata[1] || '(terakhir)')); process.exitCode = 1; return; }
        for (const row of isi) {
          const kepala = new Date(row.ts || 0).toISOString().slice(11, 19) + ' ' + String(row.role || '?').padEnd(9);
          const isiPesan = row.content ? String(row.content).slice(0, 400) : (row.tool_calls ? '[alat: ' + row.tool_calls.map((satu) => satu.function.name).join(', ') + ']' : '');
          console.log(kepala + ' ' + isiPesan);
        }
        return;
      }
      if (aksi === 'cari') {
        const hasil = cariSesi(kata.slice(1).join(' '));
        console.log(hasil.length ? hasil.map((row) => row.id + ' ' + row.role + ': ' + row.cuplikan).join('\n') : 'tidak ada yang cocok');
        return;
      }
      if (aksi === 'bersih') {
        // Retensi sesi: default pratinjau, `--hapus` baru menghapus. Sesi adalah
        // data pemilik, jadi tidak pernah ikut pembersihan otomatis.
        const hari = Math.max(0, Math.floor(Number(flag.lebih) || 0));
        if (!hari) {
          console.error('butuh --lebih=<hari>: sakti sesi bersih --lebih=30 [--hapus]');
          process.exitCode = 2;
          return;
        }
        const batasMs = Date.now() - hari * 24 * 60 * 60 * 1000;
        const tua = daftarSesi({ batas: 100000 }).filter((row) => Number(row.waktu) < batasMs);
        if (!tua.length) { console.log('tidak ada sesi lebih tua dari ' + hari + ' hari'); return; }
        const hapus = flag.hapus === true;
        for (const row of tua) console.log((hapus ? 'dihapus: ' : 'akan dihapus: ') + row.id + ' · ' + new Date(Number(row.waktu)).toISOString().slice(0, 10) + ' · ' + row.pesan + ' pesan');
        if (!hapus) { console.log('pratinjau; tambah --hapus untuk benar-benar menghapus ' + tua.length + ' sesi'); return; }
        let n = 0;
        for (const row of tua) n += hapusSesi(row.id) ? 1 : 0;
        console.log('sesi dihapus: ' + n);
        return;
      }
      if (aksi === 'hapus') {
        if (!kata[1]) { console.error('butuh id sesi: sakti sesi hapus <id>'); process.exitCode = 2; return; }
        if (!idSesiSah(kata[1])) { console.error('id sesi tidak sah: ' + kata[1]); process.exitCode = 2; return; }
        const jumlah = hapusSesi(kata[1]);
        if (jumlah) console.log('dihapus: ' + kata[1]);
        else { console.error('sesi tidak ada: ' + kata[1]); process.exitCode = 1; }
        return;
      }
      if (aksi === 'ekspor') {
        // `--json` = satu dokumen JSON (opencode `session export`), `--sanitasi`
        // membuang kunci/token/.env dari transkrip sebelum dibagikan.
        const id = kata.slice(1).find((satu) => !satu.startsWith('--')) || sesiTerakhir();
        const json = flag.json === true || flag.json === 'true' || kata.includes('--json');
        const penuh = flag.penuh === true || flag.penuh === 'true' || kata.includes('--penuh');
        const sanitasi = flag.sanitasi === true || flag.sanitasi === 'true' || kata.includes('--sanitasi');
        if (json) {
          const data = sesiJson(id, { penuh, sanitasi });
          if (!data) { console.error('sesi kosong atau tidak ada: ' + (id || '(terakhir)')); process.exitCode = 1; return; }
          process.stdout.write(JSON.stringify(data, null, 1) + '\n');
          return;
        }
        const isi = eksporSesi(id, { penuh, sanitasi });
        if (!isi) { console.error('sesi kosong atau tidak ada: ' + (id || '(terakhir)')); process.exitCode = 1; return; }
        if (!idSesiSah(id)) { console.error('id sesi tidak sah: ' + id); process.exitCode = 2; return; }
        const keluar = path.join(process.cwd(), 'sesi-' + id + '.md');
        fs.writeFileSync(keluar, isi);
        console.log('ditulis: ' + keluar + ' (' + isi.length + ' byte)' + (sanitasi ? ' · rahasia disaring' : ''));
        return;
      }
      if (aksi === 'cabang') {
        const asal = kata[1] || sesiTerakhir();
        const baru = cabangSesi(asal, { sampai: Number(kata[2]) || 0 });
        if (!baru) { console.error('sesi kosong atau tidak ada: ' + asal); process.exitCode = 1; return; }
        console.log('cabang: ' + baru.id + ' (' + baru.pesan + ' pesan dari ' + asal + ')');
        return;
      }
      if (aksi === 'import' || aksi === 'impor') {
        // `opencode session import` - masukkan sesi JSON hasil `sesi ekspor --json`.
        const sumber = kata[1];
        if (!sumber) { console.error('butuh berkas atau URL JSON: sakti sesi import <berkas|url>'); process.exitCode = 2; return; }
        const hasil = await imporSesi(sumber);
        if (!hasil.ok) { console.error('impor gagal: ' + hasil.galat); process.exitCode = 1; return; }
        console.log('sesi diimpor: ' + hasil.id + ' (' + hasil.pesan + ' pesan' + (hasil.judul ? ' · ' + hasil.judul : '') + ')');
        return;
      }
      // Aksi yang tidak dikenal jangan diam-diam berubah jadi "daftar sesi":
      // salah ketik harus berisik (kode keluar 2 = salah pakai).
      if (AKSI_SESI.has(aksi)) { tampilSesi(); return; }
      console.error('aksi sesi tidak dikenal: ' + aksi + ' (daftar|baca|cari|hapus|cabang|ekspor|import)');
      process.exitCode = 2;
      return;
    }
    case 'biaya': {
      // `--hari=<n>` = statistik per model & per hari (opencode `stats --days`);
      // `--json` = dokumen yang sama untuk skrip.
      const hari = Math.max(0, Math.floor(Number(flag.hari) || 0));
      if (flag.json === true || flag.json === 'true' || kata.includes('--json')) {
        const data = hari > 0 ? statistikBiaya({ hari }) : bacaBiaya();
        process.stdout.write(JSON.stringify(data, null, 1) + '\n');
        return;
      }
      console.log(ringkasBiaya(flag.sesi && typeof flag.sesi === 'string' ? flag.sesi : null, { hari }));
      return;
    }
    case 'room': {
      // Setelan mesin: siapa menjawab di room. `tim`/`otomatis` = koordinator
      // membagi tugas (rekan lewat `panggil`), `solo` = satu bot per pesan.
      // Disimpan di state supaya berlaku untuk TUI, run, dan serve.
      const pilih = String(kata[0] || '').toLowerCase();
      if (!pilih) { console.log('mode room: ' + modeRoomTersimpan() + ' · pilihan: ' + MODE_ROOM.join(' | ') + ' · otomatis/tim = koordinator membagi tugas sesuai peran'); return; }
      if (!MODE_ROOM.includes(pilih)) { console.error('mode room tidak dikenal: ' + pilih + ' (pakai ' + MODE_ROOM.join(' | ') + ')'); process.exitCode = 2; return; }
      ubahState((state) => { state.modeRoom = pilih; });
      console.log('mode room: ' + pilih + (pilih === 'otomatis' || pilih === 'tim' ? ' · koordinator membagi tugas ke rekan sesuai peran (tanpa kerja dobel)' : ' · satu bot per pesan'));
      return;
    }
    case 'skill':
      if (kata[0] === 'cocok') {
        const teks = kata.slice(1).join(' ');
        const cocok = skillCocok(teks);
        console.log(cocok.length ? cocok.map((satu) => satu.nama + '  skor=' + satu.skor + '  ' + satu.deskripsi.slice(0, 80)).join('\n') : '(tidak ada keahlian yang cocok)');
        return;
      }
      if (kata[0] === 'curator') {
        const sub = String(kata[1] || 'status').toLowerCase();
        if (sub === 'arsipkan') {
          const hasil = arsipkanSkill(kata[2]);
          console.log(hasil.pindah ? 'diarsipkan: ' + hasil.dari + ' -> ' + hasil.ke : 'tidak diarsipkan: ' + hasil.alasan);
          return;
        }
        if (sub === 'pin' || sub === 'unpin') {
          pinSkill(kata[2], sub === 'pin');
          console.log(sub === 'pin' ? 'dipin: ' + kata[2] : 'pin dilepas: ' + kata[2]);
          return;
        }
        const rows = statusSkill();
        console.log(rows.map((r) => String(r.status).padEnd(8) + ' ' + r.nama.padEnd(34) + ' dipakai=' + r.dipakai + (Number.isFinite(r.umurHari) ? '  terakhir=' + Math.round(r.umurHari) + ' hari lalu' : '  belum pernah dipakai') + (r.pin ? '  PIN' : '')).join('\n'));
        return;
      }
      tampilSkill(kata[0] === 'baca' ? kata[1] : kata[0]);
      return;
    case 'model': {
      let konfSekarang = konfModel;
      // `sakti model tes` - uji endpoint+kunci sekarang; kalau endpoint punya
      // /models, katalog yang diterima sekaligus disimpan untuk endpoint itu.
      if (['tes', 'test', 'cek'].includes(String(kata[0] || '').toLowerCase())) {
        const hasil = await ujiModel(konfModel);
        const lama = hasil.ms >= 1000 ? (hasil.ms / 1000).toFixed(1) + 's' : hasil.ms + 'ms';
        const tahap = hasil.tahap === 'katalog' ? 'katalog' : hasil.tahap === 'chat' ? 'chat' : 'koneksi';
        console.log((hasil.ok ? 'OK ' : 'GAGAL ') + tahap + ' · ' + hasil.pesan + ' · ' + lama);
        console.log('endpoint: ' + hasil.baseUrl + ' · model: ' + hasil.model);
        if (hasil.ok && Array.isArray(hasil.katalog) && hasil.katalog.length) {
          simpanKatalog(konfModel, hasil.katalog);
          const ada = hasil.katalog.includes(konfModel.model);
          console.log('model aktif ' + (ada ? 'ada' : 'TIDAK ada') + ' di katalog (' + hasil.katalog.length + ' model)' + (ada ? '' : ' · contoh: ' + hasil.katalog.slice(0, 8).join(', ')));
          console.log('katalog disimpan untuk endpoint ini (' + hasil.katalog.length + ' model)');
        }
        process.exit(hasil.ok ? 0 : 1);
      }
      // `sakti model reasoning` - uji tingkat effort yang didukung endpoint ini
      // (satu POST kecil per tingkat) lalu simpan hasilnya per endpoint+model.
      if (['reasoning', 'nalar', 'reasoning-tes'].includes(String(kata[0] || '').toLowerCase())) {
        const awal = kemampuanModel(konfSekarang);
        if (awal.sumber) console.log('tersimpan: ' + ringkasKemampuan(awal));
        console.log('menguji reasoning ' + konfModel.model + ' @ ' + konfModel.baseUrl + ' (satu POST kecil per tingkat)');
        const hasil = await probeReasoning(konfSekarang, {
          onHasil: (satu) => console.log('  ' + String(satu.level).padEnd(8) + satu.status
            + (satu.tokenPenalaran != null ? ' · reasoning_tokens ' + satu.tokenPenalaran : '')
            + (satu.pesan ? ' · ' + satu.pesan : ''))
        });
        console.log('didukung: ' + (hasil.diterima.join(', ') || '(tidak ada)') + (hasil.ditolak.length ? ' · ditolak: ' + hasil.ditolak.join(', ') : ''));
        const sesudah = kemampuanModel(konfSekarang);
        if (sesudah.sumber) console.log('disimpan: ' + ringkasKemampuan(sesudah));
        else console.log('tidak disimpan (probe berhenti di tengah; coba lagi)');
        process.exit(hasil.tersimpan ? 0 : 1);
      }
      // `sakti model katalog` - tarik ulang GET /models sekarang juga.
      if (['katalog', 'models', 'segarkan', 'refresh'].includes(String(kata[0] || '').toLowerCase())) {
        const hasil = await sinkronKatalog(konfModel, { paksa: true, waktu: 15000 });
        if (!hasil.ok) { console.error('katalog gagal: ' + hasil.pesan); process.exit(1); }
        konfSekarang = konfigModel();
        console.log('katalog: ' + hasil.katalog.length + ' model dari ' + hasil.url + ' · disimpan ' + umurKatalog(hasil.waktu) + (hasil.berubah ? ' · berubah' : ' · tidak berubah'));
        if (!hasil.katalog.includes(konfSekarang.model)) {
          console.log('  ! model aktif "' + konfSekarang.model + '" tidak ada di katalog · pilih: sakti model <nama>');
        }
        cetakTurunan(konfSekarang);
        return;
      }
      // Bendera penyimpanan tanpa kata `set`: `sakti model --model=x`,
      // `--model-url=…`, `--effort=…` juga harus menyimpan, bukan mencetak
      // keadaan lama seolah tidak ada yang berubah.
      const adaFlagSimpan = ['model', 'model-url', 'model-key', 'effort', 'max-tokens', 'maks-langkah', 'alat'].some((kunci) => flag[kunci] != null);
      if (kata[0] === 'set' || adaFlagSimpan) {
        const dibangun = baruDariFlag(flag);
        if (dibangun.galat) { console.error(dibangun.galat); process.exit(2); }
        if (!Object.keys(dibangun.baru).length) { console.error('tidak ada yang diubah: pakai --model=, --model-url=, --model-key=, --effort=, --max-tokens=, --maks-langkah='); process.exit(2); }
        simpanModel(dibangun.baru);
        konfSekarang = konfigModel();
        // Env menang atas config: jangan diam-diam melaporkan endpoint yang
        // bukan dipakai proses ini.
        for (const satu of peringatanTimpa(dibangun.baru, konfSekarang)) console.error('env masih menimpa: ' + satu);
        // Endpoint baru = katalog lama tidak berlaku. Ambil daftar model
        // endpoint itu sekarang supaya langkah berikutnya tidak memakai daftar
        // asing; endpoint mati cukup dilaporkan, config tetap tersimpan.
        if (perluSegarkanKatalog(konfSekarang)) {
          const hasil = await sinkronKatalog(konfSekarang, { waktu: 6000 });
          konfSekarang = konfigModel();
          if (hasil.ok) console.log('katalog: ' + hasil.katalog.length + ' model dari ' + hasil.url);
          else console.error('katalog: ' + hasil.pesan);
        }
        console.log(barisModel(konfSekarang));
        cetakTurunan(konfSekarang);
        return;
      }
      // `sakti model <nama>` - pilih model; katalog endpoint aktif disegarkan
      // dulu (kalau basi) supaya peringatan "tidak ada di katalog" berdasar
      // daftar endpoint ini, bukan daftar lama.
      if (kata.length) {
        const nama = kata.join(' ').trim();
        if (perluSegarkanKatalog(konfSekarang)) {
          const hasil = await sinkronKatalog(konfSekarang, { waktu: 6000 });
          if (hasil.ok) konfSekarang = konfigModel();
        }
        simpanModel({ model: nama });
        konfSekarang = konfigModel();
        console.log('model dipilih: ' + nama + ' @ ' + konfSekarang.baseUrl);
        for (const satu of peringatanTimpa({ model: nama }, konfSekarang)) console.error('env masih menimpa: ' + satu);
        if (konfSekarang.models.length && !konfSekarang.models.includes(nama)) {
          console.error('  ! "' + nama + '" tidak ada di katalog endpoint ini (' + konfSekarang.models.length + ' model) · cek: sakti model katalog');
        }
        cetakTurunan(konfSekarang);
        return;
      }
      // Tanpa argumen: katalog endpoint aktif ikut diperbarui bila kosong/basi.
      if (perluSegarkanKatalog(konfSekarang)) {
        const hasil = await sinkronKatalog(konfSekarang, { waktu: 6000 });
        konfSekarang = konfigModel();
        if (!hasil.ok) console.error('katalog: ' + hasil.pesan);
      }
      console.log(barisModel(konfSekarang));
      cetakTurunan(konfSekarang);
      return;
    }
    case 'rute': {
      // sakti rute            -> keadaan + tabel
      // sakti rute on|off     -> simpan
      // sakti rute ultra      -> patok satu tingkat (skor tidak dipakai)
      const kata1 = kata[0];
      if (!kata1) {
        console.log(barisModel(konfModel));
        console.log('');
        console.log('tingkat rute (skor kesulitan -> anggaran):');
        for (const satu of TINGKAT_RUTE) {
          const n = nilaiTingkat(satu);
          console.log('  ' + satu.padEnd(8) + 'effort=' + String(n.effort).padEnd(8) + 'max_tokens=' + String(n.maxTokens).padStart(6) +
            ' riwayat=' + String(n.batasRiwayat).padStart(3) + ' konteks≤' + n.batasToken);
        }
        console.log('pakai: sakti rute on | sakti rute off | sakti rute <tingkat> | --rute=off --rute-tingkat=<tingkat>');
        return;
      }
      if (kata1 === 'auto' || kata1 === 'on' || kata1 === 'off') {
        simpanModel(kata1 === 'off' ? { rute: false } : { rute: true, ruteTingkat: '' });
        console.log(kata1 === 'off' ? 'rute: off (pakai effort/max-tokens manual)' : 'rute: on (tingkat dipilih dari skor kesulitan tugas)');
        return;
      }
      const patok = tingkatSah(kata1);
      if (!patok) { console.error('tingkat tidak dikenal: ' + kata1 + ' · pilih: on|off|auto|' + TINGKAT_RUTE.join('|')); process.exit(2); }
      simpanModel({ rute: true, ruteTingkat: patok });
      const n = nilaiTingkat(patok);
      console.log('rute dipatok: ' + patok + ' · effort=' + n.effort + ' max_tokens=' + n.maxTokens + ' riwayat=' + n.batasRiwayat + ' konteks≤' + n.batasToken);
      console.log('lepas patok: sakti rute auto');
      return;
    }
    case 'init': {
      // Kerangka AGENTS.md: titik masuk repo baru, sama seperti `opencode init`.
      const { jalur, dibuat } = buatPetunjuk(ctx.cwd, { proyek: kata.join(' ') });
      console.log(dibuat ? 'dibuat: ' + jalur : 'sudah ada, tidak ditimpa: ' + jalur);
      return;
    }
    case 'perintah': {
      // Perintah kustom: /nama di TUI = prompt tersimpan di ~/.sakti-cli/perintah.
      const aksi = kata[0] || 'daftar';
      if (aksi === 'daftar') {
        const semua = daftarPerintahKustom({ cwd: ctx.cwd });
        if (!semua.length) { console.log('belum ada. Buat: sakti perintah tulis <nama> "<isi>"'); return; }
        for (const satu of semua) console.log('/' + satu.nama + (satu.keterangan ? '  ' + satu.keterangan : ''));
        return;
      }
      if (aksi === 'lihat') {
        const isi = rangkaiPerintah(kata[1], kata.slice(2).join(' '), { cwd: ctx.cwd });
        console.log(isi || 'perintah tidak ada: ' + kata[1]);
        if (!isi) process.exitCode = 1;
        return;
      }
      if (aksi === 'tulis') {
        const hasil = tulisPerintah(kata[1], kata.slice(2).join(' '), {
          keterangan: flag.keterangan || '',
          timpa: Boolean(flag.timpa),
          proyek: Boolean(flag.proyek),
          cwd: ctx.cwd
        });
        console.log(hasil.ok ? 'ditulis: ' + hasil.jalur : 'GAGAL: ' + hasil.pesan);
        if (!hasil.ok) process.exitCode = 1;
        return;
      }
      if (aksi === 'hapus') {
        const ok = hapusPerintah(kata[1], { cwd: ctx.cwd });
        console.log(ok ? 'dihapus: ' + kata[1] : 'tidak ada: ' + kata[1]);
        if (!ok) process.exitCode = 1;
        return;
      }
      console.log('aksi tidak dikenal. Pakai: daftar | lihat | tulis | hapus');
      process.exitCode = 1;
      return;
    }
    case 'doctor':
      await doctor(konfModel, ctx, { json: flag.json === true || flag.json === 'true' });
      return;
    case 'env':
      console.log([
        'folder kerja  : ' + ctx.cwd,
        'berkas ingatan: ' + (fs.existsSync(ctx.state) ? ctx.state : ctx.state + ' (belum dibuat)'),
        'folder sesi   : ' + path.join(path.dirname(berkasState()), 'sesi'),
        'folder skill  : ' + (folderSkill().join(', ') || 'tidak ada'),
        'folder spill  : ' + (process.env.SAKTI_CLI_SPILL || path.join(process.env.HOME || '/root', '.sakti-cli', 'spill')),
        'model         : ' + konfModel.model + ' @ ' + konfModel.baseUrl,
        'mandiri       : tanpa biner pi/hermes - semua mesin di lib/'
      ].join('\n'));
      return;
    case 'alat':
      // `sakti alat`                -> daftar alat + skema
      // `sakti alat <nama>            -> skema satu alat
      // `sakti alat ada a,b,c         -> periksa nama (untuk --alat=a,b,c)
      const sub = String(kata[0] || '').toLowerCase();
      if (sub === 'ada') {
        const diminta = uraiArray(kata.slice(1).join(','));
        if (!diminta.length) { console.error('butuh nama alat: sakti alat ada baca,cari'); process.exitCode = 2; return; }
        const dikenal = new Set(ALAT.map((a) => a.name));
        // Resolusi lewat cariAlat supaya alias (`python`, `chrome`, `js`) sah di
        // sini persis seperti saat model memanggil alatnya.
        const asing = diminta.filter((nama) => !cariAlat(ALIAS[nama] || nama));
        if (asing.length) { console.error('alat tidak dikenal: ' + asing.join(', ') + '\npakai: ' + [...dikenal].join(' ')); process.exitCode = 2; return; }
        console.log('OK ' + diminta.length + ' alat: ' + diminta.map((nama) => cariAlat(ALIAS[nama] || nama).name).join(', '));
        return;
      }
      if (sub && sub !== 'semua') {
        const satu = cariAlat(ALIAS[sub] || sub);
        if (!satu) { console.error('alat tidak dikenal: ' + sub); process.exitCode = 2; return; }
        console.log(satu.name + '\n  ' + satu.description + '\n  parameter: ' + JSON.stringify(satu.parameters.properties) + '\n  wajib: ' + JSON.stringify(satu.parameters.required || []));
        return;
      }
      console.log(ALAT.map((alat) => ikonAlat(alat.name) + ' ' + alat.name + '\n  ' + alat.description + '\n  parameter: ' + JSON.stringify(alat.parameters.properties) + '\n  wajib: ' + JSON.stringify(alat.parameters.required || [])).join('\n'));
      return;
    case 'reach': {
      // Integrasi opsional Agent Reach: CLI resmi dipasang lewat uv; wrapper
      // ini tidak menambah dependensi Python ke inti sakti.
      // `kata` sudah bebas bendera global; bendera mentah ditambahkan kembali
      // supaya --json/--limit milik Reach tetap diteruskan. Jangan memakai
      // indexOf('reach') pada argv: nilai flag yang kebetulan "reach" menggeser
      // posisi dan perintah yang dikirim jadi salah.
      const sisaReach = [...kata, ...flagMentah(flag)];
      const aksi = String(sisaReach[0] || '').toLowerCase();
      const reach = await import('./lib/reach.js');
      if (!aksi || ['status', 'info'].includes(aksi)) {
        const st = reach.statusReach();
        if (!st.ada) {
          console.log('Agent Reach: belum terpasang\npasang: sakti reach pasang (butuh uv)');
          return;
        }
        console.log('Agent Reach: ' + (st.versi || 'terpasang') + '\nlauncher: ' + st.jalur);
        console.log('skill: ~/.hermes/skills/agent-reach · cek kanal: sakti reach channels');
        return;
      }
      if (['pasang', 'install'].includes(aksi)) {
        console.log('memasang Agent Reach resmi (uv tool, bukan PyPI) …');
        const hasil = reach.pasangReach();
        if (!hasil.ok) { console.error('GAGAL pasang Agent Reach: ' + hasil.galat); process.exitCode = 1; return; }
        const st = reach.statusReach();
        console.log('OK Agent Reach ' + (st.versi || '') + ' · ' + (st.jalur || 'jalur belum terbaca'));
        console.log('lanjut: sakti reach setup');
        return;
      }
      if (['perbarui', 'upgrade'].includes(aksi)) {
        const hasil = reach.jalankanReach(['update'], { cwd: ctx.cwd });
        if (!hasil.ok) { if (hasil.galat) console.error(hasil.galat); process.exitCode = hasil.kode || 1; }
        return;
      }
      const hasil = reach.jalankanReach(sisaReach, { cwd: ctx.cwd });
      if (!hasil.ok) {
        if (hasil.galat) console.error(hasil.galat);
        process.exitCode = hasil.kode || 1;
      }
      return;
    }
    case 'rea': {
      // Integrasi opsional REA: pembungkus tipis, paket besar tidak di-vendor.
      // Argumen asli dipakai (bukan `kata`) supaya flag REA seperti --json
      // tidak ditelan parser flag sakti.
      // `kata` + bendera mentah: flag REA (--json, --limit) tidak ditelan parser
      // sakti, dan perintah tidak bergeser kalau ada nilai flag bernama "rea".
      const sisaRea = [...kata, ...flagMentah(flag)];
      const aksi = String(sisaRea[0] || '').toLowerCase();
      const rea = await import('./lib/rea.js');
      if (!aksi || ['status', 'info'].includes(aksi)) {
        const st = rea.statusRea();
        if (!st.ada) {
          console.log('REA: belum terpasang\nfolder: ' + st.folder + '\npasang: sakti rea pasang');
          return;
        }
        console.log('REA: ' + (st.versi || 'terpasang') + '\nlauncher: ' + st.launcher.berkas + '\nfolder: ' + st.folder);
        const klien = await import('./lib/mcp-klien.js');
        const server = klien.daftarServer().find((satu) => satu.nama === 'rea');
        if (server && server.aktif !== false) console.log('MCP: aktif · ' + (server.alat && server.alat.length ? server.alat.length + ' alat inti' : 'semua alat') + ' · sakti mcp tes rea');
        else console.log('MCP: belum didaftarkan · sakti rea mcp-pasang');
        return;
      }
      if (['pasang', 'install', 'perbarui', 'update'].includes(aksi)) {
        const versi = (sisaRea.find((satu) => /^--versi=/.test(satu)) || '').replace(/^--versi=/, '') || 'latest';
        console.log('memasang rea-agents@' + versi + ' ke ' + rea.folderRea() + ' …');
        const hasil = rea.pasangRea({ versi });
        if (!hasil.ok) { console.error('GAGAL pasang REA: ' + hasil.galat); process.exitCode = 1; return; }
        const st = rea.statusRea();
        console.log('OK rea-agents ' + (st.versi || '') + ' · ' + hasil.folder);
        return;
      }
      if (['mcp-pasang', 'pasang-mcp'].includes(aksi)) {
        const semua = sisaRea.includes('--semua');
        const daftarAlat = (sisaRea.find((satu) => /^--alat=/.test(satu)) || '').replace(/^--alat=/, '').split(',').filter(Boolean);
        const hasil = await rea.pasangMcpRea({ semua, alat: daftarAlat });
        if (!hasil.ok) { console.error(hasil.galat); process.exitCode = 1; return; }
        const jumlah = hasil.alat && hasil.alat.length ? hasil.alat.length + ' alat inti' : 'semua alat (konteks besar)';
        console.log('OK MCP REA terdaftar: ' + hasil.server.nama + ' · ' + jumlah + ' · ' + hasil.berkas);
        return;
      }
      const hasil = rea.jalankanRea(sisaRea, { cwd: ctx.cwd });
      if (!hasil.ok) {
        if (hasil.galat) console.error(hasil.galat);
        process.exitCode = hasil.kode || 1;
      }
      return;
    }
    case 'mcp': {
      // Tanpa argumen = server MCP di stdio (dipakai host). Dengan aksi =
      // kelola server (opencode `mcp list|add`): daftar|tambah|alat|tes|hapus|aktif.
      const aksi = String(kata[0] || '').toLowerCase();
      if (aksi) {
        const klien = await import('./lib/mcp-klien.js');
        try {
        const nomor = kata.slice(1).filter((satu) => !satu.startsWith('--'));
        if (['daftar', 'list'].includes(aksi)) {
          const semua = klien.daftarServer();
          if (!semua.length) { console.log('belum ada server MCP di ' + klien.berkasMcp() + '\ntambah: sakti mcp tambah fs --command="npx -y @modelcontextprotocol/server-filesystem /root"'); return; }
          const baris = [];
          for (const server of semua) {
            const cara = server.url ? 'http ' + server.url : 'stdio ' + [server.command].concat(server.args || []).join(' ');
            let jumlah = server.aktif === false ? 'nonaktif' : '?';
            if (server.aktif !== false) {
              try { jumlah = (await klien.daftarAlatServer(server.nama)).length + ' alat'; } catch (e) { jumlah = 'MATI: ' + String((e && e.message) || e).slice(0, 100); }
            }
            baris.push(server.nama.padEnd(16) + jumlah + '  ' + cara);
          }
          console.log(baris.join('\n') + '\n(' + semua.length + ' server · ' + klien.berkasMcp() + ')');
          return;
        }
        if (['tambah', 'add'].includes(aksi)) {
          const nama = nomor[0];
          if (!nama) { console.error('butuh nama: sakti mcp tambah <nama> --command="..." atau --url=<url>'); process.exitCode = 2; return; }
          const server = klien.simpanServer(nama, {
            command: typeof flag.command === 'string' ? flag.command : undefined,
            url: typeof flag.url === 'string' ? flag.url : undefined,
            args: typeof flag.args === 'string' ? flag.args : undefined,
            env: typeof flag.env === 'string' ? flag.env : undefined,
            headers: typeof flag.headers === 'string' ? flag.headers : undefined
          });
          const alat = await klien.daftarAlatServer(server.nama).then((rows) => rows.length + ' alat').catch((e) => 'koneksi gagal: ' + String((e && e.message) || e).slice(0, 120));
          console.log('server disimpan: ' + server.nama + ' (' + alat + ')\nberkas ' + klien.berkasMcp());
          return;
        }
        if (aksi === 'alat') {
          const nama = nomor[0];
          if (!nama) { console.error('butuh nama server: sakti mcp alat <nama>'); process.exitCode = 2; return; }
          const rows = await klien.daftarAlatServer(nama).catch((e) => { console.error('koneksi gagal: ' + String((e && e.message) || e)); process.exitCode = 1; return []; });
          console.log(rows.length ? rows.map((row) => klien.namaAlatMcp(row.server, row.nama) + '  ' + String(row.deskripsi || '').split('\n')[0].slice(0, 100)).join('\n') : 'server ' + nama + ' tidak menawarkan alat');
          return;
        }
        if (aksi === 'tes') {
          const nama = nomor[0];
          if (!nama) { console.error('butuh nama server: sakti mcp tes <nama>'); process.exitCode = 2; return; }
          if (!klien.bacaServer(nama)) { console.error('server tidak ada: ' + nama); process.exitCode = 1; return; }
          const hasil = await klien.tesServer(nama).catch((e) => { console.error('GAGAL ' + nama + ': ' + String((e && e.message) || e)); process.exitCode = 1; return null; });
          if (hasil) console.log('OK ' + nama + ' · ' + hasil.alat.length + ' alat · ' + hasil.ms + 'ms\n' + hasil.alat.map((row) => '- ' + row.nama).join('\n'));
          return;
        }
        if (['hapus', 'remove', 'rm'].includes(aksi)) {
          const nama = nomor[0];
          if (!nama) { console.error('butuh nama server: sakti mcp hapus <nama>'); process.exitCode = 2; return; }
          if (!klien.hapusServer(nama)) { console.error('server tidak ada: ' + nama); process.exitCode = 1; return; }
          console.log('server dihapus: ' + nama);
          return;
        }
        if (['aktif', 'on', 'off', 'nonaktif'].includes(aksi)) {
          const nama = nomor[0];
          if (!nama) { console.error('butuh nama server: sakti mcp aktif <nama> [on|off]'); process.exitCode = 2; return; }
          if (!klien.bacaServer(nama)) { console.error('server tidak ada: ' + nama); process.exitCode = 1; return; }
          const server = klien.simpanServer(nama, { aktif: ['off', 'nonaktif'].includes(aksi) ? 'off' : 'on' });
          console.log('server ' + server.nama + ': ' + (server.aktif === false ? 'nonaktif' : 'aktif'));
          return;
        }
        console.error('aksi mcp tidak dikenal: ' + aksi + ' (daftar|tambah|alat|tes|hapus|aktif) · tanpa aksi = server stdio');
        process.exitCode = 2;
        return;
        } finally {
          // Koneksi stdio memegang pipe anak; tanpa penutupan ini `sakti mcp
          // daftar/tambah/alat` menggantung setelah mencetak hasil.
          try { klien.tutupSekarang(); } catch { /* tidak ada koneksi */ }
        }
      }
      const { spawnSync } = await import('node:child_process');
      const hasil = spawnSync(process.execPath, [path.join(DIR, 'mcp.js')], { stdio: 'inherit', cwd: ctx.cwd });
      process.exitCode = hasil.status == null ? 0 : hasil.status;
      return;
    }
    default:
      break;
  }

  const namaAlat = ALIAS[perintah] || perintah;
  const alat = cariAlat(namaAlat);
  if (!alat) {
    console.error('tidak ada perintah atau alat bernama "' + perintah + '". Coba: sakti help');
    process.exit(2);
  }
  const { args, kurang } = pasangArgv(alat, kata, flag);
  if (typeof flag.cwd === 'string') args.cwd = flag.cwd;
  if (kurang.length) {
    console.error('kurang: ' + kurang.join(', ') + '\ncontoh: sakti ' + perintah + ' <' + kurang.join('> <') + '>');
    process.exit(2);
  }
  const keluaran = await jalankanAlat(namaAlat, args, typeof flag.sesi === 'string' && flag.sesi
    ? Object.assign({}, ctx, { sesiId: flag.sesi })
    : ctx);
  console.log(keluaran);
  process.exit(/^(GAGAL|DITOLAK|alat tidak dikenal)/.test(keluaran) ? 1 : 0);
}

main().catch((galat) => {
  console.error(String((galat && galat.message) || galat));
  process.exit(1);
});