// Pelajaran otomatis: setelah giliran yang benar-benar bekerja (memakai alat),
// sakti menulis satu baris pelajaran ke ingatan - tanpa memanggil model, jadi
// cepat dan gratis. Tujuannya dua: tidak mengulang kesalahan yang sama, dan
// mengulang cara yang terbukti berhasil.
//
// Bentuk yang disimpan (contoh):
//   pelajaran: "perbaiki uji tui" berhasil · 3 alat: terminal×2, baca · berkas lib/tui.js
//   pelajaran: "pasang paket" gagal 1/2 · terminal gagal (exit 100) - periksa prasyarat sebelum ulang
//
// Sidik (hash) dipakai untuk dedupe: tugas yang sama diulang tidak menumpuk
// baris baru, cukup `ulang` bertambah - ingatan tetap kecil dan tajam.

import { ubahState } from './lokal.js';

/** Batas pelajaran tersimpan (yang tertua dibuang lebih dulu). */
export const BATAS_PELAJARAN = 60;

const RE_GAGAL = /^(GAGAL|DITOLAK|alat tidak dikenal|berhenti:|tidak bisa|menolak|bukan berkas teks)/i;
const KUNCI_BERKAS = ['path', 'jalur', 'berkas', 'dari', 'ke', 'masuk', 'keluar'];

/** Nama biasa: buang spasi berlebih, potong, kecilkan untuk sidik. */
function rapi(teks) {
  return String(teks == null ? '' : teks).replace(/\s+/g, ' ').trim();
}

function sidik(teks) {
  let h = 2166136261;
  for (let i = 0; i < teks.length; i += 1) {
    h ^= teks.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Susun pelajaran dari bukti giliran. Murni (tanpa I/O).
 * `pesanRows` = baris riwayat yang dihasilkan giliran ini (assistant/tool).
 * Mengembalikan null untuk giliran tanya-jawab tanpa alat - itu bukan pelajaran.
 */
export function susunPelajaran({ pesan = '', pesanRows = [], langkah = 0, galat = '' } = {}) {
  const alatHitung = new Map();
  const berkas = new Set();
  let totalAlat = 0;
  let gagal = 0;
  let alasanGagal = '';
  for (const row of pesanRows || []) {
    if (!row || typeof row !== 'object') continue;
    if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const panggil of row.tool_calls) {
        totalAlat += 1;
        const nama = rapi(panggil && panggil.function && panggil.function.name) || '?';
        alatHitung.set(nama, (alatHitung.get(nama) || 0) + 1);
        try {
          const arg = JSON.parse(String((panggil.function && panggil.function.arguments) || '{}'));
          for (const kunci of KUNCI_BERKAS) {
            const nilai = arg && arg[kunci];
            if (typeof nilai === 'string' && nilai && nilai.length < 160) berkas.add(nilai);
          }
        } catch { /* argumen bukan JSON: abaikan, bukan alasan gagal */ }
      }
    }
    if (row.role === 'tool' && RE_GAGAL.test(String(row.content || ''))) {
      gagal += 1;
      if (!alasanGagal) {
        const baris = String(row.content || '').split('\n')[0].replace(/\s+$/, '');
        alasanGagal = baris.slice(0, 70);
      }
    }
  }
  if (!totalAlat && !galat) return null;

  const judul = rapi(pesan).slice(0, 90);
  const daftarAlat = [...alatHitung.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([nama, n]) => (n > 1 ? nama + '×' + n : nama))
    .slice(0, 5)
    .join(', ');
  const bagian = [];
  if (galat) bagian.push('berhenti (' + rapi(galat).slice(0, 60) + ')');
  else if (gagal) bagian.push('gagal ' + gagal + '/' + Math.max(totalAlat, gagal));
  else bagian.push('berhasil');
  if (totalAlat) bagian.push(totalAlat + ' alat' + (daftarAlat ? ': ' + daftarAlat : ''));
  if (berkas.size) bagian.push('berkas: ' + [...berkas].slice(0, 4).join(', '));
  // Kalimat yang bisa ditindaklanjuti - bukan sekadar catatan.
  if (galat === 'alat-berulang') bagian.push('jangan ulangi panggilan identik; ubah pendekatan');
  else if (galat === 'batas-langkah') bagian.push('pecah tugas sebelum batas langkah');
  else if (gagal && alasanGagal) bagian.push('cek prasyarat sebelum ulang (' + alasanGagal + ')');

  const teks = 'pelajaran: "' + (judul || '(tanpa teks)') + '" ' + bagian.join(' · ');
  const kunci = (judul + '|' + daftarAlat + '|' + (galat || (gagal ? 'gagal' : 'ok'))).toLowerCase();
  return {
    teks,
    sidik: sidik(kunci),
    gagal,
    totalAlat,
    jumlahAlat: langkah || totalAlat
  };
}

