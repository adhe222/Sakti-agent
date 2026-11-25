// Khazanah: tiga hal kecil yang ditiru dari Hermes supaya sakti bisa belajar
// dari dirinya sendiri tanpa server dan tanpa daemon.
//
//   1. checkpoint  - salinan berkas SEBELUM ditimpa/dihapus (shadow copy),
//                    bisa dilihat dan dikembalikan: `sakti checkpoint`.
//   2. ingatan bagian - potongan jawaban yang disimpan sengaja, dicari tanpa
//                    model lewat pencocokan kata biasa.
//   3. pemicu      - jadwal "setiap N menit ..." yang diperiksa saat agen
//                    dijalankan (tanpa cron, tanpa proses latar).
//
// Semua di satu JSON: ~/.sakti-cli/khazanah.json, salinan di ~/.sakti-cli/ckp/.

import fs from 'node:fs';
import os from 'node:os';
import { kunciBerkas } from './lokal.js';
import path from 'node:path';

export function berkasKhazanah() {
  return process.env.SAKTI_CLI_KHAZANAH || path.join(os.homedir(), '.sakti-cli', 'khazanah.json');
}

export function folderCkp() {
  return process.env.SAKTI_CLI_CKP || path.join(path.dirname(berkasKhazanah()), 'ckp');
}

const KOSONG = () => ({ checkpoint: [], ingatan: [], pemicu: [] });

export function bacaKhazanah() {
  try {
    const isi = JSON.parse(fs.readFileSync(berkasKhazanah(), 'utf8'));
    return isi && typeof isi === 'object' ? Object.assign(KOSONG(), isi) : KOSONG();
  } catch { return KOSONG(); }
}

/**
 * Baca khazanah + status keterbacaan. Pemanggil yang MENGHAPUS sesuatu wajib
 * memakai ini: `bacaKhazanah()` mengembalikan daftar kosong saat JSON rusak,
 * dan pembersih lama mengira semua folder checkpoint "yatim" lalu menghapus
 * seluruh cadangan.
 */
export function khazanahTerbaca() {
  try {
    const isi = JSON.parse(fs.readFileSync(berkasKhazanah(), 'utf8'));
    if (!isi || typeof isi !== 'object') return { ok: false, galat: 'bukan objek', data: KOSONG() };
    return { ok: true, data: Object.assign(KOSONG(), isi) };
  } catch (galat) {
    if (galat && galat.code === 'ENOENT') return { ok: true, data: KOSONG() };
    return { ok: false, galat: String((galat && galat.message) || galat), data: KOSONG() };
  }
}

export function tulisKhazanah(data) {
  const berkas = berkasKhazanah();
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  // Rename atomik: checkpoint/ingatan/pemicu tidak boleh jadi JSON separuh.
  const sementara = berkas + '.tmp-' + process.pid;
  fs.writeFileSync(sementara, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(sementara, berkas);
  try { fs.chmodSync(berkas, 0o600); } catch { /* filesystem tanpa chmod */ }
  return berkas;
}

const idBaru = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 5);

/* ---------------------------------------------------------- checkpoint -- */

