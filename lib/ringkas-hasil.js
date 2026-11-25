// Ringkasan hasil alat untuk TUI/CLI: satu baris padat yang menjawab "apa yang
// terjadi" tanpa membuka seluruh keluaran - status (exit/timeout), ukuran,
// jumlah temuan, dan durasi. MURNI (tanpa I/O, tanpa jam) supaya bisa diuji.
//
// Kenapa ada: dulu TUI hanya menampilkan baris pertama keluaran dan menebak
// gagal dari awalan baris itu saja. Keluaran 300 baris tampil sebagai 10 baris
// pertama tanpa keterangan berapa yang disembunyikan, dan galat yang muncul di
// tengah keluaran (mis. `Traceback` setelah 80 baris build) diwarnai hijau.

import { angkaRingkas } from './status.js';

/** Alat yang keluarannya `ringkasShell` (diawali `OK ` atau `GAGAL (kode) `). */
export const ALAT_SHELL = new Set(['terminal', 'jalankan', 'py', 'uji']);

/** Kegagalan yang dinyatakan alat sendiri di AWAL hasil (bukan tebakan). */
const RE_GAGAL_AWAL = /^(GAGAL|DITOLAK|alat tidak dikenal|berhenti:|tidak bisa|menolak|bukan berkas teks|bukan repo|path tidak ada)/i;
/** Penanda kegagalan yang sah di mana pun untuk alat shell. */
const RE_GAGAL_SHELL = /^GAGAL \(\d+\)/m;
const RE_TIMEOUT = /dihentikan karena batas waktu|timeout setelah \d+/i;

/** Kode keluar yang dilaporkan `ringkasShell`, atau null kalau tidak ada. */
export function kodeKeluar(isi) {
  const teks = String(isi == null ? '' : isi);
  const gagal = /^GAGAL \((\d+)\)/m.exec(teks);
  if (gagal) return Number(gagal[1]);
  if (/^OK /m.test(teks)) return 0;
  return null;
}

/**
 * Gagal atau tidak, plus alasannya. Hanya memakai bukti yang benar-benar
 * ditulis alat: awalan status, `GAGAL (kode)`, timeout. Tidak menebak dari kata
 * "error" di dalam keluaran - berkas sumber yang dibaca boleh memuat kata itu.
 */
export function deteksiGagal(nama, isi) {
  const teks = String(isi == null ? '' : isi);
  if (!teks) return { gagal: false, alasan: '' };
  if (RE_GAGAL_AWAL.test(teks)) {
    const kode = /^GAGAL \((\d+)\)/.exec(teks);
    return { gagal: true, alasan: kode ? 'exit ' + kode[1] : teks.split('\n')[0].slice(0, 60) };
  }
  if (ALAT_SHELL.has(nama)) {
    if (RE_GAGAL_SHELL.test(teks)) {
      return { gagal: true, alasan: 'exit ' + kodeKeluar(teks) };
    }
    if (RE_TIMEOUT.test(teks)) return { gagal: true, alasan: 'timeout' };
  }
  return { gagal: false, alasan: '' };
}

/** Hitung temuan `cari` (baris `berkas:baris:isi`) tanpa menghitung ringkasan. */
function hitungCocok(daftarBaris) {
  let n = 0;
  for (const baris of daftarBaris) if (/^\S.*:\d+:/.test(baris)) n += 1;
  return n;
}

/** Baris `+`/`-` sebuah diff (header `+++`/`---` tidak dihitung). */
function hitungDiff(daftarBaris) {
  let tambah = 0;
  let buang = 0;
  for (const baris of daftarBaris) {
    if (/^\+\+\+/.test(baris) || /^---/.test(baris)) continue;
    if (/^\+/.test(baris)) tambah += 1;
    else if (/^-/.test(baris)) buang += 1;
  }
  return { tambah, buang };
}

/** `42ms`, `1.2s`, `2m 5s` - sama dengan bilah status. */
export function durasiRingkas(ms) {
  const kasar = Math.max(0, Math.round(Number(ms) || 0));
  if (!kasar) return '';
  if (kasar < 1000) return kasar + 'ms';
  const dtk = kasar / 1000;
  if (dtk < 60) return dtk.toFixed(1) + 's';
  const menit = Math.floor(dtk / 60);
  const sisa = Math.round(dtk % 60);
  return menit + 'm' + (sisa ? ' ' + sisa + 's' : '');
}

/**
 * Potong daftar baris jadi kepala + ekor. Ekor penting: baris terakhir keluaran
 * shell hampir selalu yang menentukan (`exit`, `FAIL`, ringkasan uji), dan dulu
 * itulah yang pertama dibuang.
 */
export function bagiHasil(daftarBaris, batas = 10) {
  const daftar = Array.isArray(daftarBaris) ? daftarBaris : String(daftarBaris == null ? '' : daftarBaris).split('\n');
  const n = Math.max(2, Math.floor(Number(batas) || 10));
  if (daftar.length <= n) return { kepala: daftar, ekor: [], dilewati: 0 };
  const ekorN = Math.max(1, Math.min(3, Math.floor(n / 4)));
  const kepalaN = n - ekorN;
  return {
    kepala: daftar.slice(0, kepalaN),
    ekor: daftar.slice(daftar.length - ekorN),
    dilewati: daftar.length - kepalaN - ekorN
  };
}

/**
 * Ringkasan satu hasil alat: { label, gagal, alasan, baris, karakter, exit }.
 * `label` = satu baris pendek siap tampil, mis. `exit 0 · 42 baris · 118ms`.
 */
export function ringkasHasil(nama, isi, { ms = 0 } = {}) {
  const teks = String(isi == null ? '' : isi).replace(/\s+$/, '');
  const daftar = teks ? teks.split('\n') : [];
  const { gagal, alasan } = deteksiGagal(nama, teks);
  const bagian = [];
  let exit = null;

  if (ALAT_SHELL.has(nama)) {
    exit = kodeKeluar(teks);
    if (exit !== null) bagian.push('exit ' + exit);
    if (RE_TIMEOUT.test(teks)) bagian.push('timeout');
  } else if (nama === 'cari' && daftar.length) {
    const cocok = hitungCocok(daftar);
    if (cocok) bagian.push(cocok + ' cocok');
  } else if (nama === 'edit' && daftar.length) {
    const { tambah, buang } = hitungDiff(daftar);
    if (tambah || buang) bagian.push('+' + tambah + ' −' + buang);
  } else if (nama === 'daftar' && daftar.length) {
    bagian.push(daftar.length + ' entri');
  }

  if (daftar.length) {
    bagian.push(daftar.length + ' baris');
    bagian.push(angkaRingkas(teks.length) + ' kar');
  } else {
    bagian.push('kosong');
  }
  const waktu = durasiRingkas(ms);
  if (waktu) bagian.push(waktu);

  return {
    nama: String(nama || ''),
    label: bagian.join(' · '),
    gagal,
    alasan,
    baris: daftar.length,
    karakter: teks.length,
    exit,
    daftar
  };
}
