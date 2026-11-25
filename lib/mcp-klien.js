/* global AbortSignal */
// Klien MCP: daftar server di ~/.sakti-cli/mcp.json, konek lewat stdio
// (`command`) atau http (`url`), alat server jadi alat agen bernama
// `mcp_<server>_<alat>`.
//
// Ini kebalikan mcp.js di akar repo: mcp.js MENJADI server (`sakti mcp serve`),
// berkas ini MEMAKAI server lain.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const PROTOKOL = '2024-11-05';
const WAKTU = 20000;
const MATI = ['0', 'off', 'nonaktif', 'false', 'tidak'];

export function berkasMcp() {
  return process.env.SAKTI_CLI_MCP || path.join(os.homedir(), '.sakti-cli', 'mcp.json');
}

export function namaSah(nama) {
  // `..` dilarang: nama server dipakai sebagai kunci dan bisa ikut ke jalur
  // berkas di pemakaian lain. Titik berderet dijadikan '-', titik di ujung dibuang.
  const bersih = String(nama || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!bersih) throw new Error('nama server kosong atau tidak sah');
  return bersih;
}

function bacaSemua() {
  try {
    const isi = JSON.parse(fs.readFileSync(berkasMcp(), 'utf8'));
    return isi && typeof isi === 'object' && !Array.isArray(isi) ? isi : {};
  } catch { return {}; }
}

