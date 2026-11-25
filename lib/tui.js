// Workspace `sakti` - layar penuh, TANPA garis kotak.
//
// Acuan yang dibaca langsung dari sumbernya di mesin ini:
//   pi      -> tema `dark.json`: blok berlatar untuk pesan pengguna
//              (userMessageBg), panggilan alat (toolPendingBg / toolSuccessBg /
//              toolErrorBg), teks redup untuk keluaran alat; kop banner +
//              baris hint `escape interrupt · ctrl+c/ctrl+d · / commands`.
//   Hermes  -> tema `theme.ts` (accent #FFBF00, prompt #FFF8DC, ok #4caf50,
//              error #ef5350, surface #1a1a2e), kop berisi daftar alat + MCP,
//              panel samping, palet `/`.
//
// Jadi pemisah di sini BUKAN garis `─ │`: latar warna, tebal, dan jarak.
// Warna memakai 256 warna supaya tetap benar di terminal tanpa truecolor.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { ALAT, jalanAntreanPanggil, jalankanAlat } from './alat.js';
import { ambilAntreanPanggil } from './alat.js';
import { alihkanRoom, aturBawaan, aturRoom, bacaBot, botBawaan, botDiRoom, daftarBot, folderBot, hapusBot, konteksBot, promptBot, promptKoordinatorTim, simpanBot } from './bot.js';
import { pilihSubagen, ringkasSubagen, workerSubagen } from './subagen.js';
import { putaran, sempitAlat } from './agent.js';
import { bacaState, berkasState, ubahState } from './lokal.js';
import { EFFORT_SAH, effortAman, kemampuanModel, konfigModel, normalEffort, obrol, perluSegarkanKatalog, periksaModelTurunan, probeReasoning, ringkasKemampuan, ringkasModelTurunan, simpanKatalog, simpanModel, sinkronKatalog, tokenUntukEffort, ujiModel, umurKatalog } from './model.js';
import { TINGKAT_RUTE, formatRute, nilaiTingkat, ruteAktif, tingkatSah } from './rute.js';
import { bacaSesi, cabangSesi, daftarSesi, sesiBaru, sesiTerakhir } from './sesi.js';
import { lupakanIzin, modeIzin, setModeIzin } from './izin.js';
import { bedaCheckpoint, daftarCheckpoint, kembalikanCheckpoint } from './khazanah.js';
import { bacaRencana } from './rencana.js';
import { daftarSkill } from './skill.js';
import { daftarPerintah as daftarPerintahKustom, rangkaiPerintah } from './perintah.js';
import { daftarPesan } from './kotak.js';
import { MODE_ROOM, deteksiMode, jalankanRoom, modeRoomTersimpan, rangkumHasil, urutkanNamaPeserta, workerParalel } from './room.js';
import { tutupSekarang as tutupMcp } from './mcp-klien.js';
import { ringkasBiaya } from './biaya.js';
import { GAYA_INDIKATOR, angkaRingkas, bingkaiIndikator, gayaSah, konteksStatus, padatkanSegmen, segmenStatus, teksStatus } from './status.js';
import { barisPengaturan, peringatanTimpa, rapikanUrl, sensorRiwayat, ubahPengaturan } from './pengaturan.js';
import { bagiHasil, ringkasHasil } from './ringkas-hasil.js';
import { daftarPelajaran, hapusPelajaran, pelajaranAktif } from './pelajaran.js';
import { ikonAlat } from './ikon.js';
import { rawatLokal, ringkasRawat, tarikAman } from './rawat.js';
import { pindaiSampah, ringkasSampah, sapuSampah } from './bersih.js';
import { geserPilihan, jendelaPilihan, opsiAlat, opsiBot, opsiEffort, opsiIzin, opsiModel, opsiPanel, opsiPengaturan, opsiPerintah, opsiRute, opsiSesi, opsiToken, opsiWorker } from './pilih.js';

/** Isi /perintah: daftar perintah kustom. Dipisah agar bisa diuji tanpa TUI. */
export function daftarPerintahTui(sisa, dorong, cwd) {
  const semua = daftarPerintahKustom({ cwd });
  if (!sisa[0]) {
    dorong({ tipe: 'judul', teks: 'perintah kustom' });
    if (!semua.length) {
      dorong({ tipe: 'hasil', teks: 'belum ada. Buat: sakti perintah tulis <nama> "<isi>"' });
      return;
    }
    for (const satu of semua) {
      dorong({ tipe: 'hasil', teks: '/' + satu.nama + (satu.keterangan ? '  ' + satu.keterangan : '') });
    }
    return;
  }
  const isi = rangkaiPerintah(sisa[0], sisa.slice(1).join(' '), { cwd });
  dorong({ tipe: isi ? 'hasil' : 'galat', teks: isi || 'perintah tidak ada: ' + sisa[0] });
}

const TANDA_RENCANA = { pending: '[ ]', in_progress: '[~]', completed: '[x]', cancelled: '[-]' };

/* ------------------------------------------------------------ warna --- */

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const I = '\x1b[3m';
// NO_COLOR (no-color.org) / SAKTI_WARNA=0: matikan warna, bukan atribut.
// Terminal pipa/CI tetap dapat teks bersih tanpa kode 256 warna.
const WARNA = !process.env.NO_COLOR && String(process.env.SAKTI_WARNA == null ? '' : process.env.SAKTI_WARNA) !== '0';
const TRUECOLOR = WARNA && String(process.env.SAKTI_TRUECOLOR || '') === '1';
// Palet xterm-256 -> RGB untuk terminal truecolor. Indeks tetap sama, jadi
// tema tidak berubah; hanya presisi warna naik (gradien tidak banjir).
const rgb256 = (n) => {
  const i = Math.max(0, Math.min(255, Number(n) || 0));
  const dasar = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
  if (i < 16) return dasar[i];
  if (i < 232) {
    const kubus = [0, 95, 135, 175, 215, 255];
    const j = i - 16;
    return [kubus[Math.floor(j / 36)], kubus[Math.floor((j % 36) / 6)], kubus[j % 6]];
  }
  const abu = 8 + (i - 232) * 10;
  return [abu, abu, abu];
};
const fg = (n) => {
  if (!WARNA) return '';
  if (!TRUECOLOR) return '\x1b[38;5;' + n + 'm';
  const [r, g, b] = rgb256(n);
  return '\x1b[38;2;' + r + ';' + g + ';' + b + 'm';
};
const bg = (n) => {
  if (!WARNA) return '';
  if (!TRUECOLOR) return '\x1b[48;5;' + n + 'm';
  const [r, g, b] = rgb256(n);
  return '\x1b[48;2;' + r + ';' + g + ';' + b + 'm';
};

const W = {
  teks: fg(252), redup: fg(245), samar: fg(240),
  aksen: fg(141), biru: fg(111), hijau: fg(114), merah: fg(203), kuning: fg(221), cyan: fg(81)
};
const L = { pesan: bg(24), alat: bg(236), sukses: bg(22), gagal: bg(52), status: bg(236), sorot: bg(60), masukan: bg(235) };

const kolom = () => process.stdout.columns || 80;
const baris = () => process.stdout.rows || 24;

/* ------------------------------------------------------------------ lebar --- */

const PEMISAH_GRAFEM = (() => {
  try { return new Intl.Segmenter('und', { granularity: 'grapheme' }); }
  catch { return null; }
})();

const LEBAR_2_AWAL = /^[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}\u{1FB00}-\u{1FBFF}\u{20000}-\u{2FA1F}\u{30000}-\u{3FFFD}]/u;

// Satu sekuens ANSI: CSI (termasuk parameter titik dua), OSC (hyperlink), atau
// escape satu karakter. Versi lama hanya CSI `[0-9;?]`, jadi escape truecolor
// `38:2::…` dan OSC 8 dihitung sebagai teks biasa dan bisa terpotong separuh.
const ANSI_AWAL = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/;

/** Token teks: {ansi} lebar 0 atau {g, i, len} satu grapheme + posisi mentah. */
function* tokenkan(teks) {
  const t = String(teks == null ? '' : teks);
  let i = 0;
  while (i < t.length) {
    if (t[i] === '\x1b') {
      const cocok = ANSI_AWAL.exec(t.slice(i));
      if (cocok) { yield { ansi: cocok[0], i, len: cocok[0].length }; i += cocok[0].length; continue; }
      // Escape tidak lengkap (mis. potongan string tepat di tengah CSI): jangan
      // berputar di tempat. Perlakukan byte ESC sebagai grapheme lebar 0.
      yield { g: '\x1b', i, len: 1 };
      i += 1;
      continue;
    }
    let j = i;
    while (j < t.length && t[j] !== '\x1b') j += 1;
    const potongan = t.slice(i, j);
    if (PEMISAH_GRAFEM) {
      for (const s of PEMISAH_GRAFEM.segment(potongan)) yield { g: s.segment, i: i + s.index, len: s.segment.length };
    } else {
      let k = i;
      for (const g of Array.from(potongan)) { yield { g, i: k, len: g.length }; k += g.length; }
    }
    i = j;
  }
}

/** Lebar satu grapheme. Lone surrogate (bukan pasangan) = 1 kolom. */
function lebarGrafem(g) {
  const cp = String(g).codePointAt(0);
  if (g === '\u200D' || (cp >= 0xFE00 && cp <= 0xFE0F)) return 0;
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  return LEBAR_2_AWAL.test(g) ? 2 : 1;
}

/** Lebar kolom teks (polos atau ber-ANSI): mengikuti terminal — CJK/emoji 2 kolom, ZWJ 0. */
function lebar(teks) {
  let total = 0;
  for (const tk of tokenkan(teks)) if (tk.g) total += lebarGrafem(tk.g);
  return total;
}

/** Pecah jadi grafem sekaligus buang semua sekuens ANSI (CSI/OSC). */
function potong(teks, n) {
  const t = String(teks);
  if (lebar(t) <= n) return t;
  if (n <= 1) return '\u2026';
  let hasil = '';
  let kini = 0;
  for (const tk of tokenkan(t)) {
    if (tk.ansi) { hasil += tk.ansi; continue; }
    const gl = lebarGrafem(tk.g);
    if (kini + gl > n - 1) break;
    hasil += tk.g;
    kini += gl;
  }
  return hasil + R + W.samar + '\u2026' + R;
}

/** Kiri rata kiri, kanan rata kanan pada lebar K; sempit → kiri dipotong, kanan dipertahankan. */
function duaSisi(kiri, kanan, K) {
  const k = lebar(kiri);
  const r = lebar(kanan);
  if (k + r + 2 > K) return potong(kiri, Math.max(1, K - r - 2)) + (r + 2 <= K ? '  ' + kanan : '');
  return kiri + ' '.repeat(K - k - r) + kanan;
}

/** Segmen bilah status: label redup + nilai terang. */
function segmen(label, nilai, warna) {
  return D + W.samar + label + R + ' ' + B + (warna || W.teks) + nilai + R;
}

/** Gabung potongan dengan pemisah sambil membuang ekor sampai muat di ruang. */
function muat(bagian, ruang, pemisah) {
  const pisah = pemisah === undefined ? '  ' : pemisah;
  const sisa = bagian.slice();
  let teks = sisa.join(pisah);
  while (sisa.length > 1 && lebar(teks) > ruang) {
    sisa.pop();
    teks = sisa.join(pisah);
  }
  return teks;
}

/**
 * Bungkus teks ke lebar n, hormati baris baru, kata panjang, grafem utuh, dan
 * sekuens ANSI (lebar 0, tidak pernah dipotong). Mengembalikan baris + rentang
 * offset mentah supaya kursor bisa dihitung dengan pembungkusan yang SAMA.
 */
