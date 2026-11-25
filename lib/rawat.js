// Rawat diri: periksa/perbaiki hal yang bisa diperbaiki tanpa menebak, dan
// tarik pembaruan kode dengan aman (fast-forward + validasi + rollback).
//
// Prinsip:
//  - Jangan pernah menimpa config/state/sesi yang rusak: cadangkan, laporkan.
//  - Update kode hanya kalau repo bersih, fast-forward, dan lolos `node --check`;
//    gagal = rollback ke commit lama.
//  - Tidak ada perubahan kode yang dikarang sendiri: "memperbaiki diri" di sini
//    berarti memperbaiki keadaan mesin (izin, folder, hook rusak, sampah) dan
//    menarik pembaruan resmi, bukan menulis patch tanpa bukti.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bacaState, ubahState } from './lokal.js';
import { sapuSampah, ringkasSampah } from './bersih.js';
import { promosikanPelajaran } from './pelajaran.js';

const JAM = 60 * 60 * 1000;
export const JEDA_RAWAT_MS = 6 * JAM;

export function akarSakti() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function folderRumah() {
  if (process.env.SAKTI_CLI_HOME) return process.env.SAKTI_CLI_HOME;
  // Config kustom (uji/CI atau profil terpisah) menentukan folder rumahnya
  // sendiri; jangan mencampur dengan ~/.sakti-cli milik pengguna asli.
  if (process.env.SAKTI_CLI_CONFIG) return path.dirname(process.env.SAKTI_CLI_CONFIG);
  return path.join(os.homedir(), '.sakti-cli');
}

export function berkasKonfigRawat() {
  return process.env.SAKTI_CLI_CONFIG || path.join(folderRumah(), 'config.json');
}

export function berkasHookRawat() {
  return process.env.SAKTI_CLI_HOOK || path.join(folderRumah(), 'hook.json');
}

function bacaJson(jalur) {
  try { return JSON.parse(fs.readFileSync(jalur, 'utf8')); } catch { return null; }
}

function modeIzin(jalur) {
  try { return fs.statSync(jalur).mode & 0o777; } catch { return null; }
}

function jalankanGit(akar, arg, waktu = 20000) {
  return spawnSync('git', ['-C', akar, ...arg], {
    encoding: 'utf8',
    timeout: waktu,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' })
  });
}

function jalankanNpm(akar, waktu = 180000) {
  const npm = spawnSync('bash', ['-lc', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
  if (!npm) return { ok: false, alasan: 'npm tidak ada' };
  const hasil = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: akar, encoding: 'utf8', timeout: waktu
  });
  return { ok: hasil.status === 0, alasan: String(hasil.stderr || hasil.stdout || '').slice(0, 300) };
}

/** Cek sintaks berkas .js yang berubah (bukan seluruh node_modules). */
function validasiKode(akar, berkas = []) {
  const calon = berkas.filter((satu) => satu.endsWith('.js') && !satu.startsWith('node_modules/'));
  const gagal = [];
  for (const relatif of calon) {
    const penuh = path.join(akar, relatif);
    if (!fs.existsSync(penuh)) continue;
    const hasil = spawnSync(process.execPath, ['--check', penuh], { encoding: 'utf8', timeout: 15000 });
    if (hasil.status !== 0) gagal.push(relatif + ': ' + String(hasil.stderr || '').split('\n').slice(0, 2).join(' '));
  }
  return gagal;
}

/**
 * Tarik kode dari remote dengan pengaman. Tidak melempar untuk kondisi normal
 * (tanpa remote, offline, sudah terbaru) - mengembalikan alasan yang bisa
 * dilaporkan. `validasi` bisa diganti di uji untuk mensimulasikan kode rusak.
 */