function tulisSemua(isi) {
  const berkas = berkasMcp();
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  // mcp.json memuat `env` (kunci API server MCP) - jangan 0644. Tulis lewat
  // berkas sementara + rename supaya mati listrik tidak meninggalkan JSON
  // separuh (server hilang semua), lalu rapikan mode seperti config.json.
  const sementara = berkas + '.tmp-' + process.pid;
  fs.writeFileSync(sementara, JSON.stringify(isi, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(sementara, berkas);
  try { fs.chmodSync(berkas, 0o600); } catch { /* filesystem tanpa chmod */ }
  return berkas;
}

/** Normalisasi nilai `aktif`. Berkas bisa ditulis tangan dengan "0"/"false"/"off",
 *  dan dulu `daftarServer` membacanya mentah sehingga `"0"` tetap dianggap aktif. */
export function nilaiAktif(isi) {
  if (isi === undefined || isi === null) return true;
  if (typeof isi === 'boolean') return isi;
  return !MATI.includes(String(isi).trim().toLowerCase());
}

/** Semua server, urut nama; `aktif` bawaan true. */
export function daftarServer() {
  const semua = bacaSemua();
  return Object.keys(semua).sort().map((nama) => Object.assign(
    { args: [], env: {}, headers: {} },
    semua[nama],
    { nama, aktif: nilaiAktif(semua[nama] && semua[nama].aktif) }
  ));
}

export function bacaServer(nama) {
  return daftarServer().find((satu) => satu.nama === namaSah(nama)) || null;
}

/** "K=V,K2=V2" atau "Kunci: Nilai" -> objek; gabung dengan yang lama. */
function gabungPasangan(lama, isi) {
  const hasil = Object.assign({}, lama || {});
  if (isi && typeof isi === 'object' && !Array.isArray(isi)) return Object.assign(hasil, isi);
  for (const potongan of String(isi || '').split(',')) {
    const teks = potongan.trim();
    if (!teks) continue;
    let pisah = teks.indexOf('=');
    if (pisah < 0) pisah = teks.indexOf(':');
    if (pisah > 0) hasil[teks.slice(0, pisah).trim()] = teks.slice(pisah + 1).trim();
  }
  return hasil;
}

/** Simpan (gabung dengan yang lama). */
export function simpanServer(nama, nilai = {}) {
  const bersih = namaSah(nama);
  const data = bacaSemua();
  const baru = Object.assign({}, data[bersih] || {});
  for (const [kunci, isi] of Object.entries(nilai)) {
    if (kunci === 'alat' && (isi === '' || isi === null || (Array.isArray(isi) && isi.length === 0))) { baru.alat = []; continue; }
    if (isi === undefined || isi === null || isi === '') continue;
    if (kunci === 'aktif') baru.aktif = !MATI.includes(String(isi).toLowerCase());
    else if (kunci === 'args') baru.args = (Array.isArray(isi) ? isi : String(isi).split(',')).map((satu) => String(satu).trim()).filter(Boolean);
    else if (kunci === 'env' || kunci === 'headers') baru[kunci] = gabungPasangan(baru[kunci], isi);
    else if (kunci === 'alat') {
      // Daftar putih alat MCP. Server seperti REA punya 263 alat; tanpa
      // pembatasan, schema-nya membanjiri konteks model.
      const arr = Array.isArray(isi) ? isi : String(isi).split(',');
      baru.alat = [...new Set(arr.map((satu) => String(satu).trim()).filter(Boolean))];
    } else baru[kunci] = isi;
  }
  if (baru.command && baru.url) throw new Error('pilih satu: command (stdio) atau url (http), bukan keduanya');
  if (!baru.command && !baru.url) throw new Error('butuh command="..." (stdio) atau url="..." (http)');
  baru.at = Date.now();
  data[bersih] = baru;
  tulisSemua(data);
  tutup(bersih);
  cache = { at: 0, daftar: [], galat: {} };
  return Object.assign({ nama: bersih }, baru);
}

export function hapusServer(nama) {
  const bersih = namaSah(nama);
  const data = bacaSemua();
  if (!data[bersih]) return false;
  delete data[bersih];
  tulisSemua(data);
  tutup(bersih);
  cache = { at: 0, daftar: [], galat: {} };
  return true;
}

/* -------------------------------------------------------- koneksi ----- */

const KONEKSI = new Map();
let urut = 0;
let cache = { at: 0, daftar: [], galat: {} };
// Penemuan alat MCP yang sedang berjalan (dipakai penjaga anti-panggilan-ganda).
let _sedang = null;

function tutup(nama) {
  const ada = KONEKSI.get(nama);
  KONEKSI.delete(nama);
  if (ada) ada.then((k) => k.tutup && k.tutup()).catch(() => {});
}

/* Satu penutupan untuk SEMUA koneksi, sinkron. Wajib dipanggil sebelum proses
   keluar: child stdio (`rea mcp` dsb) memegang pipe, dan pipe itu menahan event
   loop - jadi tanpa ini proses CLI menggantung setelah jawaban tercetak
   (terukur: `sakti run` + `rea mcp` aktif = tidak pernah keluar, uji timeout). */
export function tutupSekarang() {
  for (const nama of [...KONEKSI.keys()]) tutup(nama);
  cache = { at: 0, daftar: [], galat: {} };
  _sedang = null;
}

const GENERASI = new Map();

function klien(server) {
  if (KONEKSI.has(server.nama)) return KONEKSI.get(server.nama);
  const gen = (GENERASI.get(server.nama) || 0) + 1;
  GENERASI.set(server.nama, gen);
  const janji = (server.url ? klienHttp(server, gen) : klienStdio(server, gen)).catch((galat) => {
    // Hanya hapus bila koneksi ini masih yang terbaru: `close` terlambat dari
    // anak lama tidak boleh menghapus pengganti yang sudah terpasang.
    if ((GENERASI.get(server.nama) || 0) === gen) KONEKSI.delete(server.nama);
    throw galat;
  });
  KONEKSI.set(server.nama, janji);
  return janji;
}

/** initialize + notifications/initialized, balikkan {minta, kabar, tutup}. */
async function siapkan(minta, kabar, tutupFn) {
  await minta('initialize', { protocolVersion: PROTOKOL, capabilities: {}, clientInfo: { name: 'sakti', version: '2.1.0' } });
  try { await kabar('notifications/initialized', {}); } catch { /* kabar boleh gagal */ }
  return { minta, kabar, tutup: tutupFn };
}

function klienStdio(server, gen = 0) {
  if (!server.command) return Promise.reject(new Error('server ' + server.nama + ' belum punya command atau url'));
  const kata = String(server.command).trim().split(/\s+/);
  const anak = spawn(kata[0], kata.slice(1).concat(server.args || []), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, server.env || {})
  });
  const nunggu = new Map();
  let galat = '';
  let mati = null;
  /* Gagal spawn (ENOENT) hanya memancarkan 'error' + 'close', BUKAN 'exit'.
     Dulu semua permintaan yang menunggu tidak pernah ditolak karena itu, dan
     Node keluar diam-diam saat event loop kosong: `sakti mcp tambah …` dengan
     command salah mencetak apa pun tidak, kode keluar 0. */
  const gagalkan = (pesan) => {
    mati = pesan instanceof Error ? pesan : new Error(String(pesan));
    for (const slot of nunggu.values()) slot.tolak(mati);
    nunggu.clear();
    if ((GENERASI.get(server.nama) || 0) === gen) KONEKSI.delete(server.nama);
  };
  readline.createInterface({ input: anak.stdout }).on('line', (baris) => {
    let pesan;
    try { pesan = JSON.parse(baris); } catch { return; }
    if (pesan.id == null) return;
    const slot = nunggu.get(pesan.id);
    if (!slot) return;
    nunggu.delete(pesan.id);
    if (pesan.error) slot.tolak(new Error('MCP: ' + (pesan.error.message || 'galat')));
    else slot.selesai(pesan.result || {});
  });
  anak.stderr.on('data', (b) => { galat = (galat + String(b)).slice(-600); });
  anak.stdin.on('error', () => { /* EPIPE setelah anak mati: jangan uncaught */ });
  anak.on('error', (e) => {
    galat = String((e && e.message) || e);
    gagalkan(new Error('server ' + server.nama + ' tidak bisa dijalankan: ' + galat));
  });
  anak.on('close', (kode) => {
    if (!mati) gagalkan(new Error('server ' + server.nama + ' berhenti (kode ' + kode + ')' + (galat.trim() ? ' · ' + galat.trim() : '')));
  });
  anak.on('exit', (kode) => {
    if (!mati) gagalkan(new Error('server ' + server.nama + ' berhenti (kode ' + kode + ')' + (galat.trim() ? ' · ' + galat.trim() : '')));
  });
  const tulis = (pesan) => { try { anak.stdin.write(JSON.stringify(pesan) + '\n'); } catch { /* sudah mati */ } };
  const minta = (method, params) => new Promise((selesai, tolak) => {
    if (mati) return tolak(mati);
    const id = ++urut;
    nunggu.set(id, { selesai, tolak });
    tulis({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (nunggu.delete(id)) tolak(new Error('timeout ' + WAKTU + 'ms: ' + method)); }, WAKTU).unref();
  });
  const kabar = (method, params) => { tulis({ jsonrpc: '2.0', method, params }); };
  return siapkan(minta, kabar, () => { try { anak.kill(); } catch { /* sudah mati */ } });
}