/** Salin satu berkas sebelum diubah/dihapus. Diam saja kalau berkasnya tidak ada. */
export function checkpoint(jalur) {
  const asli = path.resolve(String(jalur || ''));
  let isi;
  try {
    if (!fs.statSync(asli).isFile()) return null;
    isi = fs.readFileSync(asli);
  } catch { return null; }
  const id = idBaru();
  const tujuan = path.join(folderCkp(), id);
  fs.mkdirSync(tujuan, { recursive: true });
  fs.writeFileSync(path.join(tujuan, path.basename(asli)), isi);
  // Baca → tambah → tulis di dalam kunci: dua alat yang menimpa dua berkas
  // bersamaan tidak boleh saling menghapus catatan checkpoint.
  const buang = kunciBerkas(berkasKhazanah(), () => {
    const data = bacaKhazanah();
    // ponytail: simpan 200 salinan terakhir; naikkan kalau ada yang hilang.
    const tua = (data.checkpoint || []).slice(0, Math.max(0, (data.checkpoint || []).length - 199));
    data.checkpoint = (data.checkpoint || []).slice(-199).concat([{ id, jalur: asli, salinan: path.join(tujuan, path.basename(asli)), ukuran: isi.length, at: Date.now() }]);
    tulisKhazanah(data);
    return tua;
  });
  // Salinan lama ikut dibuang dari cakram: tanpa ini folder ckp tumbuh tanpa batas.
  for (const tua of buang) { try { fs.rmSync(path.dirname(tua.salinan), { recursive: true, force: true }); } catch { /* biarkan */ } }
  return { id, jalur: asli };
}

export function daftarCheckpoint({ batas = 20 } = {}) {
  return (bacaKhazanah().checkpoint || []).slice(-batas).reverse();
}

/** Kembalikan berkas ke salinan tertentu (id atau awalan id). */
export function kembalikanCheckpoint(id) {
  const jarum = String(id || '').trim();
  if (!jarum) throw new Error('id checkpoint kosong');
  const data = bacaKhazanah();
  const semua = data.checkpoint || [];
  const satu = semua.find((row) => row.id === jarum) || semua.slice().reverse().find((row) => row.id.startsWith(jarum));
  if (!satu) throw new Error('checkpoint tidak ada: ' + jarum);
  if (!fs.existsSync(satu.salinan)) throw new Error('salinan hilang: ' + satu.salinan);
  // Baca isi salinan SEBELUM checkpoint(satu.jalur): saat daftar sudah penuh,
  // checkpoint baru memangkas entri TERTUA - yang bisa jadi salinan yang sedang
  // dipulihkan - sehingga copyFileSync gagal ENOENT setelah berkasnya dihapus.
  const isi = fs.readFileSync(satu.salinan);
  // Simpan keadaan sekarang dulu supaya pengembalian pun bisa dibatalkan.
  checkpoint(satu.jalur);
  fs.mkdirSync(path.dirname(satu.jalur), { recursive: true });
  fs.writeFileSync(satu.jalur, isi);
  return satu;
}

function pilihCheckpoint(id) {
  const jarum = String(id || '').trim();
  const semua = bacaKhazanah().checkpoint || [];
  if (!jarum) return semua.slice().reverse().find((row) => fs.existsSync(row.jalur)) || null;
  const satu = semua.find((row) => row.id === jarum) || semua.slice().reverse().find((row) => row.id.startsWith(jarum));
  if (!satu) throw new Error('checkpoint tidak ada: ' + jarum);
  return satu;
}

/** Beda berkas sekarang terhadap salinan checkpoint (unified, tanpa diff eksternal). */
export function bedaCheckpoint(id) {
  const satu = pilihCheckpoint(id);
  if (!satu) throw new Error('belum ada checkpoint');
  const lama = fs.existsSync(satu.salinan) ? fs.readFileSync(satu.salinan, 'utf8').split('\n') : [];
  const baru = fs.existsSync(satu.jalur) ? fs.readFileSync(satu.jalur, 'utf8').split('\n') : [];
  // LCS kuadratik: berkas bisa besar, jadi dipotong dulu. ponytail: cukup untuk
  // beda sekali lihat; ganti ke algoritma Myers kalau berkas ribuan baris.
  const A = lama.slice(0, 2000);
  const B = baru.slice(0, 2000);
  const tabel = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i -= 1) {
    for (let j = B.length - 1; j >= 0; j -= 1) {
      tabel[i][j] = A[i] === B[j] ? tabel[i + 1][j + 1] + 1 : Math.max(tabel[i + 1][j], tabel[i][j + 1]);
    }
  }
  const keluaran = ['--- ' + satu.salinan, '+++ ' + satu.jalur];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { keluaran.push(' ' + A[i]); i += 1; j += 1; }
    else if (tabel[i + 1][j] >= tabel[i][j + 1]) { keluaran.push('-' + A[i]); i += 1; }
    else { keluaran.push('+' + B[j]); j += 1; }
  }
  while (i < A.length) { keluaran.push('-' + A[i]); i += 1; }
  while (j < B.length) { keluaran.push('+' + B[j]); j += 1; }
  // Kepala "---"/"+++" sendiri berawalan -/+: periksa isi sesudahnya saja.
  const adaBeda = keluaran.slice(2).some((baris) => baris[0] === '+' || baris[0] === '-');
  return adaBeda ? keluaran.join('\n') : '';
}