export function tarikAman({
  akar = akarSakti(),
  validasi = null,
  pasangDependensi = true,
  waktuFetch = 20000,
  waktuPull = 60000
} = {}) {
  if (!fs.existsSync(path.join(akar, '.git'))) return { ok: false, alasan: 'tanpa repo git', berubah: [] };
  const remote = jalankanGit(akar, ['remote'], 5000);
  if (remote.status !== 0 || !String(remote.stdout || '').trim()) return { ok: false, alasan: 'tanpa remote', berubah: [] };
  const kotor = jalankanGit(akar, ['status', '--porcelain'], 10000);
  if (String(kotor.stdout || '').trim()) return { ok: false, alasan: 'repo kotor (commit/stash dulu)', berubah: [] };
  const lama = String(jalankanGit(akar, ['rev-parse', 'HEAD'], 5000).stdout || '').trim();
  if (!lama) return { ok: false, alasan: 'HEAD tidak terbaca', berubah: [] };

  const tarik = jalankanGit(akar, ['fetch', '--quiet', '--prune', 'origin'], waktuFetch);
  if (tarik.status !== 0) return { ok: false, alasan: 'fetch gagal: ' + String(tarik.stderr || '').trim().slice(0, 200), berubah: [] };
  const hulu = String(jalankanGit(akar, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 5000).stdout || '').trim();
  if (!hulu) return { ok: false, alasan: 'tanpa upstream (set git branch --set-upstream-to)', berubah: [] };
  const diBelakang = Number(String(jalankanGit(akar, ['rev-list', '--count', 'HEAD..' + hulu], 10000).stdout || '0').trim()) || 0;
  if (!diBelakang) return { ok: true, sudahTerbaru: true, dari: lama, ke: lama, berubah: [] };

  const pull = jalankanGit(akar, ['pull', '--ff-only'], waktuPull);
  if (pull.status !== 0) return { ok: false, alasan: 'pull gagal: ' + String(pull.stderr || '').trim().slice(0, 300), dari: lama, berubah: [] };
  const baru = String(jalankanGit(akar, ['rev-parse', 'HEAD'], 5000).stdout || '').trim();
  const daftar = String(jalankanGit(akar, ['diff', '--name-only', lama, baru], 15000).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const paketBerubah = daftar.some((s) => s === 'package.json' || s === 'package-lock.json');

  // Validasi kode SEBELUM npm install: postinstall paket adalah kode arbitrer,
  // dan dulu ia berjalan sebelum `node --check` sempat menolak rilis rusak.
  const gagalValidasi = (() => {
    // Validasi bisa melempar (mis. git gagal membaca berkas baru). Tanpa
    // tangkapan ini exception meninggalkan kode pada versi baru TANPA rollback.
    try { return validasi ? validasi(daftar, akar) : validasiKode(akar, daftar); }
    catch (galat) { return ['validasi melempar: ' + String((galat && galat.message) || galat)]; }
  })();
  if (gagalValidasi && gagalValidasi.length) {
    jalankanGit(akar, ['reset', '--hard', lama], 30000);
    return { ok: false, rollback: true, alasan: 'validasi gagal: ' + gagalValidasi.join(' | ').slice(0, 300), dari: lama, ke: baru, berubah: daftar };
  }

  let dependensi = null;
  if (pasangDependensi && paketBerubah) {
    dependensi = jalankanNpm(akar);
    if (!dependensi.ok) {
      jalankanGit(akar, ['reset', '--hard', lama], 30000);
      if (pasangDependensi) jalankanNpm(akar);
      return { ok: false, rollback: true, alasan: 'npm install gagal: ' + dependensi.alasan, dari: lama, ke: baru, berubah: daftar };
    }
  }
  return {
    ok: true, dari: lama, ke: baru, berubah: daftar,
    paketBerubah, dependensi: dependensi ? dependensi.ok : null,
    jumlahCommit: diBelakang
  };
}

/**
 * Perbaiki keadaan mesin yang aman: izin config, folder yang hilang, hook JSON
 * rusak (dicadangkan, bukan dihapus), sampah alat, dan promosi pelajaran.
 * Tidak menyentuh config/state/sesi yang isinya rusak - itu dilaporkan.
 */
export function rawatLokal({ perbaiki = true } = {}) {
  const temuan = [];
  const perbaikan = [];
  const rumah = folderRumah();
  try {
    fs.mkdirSync(rumah, { recursive: true, mode: 0o700 });
    const modeRumah = modeIzin(rumah);
    if (modeRumah != null && (modeRumah & 0o077)) {
      temuan.push('folder ' + rumah + ' terlalu terbuka (' + modeRumah.toString(8) + ')');
      if (perbaiki) { fs.chmodSync(rumah, 0o700); perbaikan.push('chmod 700 ' + rumah); }
    }
  } catch (galat) { temuan.push('folder rumah gagal dibuat: ' + String(galat.message || galat)); }

  const cfg = berkasKonfigRawat();
  if (fs.existsSync(cfg)) {
    const mode = modeIzin(cfg);
    if (mode != null && (mode & 0o077)) {
      temuan.push('config berisi kunci API dengan izin ' + mode.toString(8));
      if (perbaiki) { fs.chmodSync(cfg, 0o600); perbaikan.push('chmod 600 ' + cfg); }
    }
    if (!bacaJson(cfg)) temuan.push('config bukan JSON sah: ' + cfg + ' (tidak ditimpa)');
  }

  const state = bacaState();
  if (!state || typeof state !== 'object') temuan.push('state tidak terbaca sebagai objek (tidak ditimpa)');
  // sakti-cli home: semua berkas data pemilik harus 0600/0700.
  for (const [label, jalur] of [['sesi', path.join(rumah, 'sesi')], ['khazanah', path.join(rumah, 'khazanah.json')], ['biaya', path.join(rumah, 'biaya.json')]]) {
    try {
      const st = fs.statSync(jalur);
      const mode = st.mode & 0o777;
      if ((st.isDirectory() && (mode & 0o077)) || (st.isFile() && (mode & 0o077))) {
        temuan.push(label + ' terlalu terbuka (' + mode.toString(8) + '): ' + jalur);
        if (perbaiki) { fs.chmodSync(jalur, st.isDirectory() ? 0o700 : 0o600); perbaikan.push('chmod ' + (st.isDirectory() ? '700' : '600') + ' ' + jalur); }
      }
    } catch { /* belum ada: bukan temuan */ }
  }
  // mcp.json menyimpan env server (kunci API): JSON harus sah dan 0600.
  const mcp = process.env.SAKTI_CLI_MCP || path.join(rumah, 'mcp.json');
  if (fs.existsSync(mcp)) {
    if (!bacaJson(mcp)) temuan.push('mcp.json bukan JSON sah: ' + mcp + ' (tidak ditimpa)');
    const mode = modeIzin(mcp);
    if (mode != null && (mode & 0o077)) {
      temuan.push('mcp.json memuat kredensial dengan izin ' + mode.toString(8));
      if (perbaiki) { fs.chmodSync(mcp, 0o600); perbaikan.push('chmod 600 ' + mcp); }
    }
  }

  const hook = berkasHookRawat();
  if (fs.existsSync(hook)) {
    if (!bacaJson(hook)) {
      temuan.push('hook JSON rusak: ' + hook);
      if (perbaiki) {
        const cadang = hook + '.rusak-' + Date.now();
        try { fs.renameSync(hook, cadang); perbaikan.push('hook rusak dicadangkan ke ' + cadang); } catch (galat) { temuan.push('gagal mencadangkan hook: ' + String(galat.message || galat)); }
      }
    }
  }

  for (const nama of ['sesi', 'spill', 'bots']) {
    const folder = path.join(rumah, nama);
    if (!fs.existsSync(folder)) {
      if (perbaiki) { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); perbaikan.push('buat folder ' + folder); }
      else temuan.push('folder belum ada: ' + folder);
    }
  }

  let sampah = null;
  if (perbaiki) {
    try {
      sampah = sapuSampah({});
      if (sampah && sampah.item && sampah.item.length) perbaikan.push('sampah dibersihkan: ' + ringkasSampah(sampah));
    } catch (galat) { temuan.push('pembersihan sampah gagal: ' + String(galat.message || galat)); }
  } else {
    temuan.push('sampah tidak diperiksa (mode periksa saja)');
  }

  let promosi = 0;
  if (perbaiki) {
    try { promosi = promosikanPelajaran({}); if (promosi) perbaikan.push(promosi + ' pelajaran dipromosikan ke ingatan inti'); }
    catch (galat) { temuan.push('promosi pelajaran gagal: ' + String(galat.message || galat)); }
  }

  // Jejak pemulihan: berkas .rusak-* berarti data lama GAGAL dibaca dan mesin
  // jalan dengan bawaan. Wajib terlihat, bukan "sehat" diam-diam.
  try {
    for (const nama of fs.readdirSync(rumah)) {
      if (nama.includes('.rusak-')) temuan.push('berkas rusak pernah dicadangkan: ' + nama + ' (mesin memakai data bawaan)');
    }
  } catch { /* folder belum ada */ }

  const nodeBesar = Number(process.versions.node.split('.')[0]) || 0;
  if (nodeBesar < 20) temuan.push('node ' + process.version + ' terlalu tua (butuh >= 20)');
  else if (nodeBesar < 22) temuan.push('node ' + process.version + ' · alat db SQLite butuh >= 22');

  // ok = TIDAK ada temuan tersisa. Dulu `temuan.length===0 || perbaikan.length>0`
  // melaporkan "ok" walau temuan sungguhan masih tercatat.
  return { ok: temuan.length === 0, temuan, perbaikan, promosi, sampah: sampah ? { jumlah: (sampah.item || []).length, byte: sampah.totalByte || 0 } : null };
}

