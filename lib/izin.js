// Giliran izin: beberapa alat bisa mengubah hal yang tidak bisa dibatalkan
// (terminal, hapus, tulis). Sebelum dijalankan, agen bertanya dulu.
//
// Tiga mode, disimpan di state (`modeIzin`) supaya bertahan antar-sesi:
//   auto  - jalan tanpa tanya (bawaan lama; pemilik yang menyuruh)
//   ask   - tanya untuk alat berisiko, sekali per panggilan (jawaban disimpan
//           di state supaya bertahan saat proses mati di tengah giliran)
//   never - alat berisiko DITOLAK, sisanya jalan
//
// Penanya disuntikkan (`tanya`), tidak diimpor: TUI punya layarnya sendiri,
// mode teks memakai readline, uji memakai jawaban palsu.

import readline from 'node:readline/promises';
import { bacaState, ubahState } from './lokal.js';

// Alat yang HANYA membaca tidak pernah ditanya. Alat campuran (punya aksi
// baca DAN aksi yang menjalankan shell/menulis) diperiksa per aksi di
// `amanTanpaTanya` - daftar nama saja tidak cukup: `tugas aksi=jalankan` dan
// `latar aksi=jalan` menjalankan bash, jadi tidak boleh lolos hanya karena
// namanya dulu terdaftar "aman".
const AMAN = new Set([
  'status', 'daftar', 'baca', 'cari', 'diff', 'web', 'cariweb', 'mind', 'ingatan', 'rencana'
]);

/** Aksi yang benar-benar hanya membaca untuk alat campuran. */
const AMAN_AKSI = {
  petunjuk: ['lihat', ''],
  skill: ['daftar', 'baca', ''],
  tugas: ['daftar'],
  khazanah: ['checkpoint', 'cari', 'pemicu'],
  mcp: ['daftar', 'alat', ''],
  latar: ['daftar', 'status', ''],
  biaya: ['lihat', '']
};

const RAHASIA = /(^|[\\/])(\.env(\..*)?|config\.json|credentials?(\..*)?|id_(rsa|ed25519)|\.netrc|mcp\.json|state\.json|bot\.json)$|\.(pem|key|p12|pfx|kdbx)$/i;

function sentuhRahasia(argumen = {}) {
  // `cari` bisa menyentuh berkas rahasia lewat pola/folder; `diff` lewat lawan.
  // Semua jalur masuk diperiksa, bukan hanya `path`.
  const jalur = String(argumen.path || argumen.jalur || argumen.berkas || '').trim();
  if (RAHASIA.test(jalur)) return true;
  if (RAHASIA.test(String(argumen.lawan || '').trim())) return true;
  const folder = String(argumen.folder || '').trim();
  if (folder && RAHASIA.test(folder)) return true;
  // Pola cari yang eksplisit menyebut nama berkas rahasia (mis. cari kunci di
  // "config.json") juga harus lewat izin - pola = cara membaca isinya.
  return RAHASIA.test(String(argumen.pola || argumen.query || '').trim());
}

export function amanTanpaTanya(nama, argumen = {}) {
  // Membaca berkas rahasia (config/.env/kunci) tidak "aman" hanya karena
  // alatnya bernama baca: isinya kredensial, dan dulu lolos bahkan di mode never.
  if (nama === 'baca' || nama === 'cari' || nama === 'diff') {
    if (sentuhRahasia(argumen)) return false;
  }
  if (AMAN.has(nama)) return true;
  // Alat operasi: nilai "aman" bergantung pada aksi/argumennya, bukan namanya.
  const aksiOps = String((argumen && argumen.aksi) || '').toLowerCase();
  if (nama === 'db') return argumen.tulis !== true;
  if (nama === 'env') return argumen.buka !== true;
  if (nama === 'json' || nama === 'csv') return true;
  if (nama === 'lint') return argumen.perbaiki !== true;
  if (nama === 'http') return ['GET', 'HEAD', ''].includes(String(argumen.metode || 'GET').toUpperCase());
  if (nama === 'paket') return ['audit', 'daftar'].includes(aksiOps);
  if (nama === 'layanan') return ['cek', 'daftar', 'log', ''].includes(aksiOps);
  if (nama === 'git') {
    if (['status', 'diff', 'log', 'selamat', ''].includes(aksiOps)) return true;
    if (aksiOps === 'branch' && argumen.hapus !== true) return String(argumen.nama || '') === '';
    if (aksiOps === 'stash') return ['list', 'push'].includes(String(argumen.sub || 'push').toLowerCase());
    return false;
  }
  const daftar = AMAN_AKSI[nama];
  if (!daftar) return false;
  const aksi = String((argumen && argumen.aksi) || '').toLowerCase();
  // `skill curator` tanpa sub = status (baca); dengan sub arsipkan/pin = tulis.
  if (nama === 'skill' && aksi === 'curator') return !argumen.sub || ['status', 'lihat'].includes(String(argumen.sub).toLowerCase());
  // `khazanah pemicu` tanpa perintah/script = daftar; dengan isi = menulis jadwal.
  if (nama === 'khazanah' && aksi === 'pemicu') return !argumen.perintah && !argumen.script;
  return daftar.includes(aksi);
}

