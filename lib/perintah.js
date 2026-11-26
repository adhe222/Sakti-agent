// Perintah kustom: potongan prompt tersimpan yang dipanggil dengan /nama.
// Berkas: ~/.sakti-cli/perintah/<nama>.md  (atau $SAKTI_CLI_PERINTAH)
//
//   ---
//   keterangan: tinjau diff sebelum commit
//   ---
//   Tinjau perubahan yang belum di-commit. Sorot risiko, bukan gaya.
//   Fokus: $ARGUMEN
//
// $ARGUMEN diganti teks setelah /nama; kalau tidak ada, argumen apa adanya
// ditempel di akhir. Frontmatter opsional, hanya "keterangan".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function folderPerintah() {
  return process.env.SAKTI_CLI_PERINTAH || path.join(os.homedir(), '.sakti-cli', 'perintah');
}

/** Folder perintah milik proyek (`.sakti/perintah` di folder kerja). */
export function folderPerintahProyek(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), '.sakti', 'perintah');
}

/** Lapisan pencarian: proyek dulu, global belakangan (proyek menang saat bentrok). */
function lapisan(cwd) {
  const proyek = folderPerintahProyek(cwd);
  const global = folderPerintah();
  return proyek === global ? [proyek] : [proyek, global];
}

// Batas 64 huruf: nama panjang memicu ENAMETOOLONG dan membuat berkas tak bisa dihapus.
const NAMA_SAH = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Baca satu berkas perintah; null kalau tidak ada/rusak. */
export function bacaPerintah(nama, { cwd } = {}) {
  if (!NAMA_SAH.test(String(nama || ''))) return null;
  let mentah;
  for (const folder of lapisan(cwd)) {
    try { mentah = fs.readFileSync(path.join(folder, nama + '.md'), 'utf8'); break; }
    catch { /* coba lapisan berikutnya */ }
  }
  if (mentah === undefined) return null;
  let isi = mentah;
  let keterangan = '';
  const cocok = mentah.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (cocok) {
    isi = mentah.slice(cocok[0].length);
    for (const baris of cocok[1].split(/\r?\n/)) {
      const pisah = baris.match(/^\s*keterangan\s*:\s*(.*)$/i);
      if (pisah) keterangan = pisah[1].trim();
    }
  }
  isi = isi.trim();
  if (!isi) return null;
  return { nama, keterangan, isi };
}

/** Semua perintah kustom, urut abjad. */
export function daftarPerintah({ cwd } = {}) {
  const terlihat = new Map();
  for (const folder of lapisan(cwd)) {
    let isi;
    try { isi = fs.readdirSync(folder); } catch { continue; }
    for (const berkas of isi) {
      if (!berkas.endsWith('.md')) continue;
      const nama = berkas.slice(0, -3);
      if (terlihat.has(nama)) continue;
      const satu = bacaPerintah(nama, { cwd });
      if (satu) terlihat.set(nama, satu);
    }
  }
  return [...terlihat.values()].sort((a, b) => a.nama.localeCompare(b.nama));
}

/**
 * Rangkai prompt dari perintah kustom. Mengembalikan null kalau tidak ada.
 * Penanda yang dikenali: $ARGUMEN (semua argumen apa adanya) dan $1..$9
 * (per kata; kata yang tidak ada jadi string kosong, bukan sisa literal).
 * Tanpa penanda sama sekali, argumen ditempel sebagai baris terakhir.
 */
export function rangkaiPerintah(nama, argumen = '', { cwd } = {}) {
  const satu = bacaPerintah(nama, { cwd });
  if (!satu) return null;
  const mentah = String(argumen || '').trim();
  const kata = mentah ? mentah.split(/\s+/) : [];
  const punyaPenanda = /\$ARGUMEN\b|\$[1-9]\b/.test(satu.isi);
  if (!punyaPenanda) return mentah ? satu.isi + '\n\n' + mentah : satu.isi;
  // Urutan: $1..$9 dulu (dari kata argumen), $ARGUMEN terakhir lewat fungsi.
  // Dulu $ARGUMEN disuntik dulu sbg string mentah: replacement string
  // menafsirkan $&/$`, dan $1..$9 milik argumen bisa tertukar pass berikutnya.
  return satu.isi
    .replace(/\$([1-9])\b/g, (_, n) => kata[Number(n) - 1] || '')
    .replace(/\$ARGUMEN\b/g, () => mentah);
}

/** Tulis perintah baru; menolak menimpa kecuali timpa=true. */
export function tulisPerintah(nama, isi, { keterangan = '', timpa = false, proyek = false, cwd } = {}) {
  if (!NAMA_SAH.test(String(nama || ''))) {
    return { ok: false, pesan: 'nama tidak sah (huruf/angka/-/_): ' + nama };
  }
  const badan = String(isi || '').trim();
  if (!badan) return { ok: false, pesan: 'isi kosong' };
  const folder = proyek ? folderPerintahProyek(cwd) : folderPerintah();
  fs.mkdirSync(folder, { recursive: true });
  const jalur = path.join(folder, nama + '.md');
  if (fs.existsSync(jalur) && !timpa) return { ok: false, pesan: 'sudah ada, pakai --timpa: ' + jalur };
  const kepala = keterangan ? '---\nketerangan: ' + keterangan.replace(/\n/g, ' ') + '\n---\n' : '';
  fs.writeFileSync(jalur, kepala + badan + '\n');
  return { ok: true, jalur };
}

/** Hapus perintah yang TERLIHAT saja (proyek dulu), bukan semua lapisan -
 *  seperti `rm` pada PATH: pengguna menghapus apa yang dia lihat. */
export function hapusPerintah(nama, { cwd } = {}) {
  if (!NAMA_SAH.test(String(nama || ''))) return false;
  for (const folder of lapisan(cwd)) {
    const jalur = path.join(folder, nama + '.md');
    try { fs.unlinkSync(jalur); return true; }
    catch { /* coba lapisan berikutnya */ }
  }
  return false;
}
