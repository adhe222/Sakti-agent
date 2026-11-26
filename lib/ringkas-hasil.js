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

/**
 * Ringkasan alat ubah_diri / pasang_alat dari keluaran baku alat.js (Eny):
 * `USUL OK|GAGAL id=..` + `uji: exit N` + diff, `TERAPKAN|KEMBALIKAN OK id=..` +
 * `berkas: a, b`, `PASANG OK|GAGAL <mesin> <nama>` + `kode: N`.
 * Hasil { teks, gagal, alasan } atau null bila format tidak dikenali.
 */
function ringkasDiri(nama, daftar) {
  const kepala = daftar[0] || '';
  if (nama === 'ubah_diri') {
    let m = /^USUL (OK|GAGAL) id=(\S+)/.exec(kepala);
    if (m) {
      const uji = daftar.map((b) => /^uji: exit (-?\d+)/.exec(b)).find(Boolean);
      const kode = uji ? uji[1] : '?';
      const berkas = daftar.filter((b) => /^\+\+\+ /.test(b)).length;
      return {
        teks: 'usulan ' + m[2] + ' · uji kode ' + kode + ' · ' + berkas + ' berkas',
        gagal: m[1] === 'GAGAL',
        alasan: m[1] === 'GAGAL' ? 'uji kode ' + kode : ''
      };
    }
    m = /^(TERAPKAN|KEMBALIKAN) (OK|GAGAL) id=([^\s:]+)/.exec(kepala);
    if (m) {
      const kata = m[1] === 'TERAPKAN' ? 'diterapkan' : 'dikembalikan';
      if (m[2] === 'GAGAL') return { teks: 'gagal ' + m[1].toLowerCase() + ' ' + m[3], gagal: true, alasan: kepala.split(': ').slice(1).join(': ').slice(0, 60) };
      const daftarBerkas = daftar.map((b) => /^berkas(?: dipulihkan)?: (.+)/.exec(b)).find(Boolean);
      const n = daftarBerkas ? daftarBerkas[1].split(',').filter((s) => s.trim()).length : 0;
      return { teks: kata + ' ' + m[3] + ' · ' + n + ' berkas', gagal: false, alasan: '' };
    }
    return null;
  }
  if (nama === 'pasang_alat') {
    const m = /^PASANG (OK|GAGAL) \S+ (\S+)/.exec(kepala);
    if (!m) return null;
    const kodeM = daftar.map((b) => /^kode: (-?\d+)/.exec(b)).find(Boolean);
    const kode = kodeM ? kodeM[1] : '?';
    if (m[1] === 'GAGAL') return { teks: 'gagal pasang ' + m[2] + ' · kode ' + kode, gagal: true, alasan: 'kode ' + kode };
    return { teks: (/sudah ada/.test(kepala) ? 'sudah ada ' : 'terpasang ') + m[2], gagal: false, alasan: '' };
  }
  return null;
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
  let { gagal, alasan } = deteksiGagal(nama, teks);
  const bagian = [];
  let exit = null;
  const diri = daftar.length ? ringkasDiri(nama, daftar) : null;

  if (diri) {
    bagian.push(diri.teks);
    if (diri.gagal) {
      gagal = true;
      alasan = diri.alasan || alasan;
    }
  } else if (ALAT_SHELL.has(nama)) {
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