/**
 * Simpan pelajaran ke state (ingatan). Dedupe per sidik: yang sama menambah
 * `ulang` dan menyegarkan `at`, bukan menulis baris baru. Batas total dijaga.
 */
export function catatPelajaran(pelajaran, { proyek = process.cwd(), batas = BATAS_PELAJARAN, at = Date.now() } = {}) {
  if (!pelajaran || !pelajaran.teks || !pelajaran.sidik) return null;
  return ubahState((state) => {
    state.ingatan = Array.isArray(state.ingatan) ? state.ingatan : [];
    const sama = state.ingatan.find((row) => row && row.jenis === 'pelajaran' && row.sidik === pelajaran.sidik);
    if (sama) {
      sama.ulang = (Number(sama.ulang) || 1) + 1;
      sama.at = at;
      sama.teks = pelajaran.teks;
      return { teks: pelajaran.teks, ulang: true, ulangKe: sama.ulang };
    }
    state.ingatan.push({ teks: pelajaran.teks, proyek, at, jenis: 'pelajaran', sidik: pelajaran.sidik, ulang: 1 });
    const semua = state.ingatan.filter((row) => row && row.jenis === 'pelajaran');
    if (semua.length > batas) {
      // Buang yang TERTUA menurut `at`, bukan urutan array: ingatan manual boleh
      // terselip di antaranya dan tidak ikut terhapus.
      const buang = new Set(semua.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0)).slice(0, semua.length - batas));
      state.ingatan = state.ingatan.filter((row) => !buang.has(row));
    }
    return { teks: pelajaran.teks, ulang: false, ulangKe: 1 };
  });
}

/**
 * Naikkan pelajaran yang terbukti berulang (ulang >= 3) ke ingatan inti
 * (`state.mind`) supaya ikut prompt setiap giliran, bukan hanya 12 slot
 * pelajaran terbaru. Dedupe teks, tandai `naik`, dan jangan melebihi kapasitas
 * inti (30) - kalau penuh, lewati daripada membuang ingatan manual.
 */
export function promosikanPelajaran({ minUlang = 3, batasInti = 30 } = {}) {
  return ubahState((state) => {
    const ingatan = Array.isArray(state.ingatan) ? state.ingatan : [];
    state.mind = Array.isArray(state.mind) ? state.mind : [];
    const sudah = new Set(state.mind.map((row) => String(row && row.teks || '').trim().toLowerCase()));
    let naik = 0;
    for (const row of ingatan) {
      if (!row || row.jenis !== 'pelajaran' || row.naik) continue;
      if ((Number(row.ulang) || 1) < minUlang) continue;
      const teks = ('pelajaran: ' + String(row.teks || '')).trim();
      const kunci = teks.toLowerCase();
      if (sudah.has(kunci)) { row.naik = true; continue; }
      if (state.mind.length >= batasInti) break;
      state.mind.push({ teks, at: Date.now(), sumber: 'pelajaran' });
      sudah.add(kunci);
      row.naik = true;
      naik += 1;
    }
    return naik;
  });
}

/** Daftar pelajaran tersimpan (terbaru dulu) untuk `sakti pelajaran` / `/pelajaran`. */
export function daftarPelajaran(state = null, { batas = 20 } = {}) {
  const isi = state && Array.isArray(state.ingatan) ? state.ingatan : [];
  return isi.filter((row) => row && row.jenis === 'pelajaran')
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, Math.max(0, Number(batas) || 20));
}

/** Hapus pelajaran: semua, atau yang teksnya memuat `cari`. */
export function hapusPelajaran({ cari = '', semua = false } = {}) {
  // Tanpa kata dan tanpa `semua: true` tidak menghapus apa pun: salah ketik
  // `/pelajaran hapus` tidak boleh menghapus seluruh ingatan belajar.
  const kata = rapi(cari).toLowerCase();
  if (!kata && !semua) return 0;
  return ubahState((state) => {
    const lama = Array.isArray(state.ingatan) ? state.ingatan : [];
    const buang = lama.filter((row) => row && row.jenis === 'pelajaran'
      && ((semua && !kata) || (kata && String(row.teks || '').toLowerCase().includes(kata))));
    state.ingatan = lama.filter((row) => !buang.includes(row));
    return buang.length;
  });
}

/** Apakah pelajaran otomatis menyala? Env mati > config > bawaan hidup. */
export function pelajaranAktif(konf = {}) {
  const env = String(process.env.SAKTI_PELAJARAN_MATI || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'ya') return false;
  const nilai = String((konf && konf.pelajaran) || '').toLowerCase();
  if (nilai === 'mati' || nilai === 'off' || nilai === '0') return false;
  return true;
}
