// Helper kecil untuk alat yang memanggil biner di shell. Dipisah dari alat.js
// supaya modul alat lain (alat-ops.js) bisa memakainya tanpa impor melingkar.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Kutip satu argumen untuk bash dengan aturan single-quote POSIX. JSON.stringify
 * TIDAK aman di dalam double quotes: `$`, backtick, dan `\` tetap ditafsirkan
 * bash.
 */
export function kutip(nilai) {
  return "'" + String(nilai == null ? '' : nilai).replace(/'/g, "'\\''") + "'";
}

/**
 * Cari biner di PATH (atau jalur mutlak) dan kembalikan JALUR MUTLAK-nya.
 * `shell()` memakai `bash -lc`, dan login shell bisa mengganti PATH, jadi nama
 * polos tidak cukup. '' = tidak terpasang (dilaporkan jujur, bukan ENOENT).
 */
/**
 * Jalur keluaran WAJIB di dalam folder kerja. Tanpa ini model yang disusupi
 * halaman web bisa menulis `keluar=../../.bashrc`. Membaca tetap bebas; yang
 * dijaga hanya tujuan tulis. Untuk menulis di luar, pemilik memakai `terminal`.
 *
 * Pemeriksaan memakai REALPATH: symlink di dalam folder kerja (mis.
 * `dist -> /luar`) tidak boleh dipakai untuk keluar. `path.resolve` saja hanya
 * merapikan `..`, bukan symlink.
 */
export function jalurNyata(target) {
  let kini = path.resolve(String(target == null ? '' : target));
  const sisa = [];
  while (!fs.existsSync(kini)) {
    const induk = path.dirname(kini);
    if (induk === kini) break;
    sisa.unshift(path.basename(kini));
    kini = induk;
  }
  let nyata = kini;
  try { nyata = fs.realpathSync(kini); } catch { /* biarkan jalur apa adanya */ }
  return sisa.length ? path.join(nyata, ...sisa) : nyata;
}

export function jalurKerja(cwd, nilai, label = 'keluaran') {
  const dasar = path.resolve(cwd || process.cwd());
  const dasarNyata = jalurNyata(dasar);
  const penuh = jalurNyata(path.resolve(dasar, String(nilai == null ? '' : nilai)));
  if (penuh !== dasarNyata && !penuh.startsWith(dasarNyata + path.sep)) {
    throw new Error(label + ' harus di dalam folder kerja: ' + penuh + ' (folder: ' + dasarNyata + '). Pakai path relatif, atau alat terminal bila memang di luar.');
  }
  return penuh;
}

export function cariBiner(daftar) {
  const bisa = (jalur) => {
    try { fs.accessSync(jalur, fs.constants.X_OK); return fs.statSync(jalur).isFile(); } catch { return false; }
  };
  for (const kandidat of (daftar || []).map((satu) => String(satu || '').trim()).filter(Boolean)) {
    if (kandidat.includes('/')) { if (bisa(kandidat)) return kandidat; continue; }
    for (const folder of String(process.env.PATH || '').split(':')) {
      if (!folder) continue;
      const penuh = path.join(folder, kandidat);
      if (bisa(penuh)) return penuh;
    }
  }
  return '';
}
