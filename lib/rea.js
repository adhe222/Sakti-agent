// Integrasi opsional REA (https://github.com/morluto/rea):
// pembungkus tipis, tanpa menambah dependensi ke inti sakti.
//
// Paket besar (rea-agents ~186 MB) TIDAK di-vendor ke repo. `sakti rea pasang`
// memasangnya di ~/.sakti-cli/rea (atau SAKTI_CLI_REA), lalu perintah lain
// memakai launcher lokal itu. Kalau tidak ada, `jalurRea()` boleh menemukan
// biner `rea`/`rea-agents` di PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NAMA_PAKET = 'rea-agents';

/** Folder pemasangan REA yang terisolasi dari kode sakti. */
export function folderRea() {
  return process.env.SAKTI_CLI_REA || path.join(os.homedir(), '.sakti-cli', 'rea');
}

function bisaDijalankan(jalur) {
  try {
    const st = fs.statSync(jalur);
    if (!st.isFile()) return false;
    fs.accessSync(jalur, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * Cari launcher REA tanpa menjalankannya.
 * Balikkan { jenis:'lokal'|'path', command, args, versi? } atau null.
 */
export function jalurRea() {
  const lokal = path.join(folderRea(), 'node_modules', NAMA_PAKET, 'scripts', 'rea.mjs');
  if (fs.existsSync(lokal)) {
    return { jenis: 'lokal', command: process.execPath, args: [lokal], berkas: lokal };
  }
  for (const nama of ['rea', 'rea-agents']) {
    for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
      if (!folder) continue;
      const calon = path.join(folder, nama);
      if (bisaDijalankan(calon)) return { jenis: 'path', command: calon, args: [], berkas: calon };
    }
  }
  return null;
}

/** Jalankan perintah REA; `--version` dipakai status, sisanya diteruskan apa adanya. */
export function jalankanRea(sisa = [], { cwd = process.cwd(), env = {}, stdio = 'inherit' } = {}) {
  const launcher = jalurRea();
  if (!launcher) {
    return {
      ok: false,
      kode: 127,
      galat: 'REA belum terpasang. Jalankan: sakti rea pasang',
      launcher: null
    };
  }
  const hasil = spawnSync(launcher.command, launcher.args.concat(sisa), {
    cwd,
    stdio,
    env: Object.assign({}, process.env, env)
  });
  return {
    ok: hasil.status === 0,
    kode: hasil.status == null ? 1 : hasil.status,
    signal: hasil.signal || '',
    galat: hasil.error ? String(hasil.error.message || hasil.error) : '',
    launcher
  };
}

/** Status ringkas: versi dan letak launcher. Aman dipanggil saat REA belum ada. */
export function statusRea() {
  const launcher = jalurRea();
  if (!launcher) {
    return { ada: false, terpasang: false, folder: folderRea(), versi: '', launcher: null };
  }
  const cek = spawnSync(launcher.command, launcher.args.concat(['--version']), {
    encoding: 'utf8', timeout: 15000, cwd: process.cwd()
  });
  const versi = String(cek.stdout || cek.stderr || '').trim().split('\n')[0].slice(0, 80);
  return {
    ada: true,
    terpasang: true,
    folder: folderRea(),
    versi,
    launcher,
    galat: cek.error ? String(cek.error.message || cek.error) : ''
  };
}

/**
 * Pasang/refresh rea-agents ke folder terisolasi. Paket besar; jangan panggil
 * dari doctor atau startup. `versi` bawaan latest agar mengikuti rilis resmi.
 */
export function pasangRea({ versi = 'latest', stdio = 'inherit' } = {}) {
  const folder = folderRea();
  fs.mkdirSync(folder, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const hasil = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--prefix', folder, NAMA_PAKET + '@' + versi], {
    cwd: folder, stdio, env: process.env
  });
  if (hasil.error) return { ok: false, galat: String(hasil.error.message || hasil.error), folder };
  return {
    ok: hasil.status === 0,
    kode: hasil.status == null ? 1 : hasil.status,
    folder,
    galat: hasil.status === 0 ? '' : 'npm install gagal (kode ' + hasil.status + ')'
  };
}

/**
 * Daftarkan REA sebagai server MCP sakti. Memakai launcher lokal supaya
 * `npx` tidak mengunduh ulang setiap sesi.
 */
const ALAT_MCP_BAWAAN = [
  'open_binary',
  'binary_session',
  'analyze_javascript_application',
  'guided_workflows',
  'search_guidance',
  'read_guidance_section',
  'close_binary'
];

/**
 * Daftarkan MCP REA. Bawaannya hanya alat inti: schema 263 alat REA sekitar
 * 1,3 juta token dan akan membanjiri konteks model. `semua:true` membuka
 * seluruh katalog untuk klien yang memang sanggup; `alat` memilih subset.
 */
export async function pasangMcpRea({ semua = false, alat = null } = {}) {
  const launcher = jalurRea();
  if (!launcher) return { ok: false, galat: 'REA belum terpasang. Jalankan: sakti rea pasang' };
  if (launcher.jenis !== 'lokal') {
    return { ok: false, galat: 'launcher REA ditemukan di PATH, bukan pemasangan lokal; pasang dengan `sakti rea pasang` agar MCP stabil' };
  }
  const pilih = semua ? [] : (Array.isArray(alat) && alat.length ? alat : ALAT_MCP_BAWAAN);
  const klien = await import('./mcp-klien.js');
  const server = klien.simpanServer('rea', {
    command: process.execPath,
    args: [launcher.berkas, 'mcp'],
    alat: pilih,
    aktif: 'on'
  });
  return { ok: true, server, berkas: klien.berkasMcp(), alat: pilih };
}
