// Bersih-bersih sampah sakti: berkas yang dibuat alat lalu tidak dipakai lagi.
//
// Yang BOLEH disentuh (dan hanya ini):
//   - spill hasil alat (`~/.sakti-cli/spill`)   -> keluaran penuh yang sudah dipotong
//   - salinan checkpoint (`~/.sakti-cli/ckp`)   -> cadangan sebelum berkas ditimpa
//   - sisa tulis state (`*.tmp-*`, `*.rusak-*`) -> crash di tengah tulis
//
// Yang TIDAK PERNAH disentuh: sesi, keahlian, ingatan, config, bot. Itu data
// pemilik, bukan sampah - menghapusnya otomatis bukan "pintar", itu merusak.
//
// Semua fungsi menerima folder lewat env (SAKTI_CLI_SPILL/CKP/KHAZANAH/STATE)
// supaya bisa diuji tanpa menyentuh rumah pengguna.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bacaKhazanah, berkasKhazanah, folderCkp, khazanahTerbaca, tulisKhazanah } from './khazanah.js';
import { kunciBerkas } from './lokal.js';

const MB = 1024 * 1024;
const JAM = 60 * 60 * 1000;

export const BATAS_BAWAAN = {
  // 7 hari: keluaran alat yang masih dipakai biasanya dibaca dalam hitungan jam.
  umurJam: 168,
  spillBatas: 50,
  ckpBatas: 200,
  ckpByte: 200 * MB,
  // Dump sebelum menulis DB jaringan (pg_dump/mysqldump).
  dbBatas: 10,
  // Log paket JSONL harian: simpan 30 terbaru (atau 30 hari).
  logBatas: 30,
  logHari: 30,
  // Sisa tulis yang mati di tengah jalan: cukup 1 jam untuk memastikan tidak
  // ada proses lain yang sedang menulis.
  tmpJam: 1,
  // State rusak disimpan untuk diagnosis; 30 hari sudah lebih dari cukup.
  rusakHari: 30
};

export function folderSpill() {
  return process.env.SAKTI_CLI_SPILL || path.join(os.homedir(), '.sakti-cli', 'spill');
}

function folderState() {
  return path.dirname(process.env.SAKTI_CLI_STATE || path.join(os.homedir(), '.sakti-cli', 'state.json'));
}