/**
 * Tindakan yang WAJIB ditanya walau mode izin `auto`: tidak bisa dibatalkan
 * (riwayat remote ditimpa, perubahan lokal dibuang, layanan dimatikan, DB
 * ditulis, rahasia dibuka). Mengembalikan alasannya, atau '' bila bukan.
 */
export function wajibTanya(nama, argumen = {}) {
  const aksi = String((argumen && argumen.aksi) || '').toLowerCase();
  if (nama === 'git') {
    if (aksi === 'push' && argumen.paksa === true) return 'push paksa menimpa riwayat remote';
    if (aksi === 'reset' && String(argumen.mode || '').toLowerCase() === 'hard') return 'reset --hard membuang perubahan lokal';
    if (aksi === 'clean' && argumen.paksa === true) return 'clean -fd menghapus berkas tak terlacak';
  }
  if (nama === 'layanan' && ['stop', 'restart'].includes(aksi)) return aksi + ' menghentikan layanan';
  if (nama === 'db' && argumen.tulis === true) return 'menulis ke basis data';
  if (nama === 'env' && argumen.buka === true) return 'membuka nilai rahasia .env';
  if ((nama === 'baca' || nama === 'cari' || nama === 'diff') && sentuhRahasia(argumen)) return 'membaca berkas yang mungkin memuat kredensial';
  return '';
}

export const MODE = ['auto', 'ask', 'never'];

export function modeIzin() {
  const mode = bacaState().modeIzin;
  return MODE.includes(mode) ? mode : 'auto';
}

export function setModeIzin(mode) {
  const pilih = String(mode || '').toLowerCase();
  if (!MODE.includes(pilih)) throw new Error('mode izin harus auto|ask|never');
  ubahState((state) => { state.modeIzin = pilih; });
  return pilih;
}

/** Ringkasan satu kalimat dari argumen: yang dilihat pemilik sebelum menjawab. */
export function ringkasArgumen(nama, argumen = {}) {
  const teks = argumen.perintah || argumen.jalur || argumen.path || argumen.url || argumen.query || argumen.teks || '';
  const satu = String(teks).split('\n')[0];
  return satu.length > 200 ? satu.slice(0, 200) + '...' : satu;
}

function kunci(nama, argumen) {
  // Sidik jari panggilan: nama + argumen penuh. Panggilan sama persis cukup
  // ditanyakan sekali walau giliran diulang setelah proses mati.
  return nama + '\u0000' + JSON.stringify(argumen || {});
}

function sudahDisetujui(k) {
  const daftar = bacaState().izinkan || [];
  return Array.isArray(daftar) && daftar.includes(k);
}

function catatSetuju(k) {
  ubahState((state) => {
    const daftar = Array.isArray(state.izinkan) ? state.izinkan : [];
    if (daftar.includes(k)) return;
    // ponytail: daftar dibatasi 200; ganti ke hash+TTL kalau perlu.
    state.izinkan = daftar.concat([k]).slice(-200);
  });
}

/**
 * Penanya bawaan untuk mode teks: satu baris di stderr, jawaban dari stdin.
 * TTY dimatikan dulu kalau TUI yang memegang raw mode.
 */