/* ------------------------------------------------- ingatan bagian (cari) -- */

export function ingatBagian(teks, { judul = '', proyek = process.cwd() } = {}) {
  const isi = String(teks == null ? '' : teks).trim();
  if (!isi) throw new Error('teks kosong');
  const id = idBaru();
  const baris = {
    id,
    judul: String(judul || isi.split('\n')[0]).slice(0, 100),
    teks: isi.slice(0, 8000),
    proyek,
    at: Date.now()
  };
  kunciBerkas(berkasKhazanah(), () => {
    const data = bacaKhazanah();
    data.ingatan = (data.ingatan || []).concat([baris]).slice(-500);
    tulisKhazanah(data);
  });
  return { id, judul: baris.judul };
}

export function cariBagian(query, { batas = 10 } = {}) {
  const kata = String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (!kata.length) return [];
  return (bacaKhazanah().ingatan || [])
    .map((row) => {
      const isi = row.teks.toLowerCase();
      const skor = kata.reduce((n, k) => n + (isi.includes(k) ? 1 : 0), 0);
      return Object.assign({}, row, { skor });
    })
    .filter((row) => row.skor >= Math.max(1, Math.ceil(kata.length * 0.5)))
    .sort((a, b) => b.skor - a.skor || b.at - a.at)
    .slice(0, batas);
}

/* -------------------------------------------------------------- pemicu -- */

/**
 * Tambah/daftar pemicu. Tiap pemicu: {nama, menit, cron, perintah, terakhir}.
 * perintah = kalimat yang dikirim ke agen saat jatuh tempo; `script` = jalur
 * skrip yang dijalankan langsung (tanpa model) - berguna untuk tugas berkala
 * murah seperti `sakti khazanah pemicu nama=cuci menit=60 script=/path.sh`.
 */
export function pemicu(nama, opsi = {}) {
  const { menit = 30, perintah = '', cron = '', script = '', hapus = false } = opsi;
  const kunci = String(nama || '').trim();
  // Daftar (tanpa perintah/script/hapus) tidak butuh nama: dulu baris ini melempar
  // 'nama pemicu kosong' sehingga aksi=pemicu selalu GAGAL, padahal itu cara lihat.
  if (!perintah && !script && !hapus) return bacaKhazanah().pemicu || [];
  if (!kunci) throw new Error('nama pemicu kosong');
  return kunciBerkas(berkasKhazanah(), () => pemicuTulis(kunci, { menit, perintah, cron, script, hapus }));
}

function pemicuTulis(kunci, { menit, perintah, cron, script, hapus }) {
  const data = bacaKhazanah();
  data.pemicu = data.pemicu || [];
  if (hapus) {
    data.pemicu = data.pemicu.filter((row) => row.nama !== kunci);
    tulisKhazanah(data);
    return null;
  }
  const lama = data.pemicu.find((row) => row.nama === kunci);
  const jam = String(cron || '').trim();
  if (jam && jam.split(/\s+/).length !== 5) throw new Error('cron harus 5 kolom: menit jam tgl bln hari (contoh: "0 7 * * *")');
  const baru = {
    nama: kunci,
    menit: Math.max(1, Math.round(Number(menit) || 30)),
    cron: jam,
    perintah: String(perintah || ''),
    script: script ? path.resolve(String(script)) : '',
    terakhir: lama ? lama.terakhir : 0,
    terakhirMenit: lama ? (lama.terakhirMenit || '') : ''
  };
  data.pemicu = data.pemicu.filter((row) => row.nama !== kunci).concat([baru]);
  tulisKhazanah(data);
  return baru;
}