function daftarBerkas(folder, pola) {
  let isi = [];
  try { isi = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  const hasil = [];
  for (const satu of isi) {
    const jalur = path.join(folder, satu.name);
    if (pola && !pola.test(satu.name)) continue;
    let info;
    try { info = fs.statSync(jalur); } catch { continue; }
    hasil.push({ jalur, nama: satu.name, byte: satu.isDirectory() ? 0 : info.size, mtime: info.mtimeMs, folder: satu.isDirectory() });
  }
  return hasil;
}

function ukurFolder(jalur) {
  let total = 0;
  const tumpuk = [jalur];
  while (tumpuk.length) {
    const kini = tumpuk.pop();
    let isi = [];
    try { isi = fs.readdirSync(kini, { withFileTypes: true }); } catch { continue; }
    for (const satu of isi) {
      const penuh = path.join(kini, satu.name);
      if (satu.isDirectory()) tumpuk.push(penuh);
      else { try { total += fs.statSync(penuh).size; } catch { /* hilang */ } }
    }
  }
  return total;
}

/**
 * Rencana pembersihan TANPA menghapus apa pun. Setiap item membawa alasannya,
 * jadi `sakti bersih` bisa menampilkan bukti sebelum bertindak.
 */
export function pindaiSampah(opsi = {}) {
  const batas = Object.assign({}, BATAS_BAWAAN, opsi.batas || {});
  const sekarang = Number(opsi.sekarang) || Date.now();
  const umurMs = Math.max(1, Number(batas.umurJam) || BATAS_BAWAAN.umurJam) * JAM;
  const item = [];
  const tambah = (jenis, jalur, byte, alasan) => item.push({ jenis, jalur, byte: Number(byte) || 0, alasan });

  // 1. Spill: simpan yang terbaru, buang yang tua/berlebih.
  const spill = daftarBerkas(folderSpill(), /^\d+-[a-z0-9]+\.txt$/).sort((a, b) => b.mtime - a.mtime);
  spill.forEach((satu, i) => {
    if (i >= batas.spillBatas) tambah('spill', satu.jalur, satu.byte, 'di luar ' + batas.spillBatas + ' spill terbaru');
    else if (sekarang - satu.mtime > umurMs) tambah('spill', satu.jalur, satu.byte, 'lebih tua dari ' + batas.umurJam + ' jam');
  });

  // 2. Checkpoint: yatim (catatan hilang), terlalu tua, di luar batas, atau
  //    total byte kelewat besar -> buang yang paling lama dulu.
  const data = khazanahTerbaca();
  if (!data.ok) {
    // Khazanah tidak terbaca: JANGAN tebak folder mana yang yatim. Dulu daftar
    // kosong membuat semua cadangan dihapus saat startup.
    tambah('khazanah', berkasKhazanah(), 0, 'khazanah tidak terbaca (' + data.galat + '); checkpoint tidak dipindai');
  }
  const catat = data.ok && Array.isArray(data.data.checkpoint) ? data.data.checkpoint : [];
  const dikenal = new Set(catat.map((satu) => String(satu && satu.id)));
  const folder = folderCkp();
  const salinan = data.ok ? daftarBerkas(folder).filter((satu) => satu.folder) : [];
  const yatim = salinan.filter((satu) => !dikenal.has(satu.nama));
  for (const satu of yatim) tambah('checkpoint', satu.jalur, ukurFolder(satu.jalur), 'yatim: tidak ada di khazanah.json');

  const hidup = salinan.filter((satu) => dikenal.has(satu.nama))
    .map((satu) => Object.assign({}, satu, { byte: ukurFolder(satu.jalur) }))
    .sort((a, b) => a.mtime - b.mtime); // terlama dulu
  let totalByte = hidup.reduce((n, satu) => n + satu.byte, 0);
  const buang = new Set();
  hidup.forEach((satu, i) => {
    const sisa = hidup.length - i;
    const alasan = sisa > batas.ckpBatas ? 'di luar ' + batas.ckpBatas + ' checkpoint terbaru'
      : (sekarang - satu.mtime > umurMs * 2 ? 'lebih tua dari ' + Math.round(batas.umurJam * 2 / 24) + ' hari'
        : '');
    if (alasan) { buang.add(satu.nama); totalByte -= satu.byte; tambah('checkpoint', satu.jalur, satu.byte, alasan); }
  });
  for (const satu of hidup) {
    if (buang.has(satu.nama)) continue;
    if (totalByte <= batas.ckpByte) break;
    buang.add(satu.nama);
    totalByte -= satu.byte;
    tambah('checkpoint', satu.jalur, satu.byte, 'total checkpoint > ' + Math.round(batas.ckpByte / MB) + ' MB');
  }

  // 3. Dump DB jaringan: simpan 10 terbaru, sisanya (atau yang tua) dibuang.
  const folderDump = path.join(path.dirname(berkasKhazanah()), 'dbbackup');
  const dump = daftarBerkas(folderDump, /\.sql$/).sort((a, b) => b.mtime - a.mtime);
  dump.forEach((satu, i) => {
    if (i >= batas.dbBatas) tambah('dbbackup', satu.jalur, satu.byte, 'di luar ' + batas.dbBatas + ' cadangan DB terbaru');
    else if (sekarang - satu.mtime > umurMs) tambah('dbbackup', satu.jalur, satu.byte, 'lebih tua dari ' + batas.umurJam + ' jam');
  });

  // 4. Log paket harian: satu berkas per hari, tidak boleh tumbuh selamanya.
  const folderLog = process.env.SAKTI_CLI_LOG || path.join(path.dirname(berkasKhazanah()), 'log');
  const log = daftarBerkas(folderLog, /^paket-\d{4}-\d{2}-\d{2}\.jsonl$/).sort((a, b) => b.mtime - a.mtime);
  log.forEach((satu, i) => {
    if (i >= batas.logBatas) tambah('log', satu.jalur, satu.byte, 'di luar ' + batas.logBatas + ' log terbaru');
    else if (sekarang - satu.mtime > (Number(batas.logHari) || 30) * 24 * JAM) tambah('log', satu.jalur, satu.byte, 'lebih tua dari ' + batas.logHari + ' hari');
  });

  // 5. Sisa tulis state.
  const stateFolder = folderState();
  for (const satu of daftarBerkas(stateFolder, /\.tmp-\d+$/)) {
    if (sekarang - satu.mtime > (Number(batas.tmpJam) || 1) * JAM) tambah('state', satu.jalur, satu.byte, 'sisa tulis yang mati');
  }
  for (const satu of daftarBerkas(stateFolder, /\.rusak-\d+/)) {
    if (sekarang - satu.mtime > (Number(batas.rusakHari) || 30) * 24 * JAM) tambah('state', satu.jalur, satu.byte, 'state rusak lama');
  }

  const perJenis = {};
  for (const satu of item) perJenis[satu.jenis] = (perJenis[satu.jenis] || 0) + 1;
  return {
    item,
    jumlah: item.length,
    byte: item.reduce((n, satu) => n + satu.byte, 0),
    perJenis,
    // pindai = pratinjau: ringkasSampah memakai ini untuk menuliskannya.
    kering: true,
    folder: { spill: folderSpill(), ckp: folder, state: stateFolder }
  };
}

/**
 * Jalankan pembersihan. `kering: true` hanya memindai (dipakai `sakti bersih`
 * tanpa --hapus). Catatan checkpoint yang berkasnya dihapus ikut dibuang dari
 * khazanah.json, di dalam kunci berkas yang sama dengan penulis lain.
 */
export function sapuSampah(opsi = {}) {
  const rencana = pindaiSampah(opsi);
  if (opsi.kering) return Object.assign({ dihapus: 0, gagal: [], kering: true }, rencana);
  let dihapus = 0;
  let byte = 0;
  const gagal = [];
  const hapusCkp = [];
  for (const satu of rencana.item) {
    // Entri 'khazanah' hanya peringatan (JSON tidak terbaca), bukan sampah.
    if (satu.jenis === 'khazanah') { gagal.push(satu.alasan); continue; }
    try {
      if (satu.jenis === 'checkpoint') fs.rmSync(satu.jalur, { recursive: true, force: true });
      else fs.unlinkSync(satu.jalur);
      dihapus += 1;
      byte += satu.byte;
      if (satu.jenis === 'checkpoint') hapusCkp.push(path.basename(satu.jalur));
    } catch (galat) {
      gagal.push(satu.jalur + ': ' + String((galat && galat.message) || galat));
    }
  }
  if (hapusCkp.length) {
    const buang = new Set(hapusCkp);
    try {
      kunciBerkas(berkasKhazanah(), () => {
        const data = bacaKhazanah();
        const baru = (data.checkpoint || []).filter((satu) => !buang.has(String(satu && satu.id)));
        if (baru.length !== (data.checkpoint || []).length) { data.checkpoint = baru; tulisKhazanah(data); }
      });
    } catch { /* catatan boleh basi; berkasnya sudah hilang */ }
  }
  return { dihapus, byte, gagal, kering: false, jumlah: rencana.jumlah, perJenis: rencana.perJenis, item: rencana.item, folder: rencana.folder };
}

/** Satu baris untuk TUI/CLI: apa yang dibersihkan dan berapa besar. */
export function ringkasSampah(hasil = {}) {
  const jumlah = Number(hasil.dihapus || hasil.jumlah || 0);
  if (!jumlah) return 'bersih: tidak ada sampah';
  const mb = (Number(hasil.byte) || 0) / MB;
  const ukuran = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round((Number(hasil.byte) || 0) / 1024)) + ' KiB';
  const rinci = Object.entries(hasil.perJenis || {}).map(([jenis, n]) => jenis + ' ' + n).join(' · ');
  return 'bersih: ' + jumlah + ' berkas · ' + ukuran + (rinci ? ' (' + rinci + ')' : '') + (hasil.kering ? ' · pratinjau' : '');
}