export async function tanyaBaris(pertanyaan) {
  process.stderr.write(pertanyaan);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const jawab = await rl.question('');
    return String(jawab || '').trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/**
 * Keputusan untuk satu panggilan alat.
 * hasil.izin = 'jalankan' | 'tolak'; hasil.alasan untuk pesan ke model.
 */
export async function mintaIzin(nama, argumen, { mode = modeIzin(), tanya = null, sinyal = null } = {}) {
  if (amanTanpaTanya(nama, argumen)) return { izin: 'jalankan' };
  // Tindakan yang tidak bisa dibatalkan WAJIB lewat manusia, walau mode auto.
  // Tanpa penanya (pipa/CI) keputusannya tolak - lebih baik gagal jelas daripada
  // menimpa riwayat remote tanpa izin.
  const wajib = wajibTanya(nama, argumen);
  if (wajib) {
    if (mode === 'never') {
      return { izin: 'tolak', alasan: 'DITOLAK: mode izin "never" - ' + wajib + ' tidak dijalankan.' };
    }
    if (!tanya && !process.stdin.isTTY) {
      return { izin: 'tolak', alasan: 'DITOLAK: ' + wajib + ' butuh konfirmasi manusia, dan tidak ada TTY untuk bertanya. Jalankan di terminal interaktif.' };
    }
    if (sinyal && sinyal.aborted) return { izin: 'tolak', alasan: 'DITOLAK: giliran dibatalkan.' };
    const ringkasWajib = ringkasArgumen(nama, argumen);
    const tanyaWajib = '\n[WAJIB KONFIRMASI] ' + nama + ' - ' + wajib + (ringkasWajib ? ': ' + ringkasWajib : '')
      + '\n  jalankan? [y]a / [t]idak (Enter=tidak; tidak ada "selalu" untuk tindakan ini) ';
    let jawabWajib;
    try { jawabWajib = String(await (tanya || tanyaBaris)(tanyaWajib, { nama, argumen, wajib }) || '').trim().toLowerCase(); } catch { jawabWajib = ''; }
    if (jawabWajib === 'y' || jawabWajib === 'ya' || jawabWajib === 'yes') return { izin: 'jalankan' };
    return { izin: 'tolak', alasan: 'DITOLAK: pemilik tidak menyetujui ' + nama + ' (' + wajib + '). Jangan ulangi; tanyakan apa yang sebenarnya dibutuhkan.' };
  }
  if (mode === 'auto') return { izin: 'jalankan' };
  if (mode === 'never') return { izin: 'tolak', alasan: 'DITOLAK: mode izin "never" - alat berisiko tidak dijalankan. Jawab tanpa alat ini atau minta pemilik mengganti mode (/izin ask).' };
  const k = kunci(nama, argumen);
  if (sudahDisetujui(k)) return { izin: 'jalankan' };
  if (sinyal && sinyal.aborted) return { izin: 'tolak', alasan: 'DITOLAK: giliran dibatalkan.' };
  const ringkas = ringkasArgumen(nama, argumen);
  const pertanyaan = '\n[izin] ' + nama + (ringkas ? ': ' + ringkas : '') + '\n  jalankan? [y]a / [t]idak / [s]elalu (Enter=tidak) ';
  let jawab;
  try { jawab = String(await (tanya || tanyaBaris)(pertanyaan, { nama, argumen }) || '').trim().toLowerCase(); } catch { jawab = ''; }
  if (jawab === 'y' || jawab === 'ya' || jawab === 'yes') return { izin: 'jalankan' };
  if (jawab === 's' || jawab === 'selalu' || jawab === 'always' || jawab === 'a') {
    catatSetuju(k);
    return { izin: 'jalankan' };
  }
  return { izin: 'tolak', alasan: 'DITOLAK: pemilik tidak menyetujui ' + nama + (ringkas ? ' (' + ringkas + ')' : '') + '. Jangan ulangi panggilan yang sama; cari cara lain atau tanyakan.' };
}

/** Buang catatan persetujuan (dipanggil saat mode diganti). */
export function lupakanIzin() {
  ubahState((state) => { state.izinkan = []; });
}