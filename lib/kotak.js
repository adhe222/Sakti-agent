// Kotak pesan antar-bot: setiap pesan punya id, pengirim, penerima, jenis,
// balasKe, tugasId, dan status. Disimpan di state.json (`kotak[sesi]`) supaya
// tahan restart dan bisa diperiksa manusia.
//
// Ini meniru pola yang terbukti di Grok Bot (APK): pesan room membawa
// `sentByAgentId`, tugas punya `taskId` yang bisa dibaca/ditandai selesai, dan
// hasil kerja "landed" tanpa harus ditunggu di giliran yang sama. Bedanya di
// sini semuanya lokal: tidak ada server, tidak ada socket.

import { bacaState, ubahState } from './lokal.js';

export const JENIS_PESAN = ['info', 'tugas', 'hasil', 'tanya', 'jawab'];
export const STATUS_PESAN = ['baru', 'dibaca', 'antre', 'dikerjakan', 'selesai', 'gagal'];
const MAKS_PESAN = 200;
/** Batas teks satu pesan antar-bot: dipotong, bukan ditolak. */
export const MAKS_TEKS_PESAN = 8000;

const teks = (nilai) => String(nilai == null ? '' : nilai).trim();

/** Kunci sesi: pesan tanpa sesi masuk ke kotak 'global'. */
export function kunciSesi(sesiId) {
  return teks(sesiId) || 'global';
}

/** ID pesan/tugas: pendek, urut waktu, cukup unik untuk satu mesin.
 * Ekor acak 8 karakter: 3 karakter (36^3) terlalu mudah tabrakan dalam ms sama. */
