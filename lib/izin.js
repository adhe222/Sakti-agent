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
  if (nama === 'kerja' && aksi === 'hapus') return 'kerja aksi=hapus menjalankan worktree remove --force: perubahan belum di-commit dibuang permanen';
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
// --- Gerbang kanal tak tepercaya (serve/WA/Telegram) ---
// Dipindah dari lib/alat.js (ADR-002 risiko 2): izin.js termasuk PENGAMAN di lib/diri.js,
// jadi agen tak bisa melemahkan gerbang ini lewat ubah_diri. Perilaku & teks pesan identik.

// Pola perintah perusak yang ditolak saat giliran datang dari kanal tak tepercaya.
export const POLA_TERMINAL_BAHAYA = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z-]+\s+)*(--no-preserve-root\s+)?(\/|\/\*|~|\$HOME)(\s|$|;|&|\|)/, 'rm -r pada / atau home'],
  [/\bmkfs(\.\w+)?\b/, 'mkfs'],
  [/\bdd\b[^;&|]*\bof=\/dev\/(sd|nvme|hd|vd|xvd|mmcblk|disk)/, 'dd ke perangkat disk'],
  [/>\s*\/dev\/(sd|nvme|hd|vd|xvd|mmcblk)/, 'tulis langsung ke perangkat disk'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'curl|sh (unduh lalu jalankan)'],
  [/\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|\bsystemctl\s+(poweroff|reboot|halt)\b/, 'matikan/nyalakan ulang mesin'],
  [/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)777\s+\/(\s|$)/, 'chmod -R 777 /'],
  [/:\(\)\s*\{\s*:\|:&\s*\};\s*:/, 'fork bomb']
];

export function kanalTakTepercaya(konf) {
  const k = konf && konf.kanal;
  return !!k && k !== 'cli' && k !== 'mcp';
}

/** Kembalikan teks penolakan bila perintah ditolak, null bila boleh jalan. */
export function tolakTerminal(perintah, konf) {
  if (!kanalTakTepercaya(konf) || process.env.SAKTI_TERMINAL_BEBAS === '1') return null;
  const teks = String(perintah || '');
  for (const [pola, alasan] of POLA_TERMINAL_BAHAYA) {
    if (pola.test(teks)) {
      return 'DITOLAK: perintah berbahaya (' + alasan + ') dari kanal tak tepercaya "' + konf.kanal +
        '". Jalankan dari CLI lokal, atau set SAKTI_TERMINAL_BEBAS=1 di proses serve kalau memang disengaja.';
    }
  }
  return null;
}

/**
 * Teks penolakan bila aksi ubah-diri/pasang dijalankan dari kanal tak tepercaya, null bila boleh.
 * `usul` menjalankan uji (kode sembarang, ADR-002 K7/CELAH T1) jadi setara terminal:
 * dibuka oleh SAKTI_DIRI_KANAL=1 atau SAKTI_TERMINAL_BEBAS=1 (opsi terminalBebas).
 * terapkan/kembalikan/pasang_alat hanya dibuka SAKTI_DIRI_KANAL=1.
 */
/**
 * Redaksi secret di teks keluaran tool (ADR-003 K2, pola OpenSRE _redact):
 * nilai env yang NAMANYA cocok /TOKEN|SECRET|KEY|PASSWORD|SANDI/i diganti '***'
 * di teks. Nilai pendek (<4 karakter) diabaikan agar teks umum tidak rusak.
 * False positive diterima: lebih baik kelebihan ganti daripada bocor.
 */
export const POLA_NAMA_RAHASIA = /TOKEN|SECRET|KEY|PASSWORD|SANDI|CREDENTIAL|PASSWD|AUTH/i;

export function redaksiSecret(teks) {
  let t = String(teks == null ? '' : teks);
  if (!t) return t;
  for (const [nama, nilai] of Object.entries(process.env)) {
    if (!nilai || !POLA_NAMA_RAHASIA.test(nama) || String(nilai).length < 4) continue;
    t = t.split(nilai).join('***');
  }
  return t;
}

export function tolakDiriKanal(aksi, konf, { terminalBebas = false } = {}) {
  if (!kanalTakTepercaya(konf) || process.env.SAKTI_DIRI_KANAL === '1') return null;
  if (terminalBebas && process.env.SAKTI_TERMINAL_BEBAS === '1') return null;
  return 'DITOLAK: ' + aksi + ' dari kanal tak tepercaya "' + konf.kanal + '" (WA/Telegram/serve). ' +
    'Hanya riwayat yang boleh di sini (usul menjalankan uji = kode sembarang); jalankan dari CLI lokal, ' +
    'atau set SAKTI_DIRI_KANAL=1 di proses serve kalau memang disengaja.';
}