/* --------------------------------------------------------------- cron -- */

/** Satu kolom cron cocok dengan satu angka? Dukung bintang, bintang-per-n, a-b, dan daftar koma. */
function kolomCocok(kolom, nilai, min = 0) {
  const teks = String(kolom == null ? '*' : kolom).trim();
  if (!teks || teks === '*') return true;
  return teks.split(',').some((bagian) => {
    const rentang = /^(\d+)-(\d+)$/.exec(bagian);
    if (rentang) return nilai >= Number(rentang[1]) && nilai <= Number(rentang[2]);
    const langkah = /^(\*|\d+)\/(\d+)$/.exec(bagian);
    if (langkah) return (nilai - min) % Number(langkah[2]) === 0 && (langkah[1] === '*' || nilai >= Number(langkah[1]));
    return Number(bagian) === nilai;
  });
}

/** Ekspresi cron 5 kolom cocok dengan tanggal tertentu? */
export function cocokCron(ekspresi, tanggal = new Date()) {
  const bagian = String(ekspresi || '').trim().split(/\s+/);
  if (bagian.length !== 5) return false;
  const [menit, jam, tgl, bln, hari] = bagian;
  return kolomCocok(menit, tanggal.getMinutes())
    && kolomCocok(jam, tanggal.getHours())
    && kolomCocok(tgl, tanggal.getDate(), 1)
    && kolomCocok(bln, tanggal.getMonth() + 1, 1)
    // Cron menerima 0 DAN 7 untuk Minggu; getDay() cuma 0. Tanpa ini
    // ekspresi '0 7 * * 7' tidak pernah jalan.
    && (kolomCocok(hari, tanggal.getDay()) || (tanggal.getDay() === 0 && kolomCocok(hari, 7)));
}

// Kunci per menit memakai waktu LOKAL, sama dengan `cocokCron` (getHours dkk).
// ISO/UTC membuat zona setengah jam (mis. UTC+5:30) berganti kunci di tengah
// menit lokal -> satu pemicu cron bisa jalan dua kali dalam satu menit.
const kunciMenit = (tanggal) => {
  const dua = (n) => String(n).padStart(2, '0');
  return tanggal.getFullYear() + '-' + dua(tanggal.getMonth() + 1) + '-' + dua(tanggal.getDate())
    + 'T' + dua(tanggal.getHours()) + ':' + dua(tanggal.getMinutes());
};

/**
 * Pemicu yang sudah jatuh tempo. Dua bentuk:
 *   - `cron`  : sekali per menit yang cocok (dijaga kunciMenit supaya tidak dobel),
 *   - `menit` : lewat jeda N menit dari jalan terakhir.
 */
export function pemicuJatuhTempo(sekarang = Date.now(), tanggal = new Date(sekarang)) {
  const kunci = kunciMenit(tanggal);
  return (bacaKhazanah().pemicu || []).filter((row) => {
    if (row.cron) return cocokCron(row.cron, tanggal) && row.terakhirMenit !== kunci;
    return sekarang - (row.terakhir || 0) >= row.menit * 60000;
  });
}

export function tandaiPemicu(nama) {
  const sekarang = new Date();
  kunciBerkas(berkasKhazanah(), () => {
    const data = bacaKhazanah();
    data.pemicu = (data.pemicu || []).map((row) => (row.nama === nama ? Object.assign({}, row, { terakhir: Date.now(), terakhirMenit: kunciMenit(sekarang) }) : row));
    tulisKhazanah(data);
  });
}