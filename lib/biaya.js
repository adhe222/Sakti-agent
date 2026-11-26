// Biaya token: angka usage dari endpoint dicatat supaya bisa dilihat dan diuji.
// Sebelumnya `usage` sudah dikembalikan model.js tapi tidak pernah dibaca siapa
// pun, jadi pemakaian token tidak kelihatan.
//
// Perkiraan (tanpa usage dari endpoint) memakai 4 karakter per token - cukup
// untuk "kira-kira sebesar apa prompt ini".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderProfil, kunciBerkas } from './lokal.js';

export function berkasBiaya() {
  return process.env.SAKTI_CLI_BIAYA || path.join(folderProfil(), 'biaya.json');
}

const KOSONG = () => ({ total: { prompt: 0, completion: 0, giliran: 0 }, sesi: {}, riwayat: [] });

export function bacaBiaya() {
  try {
    const isi = JSON.parse(fs.readFileSync(berkasBiaya(), 'utf8'));
    if (!isi || typeof isi !== 'object') return KOSONG();
    const dasar = KOSONG();
    const total = Object.assign(dasar.total, isi.total || {});
    // Berkas tulisan tangan bisa memuat angka sebagai string; tanpa normalisasi
    // `total.prompt += 5` menjadi "05" dan angka membesar tanpa batas.
    for (const kunci of ['prompt', 'completion', 'giliran']) total[kunci] = angka(total[kunci]);
    return { total, sesi: isi.sesi || {}, riwayat: Array.isArray(isi.riwayat) ? isi.riwayat : [] };
  } catch {
    // JSON rusak: cadangkan dulu - riwayat biaya jangan lenyap tanpa jejak.
    try {
      const sumber = berkasBiaya();
      if (fs.existsSync(sumber)) fs.renameSync(sumber, sumber + '.rusak-' + Date.now());
    } catch { /* berkas sudah tidak ada */ }
    return KOSONG();
  }
}

export function tulisBiaya(data) {
  const berkas = berkasBiaya();
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  // Rename atomik seperti tulisState: pembaca tidak boleh melihat JSON separuh.
  const sementara = berkas + '.tmp-' + process.pid;
  fs.writeFileSync(sementara, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(sementara, berkas);
  try { fs.chmodSync(berkas, 0o600); } catch { /* filesystem tanpa chmod */ }
  return berkas;
}

const angka = (nilai) => (Number.isFinite(Number(nilai)) ? Number(nilai) : 0);

/** Perkiraan token satu teks (kalau endpoint tidak melaporkan usage). */
export const kiraToken = (teks) => Math.ceil(String(teks == null ? '' : teks).length / 4);

/** Perkiraan token satu daftar pesan gaya chat. */
export function kiraPesan(messages) {
  return (messages || []).reduce((n, row) => {
    const isi = typeof row.content === 'string' ? row.content : JSON.stringify(row.content || '');
    return n + 4 + kiraToken(isi);
  }, 0);
}

/** Catat satu panggilan model. `usage` boleh null -> dipakai perkiraan. */
export function catat({ sesiId = '-', model = '-', usage = null, perkiraan = 0 } = {}) {
  const pakaiUsage = usage && (usage.prompt_tokens != null || usage.input_tokens != null);
  const prompt = pakaiUsage ? angka(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) : angka(perkiraan);
  const completion = pakaiUsage ? angka(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) : 0;
  // Baca → tambah → tulis harus di dalam kunci: `sakti serve` + TUI menulis
  // berkas yang sama, dan tanpa kunci hitungan giliran/token hilang.
  kunciBerkas(berkasBiaya(), () => {
    const data = bacaBiaya();
    data.total.prompt += prompt;
    data.total.completion += completion;
    data.total.giliran += 1;
    const lama = data.sesi[String(sesiId)] || { prompt: 0, completion: 0, giliran: 0 };
    data.sesi[String(sesiId)] = {
      prompt: angka(lama.prompt) + prompt,
      completion: angka(lama.completion) + completion,
      giliran: angka(lama.giliran) + 1
    };
    data.riwayat = data.riwayat.concat([{ at: Date.now(), sesi: String(sesiId), model, prompt, completion, perkiraan: !pakaiUsage }]).slice(-200);
    tulisBiaya(data);
  });
  return { prompt, completion, perkiraan: !pakaiUsage };
}

/**
 * Statistik pemakaian per model + per hari (opencode `stats`): angka yang
 * dipakai menjawab "model mana yang boros" dan "hari mana yang meledak".
 * Dihitung dari `riwayat` (200 panggilan terakhir) supaya berkas tidak perlu
 * format baru; `hari` = 0 -> semua baris.
 */
export function statistikBiaya({ hari = 0, sekarang = Date.now() } = {}) {
  const data = bacaBiaya();
  const batas = hari > 0 ? sekarang - hari * 86400000 : 0;
  const rows = data.riwayat
    .filter((row) => row && typeof row === 'object')
    .filter((row) => !batas || Number(row.at) >= batas);
  const model = new Map();
  const perHari = new Map();
  const jumlah = { prompt: 0, completion: 0, giliran: rows.length };
  // Tanggal LOKAL, bukan `toISOString()` (UTC): pemilik di UTC+8 melihat
  // panggilan pukul 07.00 masuk ke "hari kemarin".
  const tanggalLokal = (ms) => {
    const d = new Date(Number(ms) || 0);
    const dua = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + dua(d.getMonth() + 1) + '-' + dua(d.getDate());
  };
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const nama = String(row.model || '-');
    const m = model.get(nama) || { model: nama, prompt: 0, completion: 0, giliran: 0 };
    m.prompt += angka(row.prompt); m.completion += angka(row.completion); m.giliran += 1;
    model.set(nama, m);
    const tanggal = tanggalLokal(row.at);
    const h = perHari.get(tanggal) || { hari: tanggal, prompt: 0, completion: 0, giliran: 0 };
    h.prompt += angka(row.prompt); h.completion += angka(row.completion); h.giliran += 1;
    perHari.set(tanggal, h);
    jumlah.prompt += angka(row.prompt); jumlah.completion += angka(row.completion);
  }
  return {
    hari,
    jumlah,
    total: data.total,
    model: [...model.values()].sort((a, b) => (b.prompt + b.completion) - (a.prompt + a.completion)),
    perHari: [...perHari.values()].sort((a, b) => (a.hari < b.hari ? 1 : -1))
  };
}