/** Balasan http bisa JSON biasa atau SSE ("data: {...}"). */
export function bacaBalasan(teks) {
  const isi = String(teks || '').trim();
  if (!isi) return null;
  try { return JSON.parse(isi); } catch { /* coba SSE */ }
  for (const baris of isi.split('\n')) {
    const cocok = /^data:\s*(\{[\s\S]*\})\s*$/.exec(baris.trim());
    if (cocok) { try { return JSON.parse(cocok[1]); } catch { /* baris lain */ } }
  }
  return null;
}

async function klienHttp(server, gen = 0) {
  let sesi = '';
  const kepala = () => Object.assign(
    { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    sesi ? { 'mcp-session-id': sesi } : {},
    server.headers || {}
  );
  const kirim = async (badan) => {
    const jawab = await fetch(server.url, { method: 'POST', headers: kepala(), body: JSON.stringify(badan), signal: AbortSignal.timeout(WAKTU) });
    const id = jawab.headers.get('mcp-session-id');
    if (id) sesi = id;
    const teks = await jawab.text();
    if (!jawab.ok) throw new Error('HTTP ' + jawab.status + ' ' + teks.slice(0, 200));
    return teks;
  };
  const minta = async (method, params) => {
    const pesan = bacaBalasan(await kirim({ jsonrpc: '2.0', id: ++urut, method, params }));
    if (!pesan) throw new Error('balasan tidak dikenali dari ' + server.url);
    if (pesan.error) throw new Error('MCP: ' + (pesan.error.message || 'galat'));
    return pesan.result || {};
  };
  const kabar = (method, params) => kirim({ jsonrpc: '2.0', method, params }).catch(() => {});
  return siapkan(minta, kabar, () => {});
}

/* ------------------------------------------------------ alat MCP ------ */

export async function daftarAlatServer(nama, { semua = false } = {}) {
  const server = bacaServer(nama);
  if (!server) throw new Error('server tidak ada: ' + nama);
  const k = await klien(server);
  const hasil = await k.minta('tools/list', {});
  const baris = (hasil.tools || []).map((alat) => ({
    server: server.nama,
    nama: alat.name,
    deskripsi: alat.description || '',
    skema: alat.inputSchema || { type: 'object', properties: {} }
  }));
  const izin = Array.isArray(server.alat) && server.alat.length ? new Set(server.alat) : null;
  return !semua && izin ? baris.filter((row) => izin.has(row.nama)) : baris;
}

export async function panggilAlatServer(nama, alat, args = {}) {
  const server = bacaServer(nama);
  if (!server) throw new Error('server tidak ada: ' + nama);
  const k = await klien(server);
  const hasil = await k.minta('tools/call', { name: alat, arguments: args || {} });
  const isi = (hasil.content || []).map((satu) => {
    if (satu && satu.type === 'text') return satu.text;
    if (satu && satu.type === 'resource') return '[resource] ' + ((satu.resource && satu.resource.uri) || '');
    return JSON.stringify(satu);
  }).join('\n');
  return (hasil.isError ? 'GAGAL: ' : '') + (isi || JSON.stringify(hasil));
}

/** Konek, ambil daftar alat, tutup. Untuk `sakti mcp tes`. */
export async function tesServer(nama) {
  const mulai = Date.now();
  const alat = await daftarAlatServer(nama);
  tutup(namaSah(nama));
  return { alat, ms: Date.now() - mulai };
}

/** Alat dari semua server aktif; cache 60 detik. Galat per server disimpan. */
export async function siapkanAlatMcp({ paksa = false, waktu = 60000 } = {}) {
  if (!paksa && Date.now() - cache.at < waktu) return cache.daftar;
  // Beberapa subagen/bot kini jalan bersamaan. Tanpa penjaga ini, tiga giliran
  // yang mulai bersamaan sama-sama melihat cache kosong lalu memulai server MCP
  // tiga kali (proses ganda, port bentrok). Pemanggil berikutnya menunggu
  // penemuan yang sedang berjalan, bukan memulai yang baru.
  if (_sedang && !paksa) return _sedang;
  const kerja = (async () => {
    const daftar = [];
    const galat = {};
    for (const server of daftarServer()) {
      if (server.aktif === false) continue;
      try {
        const rows = await daftarAlatServer(server.nama);
        const izin = Array.isArray(server.alat) && server.alat.length ? new Set(server.alat) : null;
        daftar.push(...(izin ? rows.filter((row) => izin.has(row.nama)) : rows));
      } catch (e) { galat[server.nama] = String((e && e.message) || e); }
    }
    cache = { at: Date.now(), daftar, galat };
    return daftar;
  })();
  _sedang = kerja;
  try {
    return await kerja;
  } finally {
    if (_sedang === kerja) _sedang = null;
  }
}

export const galatMcp = () => cache.galat || {};

/** Alat MCP yang sudah tersambung sebelumnya (tanpa koneksi baru). */
export const alatCache = () => cache.daftar || [];

/** Nama alat gabungan untuk model. Normalisasi saja TIDAK cukup: `x-y`, `x.y`,
 *  `x_y` semuanya jadi `x_y`, dan `a-b`+`t` sama dengan `a`+`b-t` - dua alat
 *  berbeda jadi satu nama, sehingga model memanggil alat yang salah tanpa ada
 *  yang tahu. Karena itu pasangan (server, alat) diberi sidik 8 huruf di ekor,
 *  dihitung dari pasangan ASLI sebelum normalisasi. Nama jadi kurang enak
 *  dibaca, tapi salah panggil alat jauh lebih mahal. */
export function namaAlatMcp(server, alat) {
  const asli = String(server) + '\u0000' + String(alat);
  let sidik = 2166136261;
  for (let i = 0; i < asli.length; i += 1) {
    sidik ^= asli.charCodeAt(i);
    sidik = Math.imul(sidik, 16777619) >>> 0;
  }
  const akhiran = sidik.toString(36).padStart(6, '0').slice(0, 6);
  const dasar = ('mcp_' + server + '_' + alat).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  // Sisakan ruang untuk '_' + 6 huruf sidik dalam batas 64.
  return dasar.slice(0, 57) + '_' + akhiran;
}

/** Baris alat MCP -> entri alat sakti (punya `.jalankan`). */
export function bungkusAlat(rows) {
  return (rows || []).map((row) => ({
    name: namaAlatMcp(row.server, row.nama),
    label: row.server + ' · ' + row.nama,
    description: (row.deskripsi || ('alat MCP dari server ' + row.server + ': ' + row.nama)) + ' [mcp:' + row.server + ']',
    parameters: row.skema || { type: 'object', properties: {} },
    jalankan: (args) => panggilAlatServer(row.server, row.nama, args)
  }));
}

/** Cari entri alat MCP menurut nama gabungan (dipakai saat model memanggil alat). */
export function cariAlatMcp(nama) {
  return bungkusAlat(cache.daftar).find((satu) => satu.name === nama) || null;
}

export function tutupSemua() {
  tutupSekarang();
}

/** Jumlah koneksi yang masih tertahan di memori. Dipakai uji dan `sakti doctor`
 *  untuk melihat kebocoran koneksi (child process yang tidak pernah ditutup
 *  menahan proses induk tetap hidup). */
export function aktifKoneksi() {
  return KONEKSI.size;
}

process.once('exit', () => {
  for (const janji of KONEKSI.values()) janji.then((k) => k.tutup && k.tutup()).catch(() => {});
});