export function idPesan(awalan = 'm') {
  return awalan + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function kotakSesi(state, sesi) {
  state.kotak = state.kotak && typeof state.kotak === 'object' ? state.kotak : {};
  const kunci = kunciSesi(sesi);
  state.kotak[kunci] = Array.isArray(state.kotak[kunci]) ? state.kotak[kunci] : [];
  return state.kotak[kunci];
}

/** Pangkas per sesi; pesan lama dibuang, bukan seluruh kotak. */
function rapikan(daftar) {
  if (daftar.length > MAKS_PESAN) daftar.splice(0, daftar.length - MAKS_PESAN);
  return daftar;
}

/**
 * Kirim satu pesan ke satu/beberapa bot. `id` yang sama tidak menambah duplikat
 * (idempoten) - penting karena model bisa mengulang panggilan alat yang sama.
 */
export function kirimPesan({
  sesi = 'global', dari = 'pengguna', ke, teks: isi, jenis = 'info',
  balasKe = '', tugasId = '', id = ''
} = {}) {
  const isiBersih = teks(isi).slice(0, MAKS_TEKS_PESAN);
  if (!isiBersih) throw new Error('pesan kosong');
  const tujuan = (Array.isArray(ke) ? ke : [ke]).map(teks).filter(Boolean);
  if (!tujuan.length) throw new Error('penerima kosong');
  const pesanId = teks(id) || idPesan();
  return ubahState((state) => {
    const daftar = kotakSesi(state, sesi);
    const ada = daftar.find((row) => row.id === pesanId);
    if (ada) return ada;
    const row = {
      id: pesanId,
      sesi: kunciSesi(sesi),
      dari: teks(dari) || 'pengguna',
      ke: tujuan,
      jenis: JENIS_PESAN.includes(jenis) ? jenis : 'info',
      teks: isiBersih,
      balasKe: teks(balasKe),
      tugasId: teks(tugasId),
      status: 'baru',
      at: Date.now()
    };
    daftar.push(row);
    rapikan(daftar);
    return row;
  });
}

/** Daftar pesan satu sesi, urut lama -> baru. */
export function daftarPesan(sesi = 'global', { untuk = '', status = '', jenis = '', tugasId = '', batas = 20 } = {}) {
  const state = bacaState();
  const daftar = kotakSesi(state, sesi);
  const nama = teks(untuk);
  const statusFilter = teks(status);
  const jenisFilter = teks(jenis);
  const tugasFilter = teks(tugasId);
  return daftar
    .filter((row) => (!nama || (row.ke || []).includes(nama)))
    .filter((row) => (!statusFilter || row.status === statusFilter))
    .filter((row) => (!jenisFilter || row.jenis === jenisFilter))
    .filter((row) => (!tugasFilter || row.tugasId === tugasFilter))
    .slice(-Math.max(0, Math.floor(Number(batas) || 20)));
}

/** Semua record tugas dengan tugasId tertentu (satu record per bot). */
export function cariTugas(sesi = 'global', tugasId = '') {
  return daftarPesan(sesi, { tugasId, batas: MAKS_PESAN });
}

/** Ubah status pesan/tugas. Tidak pernah melempar untuk id yang hilang. */
export function ubahStatus(sesi = 'global', id = '', status = '', { hasil = '' } = {}) {
  const baru = teks(status);
  if (!STATUS_PESAN.includes(baru)) throw new Error('status tidak dikenal: ' + status);
  return ubahState((state) => {
    const daftar = kotakSesi(state, sesi);
    const row = daftar.find((satu) => satu.id === teks(id));
    if (!row) return null;
    row.status = baru;
    if (baru === 'dibaca' && !row.dibacaAt) row.dibacaAt = Date.now();
    // Jejak pemilik: dipakai `pulihkanTerputus` membedakan tugas yang masih
    // dikerjakan proses hidup dari sisa proses yang sudah mati.
    if (baru === 'dikerjakan') { row.mulaiAt = Date.now(); row.pid = process.pid; }
    if (baru === 'selesai' || baru === 'gagal') row.selesaiAt = Date.now();
    if (hasil !== '') row.hasil = teks(hasil).slice(0, 4000);
    return row;
  });
}

function pidHidup(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * Tutup record `dikerjakan` yang ditinggal proses mati: tanpa `pid`/`mulaiAt`
 * (format lama), pemiliknya tidak hidup lagi, atau umurnya melewati `batasMs`.
 * Ditandai `gagal` dengan alasan `terputus`. Mengembalikan jumlah yang ditutup.
 */
export function pulihkanTerputus(sesi = 'global', { batasMs = 900000, sekarang = Date.now() } = {}) {
  return ubahState((state) => {
    const daftar = kotakSesi(state, sesi);
    let jumlah = 0;
    for (const row of daftar) {
      if (row.status !== 'dikerjakan') continue;
      const mulai = Number(row.mulaiAt) || 0;
      const kedaluwarsa = mulai > 0 && sekarang - mulai > batasMs;
      const yatim = !mulai || !pidHidup(row.pid);
      if (!kedaluwarsa && !yatim) continue;
      row.status = 'gagal';
      row.selesaiAt = sekarang;
      row.hasil = 'terputus: ' + (kedaluwarsa ? 'melewati batas waktu ' + Math.round(batasMs / 1000) + 's' : 'proses pemilik sudah mati');
      jumlah += 1;
    }
    return jumlah;
  });
}

/** Tandai semua pesan 'baru' untuk satu penerima sebagai 'dibaca'. */
export function tandaiDibaca(sesi = 'global', untuk = '') {
  const nama = teks(untuk);
  if (!nama) return 0;
  return ubahState((state) => {
    const daftar = kotakSesi(state, sesi);
    let jumlah = 0;
    for (const row of daftar) {
      if (row.status === 'baru' && (row.ke || []).includes(nama)) {
        row.status = 'dibaca';
        row.dibacaAt = Date.now();
        jumlah += 1;
      }
    }
    return jumlah;
  });
}

/**
 * Tandai HANYA id yang benar-benar dimasukkan prompt sebagai 'dibaca'.
 * `ringkasKotak` memotong ke `batas` baris; memakai `tandaiDibaca` (semua)
 * membuat pesan ke-6 dan seterusnya hilang tanpa pernah dibaca bot.
 */
export function tandaiDibacaIds(sesi = 'global', ids = []) {
  const kumpulan = new Set((Array.isArray(ids) ? ids : []).map(teks).filter(Boolean));
  if (!kumpulan.size) return 0;
  return ubahState((state) => {
    const daftar = kotakSesi(state, sesi);
    let jumlah = 0;
    for (const row of daftar) {
      if (row.status === 'baru' && kumpulan.has(row.id)) {
        row.status = 'dibaca';
        row.dibacaAt = Date.now();
        jumlah += 1;
      }
    }
    return jumlah;
  });
}

/** Balas pesan: penerima = pengirim asli, membawa balasKe + tugasId. */
export function balasPesan(sesi = 'global', id = '', { dari = 'pengguna', teks: isi = '', jenis = 'jawab' } = {}) {
  const induk = daftarPesan(sesi, { batas: MAKS_PESAN }).find((row) => row.id === teks(id));
  if (!induk) throw new Error('pesan tidak ditemukan: ' + id);
  return kirimPesan({
    sesi,
    dari,
    ke: induk.dari,
    teks: isi,
    jenis,
    balasKe: induk.id,
    tugasId: induk.tugasId
  });
}

function satuBaris(row, { panjang = 160 } = {}) {
  const isi = String(row.teks || '').replace(/\s+/g, ' ').slice(0, panjang);
  const ke = (row.ke || []).join(',');
  return '[' + row.id + '] ' + row.jenis + ' · ' + row.dari + ' -> ' + ke + ' · ' + row.status
    + (row.balasKe ? ' · balas ' + row.balasKe : '')
    + ' · ' + isi;
}

/** Baris untuk manusia (CLI/panel). */
export function ringkasPesan(rows = []) {
  const daftar = Array.isArray(rows) ? rows : [];
  return daftar.length ? daftar.map((row) => satuBaris(row)).join('\n') : '(kotak kosong)';
}

/**
 * Ringkasan pesan BELUM DIBACA untuk satu bot, plus menandainya dibaca.
 * Dipakai sebelum giliran bot supaya pesan antar-bot benar-benar sampai, bukan
 * hanya tersimpan. Dibatasi pendek agar tidak membanjiri prompt.
 */
export function ringkasKotak(sesi = 'global', untuk = '', { batas = 5, tandai = true } = {}) {
  const nama = teks(untuk);
  if (!nama) return '';
  const rows = daftarPesan(sesi, { untuk: nama, status: 'baru', batas });
  if (!rows.length) return '';
  const isi = rows.map((row) => '- [' + row.id + '] dari ' + row.dari + ' (' + row.jenis + ')' + (row.balasKe ? ' balasan ' + row.balasKe : '') + ': ' + String(row.teks || '').replace(/\s+/g, ' ').slice(0, 240)).join('\n');
  if (tandai) tandaiDibacaIds(sesi, rows.map((row) => row.id));
  return 'PESAN MASUK dari rekan bot (' + (tandai ? 'sudah ditandai dibaca' : 'ditandai dibaca setelah giliran sukses') + '):\n' + isi
    + '\nBalas dengan alat "kotak" aksi=balas, atau tandai selesai dengan aksi=selesai.';
}

/** Id pesan 'baru' untuk satu bot, TANPA menandai dibaca. Dipasangkan dgn
 * ringkasKotak({tandai:false}): penandaan ditunda sampai giliran sukses,
 * supaya panggilan model yang gagal tidak memakan pesan rekan. */
export function idKotakBaru(sesi = 'global', untuk = '', { batas = 5 } = {}) {
  const nama = teks(untuk);
  if (!nama) return [];
  const rows = daftarPesan(sesi, { untuk: nama, status: 'baru', batas });
  return rows.map((row) => row.id);
}

/** Kosongkan satu kotak sesi (dipakai uji dan pembersihan manual). */
export function kosongkanKotak(sesi = 'global') {
  const kunci = kunciSesi(sesi);
  ubahState((state) => {
    if (state.kotak && Array.isArray(state.kotak[kunci])) state.kotak[kunci] = [];
  });
  return kunci;
}
