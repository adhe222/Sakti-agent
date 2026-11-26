// Hook alat: perintah shell yang dijalankan sebelum/sesudah satu alat.
// Berkas: ~/.sakti-cli/hook.json  (atau $SAKTI_CLI_HOOK)
//
//   { "pra":   { "tulis": "npm run lint", "*": "..." },
//     "pasca": { "terminal": "echo selesai", "*": "..." } }
//
// Kunci = nama alat, "*" = semua alat. Nilai = perintah shell, boleh array.
// Env yang disisipkan: SAKTI_ALAT, SAKTI_ARGS (JSON), SAKTI_HASIL (hanya pasca).
// Keluaran hook TIDAK memblokir alat: kegagalan hook dilaporkan, alat tetap jalan.
// (Memblokir berarti hook bisa mematikan agen tanpa jalan keluar; kalau nanti
//  butuh gerbang keras, tambahkan "wajib": true lalu periksa kode keluaran.)

import fs from 'node:fs';
import { folderProfil } from './lokal.js';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function berkasHook() {
  return process.env.SAKTI_CLI_HOOK || path.join(folderProfil(), 'hook.json');
}

export function bacaHook() {
  try {
    const isi = JSON.parse(fs.readFileSync(berkasHook(), 'utf8'));
    return isi && typeof isi === 'object' ? isi : {};
  } catch {
    return {};
  }
}

function daftarPerintah(tahap, nama, hook) {
  const blok = hook[tahap];
  // Bentuk array ({"pra": ["cmd"]}) berlaku utk semua alat - dulu no-op senyap
  // sehingga hook pengaman yang dipercaya pemilik tidak pernah jalan.
  if (Array.isArray(blok)) return blok.filter((satu) => typeof satu === 'string' && satu.trim());
  if (!blok || typeof blok !== 'object') return [];
  const ambil = (nilai) => (Array.isArray(nilai) ? nilai : nilai ? [nilai] : []);
  return [...ambil(blok[nama]), ...(nama === '*' ? [] : ambil(blok['*']))]
    .filter((satu) => typeof satu === 'string' && satu.trim());
}

/** Tombol mati: hook tidak dijalankan sama sekali. Ini jalan keluar kalau hook
 *  wajib sendiri yang rusak - tanpa ini, satu skrip salah bisa membekukan agen
 *  permanen karena semua alat berisiko diblokir. */
export function hookDimatikan() {
  const nilai = String(process.env.SAKTI_HOOK_MATI || '').toLowerCase();
  return nilai === '1' || nilai === 'true' || nilai === 'ya';
}

/** Apakah hook (tahap, alat) ini wajib lulus sebelum alat jalan.
 *  `"wajib": true` = semua wajib; `{"pra":["tulis"],"pasca":["*"]}` = selektif. */
export function wajibUntuk(tahap, nama, hook = bacaHook()) {
  const atur = hook && hook.wajib;
  if (atur === true) return true;
  if (!atur || typeof atur !== 'object') return false;
  const daftar = atur[tahap];
  const ambil = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return ambil(daftar).includes(nama) || ambil(daftar).includes('*');
}

/** Jalankan hook satu tahap dan nilai kelulusannya.
 *  `lulus` hanya berarti bila tahap ini wajib; kalau tidak wajib, selalu true. */
export function hookWajib(tahap, nama, { args, hasil, cwd, waktu = 60000 } = {}) {
  if (hookDimatikan()) {
    // `laporan` KOSONG: hook yang dimatikan bukan bagian dari hasil alat. Baris
    // "(hook dimatikan ...)" dulu menempel di setiap hasil dan dibaca model
    // sebagai keluaran sungguhan. Keadaan mati tetap terlihat di `sakti doctor`.
    return { laporan: '', lulus: true, wajib: false, mati: true };
  }
  const hook = bacaHook();
  const wajib = wajibUntuk(tahap, nama, hook);
  const rinci = hookRinci(tahap, nama, { args, hasil, cwd, waktu, hook });
  return { laporan: rinci.laporan, lulus: wajib ? !rinci.gagal : true, wajib, mati: false, gagal: rinci.gagal };
}

/**
 * Jalankan hook satu tahap. Mengembalikan baris laporan ('' kalau tidak ada hook).
 */
export function jalankanHook(tahap, nama, { args, hasil, cwd, waktu = 60000, hook, rinci } = {}) {
  const hasil2 = hookRinci(tahap, nama, { args, hasil, cwd, waktu, hook });
  return rinci ? hasil2 : hasil2.laporan;
}

/** Versi terstruktur: kode keluar dibaca dari proses, BUKAN dicocokkan regex pada
 *  keluaran - hook yang mencetak teks "kode=7" tidak boleh dituduh gagal. */
export function hookRinci(tahap, nama, { args, hasil, cwd, waktu = 60000, hook } = {}) {
  if (hookDimatikan()) return { laporan: '', gagal: false, kosong: true };
  const perintah = daftarPerintah(tahap, nama, hook || bacaHook());
  if (!perintah.length) return { laporan: '', gagal: false, kosong: true };
  const env = { ...process.env, SAKTI_ALAT: String(nama) };
  try { env.SAKTI_ARGS = JSON.stringify(args || {}); } catch { env.SAKTI_ARGS = '{}'; }
  if (hasil !== undefined) env.SAKTI_HASIL = String(hasil).slice(0, 4000);
  const laporan = [];
  let gagal = false;
  for (const satu of perintah) {
    const r = spawnSync('bash', ['-lc', satu], {
      cwd: cwd || process.cwd(),
      env,
      encoding: 'utf8',
      timeout: waktu,
      maxBuffer: 4 * 1024 * 1024
    });
    // status === null berarti proses tidak selesai wajar (timeout/dibunuh).
    const kode = r.status === null ? 'timeout/galat' : r.status;
    if (r.status !== 0) gagal = true;
    const ekor = String(r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n');
    laporan.push('hook ' + tahap + ' [' + satu + '] kode=' + kode + (ekor ? '\n' + ekor : ''));
  }
  return { laporan: laporan.join('\n'), gagal, kosong: false };
}
