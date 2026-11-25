// Petunjuk proyek: berkas yang diletakkan orang di folder kerja (AGENTS.md dan
// kerabatnya) dan otomatis ikut masuk prompt - jadi aturan repo tidak perlu
// diulang tiap sesi. Dibaca dari cwd naik ke atas sampai akar, digabung dari
// yang paling umum (akar) ke yang paling khusus (cwd).
//
// Satu berkas dibaca sekali per folder; batas ukuran supaya prompt tidak meledak.

import fs from 'node:fs';
import path from 'node:path';

export const NAMA = ['AGENTS.md', 'SAKTI.md', '.sakti.md', 'CLAUDE.md', '.cursorrules'];
export const MAKS_BAWAAN = 6000;

/** {jalur, teks, folder} untuk tiap berkas yang ada, urut akar -> cwd. */
export function bacaPetunjuk(cwd = process.cwd(), { maks = MAKS_BAWAAN } = {}) {
  const jalur = [];
  let kini = path.resolve(cwd);
  for (;;) {
    for (const nama of NAMA) {
      const penuh = path.join(kini, nama);
      try { if (fs.statSync(penuh).isFile()) jalur.push({ penuh, folder: kini, nama }); } catch { /* tidak ada */ }
    }
    const naik = path.dirname(kini);
    if (naik === kini) break;
    kini = naik;
  }
  jalur.reverse(); // akar dulu, cwd terakhir
  // Jatah: yang paling spesifik (cwd) didahulukan supaya AGENTS.md raksasa di
  // akar tidak menelan semua kuota dan menghapus aturan folder kerja. Urutan
  // keluaran tetap akar -> cwd supaya terbaca sebagai umum lalu khusus.
  const hasil = [];
  let sisa = maks;
  for (const satu of [...jalur].reverse()) {
    if (sisa <= 0) break;
    let teks = '';
    try { teks = fs.readFileSync(satu.penuh, 'utf8').trim(); } catch { continue; }
    if (!teks) continue;
    if (teks.length > sisa) teks = teks.slice(0, sisa) + '\n[...dipotong]';
    sisa -= teks.length;
    hasil.push({ jalur: satu.penuh, folder: satu.folder, nama: satu.nama, teks });
  }
  return hasil.reverse();
}

/**Tulis AGENTS.md kerangka di folder kerja. Tidak menimpa berkas yang ada. */
export function buatPetunjuk(cwd = process.cwd(), { nama = NAMA[0], proyek = '' } = {}) {
  const penuh = path.join(path.resolve(cwd), nama);
  if (fs.existsSync(penuh)) return { jalur: penuh, dibuat: false };
  const judul = proyek || path.basename(path.resolve(cwd));
  fs.writeFileSync(penuh, [
    '# ' + judul,
    '',
    'Aturan repo untuk agen. Berkas ini dibaca otomatis tiap giliran; tulis yang',
    'berlaku, bukan cita-cita.',
    '',
    '## Perintah',
    '- uji: (belum ada)',
    '- build: (belum ada)',
    '- lint: (belum ada)',
    '',
    '## Aturan',
    '- (contoh) jangan sentuh folder migrations tanpa diminta',
    '- (contoh) jalankan uji sebelum bilang selesai',
    ''
  ].join('\n'));
  return { jalur: penuh, dibuat: true };
}

/** Blok prompt dari petunjuk proyek; '' kalau tidak ada berkas. */
export function blokPetunjuk(cwd = process.cwd(), opsi = {}) {
  const rows = bacaPetunjuk(cwd, opsi);
  if (!rows.length) return '';
  return 'PETUNJUK PROYEK (dari berkas di folder kerja - ikuti, ini aturan repo)\n' +
    rows.map((row) => '--- ' + row.nama + ' (' + row.folder + ')\n' + row.teks).join('\n\n');
}