function opsiRawat() {
  const cfg = bacaJson(berkasKonfigRawat()) || {};
  return {
    auto: cfg.autoRawat !== false,
    update: cfg.autoUpdate !== false
  };
}

/**
 * Rawat otomatis: throttle 6 jam, perbaikan lokal selalu, update kode bila
 * diizinkan. Hasil disimpan di state.rawat untuk `sakti rawat`.
 */
export function rawatOtomatis({ paksa = false, update = null } = {}) {
  if (/^(1|true|ya)$/i.test(String(process.env.SAKTI_RAWAT_MATI || ''))) return { dilewati: true, alasan: 'SAKTI_RAWAT_MATI' };
  const opsi = opsiRawat();
  if (!opsi.auto) return { dilewati: true, alasan: 'autoRawat mati' };
  const state = bacaState();
  const terakhir = Number(state && state.rawat && state.rawat.terakhir) || 0;
  if (!paksa && Date.now() - terakhir < JEDA_RAWAT_MS) return { dilewati: true, alasan: 'baru saja dirawat' };

  const lokal = rawatLokal({ perbaiki: true });
  const bolehUpdate = update == null ? opsi.update : Boolean(update);
  const tarik = bolehUpdate ? tarikAman() : { ok: false, alasan: 'autoUpdate mati', berubah: [] };
  const laporan = { waktu: Date.now(), lokal, tarik };
  try { ubahState((s) => { s.rawat = { terakhir: laporan.waktu, lokal: { temuan: lokal.temuan, perbaikan: lokal.perbaikan }, tarik }; }); } catch { /* state rusak: jangan gagalkan startup */ }
  return laporan;
}

/** Ringkas laporan untuk satu-dua baris startup/CLI. */
export function ringkasRawat(laporan = {}) {
  if (laporan.dilewati) return 'rawat: dilewati (' + (laporan.alasan || '') + ')';
  const baris = [];
  const lokal = laporan.lokal || {};
  if (lokal.perbaikan && lokal.perbaikan.length) baris.push('perbaikan: ' + lokal.perbaikan.join(' · '));
  if (lokal.temuan && lokal.temuan.length) baris.push('temuan: ' + lokal.temuan.join(' · '));
  if (!lokal.perbaikan && !lokal.temuan) baris.push('mesin: bersih');
  const tarik = laporan.tarik || {};
  if (tarik.ok && tarik.sudahTerbaru) baris.push('kode: terbaru (' + String(tarik.ke || '').slice(0, 8) + ')');
  else if (tarik.ok && tarik.ke) baris.push('kode: diperbarui ' + String(tarik.dari || '').slice(0, 8) + ' -> ' + String(tarik.ke).slice(0, 8) + ' (' + (tarik.berubah || []).length + ' berkas)');
  else if (tarik.alasan && !/autoUpdate mati/.test(tarik.alasan)) baris.push('kode: ' + tarik.alasan);
  return baris.join(' · ');
}
