// Mesin lokal untuk `sakti`: menjalankan proses di laptop ini, membaca/menulis
// berkas sungguhan, dan menyimpan ingatan kecil di satu berkas JSON.
//
// Tidak ada server dan tidak ada daftar putih perintah. Perintah dijalankan apa
// adanya lewat bash -lc, dengan cwd dan batas waktu yang bisa diatur. Pagar
// yang tetap ada cuma tiga, dan ketiganya soal kejujuran bukan izin:
//   - waktu: proses yang menggantung dimatikan (bawaan 10 menit),
//   - keluaran: dipotong supaya tidak membanjiri percakapan,
//   - galat: dilaporkan apa adanya, bukan disembunyikan.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Dibaca setiap kali, bukan sekali saat import: uji dan pemakaian bersamaan
   sering memindahkan berkas state lewat env. */
export function berkasState() {
  return process.env.SAKTI_CLI_STATE || path.join(folderProfil(), 'state.json');
}

/**
 * ADR-005 K4: profil = folder berkas state (SAKTI_CLI_STATE), bukan hardcoded
 * ~/.sakti-cli. Semua berkas data milik profil (spill/log/biaya/khazanah/latar/
 * bot/sesi/…) diturunkan dari sini supaya profil uji tidak mencemari profil asli.
 * SAKTI_CLI_HOME / SAKTI_CLI_CONFIG (rawat.js) tetap menang bila di-set — dipanggil
 * malas supaya L0 tidak mengimpor rawat.js (arah lapisan ADR-001).
 */
export function folderProfil() {
  if (process.env.SAKTI_CLI_HOME) return process.env.SAKTI_CLI_HOME;
  if (process.env.SAKTI_CLI_CONFIG) return path.dirname(process.env.SAKTI_CLI_CONFIG);
  if (process.env.SAKTI_CLI_STATE) return path.dirname(process.env.SAKTI_CLI_STATE);
  return path.join(os.homedir(), '.sakti-cli');
}

export const WAKTU_BAWAAN = 600000;

/** Batas `waktu` dari agen: 1 detik .. 1 jam. */
export const WAKTU_MIN_MS = 1000;
export const WAKTU_MAKS_MS = 3600000;

/**
 * Normalisasi `waktu` dari agen/pengguna menjadi milidetik.
 * - Angka murni (10, 1600, "25") SELALU detik, dijepit 1..3600 detik.
 *   Dulu < 1000 = detik dan >= 1000 = ms, jadi waktu=1600 (maksud 1600 dtk)
 *   jalan 1.6 dtk lalu mati dan agen mengulang perintah yang sama.
 * - String bersatuan: '500ms', '90s', '25m' (juga 'dtk'/'detik'/'menit');
 *   hasil dijepit 100ms..1 jam.
 * - Kosong/<=0/sampah -> `bawaan` (ms, tidak dijepit).
 * Pemanggil internal yang sudah memegang ms pakai opsi `waktuMs` di shell().
 */
export function msWaktu(nilai, bawaan = WAKTU_BAWAAN) {
  if (typeof nilai === 'string') {
    const s = nilai.trim().toLowerCase();
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|dtk|detik|m|mnt|menit)?$/.exec(s);
    if (!m) return bawaan;
    const n = Number(m[1]);
    if (!(n > 0)) return bawaan;
    const kali = m[2] === 'ms' ? 1 : /^(m|mnt|menit)$/.test(m[2] || '') ? 60000 : 1000;
    const min = m[2] === 'ms' ? 100 : WAKTU_MIN_MS;
    return Math.min(WAKTU_MAKS_MS, Math.max(min, Math.round(n * kali)));
  }
  const n = Number(nilai);
  if (nilai == null || typeof nilai === 'boolean' || !Number.isFinite(n) || n <= 0) return bawaan;
  return Math.min(WAKTU_MAKS_MS, Math.max(WAKTU_MIN_MS, Math.round(n * 1000)));
}

/**
 * Perilaku lama (< 1000 = detik, >= 1000 = ms) khusus alat yang skemanya
 * masih mendokumentasikan `waktu` dalam milidetik (db, layanan, paket, lint,
 * ffmpeg, chromium). Jangan dipakai untuk alat baru.
 */