function bungkusRinci(teks, n) {
  const keluaran = [];
  const barisDari = (tokens) => {
    let isi = tokens.map((tk) => (tk.ansi ? tk.ansi : tk.g)).join('');
    // Baris yang membawa warna dan dipotong di tengah SGR tidak boleh mewarnai
    // baris berikutnya: tutup dengan reset.
    if (/\x1b\[[0-9;:]*m/.test(isi) && !isi.endsWith(R)) isi += R;
    return isi;
  };
  for (const bagian of String(teks).split('\n')) {
    if (!bagian) { keluaran.push({ teks: '', mulai: 0, akhir: 0 }); continue; }
    let tokens = [...tokenkan(bagian)];
    const lebarTokens = (arr) => arr.reduce((total, tk) => total + (tk.g ? lebarGrafem(tk.g) : 0), 0);
    let batasAwal = 0; // offset mentah awal baris setelah spasi pembungkus dibuang
    let putaran = 0;
    while (lebarTokens(tokens) > n) {
      // Jaring pengaman: jangan pernah membekukan TUI kalau ada bentuk token
      // yang tidak menyusut (mis. escape rusak). Satu grafem selalu diambil.
      if (++putaran > 10000) throw new Error('bungkus tidak menyusut (lebar ' + lebarTokens(tokens) + ', n ' + n + ')');
      const depan = [];
      let kini = 0;
      let idx = 0;
      let lastSpace = -1;
      for (; idx < tokens.length; idx += 1) {
        const tk = tokens[idx];
        if (!tk.g) { depan.push(tk); continue; }
        const gl = lebarGrafem(tk.g);
        if (kini + gl > n) break;
        depan.push(tk);
        kini += gl;
        if (tk.g === ' ' && kini > Math.floor(n * 0.5)) lastSpace = depan.length - 1;
      }
      // Grafem pertama lebih lebar dari n (emoji 2 kolom di kotak 1 kolom):
      // ambil satu grafem apa pun lebarnya supaya sisa pasti menyusut.
      if (!depan.some((tk) => tk.g)) {
        const satu = tokens.find((tk) => tk.g);
        const mentah = satu.i;
        keluaran.push({ teks: barisDari([satu]), mulai: mentah, akhir: mentah + satu.len });
        tokens = tokens.slice(tokens.indexOf(satu) + 1);
        while (tokens[0] && tokens[0].g === ' ') tokens.shift();
        batasAwal = tokens[0] ? tokens[0].i : bagian.length;
        continue;
      }
      const potongIdx = lastSpace >= 0 ? lastSpace : depan.length;
      const dipakai = depan.slice(0, potongIdx);
      const mentahAwal = dipakai.find((tk) => tk.g)?.i ?? batasAwal;
      const mentahAkhir = dipakai.filter((tk) => tk.g).reduce((akhir, tk) => Math.max(akhir, tk.i + tk.len), mentahAwal);
      keluaran.push({ teks: barisDari(dipakai), mulai: mentahAwal, akhir: mentahAkhir });
      tokens = tokens.slice(potongIdx);
      while (tokens[0] && tokens[0].g === ' ') tokens.shift();
      batasAwal = tokens[0] ? tokens[0].i : bagian.length;
    }
    const mentahAwal = tokens.find((tk) => tk.g)?.i ?? batasAwal;
    const mentahAkhir = tokens.filter((tk) => tk.g).reduce((akhir, tk) => Math.max(akhir, tk.i + tk.len), mentahAwal);
    keluaran.push({ teks: barisDari(tokens), mulai: mentahAwal, akhir: mentahAkhir });
  }
  return keluaran;
}

/** Bungkus teks ke lebar n (lihat bungkusRinci). */
function bungkus(teks, n) {
  return bungkusRinci(teks, n).map((row) => row.teks);
}

/**
 * Baris layar untuk blok masukan. Teks dibungkus TANPA awalan; awalan digambar
 * terpisah oleh pemanggil. Mengembalikan juga posisi kursor supaya penggambar
 * tidak menghitung lebar awalan dua kali - dulu awalan ikut dibungkus lalu
 * ditempel lagi, jadi baris pertama tampil "sakti › sakti › …".
 */
export function bingkaiMasukan(masukan, kursor, lebarKiri, awalan = 'sakti › ') {
  const teks = String(masukan == null ? '' : masukan);
  let posisi = Math.min(Math.max(0, Number(kursor) || 0), teks.length);
  // Kursor di tengah grapheme (mis. di antara dua half surrogate emoji) tidak
  // sah untuk terminal: tempelkan ke awal grapheme itu.
  for (const tk of tokenkan(teks)) {
    if (tk.g && tk.i < posisi && posisi < tk.i + tk.len) { posisi = tk.i; break; }
  }
  const lebarAwalan = lebar(awalan);
  // Minimal 2 kolom supaya emoji lebar-2 tidak memaksa satu grafem per baris.
  const muat = Math.max(2, Math.max(10, Number(lebarKiri) || 10) - 1 - lebarAwalan);
  const rinci = bungkusRinci(teks, muat);
  const baris = rinci.map((row) => row.teks);
  // Baris kursor ditentukan dari rentang mentah yang SAMA dengan pembungkusan
  // penuh. Dulu awalan dibungkus terpisah, jadi kursor melompat saat patah di
  // spasi (baris penuh 2 baris, awalan hanya 1).
  let indeksBaris = rinci.length - 1;
  for (let i = 0; i < rinci.length; i += 1) {
    const row = rinci[i];
    if (posisi <= row.akhir) { indeksBaris = i; break; }
    const berikut = rinci[i + 1];
    if (berikut && posisi < berikut.mulai) { indeksBaris = i + 1; break; }
  }
  const aktif = rinci[indeksBaris] || { mulai: 0 };
  const kolom = lebar(teks.slice(aktif.mulai, Math.max(aktif.mulai, posisi)));
  return {
    baris,
    barisKursor: indeksBaris,
    kolomKursor: 2 + lebarAwalan + kolom,
    lebarAwalan,
    muat
  };
}

/** Batas awal grapheme sebelum `posisi` (aman untuk emoji/ZWJ). */
function batasSebelum(teks, posisi) {
  const t = String(teks);
  let prev = 0;
  for (const tk of tokenkan(t)) {
    if (!tk.g) continue;
    if (tk.i + tk.len >= posisi) return tk.i;
    prev = tk.i;
  }
  return prev;
}

/** Batas akhir grapheme sesudah `posisi`. */
function batasSesudah(teks, posisi) {
  const t = String(teks);
  for (const tk of tokenkan(t)) {
    if (!tk.g) continue;
    if (tk.i >= posisi) return tk.i + tk.len;
  }
  return t.length;
}

/** Ambang jeda (ms): Enter yang datang lebih cepat dari ini dianggap bagian
 *  dari teks yang ditempel, bukan perintah kirim. Pasta ~0-2ms/ketikan. */
export const AMBANG_PASTA_MS = 120;
/** Jeda yang pasti mesin (bukan manusia): < 8ms antar ketikan. */
export const JEDA_MESIN_MS = 8;
/** Berapa ketikan rapat berturut-turut yang dianggap "ledakan pasta". */
export const LEDAKAN_PASTA = 4;

/** Pilihan tampil/sembunyi penalaran model (thinking). */
export const NALAR_SAH = ['tampil', 'sembunyi'];

/**
 * Baca setelan `nalar` dari config. Bawaan SEMBUNYI: penalaran bukan jawaban,
 * dan menampilkannya tanpa diminta membanjiri transkrip di terminal kecil.
 * Nilai asing tidak pernah melempar - jatuh ke bawaan.
 */
export function nalarSah(nilai, bawaan = 'sembunyi') {
  const teks = String(nilai == null ? '' : nilai).trim().toLowerCase();
  if (NALAR_SAH.includes(teks)) return teks;
  return NALAR_SAH.includes(bawaan) ? bawaan : 'sembunyi';
}

/**
 * Enter ini harus jadi BARIS BARU (bagian pasta) atau KIRIM? Murni supaya bisa
 * diuji. Tiga bukti, dari yang paling pasti:
 *   1. penanda bracketed paste masih terbuka (`sedangPaste`),
 *   2. jeda < JEDA_MESIN_MS - tidak ada manusia mengetik 8ms,
 *   3. ledakan >= LEDAKAN_PASTA ketikan rapat lalu Enter < AMBANG_PASTA_MS -
 *      terminal lama (Termux/iTerm tanpa `paste-start`) mengirim pasta seperti
 *      ini; mengetik biasa tidak pernah menghasilkan 4 ketikan < 25ms.
 * Tanpa satu pun bukti, Enter tetap KIRIM (tidak ada perubahan perilaku).
 */
export function enterSebagaiBaris({ sedangPaste = false, jeda = Number.POSITIVE_INFINITY, ledakan = 0, ambang = AMBANG_PASTA_MS } = {}) {
  if (sedangPaste) return true;
  const angka = Number(jeda);
  if (!Number.isFinite(angka)) return false;
  if (angka < JEDA_MESIN_MS) return true;
  return angka < Math.max(0, Number(ambang) || 0) && Number(ledakan) >= LEDAKAN_PASTA;
}

/** Gaya sebaris: **tebal**, `kode`, judul, butir. Warna pengganti tebal. */
function gaya(teks) {
  let s = String(teks);
  if (/^#{1,6}\s/.test(s)) return B + W.kuning + s.replace(/^#{1,6}\s*/, '') + R;
  if (/^\s*[-*]\s/.test(s)) s = s.replace(/^(\s*)[-*]\s/, '$1• ');
  s = s.replace(/\*\*([^*]+)\*\*/g, B + W.teks + '$1' + R);
  s = s.replace(/`([^`]+)`/g, W.cyan + '$1' + R);
  return s;
}

/**
 * Warnai baris diff (opencode style): + hijau, - merah, @@ cyan.
 * Hanya baris yang memang berbentuk diff; teks lain dibiarkan apa adanya.
 */
function warnaiDiff(teks) {
  const t = String(teks);
  if (/^\+/.test(t)) return W.hijau + t + R;
  if (/^-/.test(t)) return W.merah + t + R;
  if (/^@@/.test(t)) return W.cyan + t + R;
  return t;
}

/** Satu baris penuh berlatar: teks + sisa ruang diwarnai ikut. */
function sapu(teks, lebarBaris, warna, latar) {
  const isi = potong(teks, lebarBaris);
  const sisa = Math.max(0, lebarBaris - lebar(isi));
  return (latar || '') + (warna || '') + isi + (latar ? W.teks : '') + ' '.repeat(latar ? sisa : 0) + R + (latar ? '' : ' '.repeat(sisa));
}

/* ------------------------------------------------------------- isi ---- */

const KET = {
  '/help': 'bantuan lengkap',
  '/bantuan': 'sama dengan /help (daftar perintah + tombol)',
  '/baru': 'sesi baru',
  '/sesi': 'daftar chatroom (sesi) · /sesi = pilih · /sesi <id> melanjutkan',
  '/kotak': 'kotak pesan antar-bot · /kotak [nama bot] · status/id dari alat kotak',
  '/chatroom': 'sama dengan /sesi: daftar chatroom',
  '/bot': 'panel bot · /bot = menu masuk/lepas · /bot masuk <nama ...> | lepas <nama ...> | semua · /bot baru <nama> prompt="..." · /bot set <nama> kunci=nilai · /bot urut',
  '/worker': 'jumlah pekerja bersamaan: bot room >1 dan subagen · /worker = pilih · /worker <1-12>',
  '/room': 'siapa menjawab di room: solo (1 bot) | otomatis/tim (koordinator membagi tugas, bot lain dipanggil sesuai peran, tanpa kerja dobel) · /room tim',
  '/subagen': 'daftar subagen (peran, alat, kapan dipakai) · /subagen · /subagen pilih <teks tugas>',
  '/alat': 'panel alat · /alat = pilih subset · /alat baca,cari · /alat semua · /alat profil ringan|standar|penuh',
  '/skill': 'panel keahlian',
  '/ingatan': 'panel ingatan',
  '/tugas': 'panel tugas tersimpan',
  '/rencana': 'panel rencana kerja (todo lintas giliran)',
  '/panel': 'ganti panel samping · /panel = pilih',
  '/model': 'model & endpoint · /model = pilih dari daftar · /model <nama> · /model set model=.. url=.. key=.. · /model tes',
  '/pengaturan': 'endpoint & API key kustom di panel · /pengaturan · url <url> · key <kunci> · tes · hapus-key',
  '/effort': 'tingkat penalaran none|minimal|low|medium|high|xhigh|max|ultra · /effort = pilih · /effort tes = uji dukungan endpoint',
  '/nalar': 'tampilkan/sembunyikan penalaran (thinking) model · /nalar = setel · /nalar tampil|sembunyi (tersimpan di config)',
  '/pelajaran': 'pelajaran otomatis dari giliran yang memakai alat · /pelajaran · mati|hidup · hapus [kata]',
  '/rawat': 'rawat diri: perbaiki izin/folder/hook/sampah + tarik update kode · /rawat · periksa · update · auto on|off',
  '/bersih': 'bersih-bersih sampah (spill/checkpoint/tmp) · /bersih = pratinjau · /bersih hapus',
  '/token': 'anggaran token keluaran · /token = pilih · /token <n> · /token 0 = serahkan ke server',
  '/rute': 'smart route token: ringan=minimal, sulit=ultra · /rute = pilih · /rute on|off · /rute <tingkat> mematok',
  '/cwd': 'folder kerja sesi · /cwd <path>',
  '/izin': 'izin alat berisiko: auto | ask | never · /izin = pilih · /izin ask',
  '/undo': 'batalkan perubahan berkas terakhir (checkpoint) · /undo · /undo daftar · /undo <id>',
  '/diff': 'lihat beda berkas terhadap checkpoint terakhir · /diff · /diff <id>',
  '/biaya': 'biaya token: total + 5 panggilan terakhir · /biaya · /biaya <hari> = per model & per hari',
  '/indikator': 'gaya indikator kerja gaya Hermes: unicode (braille) | ascii | emoji · /indikator = pilih',
  '/perintah': 'perintah kustom (prompt tersimpan) · /perintah = pilih & jalankan · /perintah <nama> [argumen]',
  '/ringkas': 'ringkas sesi menjadi ingatan inti',
  '/cabang': 'salin sesi ini jadi sesi baru (opsional: sampai pesan ke-N) lalu pindah ke sana',
  '/atas': 'gulir transkrip ke atas (juga panah ↑ / PgUp, di HP juga)',
  '/bawah': 'gulir transkrip ke bawah',
  '/gulir': 'gulir transkrip ke nomor baris tertentu dari dasar · /gulir 0 (dasar) · /gulir puncak · Ctrl+Y/Ctrl+B sebaris',
  '/puncak': 'lompat ke pesan paling awal',
  '/dasar': 'lompat ke pesan paling baru',
  '/ulang': 'ulangi pesan terakhir',
  '/batal': 'hentikan giliran yang berjalan',
  '/keluar': 'simpan & keluar'
};
// Alias tidak ditampilkan dua kali di palet/bantuan. Perintah aslinya tetap
// ditangani; ini hanya mencegah daftar berisi dua nama untuk satu fungsi.
export const ALIAS_PERINTAH_TUI = Object.freeze({
  '/bantuan': '/help',
  '/chatroom': '/sesi'
});
export const PERINTAH_TUI = Object.freeze(Object.keys(KET).filter((nama) => !ALIAS_PERINTAH_TUI[nama]));
const PERINTAH = PERINTAH_TUI;
const PANEL = [null, 'bot', 'alat', 'skill', 'ingatan', 'tugas', 'rencana', 'chatroom', 'pengaturan'];

/** Pecah baris perintah dengan dukungan "kutip ganda". */
export function pecah(teks) {
  // Pisah per spasi, tapi kutip menempel: prompt="kamu analis" jadi satu token
  // "prompt=kamu analis". Regex /"([^"]*)"|\S+/ gagal di sini - kutip yang
  // muncul di tengah token (setelah `prompt=`) tidak pernah terlihat.
  const hasil = [];
  let kini = '';
  let kutip = null;
  for (const huruf of String(teks)) {
    if (kutip) {
      if (huruf === kutip) kutip = null; else kini += huruf;
      continue;
    }
    if (huruf === '"' || huruf === "'") { kutip = huruf; continue; }
    if (/\s/.test(huruf)) { if (kini) { hasil.push(kini); kini = ''; } continue; }
    kini += huruf;
  }
  if (kini) hasil.push(kini);
  return hasil;
}

/** Lokal terminal UTF-8? Non-UTF8 (C locale) → spinner ASCII, bukan braille. */
const LOKAL_UTF8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');

/** Durasi gaya pi: 0.4s, 1m 30s. */
const BINGKAI = LOKAL_UTF8
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['|', '/', '-', '\\'];

// Gaya indikator aktif untuk spinner KECIL di judul alat. Status bar memakai
// bingkaiIndikator() langsung; yang ini disetel workspace() supaya keduanya
// sejalan (dulu judul alat selalu braille walau /indikator emoji).
let GAYA_AKTIF = 'unicode';

/** Bingkai animasi kerja: berputar tiap 120ms selama agen bekerja. */
/**
 * Saring sekuens roda mouse (SGR: ESC [ < b ; x ; y M/m) DI LEVEL BYTE, sebelum
 * readline sempat memecahnya jadi ketikan sampah ("64;20;10M").
 * Selisih gulir ditumpuk dan diambil lewat ambilGulir().
 */
/**
 * Jaring pengaman aturan 9: dari blok satu giliran, susun rangkuman hasil kerja
 * kalau ada alat yang dipakai tapi jawaban akhir tidak memuat "Rangkuman".
 * Murni - tanpa model, tanpa I/O - supaya bisa diuji.
 */
export function rangkumanGiliran(baru) {
  const alat = (baru || []).filter((satu) => satu && satu.tipe === 'alat');
  if (!alat.length) return [];
  const agen = baru.filter((satu) => satu.tipe === 'agen');
  const akhir = agen.length ? String(agen[agen.length - 1].teks || '') : '';
  if (/rangkuman/i.test(akhir)) return [];
  // Nama alat tanpa awalan bot ("bot · terminal" -> "terminal"), lalu dihitung
  // per alat: `terminal×3, baca` lebih informatif daripada daftar 4 baris.
  const namaAlat = alat.map((satu) => String(satu.teks || '').split(' · ').pop() || '?');
  const hitung = new Map();
  for (const nama of namaAlat) hitung.set(nama, (hitung.get(nama) || 0) + 1);
  const daftarAlat = [...hitung.entries()].map(([nama, n]) => (n > 1 ? nama + '×' + n : nama)).join(', ');
  // Durasi tiap blok alat diisi saat hasilnya tiba; jumlahnya = waktu yang
  // dihabiskan di alat, terpisah dari waktu menunggu model.
  const totalMs = alat.reduce((n, satu) => n + (Number(satu.durasi) || 0), 0);
  const kunci = ['path', 'jalur', 'dari', 'ke', 'berkas'];
  const berkas = [...new Set(alat.flatMap((satu) => kunci.map((k) => satu.argumen && satu.argumen[k]).filter((v) => typeof v === 'string' && v)))].slice(0, 12);
  const hasil = baru.filter((satu) => satu && satu.tipe === 'hasil');
  const gagal = hasil.filter((satu) => satu.gagal);
  // Penalaran dihitung walau disembunyikan: pemakai berhak tahu model memakai
  // 1.2k karakter untuk berpikir, tanpa isinya ikut tercetak.
  const nalarKar = (baru || []).filter((satu) => satu && satu.tipe === 'nalar')
    .reduce((n, satu) => n + String(satu.teks || '').length, 0);
  const keluaran = [
    { tipe: 'judul', teks: 'Rangkuman' },
    { tipe: 'hasil', teks: '· ' + alat.length + ' langkah' + (totalMs ? ' · alat ' + durasi(totalMs) : '') + ', alat: ' + daftarAlat }
  ];
  if (nalarKar) keluaran.push({ tipe: 'hasil', teks: '· nalar ' + angkaRingkas(nalarKar) + ' kar · /nalar tampil untuk isinya' });
  if (berkas.length) keluaran.push({ tipe: 'hasil', teks: '· berkas tersentuh: ' + berkas.join(', ') });
  if (gagal.length) {
    keluaran.push({
      tipe: 'hasil',
      gagal: true,
      teks: '· ' + gagal.length + ' dari ' + hasil.length + ' langkah gagal: '
        + gagal.slice(0, 4).map((satu) => String(satu.alasan || satu.teks || '').slice(0, 60)).join(' | ')
        + (gagal.length > 4 ? ' (+' + (gagal.length - 4) + ')' : '')
    });
  }
  keluaran.push({ tipe: 'hasil', teks: '· periksa keluaran di atas sebagai bukti' });
  return keluaran;
}

export class SaringMouse extends PassThrough {
  #sisa = '';
  #gulir = 0;

  _transform(bagian, _kode, lanjut) {
    const teks = this.#sisa + bagian.toString('utf8');
    let putaran = 0;
    const bersih = teks.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_s, b, _x, _y, akhir) => {
      if (akhir === 'M') {
        const kode = Number(b);
        if (kode & 64) this.#gulir += (kode & 3) === 0 ? 1 : -1; // 0 roda naik, 1 roda turun
        putaran += (kode & 3) === 0 ? 1 : -1;
      }
      return '';
    });
    // Roda mouse TIDAK menghasilkan keypress (byte-nya sudah dibuang di sini),
    // jadi gulir harus dipancarkan sendiri. Dulu ambilGulir() hanya dipanggil
    // di dalam handler keypress -> roda tidak bereaksi sampai ada tombol ditekan.
    if (putaran) this.emit('gulir', putaran);
    // Tahan ekor yang mungkin awal sekuens mouse yang belum lengkap.
    const ekor = /\x1b(\[<?[\d;]*)?$/.exec(bersih);
    const aman = ekor ? bersih.slice(0, ekor.index) : bersih;
    this.#sisa = ekor ? ekor[0] : '';
    if (aman) this.push(aman);
    lanjut();
  }

  ambilGulir() {
    const n = this.#gulir;
    this.#gulir = 0;
    return n;
  }
}

/**
 * Satu langkah gulir transkrip, murni supaya bisa diuji.
 * gulir = jarak dari dasar (0 = paling bawah), batas = maksimum yang masuk akal.
 * arah: 'naik' | 'turun' | 'puncak' | 'dasar' | angka (menit dari dasar).
 */
export function langkahGulir({ gulir = 0, batas = 0, arah = 'naik', langkah = 3 } = {}) {
  const maks = Math.max(0, Number(batas) || 0);
  const sekarang = Math.min(Math.max(0, Number(gulir) || 0), maks);
  const jauh = Math.max(1, Math.abs(Number(langkah) || 1));
  if (arah === 'puncak') return maks;
  if (arah === 'dasar') return 0;
  if (typeof arah === 'number') return Math.min(maks, Math.max(0, Math.round(arah)));
  if (arah === 'turun') return Math.max(0, sekarang - jauh);
  return Math.min(maks, sekarang + jauh);
}

function bingkai() {
  if (GAYA_AKTIF === 'emoji') return bingkaiIndikator('emoji', Date.now());
  if (GAYA_AKTIF === 'ascii') return bingkaiIndikator('ascii', Date.now());
  return BINGKAI[Math.floor(Date.now() / 120) % BINGKAI.length];
}

function durasi(ms) {
  const kasar = Math.max(0, Math.round(Number(ms) || 0));
  if (kasar < 1000) return kasar + 'ms';
  const dtk = kasar / 1000;
  if (dtk < 60) return dtk.toFixed(1) + 's';
  const menit = Math.floor(dtk / 60);
  const sisa = Math.round(dtk % 60);
  return menit + 'm ' + (sisa ? sisa + 's' : '');
}

/** Baris argumen alat: `k: nilai`, nilai panjang dibungkus. */
function barisArgumen(argumen, n) {
  const isi = argumen && typeof argumen === 'object' ? Object.entries(argumen) : [];
  return isi.flatMap(([kunci, nilai]) => {
    const teks = typeof nilai === 'string' ? nilai : JSON.stringify(nilai);
    const satuBaris = String(teks).split('\n').join(' ');
    return bungkus('  ' + kunci + ': ' + satuBaris, n - 2).map((satu) => '  ' + satu.trim());
  });
}

function berkasRiwayat() {
  return path.join(path.dirname(berkasState()), 'history');
}

function muatRiwayat() {
  try { return fs.readFileSync(berkasRiwayat(), 'utf8').split('\n').filter(Boolean).slice(-500); } catch { return []; }
}

function simpanRiwayat(daftar) {
  try {
    fs.mkdirSync(path.dirname(berkasRiwayat()), { recursive: true });
    fs.writeFileSync(berkasRiwayat(), daftar.slice(-500).join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(berkasRiwayat(), 0o600); } catch { /* filesystem tanpa chmod */ }
  } catch { /* jangan gagalkan keluar */ }
}

/* --------------------------------------------------------- workspace -- */

export async function workspace({ ctx, konfModel: konfAwal, sesiId: sesiAwal, versi, worker: workerAwal }) {
  // Hidup, bukan beku: /model set harus langsung berlaku tanpa keluar app.
  let konfModel = konfAwal;
  // Berapa bot boleh bekerja bersamaan saat room punya >1 peserta. 1 = berurutan.
  let workerRoom = workerAwal;
  // ponytail: tanpa batas langkah - agen berjalan sampai tuntas.
  let sesiId = sesiAwal || sesiTerakhir() || sesiBaru({}).id;
  const riwayatInput = muatRiwayat();
  let posisiRiwayat = riwayatInput.length;

  let masukan = '';
  let kursor = 0;
  let sedangPaste = false;
  // Jeda sejak tombol sebelumnya. Pasta datang sebagai ledakan ketikan dengan
  // jeda ~0-2ms; manusia mengetik 50-200ms. Angka ini yang membedakan Enter
  // "bagian dari teks yang ditempel" dan Enter "kirim".
  let capWaktuTombol = 0;
  let jedaTombol = 0;
  // Ketikan rapat berturut-turut (jeda < 25ms). Terminal tanpa penanda pasta
  // mengirim teks tempel seperti ini; manusia tidak.
  let ledakanKetik = 0;
  // Waktu '\r' terakhir saat mode pasta, untuk menggabungkan CRLF jadi SATU baris.
  let crlfBaru = 0;
  let gulir = 0;
  let panel = null;
  let palet = 0;
  // Menu pilihan interaktif (/model, /effort, ...): { judul, opsi, indeks,
  // terapkan }. Selama aktif, panah menggerakkan kursor dan Enter menerapkan;
  // masukan biasa tidak ditelan supaya tidak mengetik di balik menu.
  let pemilih = null;
  let sibuk = false;
  let kendali = null;
  let keadaan = '';
  let mulaiGiliran = 0;
  let jumlahLangkah = 0;
  // Jumlah langkah yang GAGAL di giliran ini. Muncul di bilah status supaya
  // pemakai tahu ada yang merah bahkan saat transkrip sudah tergulir jauh.
  let galatGiliran = 0;
  // Karakter penalaran yang diterima giliran ini (dihitung walau disembunyikan,
  // supaya rangkuman bisa menyebut "nalar 1.2k" tanpa membocorkan isinya).
  let nalarGiliran = 0;
  const antrean = [];
  let terakhir = '';
  let keluar = false;
  let kotor = true;
  let rinci = false;
  let mulaiAlat = 0;
  let pewaktu = null;
  let animasi = null;
  // Bilah status gaya Hermes: token konteks + biaya giliran terakhir (dari
  // usage endpoint), cabang git folder kerja, dan gaya indikator pilihan.
  let konteksTerakhir = { dipakai: 0, maks: 0, total: 0, perkiraan: false };
  let biayaTerakhir = { prompt: 0, completion: 0, perkiraan: false };
  // Plafon konteks yang benar-benar dipakai rute (bisa lebih kecil dari
  // `--batas-token`). `onBiaya` tidak membawa max; `onRute` membawanya.
  let batasKonteks = 0;
  let gayaIndikator = gayaSah((konfModel && konfModel.indikator) || process.env.SAKTI_INDIKATOR, { utf8: LOKAL_UTF8 });
  GAYA_AKTIF = gayaIndikator;
  // Tampilkan penalaran? Bawaan sembunyi; `/nalar tampil` menyimpannya di config.
  let nalarTampil = nalarSah(process.env.SAKTI_NALAR || (konfModel && konfModel.nalar)) === 'tampil';
  const cabangGit = (() => {
    let folder = ctx.cwd;
    for (;;) {
      try {
        const kepala = fs.readFileSync(path.join(folder, '.git', 'HEAD'), 'utf8').trim();
        const cocok = /^ref:\s*refs\/heads\/(.+)$/.exec(kepala);
        if (cocok) return cocok[1];
        if (/^[0-9a-f]{7,}$/i.test(kepala)) return kepala.slice(0, 7);
      } catch { /* bukan repo di folder ini, cek induknya */ }
      const naik = path.dirname(folder);
      if (naik === folder) return '';
      folder = naik;
    }
  })();

  /* Jumlah skill dihitung sekali, bukan tiap gambar layar: `daftarSkill()`
     menelusuri 4 tingkat folder (terukur 24ms untuk 100 skill) dan dulu
     dipanggil di setiap frame - kedip tiap detik saat skill banyak.
     Dihitung ulang saat panel skill dibuka, setelah giliran, dan saat /skill. */
  let jumlahSkill = -1;
  const hitungSkill = () => {
    if (jumlahSkill < 0) { try { jumlahSkill = daftarSkill().length; } catch { jumlahSkill = 0; } }
    return jumlahSkill;
  };
  const lupakanSkill = () => { jumlahSkill = -1; };

  /* Cermin frame terakhir untuk penggambaran bertahap (anti-kedip). */
  const layarSebelum = [];

  const blok = [];
  const dorong = (satu) => { blok.push(satu); kotor = true; };
  let barisTranskrip = [];
  let lebarTerakhir = 0;
  /* Batas gulir yang benar-benar dipakai penggambar terakhir. Dihitung di
     gambar() karena tinggi area isi bergantung pada kop, palet, dan kotak
     masukan - bukan angka tetap. Sebelum gambar pertama, pakai perkiraan. */
  let batasGulir = 0;

  function muatTranskrip() {
    blok.length = 0;
    let alatTerakhir = null;
    for (const row of bacaSesi(sesiId)) {
      if (row.role === 'user') dorong({ tipe: 'user', teks: String(row.content || '') });
      else if (row.role === 'assistant' && row.content) {
        // Penalaran yang tersimpan ikut dipulihkan; renderer menyembunyikannya
        // kalau `/nalar` masih sembunyi, dan menampilkannya saat dinyalakan.
        if (row.nalar) dorong({ tipe: 'nalar', teks: String(row.nalar), nama: row.bot || null });
        dorong({ tipe: 'agen', nama: row.bot || null, teks: String(row.content) });
      }
      else if (row.role === 'assistant' && row.tool_calls) {
        alatTerakhir = { tipe: 'alat', teks: row.tool_calls.map((s) => s.function.name).join(', ') };
        dorong(alatTerakhir);
      } else if (row.role === 'tool') {
        // Sesi lama tidak menyimpan ringkasan; hitung ulang supaya transkrip
        // yang dimuat pun menampilkan exit/timeout dan ukuran, bukan hanya
        // baris pertama tanpa keterangan.
        const r = ringkasHasil(row.name || '', row.content || '');
        if (alatTerakhir && r.gagal) alatTerakhir.gagal = true;
        dorong({ tipe: 'hasil', penuh: String(row.content || ''), teks: r.daftar[0] || '', gagal: r.gagal, alasan: r.alasan, label: r.label });
      }
    }
    gulir = 0;
    kotor = true;
    lebarTerakhir = 0;
  }

  /* ---------------------------------------------------------- gambar -- */

  /** Ubah daftar blok jadi baris layar (sudah berwarna, belum dipotong lebar). */
  function bangunTranskrip(n) {
    if (lebarTerakhir === n && !kotor) return;
    lebarTerakhir = n;
    kotor = false;
    const keluaran = [];
    let pertama = true;

    for (const satu of blok) {
      if (satu.tipe === 'user') {
        if (!pertama) keluaran.push('');
        bungkus(satu.teks, n - 4).forEach((barisnya, i) => {
          keluaran.push(sapu((i === 0 ? '› ' : '  ') + barisnya, n, W.teks, L.pesan));
        });
        keluaran.push('');
      } else if (satu.tipe === 'agen') {
        // Nomor urut tugas ditampilkan supaya saat paralel pembaca tahu siapa
        // yang seharusnya bicara lebih dulu, walau bloknya datang lebih akhir.
        if (satu.nama) {
          const label = satu.urut ? satu.urut + '. ' + satu.nama : satu.nama;
          keluaran.push(' ' + B + W.aksen + label + R);
        }
        let kode = false;
        for (const barisnya of bungkus(satu.teks, n - 2)) {
          if (/^\s*```/.test(barisnya)) { kode = !kode; continue; }
          if (kode) keluaran.push(sapu('   ' + barisnya, n, W.hijau, L.alat));
          else keluaran.push(' ' + (barisnya.trim() ? gaya(barisnya) : '') + R);
        }
        keluaran.push('');
      } else if (satu.tipe === 'nalar') {
        // Penalaran (thinking): digambar hanya saat diminta. Disembunyikan =
        // benar-benar tidak ada di layar, tapi bloknya tetap disimpan sehingga
        // `/nalar tampil` bisa menampilkannya tanpa memanggil model lagi.
        if (!nalarTampil) continue;
        const teksNalar = String(satu.teks || '').replace(/\s+$/, '');
        const barisNalar = teksNalar ? teksNalar.split('\n') : [];
        const batasNalar = rinci ? 40 : 6;
        keluaran.push(' ' + D + I + W.samar + '✻ nalar' + (satu.nama ? ' · ' + satu.nama : '') + ' · ' + angkaRingkas(teksNalar.length) + ' kar' + R);
        for (const satuBaris of barisNalar.slice(0, batasNalar)) {
          keluaran.push(' ' + D + I + W.samar + '  ' + satuBaris.replace(/\t/g, '  ') + R);
        }
        if (barisNalar.length > batasNalar) {
          keluaran.push(' ' + D + I + W.samar + '  … ' + (barisNalar.length - batasNalar) + ' baris nalar lagi · Ctrl+T rinci' + R);
        }
        keluaran.push('');
      } else if (satu.tipe === 'alat') {
        // Alat yang belum selesai berputar, yang sudah selesai menampilkan durasinya.
        // Gagal ditandai di judul (✗) supaya terlihat tanpa membaca badan hasil.
        const tanda = satu.gagal ? '✗ ' : '▸ ';
        const judul = ' ' + tanda + satu.teks + (satu.durasi ? '  ' + durasi(satu.durasi) : sibuk ? '  ' + W.kuning + bingkai() + R : '');
        if (satu.argumen && Object.keys(satu.argumen).length) {
          if (rinci) {
            keluaran.push(sapu(judul, n, satu.gagal ? W.merah : W.teks, L.alat));
            for (const satuBaris of barisArgumen(satu.argumen, n)) keluaran.push(sapu(' ' + satuBaris, n, W.redup, L.alat));
          } else {
            const pasangan = Object.entries(satu.argumen).map(([k, v]) => k + '=' + String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ')).join('  ');
            keluaran.push(sapu(judul + '  ' + potong(pasangan, Math.max(8, n - lebar(judul) - 3)), n, satu.gagal ? W.merah : W.redup, L.alat));
          }
        } else keluaran.push(sapu(judul, n, satu.gagal ? W.merah : W.teks, L.alat));
      } else if (satu.tipe === 'hasil') {
        // `gagal` sudah diputuskan ringkas-hasil (bukti: awalan status, GAGAL
        // (kode), timeout) - bukan tebakan dari baris pertama saja.
        const gagal = satu.gagal === true;
        const isi = String(satu.penuh != null ? satu.penuh : satu.teks || '').replace(/\s+$/, '');
        const semua = isi ? isi.split('\n') : ['(kosong)'];
        const batas = rinci ? 120 : 10;
        const bagi = bagiHasil(semua, batas);
        const latar = gagal ? L.gagal : L.sukses;
        for (const satuBaris of bagi.kepala) {
          const isiBaris = warnaiDiff(satuBaris.replace(/\t/g, '  '));
          keluaran.push(sapu('   ' + isiBaris, n, W.teks, latar));
        }
        if (bagi.dilewati) {
          keluaran.push(sapu('   … ' + bagi.dilewati + ' baris dilewati · Ctrl+T buka penuh', n, W.redup, latar));
        }
        for (const satuBaris of bagi.ekor) {
          const isiBaris = warnaiDiff(satuBaris.replace(/\t/g, '  '));
          keluaran.push(sapu('   ' + isiBaris, n, W.teks, latar));
        }
        // Satu baris ringkas: exit/timeout, jumlah temuan, ukuran, durasi.
        if (satu.label) {
          keluaran.push(sapu('   ⤷ ' + satu.label, n, gagal ? W.merah : W.redup, latar));
        }
        keluaran.push('');
      } else if (satu.tipe === 'galat') {
        for (const barisnya of bungkus(satu.teks, n - 2)) keluaran.push(' ' + W.merah + barisnya + R);
        keluaran.push('');
      } else if (satu.tipe === 'info') {
        for (const barisnya of bungkus(satu.teks, n - 2)) keluaran.push(' ' + D + I + W.redup + barisnya + R);
      } else if (satu.tipe === 'judul') {
        keluaran.push('');
        keluaran.push(' ' + B + W.aksen + satu.teks + R);
      } else if (satu.tipe === 'banner') {
        for (const barisnya of satu.baris) keluaran.push(' ' + barisnya + R);
        keluaran.push('');
      } else {
        for (const barisnya of bungkus(satu.teks, n - 2)) keluaran.push(' ' + W.teks + barisnya + R);
      }
      pertama = false;
    }
    barisTranskrip = keluaran;
  }

  function banner(pertahankan = false) {
    /* baris keadaan sudah memuat alat/skill/ingatan: kop cukup model, folder, dan satu petunjuk */
    // `pertahankan` dipakai saat app dibuka dengan sesi lama: transkrip sudah
    // dimuat, jangan dihapus hanya karena petunjuk ditambahkan.
    if (!pertahankan) blok.length = 0;
    dorong({
      tipe: 'banner',
      baris: [D + W.redup + potong('tulis pesan · /bantuan teks atau /help pintasan', Math.max(10, kolom() - 2)) + R]
    });
  }

  function isiPanel(n) {
    const state = bacaState();
    if (panel === 'bot') {
      const room = botDiRoom(sesiId);
      const semua = daftarBot();
      if (!semua.length) return [D + W.redup + '(belum ada bot)' + R, D + W.redup + 'buat: /bot baru <nama> prompt="kamu …"' + R];
      return semua.flatMap((bot) => {
        const masuk = room.includes(bot.nama);
        const tanda = masuk ? W.hijau + '▸ ' + R : D + '  ' + R;
        const baris1 = tanda + (masuk ? B + W.teks : W.redup) + potong(bot.nama, n - 3) + R;
        const ket = [bot.model || 'model bawaan', bot.alat && bot.alat.length ? bot.alat.length + ' alat' : 'semua alat'].join(' · ');
        return [baris1, D + W.samar + '  ' + potong(ket, n - 2) + R];
      });
    }
    if (panel === 'alat') return ALAT.map((satu) => ikonAlat(satu.name) + ' ' + B + W.teks + satu.name + R + ' ' + D + W.redup + potong(satu.label || satu.description.split('.')[0], Math.max(4, n - lebar(satu.name) - 3)) + R);
    if (panel === 'skill') {
      lupakanSkill();
      return daftarSkill().slice(0, 200).flatMap((satu) => [B + W.biru + potong(satu.nama, n) + R, D + W.redup + potong(satu.deskripsi, n) + R]);
    }
    if (panel === 'ingatan') {
      const inti = (state.mind || []).map((row) => W.teks + '• ' + potong(row.teks, n - 2) + R);
      const biasa = (state.ingatan || []).slice(-40).map((row) => D + W.redup + '· ' + potong(row.teks, n - 2) + R);
      return [...(inti.length ? [B + W.aksen + 'inti' + R, ...inti, ''] : []), ...(biasa.length ? [B + W.aksen + 'catatan' + R, ...biasa] : [D + W.redup + '(kosong)' + R])];
    }
    if (panel === 'tugas') {
      const tugas = Object.entries(state.tugas || {});
      return tugas.length ? tugas.flatMap(([nama, perintah]) => [B + W.teks + nama + R, D + W.redup + potong(perintah, n) + R]) : [D + W.redup + '(belum ada tugas)' + R];
    }
    if (panel === 'rencana') {
      const rows = bacaRencana();
      if (!rows.length) return [D + W.redup + '(rencana kosong)' + R, D + W.redup + 'agen menulis rencana sendiri lewat alat rencana' + R];
      const warna = { pending: W.redup, in_progress: W.kuning, completed: W.hijau, cancelled: W.samar };
      return rows.map((row) => (warna[row.status] || W.redup) + TANDA_RENCANA[row.status] + ' ' + potong(row.isi, n - 5) + R);
    }
    if (panel === 'chatroom' || panel === 'sesi') {
      return daftarSesi().slice(0, 30).map((row) => (row.id === sesiId ? W.aksen + '▸ ' + B : D + '  ') + row.id.slice(-8) + R + ' ' + D + W.redup + row.pesan + ' · ' + new Date(row.waktu).toISOString().slice(5, 16).replace('T', ' ') + R);
    }
    if (panel === 'pengaturan') {
      const rute = ruteAktif(konfModel)
        ? (konfModel.ruteTingkat ? 'on, dipatok ' + tingkatSah(konfModel.ruteTingkat) : 'on, auto')
        : 'off';
      const baris = barisPengaturan(konfModel, { rute, izin: modeIzin(), worker: workerRoom });
      return baris.map((satu) => (satu.startsWith('api key') && konfModel.apiKey ? W.kuning : W.teks) + potong(satu, n) + R);
    }
    return [];
  }

  /**
   * Buka menu pilihan. `terapkan(opsi)` dipanggil setelah Enter; menu ditutup
   * lebih dulu supaya handler boleh membuka menu lain (mis. muat katalog).
   */
  function bukaPemilih(paket, terapkan) {
    if (!paket || !Array.isArray(paket.opsi) || !paket.opsi.length) return false;
    const aktif = paket.opsi.findIndex((satu) => satu && satu.aktif);
    pemilih = { judul: paket.judul || 'pilih', opsi: paket.opsi, indeks: aktif >= 0 ? aktif : 0, terapkan };
    kotor = true;
    gambarNanti();
    return true;
  }

  function terapkanPemilih() {
    const kini = pemilih;
    if (!kini) return;
    const opsi = kini.opsi[kini.indeks];
    pemilih = null;
    kotor = true;
    try { kini.terapkan(opsi); }
    catch (galat) { dorong({ tipe: 'galat', teks: 'pilihan gagal: ' + String((galat && galat.message) || galat) }); }
    gambarNanti();
  }

  function tutupPemilih() {
    if (!pemilih) return;
    pemilih = null;
    kotor = true;
    gambarNanti();
  }

  function paletCocok() {
    const kata = masukan.slice(1).toLowerCase();
    return PERINTAH.filter((satu) => satu.slice(1).startsWith(kata));
  }

  function gambar() {
    const K = kolom();
    const T = baris();
    const layar = [];

    // ---- kop (2 baris, tanpa garis)
    const judul = 'sakti ' + versi;
    const ruangKanan = Math.max(8, K - lebar(judul) - 6);
    const folder = D + W.redup + potong(ctx.cwd, Math.min(ruangKanan, Math.max(12, Math.floor(K / 3)))) + R;
    const model = potong(konfModel.model, Math.max(8, ruangKanan - lebar(folder) - 3));
    // Hermes `StatusRule`: model │ konteks (persen) │ cabang git, dengan
    // pemadatan berprioritas - cabang hilang lebih dulu, lalu ctx; model+folder
    // (segmen utama) tidak pernah dibuang.
    const ktx = konteksStatus({ dipakai: konteksTerakhir.dipakai, maks: konteksTerakhir.maks, total: konteksTerakhir.total, perkiraan: konteksTerakhir.perkiraan });
    const utama = model + ' ' + D + W.samar + '·' + R + ' ' + folder;
    const sisaRuang = () => Math.max(8, ruangKanan) - lebar(utama) - 2;
    const bagian = [];
    if (ktx.label && lebar(ktx.label) <= sisaRuang()) bagian.push((ktx.pct != null ? W.aksen : W.redup) + ktx.label + R);
    if (cabangGit && lebar(ktx.label) + lebar(cabangGit) + 4 <= sisaRuang()) bagian.push(D + W.redup + '⑂ ' + cabangGit + R);
    const kanan = [utama, ...bagian].join('  ');
    layar.push(' ' + duaSisi(B + W.aksen + judul + R, kanan, K - 2) + ' ');

    const state = bacaState();
    const roomSekarang = (() => { try { return botDiRoom(sesiId); } catch { return []; } })();
    const info = [segmen('room', String(sesiId).slice(-10)), segmen('alat', String(ALAT.length)), segmen('skill', String(hitungSkill())), segmen('ingatan', String((state.ingatan || []).length + (state.mind || []).length))];
    if (modeIzin() !== 'auto') info.push(segmen('izin', modeIzin(), W.kuning));
    if (roomSekarang.length) info.push(segmen('bot', roomSekarang.join(' '), W.hijau));
    // Indikator berputar hanya DI SATU tempat (bilah status bawah, gaya Hermes
    // `FaceTicker`); kop cukup menyebut keadaan alat + jumlah langkah supaya
    // tidak ada dua animasi yang bersaing di layar.
    const kerja = sibuk
      ? W.kuning + B + (keadaan || 'bekerja') + R + (jumlahLangkah ? '  ' + segmen('langkah', String(jumlahLangkah)) : '') + (antrean.length ? '  ' + segmen('antrean', String(antrean.length)) : '')
      : segmen('status', 'siap', W.hijau);
    // Layar sangat pendek (<=15 baris): kop satu baris saja. Baris keadaan
    // kedua dimakan ruang masukan/transkrip dan membuat TUI terasa sesak.
    if (T >= 16) {
      const infoMuat = muat(info, Math.max(10, K - 2 - lebar(kerja) - 2));
      layar.push(' ' + infoMuat + (infoMuat ? '  ' : '') + kerja + ' ');
    }

    // ---- ukuran
    const panelBuka = panel !== null && K >= 64; // ruang sempit: panel disembunyikan
    const lebarPanel = panelBuka ? Math.max(22, Math.min(44, K - 46)) : 0;
    const jarak = panelBuka ? 3 : 0;
    const lebarKiri = panelBuka ? K - lebarPanel - jarak : K;

    const awalan = 'sakti › ';
    const masuk = bingkaiMasukan(masukan, kursor, lebarKiri, awalan);
    const barisMasukan = masuk.baris;

    // Palet `/` hanya saat tidak ada menu pilihan; menu pilihan menang supaya
    // panah tidak berebut antara riwayat, palet, dan daftar.
    const daftarPalet = !pemilih && masukan.startsWith('/') && !sibuk ? paletCocok() : [];
    const daftarOpsi = pemilih ? pemilih.opsi : daftarPalet;
    // Jendela masukan: baris kursor SELALU terlihat. Masukan bisa ratusan baris
    // (paste besar); tanpa jendela ini baris kursor tersungkur ke bawah layar.
    const barisKursorIdx = masuk.barisKursor;
    const maksBarisMasukan = Math.max(2, T - (T < 16 ? 3 : 4)); // kop + status + napas
    const awalMasukan = Math.max(0, Math.min(barisKursorIdx - maksBarisMasukan + 1, barisMasukan.length - maksBarisMasukan));
    const jendelaMasukan = barisMasukan.slice(awalMasukan, awalMasukan + maksBarisMasukan);
    // Daftar pilihan: jendela bergulir mengikuti kursor; tekan ↓ terus sampai
    // menu habis. Judul memakan satu baris tambahan saat menu pilihan aktif.
    const maksTinggiOpsi = Math.max(1, Math.min(daftarOpsi.length, Math.max(2, T - 3 - jendelaMasukan.length)));
    const indeksOpsi = pemilih ? pemilih.indeks : (daftarOpsi.length ? palet % daftarOpsi.length : 0);
    const jendelaOpsi = jendelaPilihan(indeksOpsi, daftarOpsi.length, maksTinggiOpsi);
    const tinggiOpsi = jendelaOpsi.n;
    const tinggiPalet = tinggiOpsi ? tinggiOpsi + (pemilih ? 1 : 0) : 0;
    const tampilOpsi = daftarOpsi.slice(jendelaOpsi.awal, jendelaOpsi.awal + tinggiOpsi);

    const awalIsi = layar.length;
    // Jendela masukan dipakai sebagai tinggi blok; palet menimpa bagian atas
    // transkrip, dan gulir ditambah bila palet lebih tinggi dari jendela masukan.
    const tinggiMasukan = jendelaMasukan.length;
    const tinggiIsi = Math.max(3, T - awalIsi - tinggiMasukan - 1);

    bangunTranskrip(lebarKiri);
    const semua = barisTranskrip;
    const maksGulir = Math.max(0, semua.length - tinggiIsi + tinggiPalet);
    batasGulir = maksGulir;
    if (gulir > maksGulir) gulir = maksGulir;
    const akhir = semua.length - gulir;
    const mulai = Math.max(0, akhir - tinggiIsi + tinggiPalet);
    const potongan = semua.slice(mulai, mulai + tinggiIsi - tinggiPalet);

    const isiPanelBaris = panelBuka ? isiPanel(lebarPanel).flatMap((satu) => String(satu).split('\n')) : [];

    for (let i = 0; i < tinggiIsi; i += 1) {
      const kiri = potongan[i] || '';
      if (panelBuka) {
        const kepala = i === 0;
        const kananIsi = kepala ? sapu(B + W.aksen + ' ' + panel + R, lebarPanel, null, L.status) : potong(isiPanelBaris[i - 1] || '', lebarPanel);
        layar.push(potong(kiri, lebarKiri) + ' '.repeat(Math.max(0, lebarKiri - lebar(kiri))) + ' '.repeat(jarak) + kananIsi);
      } else {
        layar.push(kiri);
      }
    }

    // ---- palet `/` atau menu pilihan
    if (tinggiPalet) {
      const awalPalet = layar.length - tinggiPalet;
      let geserBaris = 0;
      if (pemilih) {
        const judulMenu = ' ' + B + W.aksen + pemilih.judul + R + D + W.redup + '  ↑↓ pilih · Enter pakai · Esc batal' + R;
        layar[awalPalet] = sapu(judulMenu, lebarKiri, null, null) + (panelBuka ? ' '.repeat(jarak + lebarPanel) : '');
        geserBaris = 1;
      }
      for (let i = 0; i < tinggiOpsi; i += 1) {
        const indeksNama = jendelaOpsi.awal + i;
        const sorot = indeksNama === indeksOpsi;
        let isi;
        if (pemilih) {
          const opsi = tampilOpsi[i] || {};
          const ket = opsi.ket ? '  ' + D + W.samar + opsi.ket + R : '';
          const label = potong(String(opsi.label || ''), Math.max(6, lebarKiri - 6 - lebar(opsi.ket || '')));
          isi = (sorot ? ' ▸ ' : '   ') + label + ket;
        } else {
          const nama = tampilOpsi[i];
          isi = (sorot ? ' ▸ ' : '   ') + nama.padEnd(10) + (KET[nama] || '');
        }
        layar[awalPalet + geserBaris + i] = sapu(isi, lebarKiri, sorot ? W.teks : W.redup, sorot ? L.sorot : null) + (panelBuka ? ' '.repeat(jarak + lebarPanel) : '');
      }
    }

    // ---- masukan: blok berlatar penuh, padding 1 kolom; awalan digambar
    // SEKALI di sini (bukan ikut dibungkus) supaya tidak tampil dobel.
    jendelaMasukan.forEach((satu, i) => {
      const kepala = awalMasukan + i === 0;
      const isi = (kepala ? B + W.aksen + awalan + R : ' '.repeat(masuk.lebarAwalan)) + W.teks + (satu || '') + R;
      layar.push(L.masukan + ' ' + isi + ' '.repeat(Math.max(0, lebarKiri - lebar(isi) - 1)) + R + (panelBuka ? ' '.repeat(jarak + lebarPanel) : ''));
    });

    // ---- baris status (bilah penuh berwarna, pengganti garis)
    // Indikator gaya Hermes: bingkai berputar + kata kerja bergiliran + durasi,
    // lalu model/konteks/biaya/cabang. Segmen dipadatkan otomatis saat sempit
    // (biaya hilang dulu) supaya petunjuk tombol tidak pernah terdorong keluar.
    const tandaGulir = gulir ? '  ↑' + gulir + '/' + batasGulir + (gulir >= batasGulir ? ' puncak' : '') : '';
    const msGiliran = sibuk ? Date.now() - mulaiGiliran : 0;
    const biayaGiliran = (biayaTerakhir.prompt || biayaTerakhir.completion)
      ? (biayaTerakhir.perkiraan ? '~' : '') + angkaRingkas(biayaTerakhir.prompt) + '+' + angkaRingkas(biayaTerakhir.completion)
      : '';
    const semuaSegmen = segmenStatus({
      sibuk,
      ms: msGiliran,
      gaya: gayaIndikator,
      kerjaTetap: sibuk ? (keadaan === '' ? '' : keadaan) : '',
      model: '',
      konteks: {},
      biaya: biayaGiliran,
      cabang: '',
      antrean: antrean.length,
      galat: galatGiliran,
      izin: modeIzin()
    });
    const petunjuk = (panel ? ['panel ' + panel] : ['Ctrl+O panel']).concat([rinci ? 'Ctrl+T ringkas' : 'Ctrl+T rinci', '/help', 'Ctrl+C']);
    let kananStatus = petunjuk.join(' · ');
    const ruangStatus = Math.max(10, K - 6 - lebar(kananStatus));
    const segmenMuat = padatkanSegmen(semuaSegmen, ruangStatus, lebar);
    const kiriStatus = teksStatus(segmenMuat) + tandaGulir;
    const ruang = K - lebar(kiriStatus) - 6;
    while (petunjuk.length > 1 && lebar(kananStatus) > ruang) {
      petunjuk.splice(1, 1);
      kananStatus = petunjuk.join(' · ');
    }
    // Sisakan kolom terakhir: menulis tepat selebar terminal di baris paling
    // bawah membuat banyak terminal menandai wrap-pending lalu SCROLL satu baris
    // tiap frame. Gejalanya: bilah status berulang membanjiri scrollback
    // (⠙ sulhan · ⏳ latar ... berkali-kali). K-1 = aman dari autowrap.
    const lebarStatus = Math.max(1, K - 1);
    const isiStatus = ' ' + duaSisi(B + (sibuk ? W.kuning : W.hijau) + kiriStatus + R, D + W.redup + kananStatus + R, Math.max(1, lebarStatus - 2)) + ' ';
    layar.push(sapu(isiStatus, lebarStatus, null, L.status));

    // ---- tulis: hanya baris yang berubah. Menggambar ulang seluruh layar
    // tiap 120 ms membuat Termux berkedip; diff + satu gerak kursor tidak.
    const sampai = Math.min(layar.length, T);
    let keluaran = '';
    for (let i = 0; i < sampai; i += 1) {
      const baris = layar[i] + R + '\x1b[K';
      if (layarSebelum[i] === baris) continue;
      layarSebelum[i] = baris;
      keluaran += '\x1b[' + (i + 1) + ';1H' + baris;
    }
    if (layarSebelum.length > sampai) {
      for (let i = sampai; i < layarSebelum.length; i += 1) {
        keluaran += '\x1b[' + (i + 1) + ';1H\x1b[K';
        layarSebelum[i] = undefined;
      }
      layarSebelum.length = sampai;
    }

    // Kursor: baris dalam JENDELA masukan, bukan baris penuh - dengan masukan
    // ratusan baris, baris penuh akan meletakkan kursor di luar layar.
    const barisDalamJendela = Math.min(jendelaMasukan.length - 1, Math.max(0, barisKursorIdx - awalMasukan));
    const nomorBarisKursor = awalIsi + tinggiIsi + barisDalamJendela + 1;
    const kolomKursor = masuk.kolomKursor;
    keluaran += '\x1b[' + Math.min(nomorBarisKursor, T) + ';' + Math.min(kolomKursor, K) + 'H';
    if (keluaran) process.stdout.write(keluaran);
  }

  /**
   * Jaring pengaman aturan 9: kalau giliran ini memakai alat tapi jawaban akhir
   * tidak memuat "Rangkuman", tambahkan rangkuman hasil kerja sendiri - tanpa
   * memanggil model lagi, jadi cepat dan tidak menambah biaya.
   */
  function rangkumanOtomatis(titikAwal) {
    const tambahan = rangkumanGiliran(blok.slice(titikAwal));
    if (!tambahan.length) return 0;
    for (const satu of tambahan) dorong(satu);
    gambarNanti();
    return tambahan.length;
  }

  function gambarNanti() {
    if (pewaktu) return;
    pewaktu = setTimeout(() => { pewaktu = null; gambar(); }, 16);
  }

  /* ---------------------------------------------------------- izin ---- */

  // Mode teks memakai readline; di layar penuh raw mode memegang stdin, jadi
  // pertanyaan digantung di baris status dan dijawab tombol: y = ya, t/Enter =
  // tolak, s = selalu (panggilan sama tidak ditanya lagi).
  let tanyaAktif = null;
  // Antrean izin: beberapa worker paralel bisa bertanya bersamaan. Dulu satu
  // slot ditimpa, promise pertama tidak pernah selesai, dan room menggantung.
  const antreIzin = [];

  function tampilkanIzin(row) {
    tanyaAktif = row;
    // Tindakan wajib tidak punya pilihan "selalu": tulis alasannya di baris
    // status supaya pemilik tahu apa yang sebenarnya akan terjadi.
    keadaan = (row.wajib ? 'WAJIB: ' + row.wajib : 'izin ' + row.nama) + '? y / ' + (row.wajib ? 't' : 't / s');
    gambarNanti();
  }

  function tanyaIzinTui(pertanyaan, info) {
    return new Promise((selesai) => {
      const row = {
        nama: (info && info.nama) || '',
        wajib: (info && info.wajib) || '',
        selesai
      };
      if (tanyaAktif) {
        antreIzin.push(row);
        keadaan = 'menunggu izin lain (' + tanyaAktif.nama + ') · ' + antreIzin.length + ' antre';
        gambarNanti();
        return;
      }
      tampilkanIzin(row);
    });
  }

  function jawabIzin(tombol) {
    const aktif = tanyaAktif;
    if (!aktif) return;
    tanyaAktif = null;
    keadaan = '';
    const nama = tombol && tombol.name;
    const huruf = nama === 'return' || nama === 'enter' ? 't' : String((tombol && tombol.sequence) || '').toLowerCase();
    // "selalu" hanya untuk pertanyaan biasa; tindakan wajib harus dijawab
    // setiap kali (s tidak boleh menjadi izin permanen).
    const jawab = huruf === 'y' || (huruf === 's' && !aktif.wajib) ? huruf : 't';
    aktif.selesai(jawab);
    dorong({ tipe: 'info', teks: 'izin ' + aktif.nama + ': ' + (jawab === 'y' ? 'ya' : jawab === 's' ? 'selalu' : 'tolak') });
    const berikut = antreIzin.shift();
    if (berikut) tampilkanIzin(berikut);
    else gambarNanti();
  }

  /* -------------------------------------------------------- giliran ---- */

  async function jalankan(pesan) {
    if (sibuk) { antrean.push(pesan); kotor = true; gambarNanti(); return; }
    sibuk = true;
    kendali = new AbortController();
    jumlahLangkah = 0;
    galatGiliran = 0;
    nalarGiliran = 0;
    // Biaya giliran di-reset, konteks terakhir dibiarkan: ukuran konteks yang
    // dikirim tetap informatif sampai panggilan pertama giliran ini selesai.
    biayaTerakhir = { prompt: 0, completion: 0, perkiraan: false };
    keadaan = '';
    mulaiGiliran = Date.now();
    // Animasi: selama bekerja, layar digambar ulang tiap 120ms supaya bingkai berputar.
    // Tanpa ini spanduk "bekerja" diam saja dan terlihat seperti menggantung.
    // jangan set kotor: transkrip tidak berubah, cukup baris status yang digambar ulang.
    if (!animasi) animasi = setInterval(() => { if (sibuk) gambarNanti(); else { clearInterval(animasi); animasi = null; } }, 150);
    terakhir = pesan;
    const titikAwal = blok.length;
    dorong({ tipe: 'user', teks: pesan });
    gambarNanti();

    // Urutan peserta menurut `urutan` eksplisit lalu urutan masuk room (bukan
    // abjad/tugas); sama dengan CLI dan HTTP. `/bot urut` menampilkan urutan itu.
    const room = botDiRoom(sesiId);
    const terurut = urutkanNamaPeserta(room, bacaBot);
    const semua = terurut.length ? terurut : [null];
    const mode = deteksiMode(pesan, semua.length, semua);
    const peserta = mode.peserta.length ? mode.peserta : semua;
    const paralel = mode.paralel;
    const tim = mode.tim === true && peserta.length === 1 && semua.length > 1;
    if (tim) {
      const rekan = semua.filter((nama) => nama && nama !== peserta[0]);
      dorong({ tipe: 'info', teks: 'tim · koordinator ' + peserta[0] + ' · rekan: ' + (rekan.join(', ') || '(tidak ada)') });
      dorong({ tipe: 'info', teks: 'koordinator membagi tugas lewat "panggil"; bot lain tidak mengulang pekerjaan yang sama' });
    }
    try {
      // Tiap bot disiapkan lebih dulu agar kegagalan satu bot (berkas rusak,
      // model tak dikenal) tidak memakan korban bot lain.
      const tugas = peserta.map((namaBot, indeks) => async () => {
        if (kendali.signal.aborted) return { batal: true };
        const bot = namaBot ? bacaBot(namaBot) : null;
        let blokAgen = null; // nama bot tampil sebagai kepala blok jawabannya
        let blokAlat = null;
        // Blok khusus bot yang dipanggil dari dalam giliran ini. Tanpa ini,
        // jawaban/alat rekan hilang di dalam hasil tool `panggil` dan pengguna
        // hanya melihat koordinator seolah-olah rekan tidak bekerja.
        const subAgen = new Map();
        const subAlat = new Map();
        const blokSubAgen = (namaRekan) => {
          let satu = subAgen.get(namaRekan);
          if (!satu) {
            satu = { tipe: 'agen', nama: namaRekan, urut: null, teks: '' };
            subAgen.set(namaRekan, satu);
            blok.push(satu);
          }
          return satu;
        };
        // Penalaran (thinking) per panggilan model: blok terpisah supaya bisa
        // disembunyikan tanpa menyentuh jawaban. `nalarKarakter` dihitung walau
        // disembunyikan - rangkuman tetap menyebut berapa besar yang dipakai.
        let blokNalar = null;
        // Penulis sesi: bot pertama yang bicara menyimpan pesan pengguna.
        // Saat paralel, urutan selesai tak bisa diandalkan - jadi penentunya
        // indeks peserta, bukan siapa yang lebih dulu sampai.
        const penulisUser = indeks === 0;
        // PARALEL = jawaban sesama bot belum ada saat bot ini mulai, jadi ia
        // tidak bisa menanggapinya. Itu konsekuensi nyata dari paralel, bukan
        // bug yang bisa disembunyikan: pilih `/worker 1` bila bot harus saling
        // menanggapi (berurutan, tiap bot melihat jawaban sebelumnya).
        // Pesan pengguna ditulis sekali oleh bot pertama (indeks 0), dan semua
        // bot membaca riwayat sesi yang sama, jadi tak ada bot yang buta tugas.
        const hasil = await putaran({
          pesan,
          sesiId,
          ctx: Object.assign(konteksBot(ctx, bot), {
            pesertaGiliran: peserta,
            panggilLangsung: tim,
            // Rekan yang dipanggil lewat alat `panggil` mengirim delta/alat ke
            // sini, bukan ke blok koordinator. Dengan begini chatroom
            // menampilkan siapa yang bekerja dan apa yang dikerjakannya.
            onSubDelta: (namaRekan, teks) => {
              const satu = blokSubAgen(namaRekan);
              satu.teks += teks;
              kotor = true;
              gambarNanti();
            },
            onSubAlat: (namaRekan, namaAlat, argumen) => {
              jumlahLangkah += 1;
              const labelAlat = ikonAlat(namaAlat) + ' ' + namaAlat;
              const satu = {
                tipe: 'alat',
                teks: namaRekan + ' · ' + labelAlat,
                argumen: argumen || {},
                mulai: Date.now()
              };
              subAlat.set(namaRekan, satu);
              dorong(satu);
              gambarNanti();
            },
            onSubHasilAlat: (namaRekan, namaAlat, isi) => {
              const satu = subAlat.get(namaRekan);
              const ms = satu ? Date.now() - satu.mulai : 0;
              if (satu) satu.durasi = ms;
              const r = ringkasHasil(namaAlat, isi, { ms });
              if (r.gagal) galatGiliran += 1;
              if (satu) satu.gagal = r.gagal;
              dorong({
                tipe: 'hasil',
                penuh: String(isi),
                teks: r.daftar[0] || '(kosong)',
                gagal: r.gagal,
                alasan: r.alasan,
                label: r.label
              });
              gambarNanti();
            }
          }),
          konfModel,
          sinyal: kendali.signal,
          tanpaUser: !penulisUser,
          modeIzin: modeIzin(),
          tanyaIzin: tanyaIzinTui,
          label: namaBot || undefined,
          promptEkstra: bot ? promptBot(bot) + (tim ? '\n\n' + promptKoordinatorTim(bot, semua.filter(Boolean).map((nama) => bacaBot(nama)).filter(Boolean)) : '') : '',
          alat: bot && bot.alat && bot.alat.length
            ? (!bot.alat.includes('panggil') ? [...bot.alat, 'panggil'] : bot.alat)
            : undefined,
          model: bot ? bot.model : undefined,
          suhu: bot && Number.isFinite(bot.suhu) ? bot.suhu : undefined,
          onNalar: (teks) => {
            // Delta penalaran datang SEBELUM jawaban. Blok baru per langkah;
            // saat tersembunyi isinya tetap dikumpulkan (Ctrl+T / /nalar
            // tampil memutar ulang tanpa memanggil model lagi).
            if (!blokNalar) { blokNalar = { tipe: 'nalar', teks: '', nama: namaBot || null }; blok.push(blokNalar); }
            blokNalar.teks += teks;
            nalarGiliran += teks.length;
            if (nalarTampil) { kotor = true; gambarNanti(); }
          },
          onDelta: (teks) => {
            // `urut` = posisi menurut tugas (1 = bicara lebih dulu). Saat
            // paralel blok datang sesuai urutan selesai, jadi nomor ini yang
            // menjaga pembaca tahu urutan sebenarnya.
            if (!blokAgen) { blokAgen = { tipe: 'agen', nama: namaBot, urut: paralel ? indeks + 1 : null, teks: '' }; blok.push(blokAgen); }
            blokNalar = null;
            blokAgen.teks += teks;
            kotor = true;
            gambarNanti();
          },
          onAlat: (nama, argumen) => {
            blokAgen = null;
            jumlahLangkah += 1;
            const labelAlat = ikonAlat(nama) + ' ' + nama;
            keadaan = (namaBot ? namaBot + ' · ' : '') + labelAlat;
            mulaiAlat = Date.now();
            blokAlat = { tipe: 'alat', teks: (namaBot ? namaBot + ' · ' : '') + labelAlat, argumen: argumen || {}, mulai: mulaiAlat };
            dorong(blokAlat);
            gambarNanti();
          },
          onHasilAlat: (nama, isi) => {
            const ms = blokAlat ? Date.now() - mulaiAlat : 0;
            if (blokAlat) blokAlat.durasi = ms;
            // Ringkasan siap tampil: exit/timeout, temuan, ukuran, durasi.
            const r = ringkasHasil(nama, isi, { ms });
            if (r.gagal) galatGiliran += 1;
            if (blokAlat) blokAlat.gagal = r.gagal;
            dorong({
              tipe: 'hasil',
              penuh: String(isi),
              teks: r.daftar[0] || '(kosong)',
              gagal: r.gagal,
              alasan: r.alasan,
              label: r.label
            });
            gambarNanti();
          },
          onStatus: (teks) => { dorong({ tipe: 'info', teks }); gambarNanti(); },
          // Angka nyata dari endpoint: biaya giliran (prompt+completion) dan
          // ukuran konteks yang benar-benar dikirim -> kop & bilah status.
          onBiaya: (satu) => {
            biayaTerakhir = { prompt: (biayaTerakhir.prompt || 0) + (satu.prompt || 0), completion: (biayaTerakhir.completion || 0) + (satu.completion || 0), perkiraan: satu.perkiraan === true };
            konteksTerakhir = {
              dipakai: satu.prompt || konteksTerakhir.dipakai,
              maks: (konfModel && konfModel.batasToken) || batasKonteks || 0,
              total: satu.prompt || 0,
              perkiraan: satu.perkiraan === true
            };
            gambarNanti();
          },
          // Rute dipilih sebelum panggilan pertama; satu baris info supaya
          // pemakai tahu tingkat mana yang dibayar giliran ini (dan saat naik).
          onRute: (keputusan) => {
            if (keputusan && keputusan.aktif && keputusan.nilai && Number(keputusan.nilai.batasToken) > 0) batasKonteks = Number(keputusan.nilai.batasToken);
            dorong({ tipe: 'info', teks: formatRute(keputusan) });
            gambarNanti();
          }
        });
        return hasil;
      });

      // Jalur bersama `jalankanRoom`: sama persis dengan CLI dan HTTP, jadi
      // aturan urutan/paralel/penanganan galat tidak bisa menyimpang antar muka.
      if (paralel) {
        dorong({ tipe: 'info', teks: peserta.length + ' bot bekerja · ' + workerParalel(workerRoom, peserta.length) + ' worker paralel' });
        gambarNanti();
      } else if (peserta.length > 1) {
        dorong({ tipe: 'info', teks: peserta.length + ' bot bekerja · ' + mode.alasan });
        gambarNanti();
      } else if (semua.length > 1) {
        dorong({ tipe: 'info', teks: '1 bot bekerja · ' + mode.alasan + ' (sebut "paralel" untuk semua)' });
        gambarNanti();
      }
      const { hasil: hasilSemua } = await jalankanRoom({
        daftar: peserta,
        worker: paralel ? workerParalel(workerRoom, peserta.length) : 1,
        sinyal: kendali.signal,
        buat: (nama, i) => tugas[i]()
      });

      // Kegagalan per bot dilaporkan SATU per satu; satu gagal tidak menutupi
      // bot lain, dan yang gagal tetap kelihatan sebagai jawaban yang absen.
      const laporan = rangkumHasil((i) => peserta[i] || 'agen', hasilSemua);
      for (const baris of laporan.baris) dorong({ tipe: 'galat', teks: baris });
      // Pelajaran yang disimpan giliran ini (lib/pelajaran.js): sebut supaya
      // pemakai tahu ingatan bertambah, dan tahu di mana melihatnya.
      for (const satu of hasilSemua) {
        const pel = satu && satu.hasil && satu.hasil.pelajaran;
        if (pel && pel.teks) {
          dorong({ tipe: 'info', teks: (pel.ulang ? 'pelajaran diulang (' + pel.ulangKe + 'x): ' : 'pelajaran disimpan: ') + potong(pel.teks, 150) });
        }
      }
      if (paralel) {
        dorong({ tipe: 'info', teks: laporan.berhasil + '/' + peserta.length + ' bot menjawab' + (laporan.gagal ? ', ' + laporan.gagal + ' gagal' : '') });
      }
      if (hasilSemua.some((satu) => satu && satu.hasil && satu.hasil.dibatalkan)) {
        dorong({ tipe: 'info', teks: 'dibatalkan.' });
      }
      const adaRangkuman = rangkumanOtomatis(titikAwal);
      // Penalaran tersembunyi tetap disebut: tanpa ini pemakai tidak tahu model
      // berpikir 1.2k karakter dan tidak pernah menemukan `/nalar tampil`.
      // Kalau rangkuman sudah menyebutnya (giliran memakai alat), jangan ulang.
      if (nalarGiliran > 0 && !nalarTampil && !adaRangkuman) {
        dorong({ tipe: 'info', teks: 'nalar ' + angkaRingkas(nalarGiliran) + ' kar disembunyikan · /nalar tampil untuk isinya' });
        gambarNanti();
      }
    } catch (galat) {
      dorong({ tipe: 'galat', teks: 'GAGAL: ' + String((galat && galat.message) || galat) });
    } finally {
      // `sibuk` TETAP true selama gelombang panggilan rekan: kalau dilepas di
      // sini, Enter berikutnya memulai giliran kedua yang menimpa `kendali`
      // sementara bot rekan masih bekerja.
      lupakanSkill();
      gambarNanti();
      // Panggilan antar-bot dari giliran ini di-antrekan; giliran selesai,
      // sekarang giliran MEREKA - tiap panggil dijalan utuh, jawabannya jadi
      // balasan bot itu di room (tanpa menulis ulang pesan pengguna). Loop
      // sampai antrean benar-benar habis: bot yang dipanggil boleh memanggil lagi.
      let gelombang = 0;
      while (ambilAntreanPanggil(sesiId).length && gelombang < 4) {
        gelombang += 1;
        try {
          dorong({ tipe: 'info', teks: 'panggilan rekan diproses (gelombang ' + gelombang + ')…' });
          gambarNanti();
          // Hasil tiap bot rekan WAJIB masuk transkrip. Dulu nilai kembaliannya
          // dibuang, jadi bot lain benar-benar bekerja (dan dibayar) tapi
          // jawabannya tidak pernah terlihat - persis keluhan "hanya satu bot
          // yang menjawab".
          const blokRekan = await jalanAntreanPanggil(sesiId, {
            konfModel,
            cwd: ctx.cwd,
            worker: workerRoom != null ? workerRoom : ctx.worker,
            modeIzin: modeIzin(),
            tanyaIzin: tanyaIzinTui,
            sinyal: kendali ? kendali.signal : undefined
          });
          for (const blok of blokRekan || []) dorong({ tipe: 'agen', nama: null, teks: String(blok), urut: null });
        } catch (galatAntre) {
          dorong({ tipe: 'galat', teks: 'panggilan rekan gagal: ' + String((galatAntre && galatAntre.message) || galatAntre) });
          break;
        }
        gambarNanti();
      }
      sibuk = false;
      kendali = null;
      keadaan = '';
      gambarNanti();
      if (antrean.length) {
        const berikut = antrean.shift();
        setTimeout(() => jalankan(berikut), 10);
      }
    }
  }

  async function ringkasSesi() {
    const isi = bacaSesi(sesiId).filter((row) => row.role === 'user' || row.role === 'assistant');
    if (!isi.length) { dorong({ tipe: 'info', teks: 'sesi masih kosong' }); return; }
    dorong({ tipe: 'info', teks: 'meringkas sesi…' });
    gambarNanti();
    const teks = isi.map((row) => row.role + ': ' + String(row.content || '').slice(0, 400)).join('\n').slice(-6000);
    try {
      const balas = await obrol({
        konf: konfModel,
        messages: [
          { role: 'system', content: 'Ringkas percakapan ini jadi maksimal 5 butir ingatan inti yang berguna untuk sesi berikutnya. Tiap butir satu baris diawali "- ", bahasa Indonesia, tanpa pembuka.' },
          { role: 'user', content: teks }
        ],
        stream: false
      });
      const butir = String(balas.content || '').split('\n').map((b) => b.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
      ubahState((state) => {
        state.mind = (state.mind || []).concat(butir.map((teks) => ({ teks, at: Date.now() }))).slice(-300);
      });
      dorong({ tipe: 'judul', teks: 'ingatan inti diperbarui (' + butir.length + ' butir)' });
      for (const satu of butir) dorong({ tipe: 'hasil', teks: satu });
    } catch (galat) {
      dorong({ tipe: 'galat', teks: 'gagal meringkas: ' + String((galat && galat.message) || galat) });
    }
    gambarNanti();
  }

  /** Satu langkah gulir + gambar ulang. batas = baris yang bisa digulir. */
  function geser(arah, langkah = 3) {
    gulir = langkahGulir({ gulir, batas: batasGulir, arah, langkah });
    kotor = true;
    gambarNanti();
    return gulir;
  }

  /* ------------------------------------------------------ pengaturan -- */

  // Uji endpoint+kunci tanpa mengubah konfigurasi. Satu uji pada satu waktu:
  // menekan /pengaturan tes berkali-kali tidak boleh menumpuk permintaan.
  let sedangUji = false;
  function tesKoneksi() {
    if (sedangUji) { dorong({ tipe: 'info', teks: 'uji endpoint masih berjalan' }); return; }
    sedangUji = true;
    dorong({ tipe: 'info', teks: 'menguji ' + konfModel.baseUrl + ' · model ' + konfModel.model + ' …' });
    gambarNanti();
    ujiModel(konfModel, { waktu: 12000 }).then((hasil) => {
      const lama = hasil.ms >= 1000 ? (hasil.ms / 1000).toFixed(1) + 's' : hasil.ms + 'ms';
      const tahap = hasil.tahap === 'katalog' ? 'katalog' : hasil.tahap === 'chat' ? 'chat' : 'koneksi';
      dorong({ tipe: 'judul', teks: 'uji endpoint' });
      dorong({ tipe: hasil.ok ? 'hasil' : 'galat', teks: (hasil.ok ? 'OK ' : 'GAGAL ') + tahap + ' · ' + hasil.pesan + ' · ' + lama });
      if (hasil.ok && Array.isArray(hasil.katalog) && hasil.katalog.length) {
        // Uji yang berhasil sekaligus katalog terbaru: simpan, supaya menu
        // /model memakai daftar endpoint ini tanpa permintaan ulang.
        simpanKatalog(konfModel, hasil.katalog);
        konfModel = konfigModel();
        const aktif = String(hasil.model || '');
        const ada = hasil.katalog.includes(aktif);
        dorong({ tipe: 'hasil', teks: 'model aktif "' + aktif + '" ' + (ada ? 'ada di katalog' : 'TIDAK ada di katalog') });
        if (!ada) {
          const kecil = aktif.toLowerCase();
          const mirip = hasil.katalog.filter((satu) => String(satu).toLowerCase().includes(kecil) || kecil.includes(String(satu).toLowerCase())).slice(0, 5);
          if (mirip.length) dorong({ tipe: 'info', teks: 'mirip: ' + mirip.join(', ') + ' · pakai /pengaturan model <nama>' });
          else dorong({ tipe: 'info', teks: 'contoh model di katalog: ' + hasil.katalog.slice(0, 5).join(', ') });
        }
      }
      if (!hasil.ok) dorong({ tipe: 'info', teks: 'perbaiki dengan /pengaturan url <url> · /pengaturan key <kunci>, lalu /pengaturan tes lagi' });
    }).catch((galat) => {
      dorong({ tipe: 'galat', teks: 'uji endpoint gagal: ' + String((galat && galat.message) || galat) });
    }).finally(() => { sedangUji = false; gambarNanti(); });
  }

  // Katalog model dari endpoint: satu permintaan pada satu waktu. Dipakai saat
  // katalog endpoint aktif kosong/basi atau saat baris "muat ulang" dipilih.
  // `paksa` = ambil ulang walau cap waktunya masih muda.
  let sedangKatalog = false;
  function muatKatalogModel(info, { paksa = true } = {}) {
    if (sedangKatalog) { dorong({ tipe: 'info', teks: 'katalog masih dimuat' }); return; }
    sedangKatalog = true;
    if (info) dorong(info);
    gambarNanti();
    sinkronKatalog(konfModel, { paksa, waktu: 15000 }).then((hasil) => {
      if (hasil.ok && hasil.katalog.length) {
        konfModel = konfigModel();
        dorong({ tipe: 'judul', teks: 'katalog model dimuat (' + hasil.katalog.length + ')' });
        dorong({ tipe: 'hasil', teks: hasil.url + (hasil.segar ? ' · masih segar' : '') });
        for (const satu of peringatanTurunan()) dorong({ tipe: 'info', teks: 'model turunan: ' + satu });
        bukaPemilih(opsiModel(konfModel), terapkanModel);
      } else {
        dorong({ tipe: 'galat', teks: 'katalog gagal dimuat: ' + hasil.pesan });
        // Endpoint tidak punya /models atau sedang mati: jangan biarkan menu
        // kosong. Katalog tersimpan (kalau ada) tetap bisa dipilih.
        if (Array.isArray(konfModel.models) && konfModel.models.length) {
          dorong({ tipe: 'info', teks: 'memakai katalog tersimpan' });
          bukaPemilih(opsiModel(konfModel), terapkanModel);
        }
      }
    }).catch((galat) => {
      dorong({ tipe: 'galat', teks: 'katalog gagal dimuat: ' + String((galat && galat.message) || galat) });
    }).finally(() => { sedangKatalog = false; gambarNanti(); });
  }

  // Uji dukungan reasoning endpoint+model: satu POST kecil per tingkat, hasil
  // disimpan supaya nilai ditolak tidak dibayar ulang tiap giliran.
  let sedangUjiReasoning = false;
  function ujiReasoning() {
    if (sedangUjiReasoning) { dorong({ tipe: 'info', teks: 'uji reasoning masih berjalan' }); return; }
    sedangUjiReasoning = true;
    dorong({ tipe: 'judul', teks: 'uji dukungan reasoning' });
    dorong({ tipe: 'info', teks: konfModel.model + ' @ ' + konfModel.baseUrl + ' · satu POST kecil per tingkat' });
    gambarNanti();
    probeReasoning(konfModel, {
      onHasil: (satu) => {
        dorong({
          tipe: satu.status === 'ok' ? 'hasil' : satu.status === 'ditolak' ? 'info' : 'galat',
          teks: String(satu.level).padEnd(8) + satu.status
            + (satu.tokenPenalaran != null ? ' · reasoning_tokens ' + satu.tokenPenalaran : '')
            + (satu.pesan ? ' · ' + satu.pesan : '')
        });
        gambarNanti();
      }
    }).then((hasil) => {
      const ringkas = ringkasKemampuan(kemampuanModel(konfModel));
      dorong({ tipe: 'judul', teks: 'hasil reasoning' });
      dorong({ tipe: 'hasil', teks: 'didukung: ' + (hasil.diterima.join(', ') || '(tidak ada)') + (hasil.ditolak.length ? ' · ditolak: ' + hasil.ditolak.join(', ') : '') });
      if (ringkas) dorong({ tipe: 'info', teks: 'tersimpan: ' + ringkas });
      else if (!hasil.tersimpan) dorong({ tipe: 'info', teks: 'tidak disimpan (probe berhenti di tengah; coba lagi nanti)' });
      dorong({ tipe: 'info', teks: '/effort untuk menu · nilai yang ditolak diturunkan otomatis saat dipakai' });
    }).catch((galat) => {
      dorong({ tipe: 'galat', teks: 'uji reasoning gagal: ' + String((galat && galat.message) || galat) });
    }).finally(() => { sedangUjiReasoning = false; gambarNanti(); });
  }

  // Model turunan (murah/fallback/bot) ikut bergantung endpoint: yang tidak ada
  // di katalog endpointnya disebut, yang belum punya katalog didiamkan.
  function peringatanTurunan(konf = konfModel) {
    const daftar = [];
    const murah = String(process.env.SAKTI_MODEL_MURAH || '').trim();
    if (murah) daftar.push({ label: 'model murah (SAKTI_MODEL_MURAH)', model: murah });
    for (const [i, satu] of (Array.isArray(konf.fallbacks) ? konf.fallbacks : []).entries()) {
      if (satu && satu.model) daftar.push({ label: 'fallback ' + (i + 1), model: satu.model, baseUrl: satu.baseUrl });
    }
    for (const bot of daftarBot()) if (bot && bot.model) daftar.push({ label: 'bot ' + bot.nama, model: bot.model });
    return ringkasModelTurunan(periksaModelTurunan(konf, daftar));
  }

  // Katalog mengikuti endpoint tanpa disuruh: saat app dibuka, saat endpoint
  // diganti, atau saat cap waktunya lewat. Tenang - satu baris hanya kalau isi
  // katalog berubah; galat hanya dilaporkan kalau belum ada katalog tersimpan.
  let sinkronLatar = false;
  function segarkanKatalogLatar(alasan = '') {
    if (sinkronLatar || !perluSegarkanKatalog(konfModel)) return;
    sinkronLatar = true;
    sinkronKatalog(konfModel).then((hasil) => {
      if (hasil.ok) {
        konfModel = konfigModel();
        if (hasil.berubah) {
          dorong({ tipe: 'info', teks: 'katalog model ' + (alasan ? alasan + ': ' : '') + hasil.katalog.length + ' dari ' + hasil.url });
          for (const satu of peringatanTurunan()) dorong({ tipe: 'info', teks: 'model turunan: ' + satu });
          gambarNanti();
        }
      } else if (!(konfModel.models || []).length) {
        dorong({ tipe: 'info', teks: 'katalog model belum bisa dimuat: ' + hasil.pesan });
        gambarNanti();
      }
    }).catch(() => { /* latar belakang: diam */ })
      .finally(() => { sinkronLatar = false; });
  }

  function terapkanModel(opsi) {
    const nilai = (opsi && opsi.nilai) || {};
    if (nilai.muatKatalog) { muatKatalogModel({ tipe: 'info', teks: 'mengambil katalog dari ' + konfModel.baseUrl + ' …' }); return; }
    if (!nilai.model) return;
    simpanModel({ model: nilai.model });
    konfModel = konfigModel();
    dorong({ tipe: 'judul', teks: 'model dipilih' });
    dorong({ tipe: 'hasil', teks: konfModel.model + ' @ ' + konfModel.baseUrl });
    dorong({ tipe: 'info', teks: 'berlaku sekarang juga · /model tes untuk cek endpoint' });
  }

  // Perintah bisa menulis berkas (simpanModel/tulisState). EACCES/ENOSPC tidak
  // boleh mematikan TUI dan meninggalkan terminal di raw mode: tangkap di satu
  // pintu, laporkan sebagai baris galat.
  function amanPerintah(teks) {
    try { perintah(teks); }
    catch (galat) { dorong({ tipe: 'galat', teks: 'perintah gagal: ' + String((galat && galat.message) || galat) }); gambarNanti(); }
  }

  function perintah(teks) {
    const [nama, ...sisa] = pecah(teks.slice(1));
    if (nama === 'perintah') {
      const semua = daftarPerintahKustom({ cwd: ctx && ctx.cwd });
      // Tanpa argumen + ada perintah: menu untuk menjalankan prompt tersimpan.
      // Dengan argumen tetap jalur teks lama (melihat isi prompt).
      if (!sisa.length && semua.length) {
        bukaPemilih(opsiPerintah(semua), (opsi) => {
          const namaKustom = opsi && opsi.nilai && opsi.nilai.perintah;
          const isi = namaKustom ? rangkaiPerintah(namaKustom, '', { cwd: ctx && ctx.cwd }) : null;
          if (!isi) { dorong({ tipe: 'galat', teks: 'perintah tidak ada: ' + (namaKustom || '?') }); return; }
          dorong({ tipe: 'judul', teks: '/' + namaKustom });
          jalankan(isi);
        });
        return;
      }
      daftarPerintahTui(sisa, dorong, ctx && ctx.cwd);
      return;
    }
    if (['keluar', 'exit', 'quit'].includes(nama)) { selesai(); return; }
    if (['atas', 'bawah', 'puncak', 'dasar', 'gulir'].includes(nama)) {
      const angka = Number(sisa[0]);
      const hasil = nama === 'gulir'
        ? geser(Number.isFinite(angka) ? angka : gulir, 1)
        : geser(nama === 'atas' ? 'naik' : nama === 'bawah' ? 'turun' : nama, nama === 'atas' || nama === 'bawah' ? (Number.isFinite(angka) && angka > 0 ? angka : 3) : 3);
      dorong({ tipe: 'hasil', teks: 'gulir ' + hasil + (hasil === 0 ? ' (di dasar)' : ' baris dari dasar') });
      return;
    }
    if (nama === 'bersih') {
      // Hanya sampah yang dibuat alat sendiri; sesi/skill/ingatan/config tidak
      // pernah disentuh (lihat catatan di lib/bersih.js).
      const hapus = ['hapus', 'bersihkan', 'jalankan'].includes(String(sisa[0] || '').toLowerCase());
      const hasil = hapus ? sapuSampah({}) : pindaiSampah({});
      dorong({ tipe: 'judul', teks: 'bersih-bersih' });
      dorong({ tipe: 'hasil', teks: ringkasSampah(hasil) });
      for (const satu of (hasil.item || []).slice(0, 15)) {
        dorong({ tipe: 'hasil', teks: '· ' + satu.jenis + ' · ' + satu.alasan + ' · ' + satu.jalur + ' (' + Math.max(0, Math.round(satu.byte / 1024)) + ' KiB)' });
      }
      if (!hapus) dorong({ tipe: 'info', teks: 'pratinjau saja · /bersih hapus untuk benar-benar menghapus' });
      gambarNanti();
      return;
    }
    if (nama === 'pelajaran') {
      const sub = String(sisa[0] || '').toLowerCase();
      if (['mati', 'off', '0'].includes(sub)) { simpanModel({ pelajaran: 'mati' }); konfModel = konfigModel(); dorong({ tipe: 'hasil', teks: 'pelajaran otomatis: mati' }); return; }
      if (['hidup', 'on', '1'].includes(sub)) { simpanModel({ pelajaran: 'otomatis' }); konfModel = konfigModel(); dorong({ tipe: 'hasil', teks: 'pelajaran otomatis: hidup' }); return; }
      if (['hapus', 'lupakan'].includes(sub)) {
        const kata = sisa.slice(1).join(' ').trim();
        const semua = ['semua', 'all', '*'].includes(kata.toLowerCase());
        if (!kata) {
          dorong({ tipe: 'galat', teks: 'hapus butuh kata atau "semua": /pelajaran hapus <kata> | /pelajaran hapus semua' });
          gambarNanti();
          return;
        }
        const n = hapusPelajaran({ cari: semua ? '' : kata, semua });
        dorong({ tipe: 'hasil', teks: 'pelajaran dihapus: ' + n + (semua ? ' (semua)' : ' (cocok "' + kata + '")') });
        gambarNanti();
        return;
      }
      const rows = daftarPelajaran(bacaState(), { batas: 12 });
      dorong({ tipe: 'judul', teks: 'pelajaran (otomatis ' + (pelajaranAktif(konfModel) ? 'hidup' : 'mati') + ' · ' + rows.length + ' terbaru)' });
      if (!rows.length) dorong({ tipe: 'info', teks: '(belum ada) - muncul sendiri setelah giliran yang memakai alat' });
      for (const row of rows) dorong({ tipe: 'hasil', teks: '· ' + potong(String(row.teks || ''), 150) + (Number(row.ulang) > 1 ? ' (' + row.ulang + 'x)' : '') });
      dorong({ tipe: 'info', teks: '/pelajaran mati|hidup · /pelajaran hapus [kata]' });
      gambarNanti();
      return;
    }
    if (nama === 'rawat') {
      const sub = String(sisa[0] || '').toLowerCase();
      if (['auto', 'otomatis'].includes(sub)) {
        const nilai = !['off', 'mati', '0', 'false'].includes(String(sisa[1] || '').toLowerCase());
        simpanModel({ autoRawat: nilai, autoUpdate: nilai });
        konfModel = konfigModel();
        dorong({ tipe: 'hasil', teks: 'rawat otomatis: ' + (nilai ? 'hidup' : 'mati') });
        return;
      }
      if (['update', 'tarik', 'pull'].includes(sub)) {
        const hasil = tarikAman();
        dorong({ tipe: 'hasil', teks: hasil.ok
          ? (hasil.sudahTerbaru ? 'kode sudah terbaru (' + String(hasil.ke || '').slice(0, 8) + ')' : 'kode diperbarui ' + String(hasil.dari || '').slice(0, 8) + ' -> ' + String(hasil.ke).slice(0, 8) + ' · ' + (hasil.berubah || []).length + ' berkas')
          : 'update tidak dijalankan: ' + (hasil.alasan || '?') });
        return;
      }
      const perbaiki = sub !== 'periksa' && sub !== 'check';
      const hasil = rawatLokal({ perbaiki });
      dorong({ tipe: 'judul', teks: 'rawat · ' + (perbaiki ? 'perbaiki' : 'periksa') });
      for (const satu of hasil.perbaikan || []) dorong({ tipe: 'hasil', teks: 'OK ' + satu });
      for (const satu of hasil.temuan || []) dorong({ tipe: 'info', teks: '! ' + satu });
      if (!(hasil.perbaikan || []).length && !(hasil.temuan || []).length) dorong({ tipe: 'info', teks: 'bersih, tidak ada yang perlu diperbaiki' });
      dorong({ tipe: 'info', teks: ringkasRawat({ lokal: hasil, tarik: { alasan: '' } }) });
      return;
    }
    if (nama === 'nalar') {
      // Tampil/sembunyi penalaran model. Disimpan di config (`nalar`), jadi
      // bertahan lintas sesi; blok lama ikut tampil/hilang tanpa panggilan ulang.
      const kata = String(sisa[0] || '').toLowerCase();
      if (kata && !NALAR_SAH.includes(kata)) {
        dorong({ tipe: 'galat', teks: 'nalar: ' + sisa[0] + ' · pakai: ' + NALAR_SAH.join(' | ') });
        return;
      }
      nalarTampil = kata ? kata === 'tampil' : !nalarTampil;
      simpanModel({ nalar: nalarTampil ? 'tampil' : 'sembunyi' });
      konfModel = konfigModel();
      lebarTerakhir = 0;
      kotor = true;
      dorong({
        tipe: 'hasil',
        teks: 'nalar: ' + (nalarTampil ? 'tampil' : 'sembunyi')
          + (nalarTampil ? ' · blok ✻ digambar (Ctrl+T = 40 baris)' : ' · isi disembunyikan; jumlahnya tetap di rangkuman')
      });
      gambarNanti();
      return;
    }
    if (nama === 'effort') {
      if (['tes', 'test', 'cek', 'probe'].includes(String(sisa[0] || '').toLowerCase())) { ujiReasoning(); return; }
      const pilihan = normalEffort(sisa[0]);
      if (!sisa[0]) {
        // Menu interaktif: semua tingkat + anggaran token + status dukungan
        // endpoint, Enter menerapkan; baris terakhir = probe dukungan.
        bukaPemilih(opsiEffort(konfModel, kemampuanModel(konfModel)), (opsi) => {
          if (opsi && opsi.nilai && opsi.nilai.ujiReasoning) { ujiReasoning(); return; }
          const pilih = normalEffort(opsi && opsi.nilai && opsi.nilai.effort) || 'none';
          simpanModel({ effort: pilih });
          konfModel = konfigModel();
          const anggaran = tokenUntukEffort(pilih);
          const dipakai = effortAman(pilih, kemampuanModel(konfModel));
          dorong({ tipe: 'hasil', teks: 'effort: ' + pilih + (pilih === 'none' ? ' (field tidak dikirim)' : ' (reasoning_effort=' + pilih + ')') + ' · token: ' + (konfModel.maxTokens || 'server') + (anggaran ? ' (bawaan tingkat)' : '') + (dipakai !== pilih ? ' · endpoint: ' + (dipakai || 'tanpa effort') : '') });
        });
        return;
      }
      if (!pilihan) { dorong({ tipe: 'galat', teks: 'level tidak dikenal: ' + sisa[0] + ' · pakai salah satu: ' + EFFORT_SAH.join('|') }); return; }
      simpanModel({ effort: pilihan });
      konfModel = konfigModel();
      const anggaran = tokenUntukEffort(pilihan);
      const dipakai = effortAman(pilihan, kemampuanModel(konfModel));
      dorong({ tipe: 'hasil', teks: 'effort: ' + pilihan + (pilihan === 'none' ? ' (field tidak dikirim)' : ' (reasoning_effort=' + pilihan + ')') + ' · token: ' + (konfModel.maxTokens || 'server') + (anggaran ? ' (bawaan tingkat)' : '') + (dipakai !== pilihan ? ' · endpoint: ' + (dipakai || 'tanpa effort') : '') });
      return;
    }
    if (nama === 'room') {
      // `solo` = 1 bot (rekan lewat alat panggil). `tim`/`otomatis` =
      // koordinator membagi tugas; bukan semua bot mengulang pesan yang sama.
      const sekarang = modeRoomTersimpan();
      const pilih = (sisa[0] || '').toLowerCase();
      if (!pilih) {
        dorong({ tipe: 'hasil', teks: 'mode room: ' + sekarang + ' · pilihan: ' + MODE_ROOM.join(' | ') + ' · pakai /room tim' });
        return;
      }
      if (!MODE_ROOM.includes(pilih)) {
        dorong({ tipe: 'galat', teks: 'mode room tidak dikenal: ' + pilih + ' (pakai ' + MODE_ROOM.join(' | ') + ')' });
        return;
      }
      ubahState((state) => { state.modeRoom = pilih; });
      const ket = (pilih === 'otomatis' || pilih === 'tim')
        ? ' · koordinator membagi tugas ke rekan sesuai peran (tidak ada pekerjaan dobel)'
        : ' · satu bot per pesan';
      dorong({ tipe: 'hasil', teks: 'mode room: ' + pilih + ket });
      return;
    }
    if (nama === 'worker') {
      if (!sisa[0]) {
        // Menu interaktif: otomatis atau 1..12, plus keterangan serial/paralel.
        const jumlahBot = botDiRoom(sesiId).length;
        bukaPemilih(opsiWorker(workerRoom, jumlahBot), (opsi) => {
          const nilai = opsi && opsi.nilai ? opsi.nilai.worker : null;
          workerRoom = nilai == null ? null : Math.max(1, Math.floor(Number(nilai) || 1));
          ctx = Object.assign({}, ctx, { worker: workerRoom });
          dorong({ tipe: 'hasil', teks: workerRoom == null ? 'worker: otomatis (room: semua peserta; subagen: bawaan)' : 'worker: ' + workerRoom + ' pekerja bersamaan (bot room + subagen)' });
        });
        return;
      }
      const angka = Number(sisa[0]);
      if (!Number.isFinite(angka) || angka < 1) {
        dorong({ tipe: 'galat', teks: 'butuh angka >= 1 (1 = berurutan)' });
        return;
      }
      workerRoom = Math.floor(angka);
      // Satu tombol untuk dua pool: bot room DAN subagen di dalam giliran.
      ctx = Object.assign({}, ctx, { worker: workerRoom });
      dorong({ tipe: 'hasil', teks: 'worker: ' + workerRoom + ' pekerja bersamaan (bot room + subagen)' });
      return;
    }
    if (nama === 'subagen') {
      if (sisa[0] === 'pilih') {
        const teks = sisa.slice(1).join(' ');
        if (!teks) { dorong({ tipe: 'galat', teks: 'butuh teks tugas: /subagen pilih perbaiki bug login' }); return; }
        dorong({ tipe: 'judul', teks: 'peran terpilih (otomatis)' });
        for (const satu of pilihSubagen(teks, { maks: 3 })) dorong({ tipe: 'hasil', teks: satu.nama.padEnd(12) + 'skor=' + satu.skor });
        return;
      }
      dorong({ tipe: 'judul', teks: 'subagen · ' + (workerSubagen(workerRoom, 12) || '?') + ' worker bersamaan' });
      for (const satu of ringkasSubagen().split('\n')) dorong({ tipe: 'hasil', teks: satu });
      dorong({ tipe: 'info', teks: 'pakai: delegasi peran=auto|<nama> · banyak=[{peran,tugas}...] untuk beberapa tugas paralel · penuh=true kalau perlu mengubah berkas' });
      return;
    }
    if (nama === 'token') {
      if (!sisa[0]) {
        // Menu interaktif: preset 0/1024..48000 + nilai aktif bila di luar preset.
        bukaPemilih(opsiToken(konfModel), (opsi) => {
          const angka = Math.floor(Number(opsi && opsi.nilai && opsi.nilai.maxTokens) || 0);
          simpanModel({ maxTokens: angka });
          konfModel = konfigModel();
          dorong({ tipe: 'hasil', teks: 'token: ' + (konfModel.maxTokens > 0 ? konfModel.maxTokens : 'serahkan ke server') });
        });
        return;
      }
      const angka = Number(sisa[0]);
      if (!Number.isFinite(angka) || angka < 0) { dorong({ tipe: 'galat', teks: 'butuh angka >= 0: /token 8192 (0 = serahkan ke server)' }); return; }
      simpanModel({ maxTokens: Math.floor(angka) });
      konfModel = konfigModel();
      dorong({ tipe: 'hasil', teks: 'token: ' + (konfModel.maxTokens > 0 ? konfModel.maxTokens : 'serahkan ke server') });
      return;
    }
    if (nama === 'rute') {
      if (!sisa[0]) {
        // Menu interaktif: off / auto / patok satu tingkat, lengkap dengan
        // anggaran tiap tingkat supaya pilihan tidak buta angka.
        bukaPemilih(opsiRute(konfModel), (opsi) => {
          const kata = String((opsi && opsi.nilai && opsi.nilai.rute) || 'auto').toLowerCase();
          if (kata === 'off') {
            simpanModel({ rute: false, ruteTingkat: konfModel.ruteTingkat });
            konfModel = konfigModel();
            dorong({ tipe: 'hasil', teks: 'rute: off (pakai effort/max-tokens manual)' });
            return;
          }
          if (kata === 'auto' || kata === 'on') {
            simpanModel({ rute: true, ruteTingkat: '' });
            konfModel = konfigModel();
            dorong({ tipe: 'hasil', teks: 'rute: on, tingkat dipilih dari skor kesulitan (patok dilepas)' });
            return;
          }
          const patok = tingkatSah(kata);
          if (!patok) { dorong({ tipe: 'galat', teks: 'tingkat tidak dikenal: ' + kata }); return; }
          simpanModel({ ruteTingkat: patok, rute: true });
          konfModel = konfigModel();
          const n = nilaiTingkat(patok);
          dorong({ tipe: 'hasil', teks: 'rute dipatok: ' + patok + ' · effort=' + n.effort + ' max_tokens=' + n.maxTokens + ' riwayat=' + n.batasRiwayat + ' · /rute off untuk lepas' });
        });
        return;
      }
      const kata = String(sisa[0]).toLowerCase();
      if (kata === 'auto') {
        simpanModel({ rute: true, ruteTingkat: '' });
        konfModel = konfigModel();
        dorong({ tipe: 'hasil', teks: 'rute: on, tingkat dipilih dari skor kesulitan (patok dilepas)' });
        return;
      }
      if (kata === 'on' || kata === 'off') {
        simpanModel({ rute: kata === 'on', ruteTingkat: kata === 'on' ? '' : konfModel.ruteTingkat });
        konfModel = konfigModel();
        dorong({ tipe: 'hasil', teks: 'rute: ' + (kata === 'on' ? 'on (tingkat dipilih dari kesulitan tugas)' : 'off (pakai effort/max-tokens manual)') });
        return;
      }
      const patok = tingkatSah(kata);
      if (!patok) { dorong({ tipe: 'galat', teks: 'tidak dikenal: ' + sisa[0] + ' · pakai on | off | ' + TINGKAT_RUTE.join('|') }); return; }
      simpanModel({ ruteTingkat: patok, rute: true });
      konfModel = konfigModel();
      const n = nilaiTingkat(patok);
      dorong({ tipe: 'hasil', teks: 'rute dipatok: ' + patok + ' · effort=' + n.effort + ' max_tokens=' + n.maxTokens + ' riwayat=' + n.batasRiwayat + ' · /rute off untuk lepas' });
      return;
    }
    if (nama === 'izin') {
      if (!sisa[0]) {
        // Menu interaktif: auto / ask / never, dengan akibat masing-masing.
        bukaPemilih(opsiIzin(modeIzin()), (opsi) => {
          const pilih = String((opsi && opsi.nilai && opsi.nilai.izin) || 'auto');
          try { setModeIzin(pilih); lupakanIzin(); }
          catch (galat) { dorong({ tipe: 'galat', teks: String((galat && galat.message) || galat) }); return; }
          dorong({ tipe: 'hasil', teks: 'mode izin: ' + modeIzin() });
        });
        return;
      }
      try { setModeIzin(sisa[0]); lupakanIzin(); } catch (galat) { dorong({ tipe: 'galat', teks: String((galat && galat.message) || galat) }); return; }
      dorong({ tipe: 'hasil', teks: 'mode izin: ' + modeIzin() });
      return;
    }
    if (nama === 'undo') {
      if (sisa[0] === 'daftar') {
        const rows = daftarCheckpoint({ batas: 20 });
        if (!rows.length) { dorong({ tipe: 'info', teks: 'belum ada checkpoint' }); return; }
        for (const row of rows) dorong({ tipe: 'hasil', teks: row.id + '  ' + new Date(row.at).toISOString().slice(0, 19) + '  ' + row.jalur });
        return;
      }
      try {
        const satu = kembalikanCheckpoint(sisa[0] || '');
        dorong({ tipe: 'hasil', teks: 'dipulihkan: ' + satu.jalur + ' (dari ' + satu.id + ')' });
      } catch (galat) { dorong({ tipe: 'galat', teks: String((galat && galat.message) || galat) }); }
      return;
    }
    if (nama === 'indikator') {
      // Gaya indikator kerja gaya Hermes (`/indicator`): unicode | ascii | emoji.
      const minta = String(sisa[0] || '').toLowerCase();
      if (!sisa[0]) {
        const kini = gayaIndikator;
        const opsi = GAYA_INDIKATOR.map((gaya) => ({
          label: gaya,
          // Contoh dua bingkai berurutan: emoji berganti tiap 600ms, braille 100ms.
          ket: (gaya === kini ? 'aktif · ' : '') + bingkaiIndikator(gaya, 0) + ' ' + bingkaiIndikator(gaya, gaya === 'emoji' ? 600 : 200),
          nilai: { gaya },
          aktif: gaya === kini
        }));
        bukaPemilih({ judul: 'indikator kerja · ' + kini, opsi }, (opsi2) => {
          const nilai = opsi2 && opsi2.nilai && opsi2.nilai.gaya;
          if (!nilai) return;
          gayaIndikator = gayaSah(nilai, { utf8: LOKAL_UTF8 });
          GAYA_AKTIF = gayaIndikator;
          simpanModel({ indikator: gayaIndikator });
          konfModel = konfigModel();
          dorong({ tipe: 'hasil', teks: 'indikator: ' + gayaIndikator + ' · ' + bingkaiIndikator(gayaIndikator, 0) + ' ' + bingkaiIndikator(gayaIndikator, 200) + ' (contoh bingkai)' });
          gambarNanti();
        });
        return;
      }
      if (!GAYA_INDIKATOR.includes(minta)) {
        dorong({ tipe: 'galat', teks: 'gaya tidak dikenal: ' + sisa[0] + ' · pilih: ' + GAYA_INDIKATOR.join(' | ') });
        return;
      }
      gayaIndikator = gayaSah(minta, { utf8: LOKAL_UTF8 });
      GAYA_AKTIF = gayaIndikator;
      simpanModel({ indikator: gayaIndikator });
      konfModel = konfigModel();
      dorong({ tipe: 'hasil', teks: 'indikator: ' + gayaIndikator + (gayaIndikator === 'ascii' && minta !== 'ascii' ? ' (terminal non-UTF8)' : '') });
      return;
    }
    if (nama === 'biaya') {
      // `/biaya` = total + 5 terakhir; `/biaya <hari>` = per model & per hari
      // (sama dengan `sakti biaya --hari=<n>`). Tanpa panggilan model.
      const hari = Math.max(0, Math.floor(Number(sisa[0]) || 0));
      for (const baris of ringkasBiaya(sesiId, { hari }).split('\n')) dorong({ tipe: 'hasil', teks: baris });
      return;
    }
    if (nama === 'diff') {
      try {
        dorong({ tipe: 'judul', teks: 'beda terhadap checkpoint' });
        const isi = bedaCheckpoint(sisa[0] || '');
        if (!isi) dorong({ tipe: 'info', teks: 'tidak ada beda' });
        else for (const baris of isi.split('\n').slice(0, 400)) dorong({ tipe: 'hasil', teks: baris });
      } catch (galat) { dorong({ tipe: 'galat', teks: String((galat && galat.message) || galat) }); }
      return;
    }
    if (nama === 'batal') { if (kendali) kendali.abort(); else dorong({ tipe: 'info', teks: 'tidak ada giliran yang berjalan' }); return; }
    if (nama === 'baru') { sesiId = sesiBaru({}).id; banner(); return; }
    if (nama === 'ulang') { if (terakhir) jalankan(terakhir); else dorong({ tipe: 'info', teks: 'belum ada pesan' }); return; }
    if (nama === 'ringkas') { ringkasSesi().then(gambarNanti); return; }
    if (nama === 'cabang') {
      if (sibuk) { dorong({ tipe: 'info', teks: 'tunggu giliran ini selesai dulu' }); return; }
      const baru = cabangSesi(sesiId, { sampai: Number(sisa[0]) || 0 });
      if (!baru) { dorong({ tipe: 'galat', teks: 'sesi ini kosong, tidak ada yang dicabang' }); return; }
      sesiId = baru.id;
      muatTranskrip();
      dorong({ tipe: 'judul', teks: 'cabang dibuat: ' + baru.id });
      dorong({ tipe: 'hasil', teks: baru.pesan + ' pesan disalin; sesi asal tidak disentuh' });
      return;
    }
    if (nama === 'alat') {
      // `/alat` = menu subset alat (hemat token skema). Kursor mendarat di
      // keadaan aktif; Enter = toggle satu alat, baris `semua alat` = kirim
      // semua lagi. Tersimpan di config.alat, jadi berlaku untuk semua muka.
      if (!sisa.length) {
        bukaPemilih(opsiAlat(ALAT.map((satu) => satu.name), konfModel), (opsi) => {
          const nilai = opsi && opsi.nilai;
          const kini = String(konfModel.alat || '').split(',').map((s) => s.trim()).filter(Boolean);
          if (nilai && Object.prototype.hasOwnProperty.call(nilai, 'alat')) {
            simpanModel({ alat: String(nilai.alat || '') });
          } else if (nilai && nilai.alatToggle) {
            const nama2 = nilai.alatToggle;
            const baru = kini.includes(nama2) ? kini.filter((s) => s !== nama2) : [...kini, nama2];
            // Daftar kosong = sentinel "SEMUA alat" di config. Mematikan alat
            // terakhir tidak boleh diam-diam membuka seluruh skema alat.
            if (!baru.length) {
              dorong({ tipe: 'galat', teks: 'minimal satu alat harus aktif; pakai /alat semua untuk membuka semuanya' });
              gambarNanti();
              return;
            }
            simpanModel({ alat: baru.join(',') });
          }
          konfModel = konfigModel();
          const dipakai = String(konfModel.alat || '').split(',').filter(Boolean);
          const teksJumlah = dipakai.length ? dipakai.length + ' alat: ' + dipakai.join(', ') : 'semua ' + ALAT.length + ' alat';
          dorong({ tipe: 'hasil', teks: 'alat dikirim ke model: ' + teksJumlah + (dipakai.length ? ' (hemat skema ' + Math.round((1 - dipakai.length / ALAT.length) * 100) + '%)' : '') });
          gambarNanti();
        });
        return;
      }
      // `/alat profil [ringan|standar|penuh]` - pangkas skema tanpa mendaftar
      // satu per satu. Daftar eksplisit (`/alat baca,cari`) tetap menang.
      if (String(sisa[0] || '').toLowerCase() === 'profil') {
        const pilihProfil = String(sisa[1] || '').toLowerCase();
        if (!pilihProfil) {
          const aktif = String(konfModel.profilAlat || 'penuh');
          dorong({ tipe: 'hasil', teks: 'profil alat: ' + aktif + ' · pilihan: ringan | standar | penuh' });
          return;
        }
        if (!['ringan', 'standar', 'penuh'].includes(pilihProfil)) {
          dorong({ tipe: 'galat', teks: 'profil tidak dikenal: ' + sisa[1] + ' · ringan | standar | penuh' });
          return;
        }
        simpanModel({ profilAlat: pilihProfil === 'penuh' ? '' : pilihProfil });
        konfModel = konfigModel();
        const dipakai = sempitAlat(konfModel);
        dorong({ tipe: 'hasil', teks: 'profil alat: ' + pilihProfil + ' · ' + (dipakai ? dipakai.length + ' alat dikirim ke model' : 'semua ' + ALAT.length + ' alat') });
        return;
      }
      const minta = String(sisa[0]).toLowerCase();
      if (['semua', 'all', '*'].includes(minta)) { simpanModel({ alat: '' }); konfModel = konfigModel(); dorong({ tipe: 'hasil', teks: 'alat dikirim ke model: semua ' + ALAT.length + ' alat' }); return; }
      // `pecah()` memisah per spasi, jadi `/alat baca,cari` datang sebagai satu
      // token `baca,cari` - pecah juga per koma.
      const diminta = sisa.join(',').split(',').map((s) => s.trim()).filter(Boolean);
      const asing = diminta.filter((s) => !ALAT.some((a) => a.name === s));
      if (asing.length) { dorong({ tipe: 'galat', teks: 'alat tidak dikenal: ' + asing.join(', ') + ' · lihat /alat' }); return; }
      simpanModel({ alat: diminta.join(',') });
      konfModel = konfigModel();
      dorong({ tipe: 'hasil', teks: 'alat dikirim ke model: ' + diminta.join(', ') });
      return;
    }
    if (nama === 'panel') {
      if (!sisa[0]) {
        bukaPemilih(opsiPanel(panel), (opsi) => {
          panel = opsi && opsi.nilai && Object.prototype.hasOwnProperty.call(opsi.nilai, 'panel') ? opsi.nilai.panel : panel;
          gambarNanti();
        });
        return;
      }
      panel = sisa[0] && PANEL.includes(sisa[0]) ? sisa[0] : PANEL[(PANEL.indexOf(panel) + 1) % PANEL.length];
      return;
    }
    if (nama === 'skill' || nama === 'ingatan' || nama === 'tugas' || nama === 'rencana') { panel = nama; return; }
    if (nama === 'chatroom') { panel = 'chatroom'; return; }
    if (nama === 'cwd') {
      if (!sisa[0]) { dorong({ tipe: 'hasil', teks: 'cwd ' + ctx.cwd }); return; }
      const tujuan = path.resolve(ctx.cwd, sisa[0]);
      if (!fs.existsSync(tujuan)) { dorong({ tipe: 'galat', teks: 'tidak ada: ' + tujuan }); return; }
      ctx.cwd = tujuan;
      dorong({ tipe: 'judul', teks: 'folder kerja' });
      dorong({ tipe: 'hasil', teks: ctx.cwd });
      return;
    }
    if (nama === 'bot') {
      const aksi = sisa[0];
      if (!aksi) {
        // Panel bot tetap ada; menu memberi aksi masuk/lepas tanpa menghafal nama.
        const semua = daftarBot();
        if (!semua.length) { panel = 'bot'; return; }
        panel = 'bot';
        bukaPemilih(opsiBot(semua, botDiRoom(sesiId)), (opsi) => {
          const namaBot = opsi && opsi.nilai && opsi.nilai.bot;
          const masuk = Boolean(opsi && opsi.nilai && opsi.nilai.masuk);
          if (!namaBot) return;
          const sekarang = botDiRoom(sesiId);
          const berikut = masuk ? [...new Set(sekarang.concat([namaBot]))] : sekarang.filter((satu) => satu !== namaBot);
          const akhir = aturRoom(sesiId, berikut);
          // Room bawaan ikut diubah supaya pilihan ini bertahan setelah restart.
          aturBawaan(masuk ? [...new Set(botBawaan().concat([namaBot]))] : botBawaan().filter((satu) => satu !== namaBot));
          dorong({ tipe: 'info', teks: (masuk ? 'masuk room: ' : 'lepas dari room: ') + namaBot + ' · room sekarang ' + (akhir.join(', ') || '(kosong - hanya kamu)') + ' · berlaku juga untuk sesi baru' });
        });
        return;
      }
      if (aksi === 'baru') {
        const namaBaru = sisa[1];
        if (!namaBaru) { dorong({ tipe: 'galat', teks: 'butuh nama: /bot baru riset prompt="kamu analis …"' }); return; }
        const nilai = {};
        const sisaToken = [];
        for (const potongan of sisa.slice(2)) {
          const pisah = potongan.indexOf('=');
          if (pisah > 0) nilai[potongan.slice(0, pisah)] = potongan.slice(pisah + 1);
          else sisaToken.push(potongan);
        }
        if (!nilai.prompt && sisaToken.length) nilai.prompt = sisaToken.join(' ');
        simpanBot(namaBaru, nilai);
        // Selalu MASUKKAN, jangan alihkan: bot baru yang namanya kebetulan sudah
        // ada di room tidak boleh malah terlempar keluar.
        aturRoom(sesiId, botDiRoom(sesiId).concat([namaBaru]));
        dorong({ tipe: 'judul', teks: 'bot dibuat: ' + namaBaru });
        dorong({ tipe: 'hasil', teks: 'berkas  ' + path.join(folderBot(), String(namaBaru).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') + '.json') });
        dorong({ tipe: 'hasil', teks: 'instruksi sudah masuk room ini; atur lagi dengan /bot set ' + namaBaru + ' prompt="…"' });
        return;
      }
      if (aksi === 'hapus') {
        const target = sisa[1];
        if (!target) { dorong({ tipe: 'galat', teks: 'butuh nama: /bot hapus riset' }); return; }
        hapusBot(target);
        aturRoom(sesiId, botDiRoom(sesiId).filter((satu) => satu !== target));
        dorong({ tipe: 'info', teks: 'bot dihapus: ' + target });
        return;
      }
      if (aksi === 'set') {
        const target = sisa[1];
        if (!target) { dorong({ tipe: 'galat', teks: 'butuh nama: /bot set riset prompt="…" model=… suhu=… alat=a,b' }); return; }
        const nilai = {};
        // `sisa` SUDAH dipecah dengan penghormatan kutip; jangan pecah ulang.
        // Dulu `pecah(sisa.slice(2).join(' '))` memecah `prompt="kamu analis"`
        // jadi prompt=kamu dan membuang kata sisanya.
        for (const potongan of sisa.slice(2)) {
          const pisah = potongan.indexOf('=');
          if (pisah > 0) nilai[potongan.slice(0, pisah)] = potongan.slice(pisah + 1);
        }
        if (!Object.keys(nilai).length) { dorong({ tipe: 'galat', teks: 'tidak ada yang diatur; contoh: prompt="kamu …" model=Gratis suhu=0.4 alat=baca,cari' }); return; }
        const hasil = simpanBot(target, nilai);
        dorong({ tipe: 'judul', teks: 'bot diperbarui: ' + hasil.nama });
        dorong({ tipe: 'hasil', teks: 'kunci  ' + Object.keys(nilai).join(', ') });
        return;
      }
      if (aksi === 'urut') {
        // Urutan bicara di room ini, menurut tugas. Angka kecil lebih dulu.
        const room = urutkanNamaPeserta(botDiRoom(sesiId), bacaBot);
        if (!room.length) { dorong({ tipe: 'info', teks: 'room ini kosong - hanya kamu' }); return; }
        dorong({ tipe: 'judul', teks: 'urutan bicara' });
        room.forEach((namaBot, i) => {
          const bot = bacaBot(namaBot);
          const tugas = (bot && bot.tugas) || '-';
          const urut = bot && Number.isFinite(Number(bot.urutan)) ? Number(bot.urutan) : 'bawaan';
          dorong({ tipe: 'hasil', teks: (i + 1) + '. ' + namaBot + '  tugas=' + tugas + '  urutan=' + urut });
        });
        dorong({ tipe: 'info', teks: 'ubah: /bot set <nama> tugas=qa urutan=10  · kecil bicara dulu' });
        return;
      }
      if (aksi === 'masuk' || aksi === 'lepas') {
        // Beberapa nama sekaligus: `/bot masuk riset kode`. `semua` = setiap bot
        // yang ada di disk. `/bot lepas semua` mengosongkan room.
        let target = sisa.slice(1).filter(Boolean);
        const semua = target.length === 1 && target[0] === 'semua';
        if (semua) target = daftarBot().map((satu) => satu.nama);
        if (!target.length) { dorong({ tipe: 'galat', teks: 'butuh nama: /bot ' + aksi + ' riset [kode ...] · /bot ' + aksi + ' semua' }); return; }
        const hilang = target.filter((namaBot) => !bacaBot(namaBot));
        if (hilang.length) { dorong({ tipe: 'galat', teks: 'bot tidak ada: ' + hilang.join(', ') + ' (buat: /bot baru ' + hilang[0] + ' prompt="...")' }); return; }
        const sekarang = botDiRoom(sesiId);
        const mau = aksi === 'masuk';
        const berikut = mau
          ? [...new Set(sekarang.concat(target))]
          : sekarang.filter((satu) => !target.includes(satu));
        const akhir = aturRoom(sesiId, berikut);
        // Room BAWAAN ikut diubah: tanpa ini `/bot masuk` hilang begitu TUI
        // ditutup, karena sesi berikutnya mewarisi room bawaan (bukan sesi ini).
        aturBawaan(mau ? [...new Set(botBawaan().concat(target))] : botBawaan().filter((satu) => !target.includes(satu)));
        const berubah = mau ? target.filter((satu) => !sekarang.includes(satu)) : target.filter((satu) => sekarang.includes(satu));
        dorong({ tipe: 'info', teks: (mau ? 'masuk room: ' : 'lepas dari room: ') + (berubah.join(', ') || '(tidak ada perubahan)') + ' · room sekarang ' + (akhir.join(', ') || '(kosong - hanya kamu)') + ' · berlaku juga untuk sesi baru' });
        return;
      }
      // /bot <nama> = masuk/lepas
      if (!bacaBot(aksi)) { dorong({ tipe: 'galat', teks: 'bot tidak ada: ' + aksi + ' (buat: /bot baru ' + aksi + ')' }); return; }
      const akhir = alihkanRoom(sesiId, aksi);
      // Samakan room bawaan agar pilihan ini tidak hilang setelah restart.
      aturBawaan(akhir);
      dorong({ tipe: 'info', teks: (akhir.includes(aksi) ? 'masuk room: ' : 'lepas dari room: ') + aksi + ' · room ' + (akhir.join(', ') || '(kosong)') });
      return;
    }
    if (nama === 'kotak') {
      const untuk = String(sisa[0] || '').trim();
      const rows = daftarPesan(sesiId || 'global', { untuk, batas: 20 });
      dorong({ tipe: 'judul', teks: 'kotak pesan' + (untuk ? ' · ' + untuk : '') + ' · ' + rows.length });
      if (!rows.length) dorong({ tipe: 'info', teks: 'belum ada pesan antar-bot di sesi ini' });
      else for (const satu of rows) dorong({ tipe: 'hasil', teks: '[' + satu.id + '] ' + satu.jenis + ' · ' + satu.dari + ' -> ' + satu.ke.join(',') + ' · ' + satu.status + ' · ' + String(satu.teks).slice(0, 120) });
      dorong({ tipe: 'info', teks: 'tutup/balas lewat alat: sakti kotak aksi=selesai id=<id> hasil="..."' });
      return;
    }
    if (nama === 'sesi') {
      const tujuan = sisa[0];
      if (tujuan) {
        const ada = daftarSesi().find((row) => row.id === tujuan || row.id.endsWith(tujuan));
        if (!ada) { dorong({ tipe: 'galat', teks: 'sesi tidak ada: ' + tujuan }); return; }
        if (sibuk) { dorong({ tipe: 'info', teks: 'tunggu giliran ini selesai dulu' }); return; }
        sesiId = ada.id;
        muatTranskrip();
        return;
      }
      // Tanpa argumen: daftar sesi yang bisa dipilih, bukan hanya panel.
      if (sibuk) { dorong({ tipe: 'info', teks: 'tunggu giliran ini selesai dulu' }); return; }
      const rows = daftarSesi({ batas: 50 });
      if (!rows.length) { dorong({ tipe: 'info', teks: 'belum ada sesi' }); return; }
      bukaPemilih(opsiSesi(rows, sesiId), (opsi) => {
        const id = opsi && opsi.nilai && opsi.nilai.sesi;
        if (!id) return;
        sesiId = id;
        muatTranskrip();
      });
      return;
    }
    if (nama === 'model') {
      if (['tes', 'test', 'cek'].includes(String(sisa[0] || '').toLowerCase())) { tesKoneksi(); return; }
      // /model tanpa argumen = menu pilihan interaktif. Katalog endpoint aktif
      // yang segar dipakai tanpa jaringan. Kalau kosong, basi (TTL), atau model
      // aktif tidak ada di dalamnya, katalog diambil ulang dulu supaya yang
      // tampil model yang benar-benar ditawarkan endpoint ini, bukan daftar basi.
      if (!sisa.length) {
        const tersimpan = Array.isArray(konfModel.models) ? konfModel.models : [];
        const alasan = !tersimpan.length
          ? 'katalog endpoint ini belum ada'
          : (!tersimpan.includes(konfModel.model) ? 'model aktif tidak ada di katalog' : 'katalog basi');
        if (perluSegarkanKatalog(konfModel) || !tersimpan.includes(konfModel.model)) {
          muatKatalogModel({ tipe: 'info', teks: alasan + '; mengambil dari ' + konfModel.baseUrl + ' …' });
          return;
        }
        for (const satu of peringatanTurunan()) dorong({ tipe: 'info', teks: 'model turunan: ' + satu });
        bukaPemilih(opsiModel(konfModel), terapkanModel);
        return;
      }
      // /model <nama> pilih model · /model set model=.. url=.. key=.. tulis config
      if (sisa[0] === 'set' || sisa.length) {
        const baru = {};
        const pasangan = sisa[0] === 'set' ? sisa.slice(1) : sisa;
        for (const potongan of pasangan) {
          const pisah = potongan.indexOf('=');
          if (pisah < 1) { baru.model = potongan; continue; }
          const kunci = potongan.slice(0, pisah);
          const nilai = potongan.slice(pisah + 1);
          if (kunci === 'model') baru.model = nilai;
          else if (['url', 'model-url', 'baseUrl'].includes(kunci)) {
            try { baru.baseUrl = rapikanUrl(nilai); } catch (galat) { dorong({ tipe: 'galat', teks: String((galat && galat.message) || galat) }); return; }
          }
          else if (['key', 'model-key', 'apiKey'].includes(kunci)) baru.apiKey = nilai;
          else { dorong({ tipe: 'galat', teks: 'kunci tidak dikenal: ' + kunci + ' · pakai model= | url= | key=' }); return; }
        }
        if (!Object.keys(baru).length) { dorong({ tipe: 'galat', teks: 'contoh: /model set model=Gratis url=http://localhost:3000/v1 key=sk-...' }); return; }
        simpanModel(baru);
        konfModel = konfigModel();
        // Endpoint berganti = katalog lama tidak berlaku; ambil daftar model
        // endpoint baru tanpa perlu perintah tambahan.
        segarkanKatalogLatar('endpoint baru');
        dorong({ tipe: 'judul', teks: 'model disimpan' });
        dorong({ tipe: 'hasil', teks: 'diubah  ' + Object.keys(baru).join(', ') });
        const timpaModel = peringatanTimpa(baru, konfModel);
        if (timpaModel.length) dorong({ tipe: 'galat', teks: 'env masih menimpa: ' + timpaModel.join(' · ') });
      }
      dorong({ tipe: 'judul', teks: 'model' });
      dorong({ tipe: 'hasil', teks: konfModel.model + ' @ ' + konfModel.baseUrl });
      dorong({ tipe: 'hasil', teks: 'kunci ' + (konfModel.apiKey ? 'ada' : 'kosong') + ' · berkas ' + konfModel.berkas });
      const katalog = konfModel.models;
      if (sisa[0] !== 'set' && Array.isArray(katalog) && katalog.length) {
        dorong({ tipe: 'hasil', teks: katalog.length + ' model untuk ' + konfModel.baseUrl + ' · disegarkan ' + umurKatalog(konfModel.katalogWaktu) + ' · /model <nama> untuk pilih' });
        if (!katalog.includes(konfModel.model)) {
          const kecil = String(konfModel.model || '').toLowerCase();
          const mirip = katalog.filter((satu) => String(satu).toLowerCase().includes(kecil)).slice(0, 5);
          dorong({ tipe: 'info', teks: 'model aktif tidak ada di katalog TERSIMPAN (bisa basi)' + (mirip.length ? ' · mirip: ' + mirip.join(', ') : '') + ' · /model tes untuk cek langsung' });
        }
      } else if (sisa[0] !== 'set') {
        dorong({ tipe: 'info', teks: 'katalog endpoint ini belum ada · /model tanpa argumen untuk menarik GET /models' });
      }
      for (const satu of peringatanTurunan()) dorong({ tipe: 'info', teks: 'model turunan: ' + satu });
      return;
    }
    if (nama === 'pengaturan' || nama === 'setting' || nama === 'setelan' || nama === 'endpoint' || nama === 'apikey' || nama === 'key') {
      if (nama === 'pengaturan' && ['tes', 'test', 'cek'].includes(String(sisa[0] || '').toLowerCase())) { panel = 'pengaturan'; tesKoneksi(); return; }
      // Pintasan: /endpoint <url> dan /apikey <kunci> = /pengaturan url|key.
      const argumen = nama === 'endpoint' ? (sisa.length ? ['url', ...sisa] : []) : nama === 'apikey' || nama === 'key' ? (sisa.length ? ['key', ...sisa] : []) : sisa;
      const hasil = ubahPengaturan(argumen, konfModel);
      if (hasil.galat) { dorong({ tipe: 'galat', teks: hasil.galat }); return; }
      if (Object.keys(hasil.baru).length) {
        simpanModel(hasil.baru);
        konfModel = konfigModel();
        // URL diganti lewat /pengaturan = katalog endpoint baru diambil sendiri.
        segarkanKatalogLatar('endpoint baru');
        dorong({ tipe: 'judul', teks: 'pengaturan disimpan' });
        for (const satu of hasil.catatan) dorong({ tipe: 'hasil', teks: satu });
        const timpa = peringatanTimpa(hasil.baru, konfModel);
        if (timpa.length) dorong({ tipe: 'galat', teks: 'env masih menimpa: ' + timpa.join(' · ') });
        else dorong({ tipe: 'info', teks: 'berlaku sekarang juga, tanpa keluar app' });
      } else {
        const rute = ruteAktif(konfModel)
          ? (konfModel.ruteTingkat ? 'on, dipatok ' + tingkatSah(konfModel.ruteTingkat) : 'on, auto')
          : 'off';
        dorong({ tipe: 'judul', teks: 'pengaturan' });
        for (const satu of barisPengaturan(konfModel, { rute, izin: modeIzin(), worker: workerRoom })) dorong({ tipe: 'hasil', teks: satu });
        dorong({ tipe: 'info', teks: 'menu di atas: ↑↓ pilih · Enter buka · url/key tetap diketik: /pengaturan url <url> · /pengaturan key <kunci> · /pengaturan hapus-key' });
        // Menu akar: baris memilih submenu nilai yang sudah interaktif.
        bukaPemilih(opsiPengaturan(konfModel, { rute, izin: modeIzin(), worker: workerRoom, room: modeRoomTersimpan() }), (opsi) => {
          const menu = opsi && opsi.nilai && opsi.nilai.menu;
          if (menu) perintah('/' + menu);
        });
      }
      panel = 'pengaturan';
      return;
    }
    // Perintah kustom: /nama -> prompt tersimpan, argumen mengisi $ARGUMEN.
    const kustom = rangkaiPerintah(nama, sisa.join(' '), { cwd: ctx && ctx.cwd });
    if (kustom) {
      dorong({ tipe: 'judul', teks: '/' + nama });
      jalankan(kustom);
      return;
    }
    if (nama === 'help' || nama === 'bantuan' || !PERINTAH.includes('/' + nama)) {
      dorong({ tipe: 'judul', teks: 'perintah' });
      for (const satu of PERINTAH) dorong({ tipe: 'hasil', teks: satu.padEnd(10) + KET[satu] });
      dorong({ tipe: 'judul', teks: 'tombol' });
      for (const satu of ['Enter kirim (boleh saat bekerja: masuk antrean)', 'Tab lengkapi nama perintah/alat/skill', 'Ctrl+O putar panel · Esc tutup', 'Ctrl+C hentikan giliran · kosong = keluar', 'PgUp/PgDn · Shift+↑/↓ · panah ↑/↓ gulir transkrip (di HP juga)', 'Ctrl+E ke bawah · /atas /bawah /puncak /dasar · /gulir <n>', '!perintah jalan bash langsung', 'Ctrl+L bersihkan · Ctrl+A/E/W/U/K edit baris']) {
        dorong({ tipe: 'hasil', teks: satu });
      }
      return;
    }
    dorong({ tipe: 'info', teks: 'perintah tidak dikenal: /' + nama });
  }

  function selesai() {
    if (keluar) return;
    keluar = true;
    if (pewaktu) clearTimeout(pewaktu);
    // Child MCP memegang pipe dan menahan event loop: tanpa penutupan ini
    // `process.exit` tetap jalan, tapi TUI yang ditutup lewat sinyal bisa
    // menggantung dengan `rea mcp` sebagai yatim. Satu panggilan, nol biaya.
    try { tutupMcp(); } catch { /* tidak ada koneksi */ }
    simpanRiwayat(riwayatInput);
    let jumlah = 0;
    try { jumlah = bacaSesi(sesiId).length; } catch { /* - */ }
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
    try { process.stdin.setRawMode(false); } catch { /* - */ }
    process.stdin.pause();
    console.log('sakti: sesi ' + sesiId + ' disimpan (' + jumlah + ' pesan)');
    process.exit(0);
  }

  async function bashLangsung(teks) {
    if (!teks) { dorong({ tipe: 'info', teks: '!butuh perintah' }); gambarNanti(); return; }
    dorong({ tipe: 'user', teks: '!' + teks });
    dorong({ tipe: 'alat', teks: 'terminal  ' + potong(teks, 60) });
    gambarNanti();
    try {
      const isi = await jalankanAlat('terminal', { perintah: teks }, ctx);
      const gagal = /^GAGAL/.test(isi);
      dorong({ tipe: 'hasil', penuh: String(isi), teks: String(isi).split('\n')[0], gagal });
    } catch (galat) {
      dorong({ tipe: 'galat', teks: 'GAGAL: ' + String((galat && galat.message) || galat) });
    }
    gambarNanti();
  }

  /* ---------------------------------------------------------- tombol --- */

  // Layar penuh mematikan scrollback terminal, jadi roda mouse harus ditangani
  // sendiri: aktifkan pelaporan SGR (?1000h + ?1006h), lalu saring escape-nya
  // sebelum readline sempat memecahnya jadi ketikan sampah seperti "64;20;10M".
  // ?7l = autowrap mati: TUI menggambar per baris absolut; satu baris penuh
  // di dasar layar tidak boleh menggulir scrollback (gejala status berulang).
  process.stdout.write('\x1b[?1049h\x1b[?7l\x1b[2J\x1b[H\x1b[?25h\x1b[?1000h\x1b[?1006h\x1b[?2004h');
  const masuk = new SaringMouse();
  process.stdin.pipe(masuk);
  readline.emitKeypressEvents(masuk);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const pulihkan = () => {
    // Raw mode WAJIB dilepas di sini: dulu hanya `selesai()` yang melakukannya,
    // jadi crash/exception meninggalkan terminal tanpa echo dan tanpa line
    // discipline sampai pengguna menjalankan `stty sane`.
    try { process.stdin.setRawMode(false); } catch { /* bukan TTY */ }
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?7h\x1b[?2004l\x1b[?1049l');
  };
  process.on('exit', pulihkan);
  // Jalur darurat: exception/rejection di luar `amanPerintah` tidak boleh
  // mematikan proses dengan terminal masih raw. Cetak alasannya, pulihkan,
  // lalu keluar dengan kode gagal (bukan menelan bug).
  const darurat = (galat) => {
    try { pulihkan(); } catch { /* - */ }
    try { console.error('\nsakti: berhenti karena galat: ' + String((galat && galat.stack) || galat)); } catch { /* - */ }
    process.exit(1);
  };
  process.once('uncaughtException', darurat);
  process.once('unhandledRejection', darurat);
  process.on('SIGWINCH', () => { process.stdout.write('\x1b[2J'); layarSebelum.length = 0; kotor = true; gambar(); });

  // Roda mouse memancarkan 'gulir' sendiri: byte-nya dibuang SaringMouse, jadi
  // tidak pernah jadi keypress. Dulu hanya dibaca di handler keypress -> roda
  // diam sampai ada tombol ditekan. Batas pakai batasGulir (dari penggambar),
  // bukan panjang transkrip, supaya tidak bisa menggulir ke layar kosong.
  masuk.on('gulir', () => {
    const putaranRoda = masuk.ambilGulir();
    if (putaranRoda) geser(putaranRoda > 0 ? 'naik' : 'turun', Math.abs(putaranRoda) * 3);
  });

  masuk.on('keypress', (str, tombol) => {
    // Jeda sejak tombol sebelumnya: pembeda pasta vs ketikan manusia. Dihitung
    // SEBELUM cabang mana pun supaya semua jalur (termasuk return dini) jujur.
    {
      const kini = Date.now();
      jedaTombol = capWaktuTombol ? kini - capWaktuTombol : 1e9;
      capWaktuTombol = kini;
      ledakanKetik = jedaTombol < 25 ? ledakanKetik + 1 : 0;
    }
    // Pasta sungguhan (kurung 2004) punya pembatas paste-start/-end. Di banyak
    // terminal (macOS iTerm, beberapa Termux) pembatas paste-end tidak pernah
    // datang; penanda lama dilepas hanya kalau Enter tiba JAUH setelah ketikan
    // terakhir - Enter di tengah pasta tidak boleh melepasnya (dulu justru itu
    // penyebab: 'return' ber-str melepas penanda, 'enter' CRLF berikutnya
    // langsung mengirim pesan).
    if (sedangPaste && tombol && (tombol.name === 'return' || tombol.name === 'enter') && jedaTombol > 500) sedangPaste = false;
    if (tombol && tombol.name === 'paste-start') { sedangPaste = true; return; }
    if (tombol && tombol.name === 'paste-end') { sedangPaste = false; crlfBaru = 0; gambarNanti(); return; }
    // Esc mentah (tanpa urutan lengkap) kadang tidak punya nama tombol:
    // readline menahannya sampai ketikan berikutnya, lalu mengirim event
    // `meta` dengan sequence "\x1b<char>". Selama menu terbuka, Esc berarti
    // batal; karakter yang ikut menempel tetap diteruskan ke baris masukan
    // supaya `/worker` sesudah Esc tidak kehilangan garis miringnya.
    if (pemilih && (str === '\x1b' || (tombol && tombol.meta))) {
      tutupPemilih();
      const sisaMeta = tombol && typeof tombol.sequence === 'string' ? tombol.sequence.replace(/^\x1b/, '') : '';
      if (sisaMeta && !/[\x00-\x1f\x7f]/.test(sisaMeta)) { masukan += sisaMeta; kursor = masukan.length; palet = 0; gambarNanti(); }
      return;
    }
    if (!tombol) return;

    // Menu pilihan memegang panah/Enter/Esc lebih dulu. Ketikan lain ditelan:
    // mengetik di balik menu hanya membingungkan, dan Enter akan menerapkan
    // opsi yang tidak sengaja disorot.
    if (pemilih) {
      if (tombol.name === 'up' || tombol.name === 'down') {
        pemilih.indeks = geserPilihan(pemilih.indeks, tombol.name === 'up' ? -1 : 1, pemilih.opsi.length);
        gambarNanti();
        return;
      }
      if (tombol.name === 'home') { pemilih.indeks = 0; gambarNanti(); return; }
      if (tombol.name === 'end') { pemilih.indeks = Math.max(0, pemilih.opsi.length - 1); gambarNanti(); return; }
      if (tombol.name === 'return' || tombol.name === 'enter') {
        // Enter dari pasta di dalam menu juga bukan "pakai opsi".
        if (enterSebagaiBaris({ sedangPaste, jeda: jedaTombol, ledakan: ledakanKetik })) return;
        terapkanPemilih();
        return;
      }
      if (tombol.name === 'escape' || (tombol.ctrl && tombol.name === 'c')) { tutupPemilih(); return; }
      return;
    }

    // Izin wajib dijawab dari keypress, bukan dari fungsi gambar. Dulu
    // `gambar()` memanggil `jawabIzin(tombol)` dengan `tombol` undefined,
    // sehingga setiap pertanyaan izin langsung dijawab "tolak" saat layar
    // digambar - bot rekan lalu tampak tidak merespons.
    if (tanyaAktif) {
      // Teks yang ditempel BUKAN jawaban. Tanpa penjagaan ini pasta yang
      // kebetulan dimulai huruf `s` memberi izin permanen ("selalu").
      if (sedangPaste || ledakanKetik >= LEDAKAN_PASTA) return;
      const namaTombol = tombol && tombol.name;
      const hurufTombol = String((tombol && tombol.sequence) || '').toLowerCase();
      if (tombol && tombol.ctrl && namaTombol === 'c') {
        jawabIzin({ name: 't' }); // Ctrl+C saat izin = tolak, jangan biarkan menggantung
      } else if (['y', 's', 't'].includes(hurufTombol) || ['return', 'enter', 'escape'].includes(namaTombol)) {
        jawabIzin(tombol);
      }
      return;
    }

    const daftarPalet = masukan.startsWith('/') && !sibuk ? paletCocok() : [];
    const adaPalet = daftarPalet.length > 0;

    if (tombol.ctrl && tombol.name === 'c') {
      if (tanyaAktif) { jawabIzin({ name: 't' }); return; }
      if (sibuk && kendali) { kendali.abort(); keadaan = 'membatalkan'; gambarNanti(); return; }
      if (masukan) { masukan = ''; kursor = 0; gambarNanti(); return; }
      selesai();
      return;
    }
    if (tombol.ctrl && tombol.name === 'd' && !masukan) { selesai(); return; }
    if (tombol.ctrl && tombol.name === 'o') { panel = PANEL[(PANEL.indexOf(panel) + 1) % PANEL.length]; gambarNanti(); return; }
    if (tombol.ctrl && tombol.name === 'l') { banner(); gambarNanti(); return; }
    if (tombol.ctrl && tombol.name === 'e') { gulir = 0; gambarNanti(); return; }
    // Tanpa roda mouse, tanpa PgUp/PgDn, tanpa Shift+panah (HP): Ctrl+Y / Ctrl+B
    // menggulir transkrip sebaris, Ctrl+G kembali ke dasar.
    if (tombol.ctrl && tombol.name === 'y' && !masukan) { geser('naik', 1); return; }
    if (tombol.ctrl && tombol.name === 'b' && !masukan) { geser('turun', 1); return; }
    if (tombol.ctrl && tombol.name === 'g') { geser('dasar'); return; }
    if (tombol.ctrl && tombol.name === 't') { rinci = !rinci; lebarTerakhir = 0; kotor = true; gambarNanti(); return; }
    if (tombol.name === 'pageup') { geser('naik', 10); return; }
    if (tombol.name === 'pagedown') { geser('turun', 10); return; }
    if (tombol.name === 'home' && tombol.shift) { geser('puncak'); return; }
    if (tombol.name === 'end' && tombol.shift) { geser('dasar'); return; }
    // Panah TIDAK menggulir: panah = riwayat input (dan seleksi palet). Gulir
    // punya jalurnya sendiri: roda mouse, PgUp/PgDn, Ctrl+Y/Ctrl+B, Shift+Home/End.
    if (tombol.name === 'escape') { if (panel) panel = null; gambarNanti(); return; }

    if (adaPalet && (tombol.name === 'up' || tombol.name === 'down')) {
      palet = (palet + (tombol.name === 'up' ? -1 : 1) + daftarPalet.length) % daftarPalet.length;
      gambarNanti();
      return;
    }

    if (tombol.name === 'return' || tombol.name === 'enter') {
      // Enter yang menempel ke pasta = baris baru, BUKAN kirim. Ini yang bikin
      // teks hasil tempel langsung terkirim di terminal tanpa penanda pasta.
      // Shift+Enter juga selalu baris baru (kebiasaan editor).
      if (enterSebagaiBaris({ sedangPaste, jeda: jedaTombol, ledakan: ledakanKetik }) || tombol.shift) {
        // CRLF: '\r' lalu '\n' dari pasta yang sama = SATU baris baru.
        if (tombol.name === 'enter' && crlfBaru && Date.now() - crlfBaru < 20) {
          crlfBaru = 0;
          gambarNanti();
          return;
        }
        if (tombol.name === 'return') crlfBaru = Date.now();
        masukan = masukan.slice(0, kursor) + '\n' + masukan.slice(kursor);
        kursor += 1;
        gambarNanti();
        return;
      }
      if (adaPalet) {
        const pilihan = daftarPalet[palet % daftarPalet.length];
        masukan = '';
        kursor = 0;
        amanPerintah(pilihan);
        kotor = true;
        gambarNanti();
        return;
      }
      const teks = masukan.replace(/[\r\n]+$/, '');
      masukan = '';
      kursor = 0;
      if (!teks) { gambarNanti(); return; }
      riwayatInput.push(sensorRiwayat(teks));
      posisiRiwayat = riwayatInput.length;
      if (teks.startsWith('!')) { bashLangsung(teks.slice(1).trim()); return; }
      if (teks.startsWith('/')) { amanPerintah(teks); kotor = true; gambarNanti(); return; }
      jalankan(teks);
      return;
    }

    if (tombol.name === 'tab') {
      const potongan = masukan.split(/\s+/);
      if (masukan.startsWith('/')) {
        const cocok = PERINTAH.filter((satu) => satu.startsWith(masukan));
        if (cocok.length) { masukan = cocok[0] + (cocok.length === 1 ? ' ' : ''); kursor = masukan.length; }
      } else if (potongan.length <= 1) {
        const nama = [...ALAT.map((satu) => satu.name), ...daftarSkill().map((satu) => satu.nama)];
        const cocok = nama.filter((satu) => satu.startsWith(potongan[0] || ''));
        if (cocok.length) { masukan = cocok[0]; kursor = masukan.length; }
      }
      gambarNanti();
      return;
    }

    if (tombol.name === 'up') {
      // Navigasi riwayat: saat entri sedang tampil, `masukan` tidak kosong -
      // dulu syarat `!masukan` membuat panah atas hanya bekerja SEKALI.
      const entri = riwayatInput[posisiRiwayat] || '';
      if (riwayatInput.length && (!masukan || masukan === entri) && posisiRiwayat > 0) {
        posisiRiwayat = Math.max(0, posisiRiwayat - 1);
        masukan = riwayatInput[posisiRiwayat] || '';
        kursor = masukan.length;
      }
      gambarNanti();
      return;
    }
    if (tombol.name === 'down') {
      const entri = riwayatInput[posisiRiwayat] || '';
      if (posisiRiwayat < riwayatInput.length && (!masukan || masukan === entri)) {
        posisiRiwayat = Math.min(riwayatInput.length, posisiRiwayat + 1);
        masukan = riwayatInput[posisiRiwayat] || '';
        kursor = masukan.length;
      }
      gambarNanti();
      return;
    }
    if (tombol.name === 'left') { kursor = batasSebelum(masukan, kursor); gambarNanti(); return; }
    if (tombol.name === 'right') { kursor = batasSesudah(masukan, kursor); gambarNanti(); return; }
    if (tombol.name === 'home' || (tombol.ctrl && tombol.name === 'a')) { kursor = 0; gambarNanti(); return; }
    if (tombol.name === 'end') { kursor = masukan.length; gambarNanti(); return; }
    if (tombol.name === 'backspace') {
      if (kursor > 0) {
        const mulai = batasSebelum(masukan, kursor);
        masukan = masukan.slice(0, mulai) + masukan.slice(kursor);
        kursor = mulai;
        palet = 0;
      }
      gambarNanti();
      return;
    }
    if (tombol.name === 'delete') {
      const akhir = batasSesudah(masukan, kursor);
      masukan = masukan.slice(0, kursor) + masukan.slice(akhir);
      gambarNanti();
      return;
    }
    if (tombol.ctrl && tombol.name === 'w') {
      const depan = masukan.slice(0, kursor).replace(/\s*\S+$/, '');
      masukan = depan + masukan.slice(kursor);
      kursor = depan.length;
      gambarNanti();
      return;
    }
    if (tombol.ctrl && tombol.name === 'u') { masukan = masukan.slice(kursor); kursor = 0; gambarNanti(); return; }
    if (tombol.ctrl && tombol.name === 'k') { masukan = masukan.slice(0, kursor); gambarNanti(); return; }

    if (str && !tombol.ctrl && str >= ' ') {
      masukan = masukan.slice(0, kursor) + str + masukan.slice(kursor);
      kursor += str.length;
      if (masukan.startsWith('/')) palet = 0;
      gambarNanti();
    }
  });

  // Muat transkrip sesi yang dibuka (--lanjut/--sesi): dulu hanya sidebar yang
  // menyebut id sesi, layarnya kosong sampai pengguna berpindah sesi.
  muatTranskrip();
  banner(true);
  // Bersih-bersih sampah saat app dibuka: hanya spill/checkpoint/tmp, tidak
  // pernah sesi/skill/ingatan/config. Matikan lewat SAKTI_BERSIH_MATI=1.
  if (!/^(1|true|ya)$/i.test(String(process.env.SAKTI_BERSIH_MATI || ''))) {
    try {
      const sapu = sapuSampah({});
      if (sapu && sapu.dihapus > 0) dorong({ tipe: 'info', teks: ringkasSampah(sapu) });
    } catch { /* pembersihan tidak boleh menahan app dibuka */ }
  }
  gambar();
  // Katalog model mengikuti endpoint: diambil sendiri saat app dibuka bila
  // kosong/basi, tanpa menahan layar dan tanpa menanyakan apa pun.
  segarkanKatalogLatar();
  await new Promise(() => { /* berjalan sampai selesai() memanggil process.exit */ });
}

export { barisArgumen, bingkai, bungkus, duaSisi, durasi, gaya, lebar, potong, segmen, warnaiDiff };