/** Ringkas untuk `/biaya`. `hari` = tampilkan statistik per model/hari. */
export function ringkasBiaya(sesiId = null, { hari = 0 } = {}) {
  const data = bacaBiaya();
  const angkakan = (n) => String(angka(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const baris = [];
  if (sesiId) {
    const sesi = data.sesi[String(sesiId)] || { prompt: 0, completion: 0, giliran: 0 };
    baris.push('sesi ini   : ' + angkakan(sesi.prompt) + ' masuk · ' + angkakan(sesi.completion) + ' keluar · ' + sesi.giliran + ' panggilan');
  }
  baris.push('total      : ' + angkakan(data.total.prompt) + ' masuk · ' + angkakan(data.total.completion) + ' keluar · ' + data.total.giliran + ' panggilan');
  if (hari > 0) {
    const stat = statistikBiaya({ hari });
    baris.push('periode    : ' + hari + ' hari terakhir · ' + stat.jumlah.giliran + ' panggilan · ' + angkakan(stat.jumlah.prompt) + ' masuk · ' + angkakan(stat.jumlah.completion) + ' keluar');
    if (stat.model.length) {
      baris.push('per model  :');
      for (const m of stat.model.slice(0, 8)) baris.push('  ' + m.model.slice(0, 28).padEnd(28) + ' ' + angkakan(m.prompt) + ' masuk · ' + angkakan(m.completion) + ' keluar · ' + m.giliran + ' panggilan');
    }
    if (stat.perHari.length) {
      baris.push('per hari   :');
      for (const h of stat.perHari.slice(0, 8)) baris.push('  ' + h.hari + '  ' + angkakan(h.prompt) + ' masuk · ' + angkakan(h.completion) + ' keluar · ' + h.giliran + ' panggilan');
    }
    baris.push('catatan    : statistik dari ' + data.riwayat.length + ' panggilan terakhir yang masih tersimpan');
  }
  const terakhir = data.riwayat.filter((row) => row && typeof row === 'object' && Number(row.at) > 0).slice(-5).reverse();
  if (terakhir.length) {
    baris.push('5 terakhir :');
    for (const row of terakhir) baris.push('  ' + new Date(Number(row.at)).toISOString().slice(11, 19) + '  ' + String(row.model).slice(0, 26) + '  ' + angka(row.prompt) + '+' + angka(row.completion) + (row.perkiraan ? ' ~' : ''));
  }
  baris.push('berkas     : ' + berkasBiaya());
  return baris.join('\n');
}

/** Satu baris kecil untuk ditempel di akhir giliran. */
export function barisBiaya({ prompt = 0, completion = 0, perkiraan = false } = {}) {
  if (!prompt && !completion) return '';
  return (perkiraan ? '~' : '') + prompt + '+' + completion + ' token';
}

export function kosongkanBiaya() {
  kunciBerkas(berkasBiaya(), () => tulisBiaya(KOSONG()));
  return berkasBiaya();
}