export function msWaktuLama(nilai, bawaan = WAKTU_BAWAAN) {
  const n = Number(nilai);
  if (!Number.isFinite(n) || n <= 0) return bawaan;
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

/** Batas efektif shell(): `waktu` (detik/string) menang; lalu `waktuMs`; lalu bawaan. */
export function batasShellMs(waktu, waktuMs) {
  const dariWaktu = msWaktu(waktu, null);
  if (dariWaktu != null) return dariWaktu;
  const ms = Number(waktuMs);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : WAKTU_BAWAAN;
}

export class GalatLokal extends Error {}

/** Jalankan perintah shell apa pun. Keluaran SELALU dikembalikan, termasuk saat gagal. */
export async function shell(perintah, { cwd = process.cwd(), waktu = null, waktuMs = null, env = {}, masukan = null, sinyal = null } = {}) {
  const batasMs = batasShellMs(waktu, waktuMs);
  const baris = String(perintah == null ? '' : perintah).trim();
  if (!baris) return Promise.reject(new GalatLokal('perintah kosong'));
  // Jangan diam-diam jatuh ke process.cwd(): `git reset --hard cwd=./typo`
  // dulu menjalankan reset di repo peluncur, bukan folder yang dimaksud.
  if (cwd && !fs.existsSync(cwd)) return Promise.reject(new GalatLokal('folder kerja tidak ada: ' + cwd));
  // ADR-005 K2: env anak disaring satu titik (secret diblok, passthrough env).
  // envTool diimpor malas dari alat.js: L0 tak boleh menarik modul besar.
  const { envTool } = await import('./alat.js');
  return new Promise((resolve) => {
    // pipefail: kode keluar pipeline = perintah PERTAMA yang gagal. Tanpa ini
    // `layanan cek ... | head -20` selalu lapor sukses walau systemd menolak.
    const skrip = baris.startsWith('set -o pipefail') ? baris : 'set -o pipefail; ' + baris;
    const anak = execFile('bash', ['-lc', skrip], {
      cwd: cwd || process.cwd(),
      timeout: batasMs,
      maxBuffer: 16 * 1024 * 1024,
      /* Ctrl+C di REPL membatalkan giliran -> anak ikut dimatikan, bukan
         dibiarkan jalan sampai batas waktunya. */
      signal: sinyal || undefined,
      env: envTool(env)
    }, (galat, stdout, stderr) => {
      const batal = Boolean(galat && galat.code === 'ABORT_ERR');
      // maxBuffer: Node bunuh anak dgn code STRING (bukan number, killed kosong)
      // - laporkan jujur, jangan diam-diam "GAGAL (1)" tanpa sebab.
      const penuhBuffer = Boolean(galat && galat.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      const mati = Boolean(galat && galat.killed) && !batal;
      const keterangan = penuhBuffer ? (String((galat && galat.message) || 'keluaran lewat batas maxBuffer 16MB')) : '';
      resolve({
        perintah: baris,
        kode: batal ? 130 : galat ? (typeof galat.code === 'number' ? galat.code : 1) : 0,
        keluaran: String(stdout || ''),
        galat: batal
          ? (String(stderr || '') + '\n[dibatalkan]').trim()
          : keterangan
            ? (String(stderr || '') + (stderr ? '\n' : '') + '[' + keterangan + ']').trim()
            : String(stderr || ''),
        timeout: mati || penuhBuffer,
        batasMs,
        dibatalkan: batal,
        ms: null
      });
    });
    if (masukan != null && anak.stdin) {
      // Anak boleh keluar tanpa membaca stdin: EPIPE saat end() tidak boleh
      // menjatuhkan proses utama (uncaughtException).
      anak.stdin.on('error', () => {});
      anak.stdin.end(String(masukan));
    }
  });
}

/** Ringkas hasil shell untuk model/manusia: satu blok, tanpa menghilangkan kode keluar. */
export function ringkasShell(hasil, maks = 12000) {
  const potong = (teks) => {
    const isi = String(teks || '');
    return isi.length > maks ? isi.slice(0, maks) + '\n[...dipotong, ' + isi.length + ' karakter total]' : isi;
  };
  const kepala = (hasil.kode === 0 ? 'OK ' : 'GAGAL (' + hasil.kode + ') ') + hasil.perintah;
  // Sebut batasnya dan jalan keluarnya: tanpa itu agen menjalankan ulang
  // perintah yang sama dengan batas yang sama dan gagal lagi.
  const habis = hasil.timeout
    ? 'dihentikan karena batas waktu' + (hasil.batasMs ? ' ' + Math.round(hasil.batasMs / 1000) + 'dtk' : '') +
      ' - JANGAN ulang perintah sama: naikkan `waktu`, pecah perintahnya, atau jalankan di latar lalu baca lognya.'
    : '';
  return [kepala, habis, hasil.keluaran ? potong(hasil.keluaran.trimEnd()) : '', hasil.galat ? '[stderr]\n' + potong(hasil.galat.trimEnd()) : '']
    .filter(Boolean).join('\n');
}

export function jalurAman(nilai, akar = process.cwd()) {
  const dasar = path.resolve(akar);
  const penuh = path.resolve(dasar, String(nilai == null ? '' : nilai) || '.');
  return penuh;
}

/**
 * Apakah `target` berada DI DALAM `akar`? Dipakai `hapus`: menghapus di luar
 * folder kerja terlalu mudah salah (dan `..` lolos dari daftar akar yang lama).
 * Mengembalikan jalur relatif ('..' = di luar).
 */
export function diDalam(target, akar = process.cwd()) {
  let t = path.resolve(target);
  let a = path.resolve(akar);
  // Symlink di dalam folder kerja bisa menunjuk keluar; realpath menutupnya.
  try { t = fs.realpathSync(t); } catch { /* belum ada: pakai jalur resolve */ }
  try { a = fs.realpathSync(a); } catch { /* - */ }
  const rel = path.relative(a, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function bacaBerkas(jalur, { offset = 0, limit = 0 } = {}) {
  const penuh = jalurAman(jalur);
  const info = fs.statSync(penuh);
  if (info.isDirectory()) throw new GalatLokal('itu folder, bukan berkas: ' + penuh);
  const isi = fs.readFileSync(penuh);
  if (isi.includes(0)) return { binari: true, ukuran: isi.length, jalur: penuh };
  const teks = isi.toString('utf8');
  const mulai = Math.max(0, Number(offset) || 0);
  const banyak = Number(limit) > 0 ? Number(limit) : teks.length;
  return { jalur: penuh, ukuran: isi.length, teks: teks.slice(mulai, mulai + banyak), terpotong: mulai + banyak < teks.length };
}

export function tulisBerkas(jalur, teks, { append = false } = {}) {
  const penuh = jalurAman(jalur);
  fs.mkdirSync(path.dirname(penuh), { recursive: true });
  if (append) fs.appendFileSync(penuh, String(teks == null ? '' : teks));
  else fs.writeFileSync(penuh, String(teks == null ? '' : teks));
  return { jalur: penuh, ukuran: fs.statSync(penuh).size };
}

/** Daftar pohon folder. Tanpa -a (berkas titik disembunyikan) supaya keluaran terbaca. */
export function daftarPohon(jalur = '.', { dalam = 2 } = {}) {
  const penuh = jalurAman(jalur);
  if (!fs.existsSync(penuh)) throw new GalatLokal('tidak ada: ' + penuh);
  const baris = [];
  const telusuri = (folder, tingkat, awalan) => {
    let isi;
    try { isi = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    const tampil = isi.filter((satu) => !satu.name.startsWith('.') && satu.name !== 'node_modules').slice(0, 200);
    for (const satu of tampil) {
      const lengkap = path.join(folder, satu.name);
      if (satu.isDirectory()) {
        baris.push(awalan + satu.name + '/');
        if (tingkat < dalam) telusuri(lengkap, tingkat + 1, awalan + '  ');
      } else {
        let ukuran = 0;
        try { ukuran = fs.statSync(lengkap).size; } catch { /* biarkan 0 */ }
        baris.push(awalan + satu.name + ' (' + ukuran + ' B)');
      }
    }
  };
  telusuri(penuh, 1, '');
  return baris.length ? baris.join('\n') : '(kosong)';
}

/**
 * Jalankan `fn` dengan kunci berkas eksklusif di `<berkas>.kunci`.
 *
 * State/biaya/khazanah adalah JSON read-modify-write: `sakti serve` yang hidup
 * lama, TUI, dan bot room menulis berkas yang SAMA. Tanpa kunci, dua proses yang
 * membaca bersamaan lalu menulis berturut-turut menghapus tulisan yang lain
 * (terukur: 12 `ingatan tambah` paralel -> 10-11 tersimpan, `biaya.json` ->
 * 2-10 dari 12 dan pernah jadi JSON rusak). Rename atomik di `tulisState`
 * mencegah berkas separuh, bukan mencegah kehilangan tulisan.
 *
 * Kunci = berkas penanda `wx` (O_EXCL); proses mati meninggalkan berkas basi,
 * jadi umur kunci dibatasi dan kunci tua dirampas. Penantian memakai tidur
 * sinkron kecil karena semua pemanggil di sini sinkron (baca/tulis JSON kecil).
 * ponytail: tidur sinkron, bukan async - ubah ke async kalau ada pemanggil async.
 */
export function kunciBerkas(berkas, fn, { tunggu = 20000, basi = 15000 } = {}) {
  const penanda = String(berkas) + '.kunci';
  fs.mkdirSync(path.dirname(penanda), { recursive: true });
  const batas = Date.now() + tunggu;
  let pintu = null;
  while (pintu === null) {
    try {
      pintu = fs.openSync(penanda, 'wx');
    } catch (galat) {
      if (galat.code !== 'EEXIST') throw galat;
      // Pemilik hidup: JANGAN rampas walau sudah lewat `basi` (pekerjaan sah
      // bisa >15 detik). Pemilik mati: rampas segera, jangan tunggu 10 detik.
      let hidup = false;
      let umur = 0;
      try {
        umur = Date.now() - fs.statSync(penanda).mtimeMs;
        const pid = Number(String(fs.readFileSync(penanda, 'utf8')).trim());
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); hidup = true; } catch { hidup = false; }
        }
      } catch { /* penanda hilang */ }
      if (!hidup && umur > 50) {
        try { fs.unlinkSync(penanda); } catch { /* sudah hilang */ }
      } else if (umur > Math.max(basi * 8, 120000)) {
        // Pemilik hidup tapi macet >2 menit: anggap basi (jaring terakhir).
        try { fs.unlinkSync(penanda); } catch { /* sudah hilang */ }
      }
      if (Date.now() > batas) throw new GalatLokal('kunci berkas basi: ' + penanda);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  try {
    fs.writeSync(pintu, String(process.pid));
    return fn();
  } finally {
    let milikSendiri = null;
    try { milikSendiri = fs.fstatSync(pintu); } catch { /* handle sudah rusak */ }
    try { fs.closeSync(pintu); } catch { /* sudah tertutup */ }
    // Hapus penanda HANYA kalau masih penanda milik kita. Kunci basi bisa
    // dirampas proses lain saat kita masih bekerja; unlink buta akan menghapus
    // kunci pemilik baru dan dua proses masuk sekaligus.
    try {
      if (!milikSendiri) throw new Error('tanpa inode');
      const kini = fs.statSync(penanda);
      if (milikSendiri.ino === kini.ino && milikSendiri.dev === kini.dev) fs.unlinkSync(penanda);
    } catch { /* sudah dirampas / sudah hilang */ }
  }
}

/** Baca state → ubah → tulis, di dalam satu kunci. `fn` menerima state, boleh mengubahnya. */
export function ubahState(fn) {
  return kunciBerkas(berkasState(), () => {
    const state = bacaState();
    const hasil = fn(state);
    tulisState(state);
    return hasil;
  });
}

export function bacaState() {
  const berkas = berkasState();
  const bawaan = { ingatan: [], mind: [], pengingat: [], tugas: {} };
  try {
    const isi = JSON.parse(fs.readFileSync(berkas, 'utf8'));
    if (!isi || typeof isi !== 'object' || Array.isArray(isi)) return bawaan;
    const state = Object.assign({}, bawaan, isi);
    // State tulisan tangan / versi lama bisa punya bentuk salah (null, string,
    // angka). Normalisasi di SATU tempat: pemakai lain memanggil .length dan
    // .push tanpa memeriksa tipe, dan dulu satu `ingatan: null` mematikan
    // status/pelajaran sampai berkasnya dihapus.
    for (const kunci of ['ingatan', 'mind', 'pengingat', 'izinkan']) {
      if (!Array.isArray(state[kunci])) state[kunci] = [];
    }
    if (!state.tugas || typeof state.tugas !== 'object' || Array.isArray(state.tugas)) state.tugas = {};
    return state;
  } catch {
    // JSON rusak jangan langsung ditimpa tulis berikutnya: simpan dulu sebagai
    // .rusak-<ts>, baru kembalikan bawaan. Tanpa ini satu byte rusak menghapus
    // seluruh ingatan/skillPakai/mode izin.
    try {
      const info = fs.statSync(berkas);
      if (info.isFile() && info.size > 0) fs.renameSync(berkas, berkas + '.rusak-' + Date.now());
    } catch { /* berkas tidak ada / tidak bisa dipindah */ }
    return bawaan;
  }
}

export function tulisState(state) {
  const berkas = berkasState();
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  // rename atomik: proses mati di tengah tulis tidak merusak ingatan/state.
  const sementara = berkas + '.tmp-' + process.pid;
  fs.writeFileSync(sementara, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(sementara, berkas);
  try { fs.chmodSync(berkas, 0o600); } catch { /* filesystem tanpa chmod */ }
  return berkas;
}

/** Satu fakta pendek, satu baris; kembaran ingatan Sakti tapi tanpa server. */
export function tambahIngatan(teks, { proyek = process.cwd() } = {}) {
  const isi = String(teks == null ? '' : teks).replace(/\s+/g, ' ').trim();
  if (!isi) throw new GalatLokal('teks ingatan kosong');
  ubahState((state) => {
    state.ingatan = (state.ingatan || []).concat([{ teks: isi, proyek, at: Date.now() }]).slice(-500);
  });
  return isi;
}
/* ------------------------------------------------------- proses latar --- */
// Tugas panjang (build, server, tarikan data) bisa dijalankan di latar supaya
// giliran agen tidak ikut menunggu. Ini SENGAJA bukan daemon: agen tetap tidak
// menyalakan layanan sendiri - pemilik yang memutuskan, dan prosesnya bisa
// dilihat/dimatikan lewat alat `latar`.

export function folderLatar() {
  return process.env.SAKTI_CLI_LATAR || path.join(folderProfil(), 'latar');
}

function berkasLatar() {
  return path.join(folderLatar(), 'daftar.json');
}

function bacaLatar() {
  try {
    const isi = JSON.parse(fs.readFileSync(berkasLatar(), 'utf8'));
    return Array.isArray(isi) ? isi : [];
  } catch {
    // JSON rusak: cadangkan sebelum bawaan - daftar lama jangan lenyap tanpa jejak.
    try {
      const sumber = berkasLatar();
      if (fs.existsSync(sumber)) fs.renameSync(sumber, sumber + '.rusak-' + Date.now());
    } catch { /* berkas sudah tidak ada */ }
    return [];
  }
}

function tulisLatar(daftar) {
  fs.mkdirSync(folderLatar(), { recursive: true });
  const berkas = berkasLatar();
  const sementara = berkas + '.tmp-' + process.pid;
  fs.writeFileSync(sementara, JSON.stringify(daftar, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(sementara, berkas);
  return berkas;
}

/** Baca → ubah → tulis daftar proses latar di bawah kunci + rename atomik. */
function ubahLatar(fn) {
  fs.mkdirSync(folderLatar(), { recursive: true });
  return kunciBerkas(berkasLatar(), () => {
    const baru = fn(bacaLatar());
    tulisLatar(baru);
    return baru;
  });
}

const hidup = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Mulai satu perintah di latar. Keluaran masuk berkas log, bukan ke terminal. */
export async function latarMulai(perintah, { cwd = process.cwd(), nama = '' } = {}) {
  const baris = String(perintah == null ? '' : perintah).trim();
  if (!baris) throw new GalatLokal('perintah kosong');
  // Sama dgn shell(): cwd tak ada = gagal jelas, bukan jatuh ke folder peluncur.
  if (cwd && !fs.existsSync(cwd)) throw new GalatLokal('folder kerja tidak ada: ' + cwd);
  const folderKerja = cwd || process.cwd();
  const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const folder = path.join(folderLatar(), id);
  fs.mkdirSync(folder, { recursive: true });
  const log = path.join(folder, 'log.txt');
  const pintu = fs.openSync(log, 'a');
  const { spawn } = await import('node:child_process');
  const anak = spawn('bash', ['-lc', baris], {
    cwd: folderKerja,
    detached: true,
    stdio: ['ignore', pintu, pintu],
    // ADR-005 K2: filter env sama dgn shell() - secret tidak diwariskan.
    env: await (async () => { const { envTool } = await import('./alat.js'); return envTool(); })()
  });
  anak.unref();
  fs.closeSync(pintu);
  const meta = { id, nama: String(nama || baris.slice(0, 40)), perintah: baris, cwd, pid: anak.pid, mulai: Date.now(), log, selesai: 0, kode: null };
  ubahLatar((daftar) => daftar.concat([meta]).slice(-50));
  return meta;
}

/** Semua proses latar + keadaan hidup/mati (dihitung saat dibaca, bukan disimpan). */
export function latarDaftar() {
  return bacaLatar().map((row) => {
    const jalan = !row.selesai && hidup(row.pid);
    return Object.assign({}, row, { jalan, ukuranLog: (() => { try { return fs.statSync(row.log).size; } catch { return 0; } })() });
  });
}

function satuLatar(id) {
  const jarum = String(id || '').trim();
  const daftar = latarDaftar();
  const satu = daftar.find((row) => row.id === jarum) || daftar.slice().reverse().find((row) => row.id.startsWith(jarum));
  if (!satu) throw new GalatLokal('proses latar tidak ada: ' + jarum);
  return satu;
}

/** Keadaan satu proses + ekor log. */
export function latarStatus(id, { ekor = 40 } = {}) {
  const satu = satuLatar(id);
  let log = '';
  try {
    log = fs.readFileSync(satu.log, 'utf8').split('\n').slice(-ekor).join('\n').trimEnd();
  } catch { log = '(belum ada keluaran)'; }
  return { meta: satu, log };
}

/** Matikan proses latar (beserta anak-anaknya). */
export function latarBunuh(id) {
  const satu = satuLatar(id);
  if (!satu.jalan) return Object.assign({}, satu, { dibunuh: false });
  try { process.kill(-satu.pid, 'SIGTERM'); } catch { try { process.kill(satu.pid, 'SIGTERM'); } catch { /* sudah mati */ } }
  ubahLatar((daftar) => daftar.map((row) => (row.id === satu.id ? Object.assign({}, row, { selesai: Date.now(), kode: 'dimatikan' }) : row)));
  return Object.assign({}, satu, { dibunuh: true });
}

/** Tandai proses yang sudah mati sebagai selesai (dipanggil saat daftar dilihat). */
export function latarSapu() {
  // Baca-modify-tulis DI DALAM kunci: snapshot dari luar kunci bisa menimpa
  // entri baru yang ditulis latarMulai di antara baca dan tulis.
  let baru = [];
  ubahLatar((daftar) => {
    baru = daftar.map((row) => {
      if (row.selesai || hidup(row.pid)) return row;
      return Object.assign({}, row, { selesai: Date.now(), kode: 'berhenti' });
    });
    return baru;
  });
  return baru;
}
