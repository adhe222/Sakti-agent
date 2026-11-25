// Keahlian (skill): folder berisi SKILL.md dengan frontmatter name/description,
// persis bentuk yang dipakai Hermes dan pi - jadi folder skill yang sudah ada di
// mesin ini langsung terpakai tanpa menjalankan biner mereka.
//
// Yang dibaca hanya teksnya: indeks (nama + deskripsi) masuk ke system prompt,
// isi lengkap dimuat saat benar-benar dibutuhkan.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { berkasState, bacaState, ubahState } from './lokal.js';

// ------------------------------------------------------------------ curator ---
// Terinspirasi curator Hermes: cara pakainya dicatat, yang lama tidak dipakai
// masuk status `stale` lalu diarsipkan. Di sini SENGAJA tanpa LLM dan tanpa
// interval latar: murni deterministik, dijalankan saat `sakti skill curator`
// dipanggil, dan tidak pernah menghapus - arsip selalu bisa dipulihkan.

function petaPakai(state) {
  const semua = (state && state.skillPakai) || {};
  const bersih = {};
  for (const [nama, row] of Object.entries(semua)) {
    if (row && typeof row === 'object') bersih[nama] = { dipakai: Number(row.dipakai) || 0, terakhir: Number(row.terakhir) || 0, pin: !!row.pin };
  }
  return bersih;
}

function folderArsip() {
  return process.env.SAKTI_CLI_SKILL_ARSIP || path.join(os.homedir(), '.sakti-cli', 'skills-arsip');
}

/** Catat satu pemakaian skill. Folder state dibuat bila belum ada. */
export function catatPakai(nama, { at = Date.now() } = {}) {
  const namaBersih = String(nama || '').trim();
  if (!namaBersih) return null;
  try {
    fs.mkdirSync(path.dirname(berkasState()), { recursive: true });
    return ubahState((state) => {
      const peta = petaPakai(state);
      const lama = peta[namaBersih] || { dipakai: 0, terakhir: 0, pin: false };
      peta[namaBersih] = { dipakai: lama.dipakai + 1, terakhir: at, pin: lama.pin };
      state.skillPakai = peta;
      return peta[namaBersih];
    });
  } catch { return null; /* pembukuan tidak boleh mematikan satu giliran */ }
}

/** Tandai `stale` atau `arsipkan`. Tanpa tulis berkas dan tanpa pindah folder. */
export function statusSkill({ hariStale = 14, hariArsip = 30, sekarang = Date.now() } = {}) {
  const peta = petaPakai(bacaState());
  const hari = (ms) => ms / 86400000;
  return daftarSkill().map((satu) => {
    const pakai = peta[satu.nama] || { dipakai: 0, terakhir: 0, pin: false };
    const umurHari = pakai.terakhir ? hari(sekarang - pakai.terakhir) : Infinity;
    // Grace floor seperti curator Hermes: belum pernah dipakai bukan bukti
    // keahlian itu layak dibuang, jadi statusnya tetap `active` sampai ada
    // catatan pemakaian yang benar-benar menua.
    let status = Number.isFinite(umurHari) && umurHari >= hariArsip ? 'archive' : (Number.isFinite(umurHari) && umurHari >= hariStale ? 'stale' : 'active');
    if (pakai.pin) status = 'pinned';
    return Object.assign({}, satu, { status, dipakai: pakai.dipakai, terakhir: pakai.terakhir, pin: pakai.pin, umurHari });
  });
}

/** Pindahkan SKILL.md + berkas pendukungnya ke folder arsip (bisa dipulihkan). */
export function arsipkanSkill(nama) {
  const hasil = cariSkill(nama);
  if (!hasil) return { pindah: false, alasan: 'keahlian tidak ditemukan: ' + nama };
  const asal = path.dirname(hasil.jalur);
  const tujuan = path.join(folderArsip(), path.basename(asal));
  if (fs.existsSync(tujuan)) return { pindah: false, alasan: 'sudah ada di arsip: ' + tujuan };
  fs.mkdirSync(path.dirname(tujuan), { recursive: true });
  try { fs.renameSync(asal, tujuan); }
  catch (galat) {
    // Arsip biasanya di home yang sama, tapi $SAKTI_CLI_SKILL_ARSIP bisa di
    // filesystem lain (EXDEV). Salin lalu hapus = arti "pindahkan".
    if (!galat || galat.code !== 'EXDEV') throw galat;
    fs.cpSync(asal, tujuan, { recursive: true });
    fs.rmSync(asal, { recursive: true, force: true });
  }
  kosongkanSkillCache();
  return { pindah: true, dari: asal, ke: tujuan };
}

/** Pasang/copot penanda `pin`: keahlian berpin tidak pernah diarsipkan otomatis. */
export function pinSkill(nama, pin = true) {
  const namaBersih = String(nama || '').trim();
  if (!namaBersih) throw new Error('nama keahlian kosong');
  return ubahState((state) => {
    const peta = petaPakai(state);
    peta[namaBersih] = Object.assign({ dipakai: 0, terakhir: 0 }, peta[namaBersih], { pin: !!pin });
    state.skillPakai = peta;
    return peta[namaBersih];
  });
}

export function folderSkill() {
  const bawaan = [
    path.join(os.homedir(), '.sakti-cli', 'skills'),
    path.join(os.homedir(), '.hermes', 'skills'),
    path.join('/root', 'sakti', 'skills')
  ];
  const tambahan = String(process.env.SAKTI_SKILL_DIRS || '').split(':').map((satu) => satu.trim()).filter(Boolean);
  return [...new Set([...bawaan, ...tambahan])].filter((satu) => {
    try { return fs.statSync(satu).isDirectory(); } catch { return false; }
  });
}

function bacaFrontmatter(teks) {
  const cocok = /^---\n([\s\S]*?)\n---\n?/.exec(teks);
  if (!cocok) return { nama: '', deskripsi: '' };
  const isi = {};
  const baris = cocok[1].split('\n');
  for (let i = 0; i < baris.length; i++) {
    const pisah = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(baris[i].trim());
    if (!pisah) continue;
    let nilai = pisah[2].trim();
    // block scalar: "description: >" lalu baris menjorok di bawahnya
    if (nilai === '>' || nilai === '|' || nilai === '>-' || nilai === '|-') {
      const kumpul = [];
      while (i + 1 < baris.length && /^\s+\S/.test(baris[i + 1])) kumpul.push(baris[++i].trim());
      nilai = kumpul.join(nilai.startsWith('|') ? '\n' : ' ');
    }
    isi[pisah[1].toLowerCase()] = nilai.replace(/^["']|["']$/g, '');
  }
  return { nama: isi.name || '', deskripsi: isi.description || '' };
}

/** Semua SKILL.md di semua folder skill, dicari rekursif. */
// Cache per berkas: kunci jalur, nilai mtime+size+isi frontmatter. Folder tetap
// dipindai ulang (murah) dan stat tiap SKILL.md menentukan segar/tidak, jadi
// hasilnya tidak pernah basi walau skill diedit dari luar - tapi tidak lagi
// membaca 126 berkas tiap frame TUI (~33-68ms -> ~beberapa ms).
const _berkasSkill = new Map();
// Memo hasil penuh 1 detik: stat 126 berkas masih ~13ms, terlalu mahal untuk
// tiap frame TUI. Perubahan skill dari luar tetap terlihat dalam <=1 detik,
// dan mutasi lewat CLI memanggil kosongkanSkillCache() untuk seketika.
let _daftarCache = { pada: 0, hasil: null };

export function daftarSkill({ dalam = 4 } = {}) {
  if (dalam === 4 && _daftarCache.hasil && Date.now() - _daftarCache.pada < 1000) return _daftarCache.hasil;
  const hasil = [];
  const terlihat = new Set();
  const telusuri = (folder, tingkat) => {
    let isi;
    try { isi = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const satu of isi) {
      if (satu.name.startsWith('.')) continue;
      const lengkap = path.join(folder, satu.name);
      // Ikuti symlink folder: instalasi seperti Agent Reach menautkan
      // ~/.hermes/skills/agent-reach -> ~/.agents/skills/agent-reach.
      let direktori = satu.isDirectory();
      if (!direktori && satu.isSymbolicLink()) {
        try { direktori = fs.statSync(lengkap).isDirectory(); } catch { direktori = false; }
      }
      if (direktori) {
        if (tingkat < dalam) telusuri(lengkap, tingkat + 1);
        continue;
      }
      if (satu.name !== 'SKILL.md') continue;
      let info;
      try { info = fs.statSync(lengkap); } catch { continue; }
      terlihat.add(lengkap);
      const lama = _berkasSkill.get(lengkap);
      let isiSkill;
      if (lama && lama.mtimeMs === info.mtimeMs && lama.size === info.size) {
        isiSkill = lama.isi;
      } else {
        let teks = '';
        try { teks = fs.readFileSync(lengkap, 'utf8'); } catch { continue; }
        isiSkill = bacaFrontmatter(teks);
        _berkasSkill.set(lengkap, { mtimeMs: info.mtimeMs, size: info.size, isi: isiSkill });
      }
      hasil.push({
        nama: isiSkill.nama || path.basename(path.dirname(lengkap)),
        deskripsi: isiSkill.deskripsi || '(tanpa deskripsi)',
        jalur: lengkap,
        akar: folder
      });
    }
  };
  for (const folder of folderSkill()) telusuri(folder, 1);
  // Buang entri yang berkasnya sudah tidak ada supaya Map tidak tumbuh selamanya.
  if (_berkasSkill.size > hasil.length) {
    for (const kunci of _berkasSkill.keys()) if (!terlihat.has(kunci)) _berkasSkill.delete(kunci);
  }
  const urut = hasil.sort((a, b) => a.nama.localeCompare(b.nama));
  if (dalam === 4) _daftarCache = { pada: Date.now(), hasil: urut };
  return urut;
}

export function cariSkill(nama) {
  const jarum = String(nama || '').trim().toLowerCase();
  // Nama kosong dulu cocok dengan skill PERTAMA (`includes('')` selalu true),
  // sehingga arsipkanSkill('') benar-benar memindahkan folder skill asli.
  if (!jarum) return null;
  const semua = daftarSkill();
  return semua.find((satu) => satu.nama.toLowerCase() === jarum)
    || semua.find((satu) => satu.nama.toLowerCase().includes(jarum))
    || null;
}

export function bacaSkill(nama) {
  const skill = cariSkill(nama);
  if (!skill) return null;
  return { skill, teks: fs.readFileSync(skill.jalur, 'utf8') };
}

// Kata Indonesia sehari-hari -> kata kunci Inggris yang dipakai deskripsi skill.
// ponytail: tabel kecil; tambah pasangan baru kalau ada tugas yang tidak terpicu.
const PADANAN = {
  laporan: 'report', laporkan: 'report', ringkas: 'summary summarize', ringkasan: 'summary',
  tulis: 'write create make', tuliskan: 'write create', buat: 'create make', bikin: 'create make',
  gambar: 'image design diagram', desain: 'design', diagram: 'diagram', animasi: 'animation',
  video: 'video', musik: 'music song', lagu: 'song music', audio: 'audio',
  foto: 'photo image', spreadsheet: 'excel xlsx spreadsheet', excel: 'excel xlsx',
  word: 'word docx', ppt: 'powerpoint pptx', presentasi: 'powerpoint deck presentation',
  catatan: 'notes obsidian', email: 'email inbox', surel: 'email',
  kalender: 'calendar', jadwal: 'calendar schedule', pengingat: 'reminder',
  pasang: 'install setup', perbaiki: 'fix debug', betulkan: 'fix', benahi: 'fix',
  cari: 'search find', telusuri: 'search', uji: 'test testing', ujian: 'test',
  kode: 'code coding programming', koding: 'coding', skrip: 'script',
  harga: 'price pricing monitor', pantau: 'monitor watch', awasi: 'monitor watch',
  saham: 'stock trading', trading: 'trading exchange', bot: 'bot',
  server: 'server vps host', vps: 'vps host server', ram: 'ram memory host',
  deploy: 'deploy ship', rilis: 'release', rapat: 'meeting', pertemuan: 'meeting',
  klien: 'client', pelanggan: 'customer', iklan: 'ads paid-media', promosi: 'marketing',
  riset: 'research arxiv', jurnal: 'arxiv paper', makalah: 'paper arxiv',
  terjemah: 'translate', terjemahkan: 'translate', rangkum: 'summary summarize',
  peta: 'maps geocode route', lokasi: 'maps geocode location', rute: 'route maps',
  thread: 'twitter post posting', utas: 'thread twitter post', tweet: 'twitter post',
  twit: 'twitter post', posting: 'post twitter', persona: 'persona agent role',
  // kondisi kerja: keluhan/gejala -> nama keahlian yang menanganinya
  kesehatan: 'health triage', penuh: 'memory disk ram full triage', lemot: 'latency slow tuning',
  lambat: 'latency slow tuning', lambatnya: 'latency slow tuning', hang: 'debug triage',
  crash: 'debug debugging', galat: 'debug error', eror: 'debug error', rusak: 'fix debug audit',
  hemat: 'budget token', boros: 'budget token', kepanjangan: 'budget token',
  mati: 'kill triage down',
  bug: 'debug fix', analisa: 'debug inspect review', analisis: 'debug inspect review',
  kesalahan: 'debug error', error: 'debug error', log: 'debug log inspect',
  keamanan: 'security pentest audit', celah: 'security pentest', rentan: 'security pentest audit',
  audit: 'audit inspect review', review: 'review code', commit: 'git commit review',
  artikel: 'write content blog', blog: 'write content blog', konten: 'content write',
  tulisan: 'write content', naskah: 'write document content',
  dashboard: 'chart visual dashboard html', visual: 'visual chart design',
  landing: 'popular-web-designs claude-design design', halaman: 'page html design web',
  web: 'web html page design', html: 'html design page', ui: 'ui design web',
  skripsi: 'document write docx', dokumen: 'document docx write', surat: 'document write',
  hitung: 'excel xlsx calculate', pajak: 'excel xlsx', keuangan: 'finance excel xlsx',
  gaji: 'excel xlsx', rekap: 'excel xlsx', rekapnya: 'excel xlsx', rekapkan: 'excel xlsx',
  grafik: 'infographic chart graph', chart: 'infographic graph',
  tinjau: 'review inspect', periksa: 'check inspect triage', cek: 'check inspect triage'
};

// Akronim 3 huruf yang sering jadi inti tugas - jangan dibuang oleh saringan panjang.
const PENDEK = new Set(['vps', 'ram', 'cpu', 'gpu', 'ssd', 'git', 'pdf', 'ppt', 'sql', 'api', 'bot', 'kpi', 'svg', 'dom', 'mp4', 'ocr', 'url', 'ide', 'rek', 'lxc', 'ssh']);

const KATA = (teks) => {
  const hasil = [];
  for (const k of String(teks || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    // Padanan diperiksa lebih dulu: kata 3 huruf seperti "bug" tetap berarti
    // walau tidak ada di daftar akronim.
    if (PADANAN[k]) { hasil.push(k, ...PADANAN[k].split(' ')); continue; }
    if (k.length === 3 && !PENDEK.has(k)) continue;
    hasil.push(k);
  }
  return hasil;
};

/**
 * Keahlian yang cocok dengan sebuah teks (pesan pengguna). Skor: kata dari nama
 * berbobot 2, kata dari deskripsi 1. Ambang 2, kata umum (>20% deskripsi) diabaikan.
 * semua: daftar skill pengganti (dipakai uji).
 */
// Indeks kata kandidat di-cache: tiap giliran memanggil skillCocok 2x (bahanSkill
// + keahlianAktif); tanpa cache = 2x pindai 100+ SKILL.md = ~140ms per giliran
// CPU sinkron, alias >1s per room 4 bot. Dibatalkan kosongkanSkillCache().
let _kokokCache = { pada: 0, semua: null, nama: [], isi: [], df: new Map(), batas: 0 };

function _kokokIndeks(semua) {
  const kini = Date.now();
  if (_kokokCache.pada && kini - _kokokCache.pada < 10000 && _kokokCache.semua === semua) return _kokokCache;
  const kandidat = Array.isArray(semua) ? semua : daftarSkill();
  const namaTiap = kandidat.map((satu) => KATA(satu.nama.replace(/[-_]/g, ' ')));
  const isiTiap = kandidat.map((satu) => KATA(satu.deskripsi));
  const df = new Map();
  for (const isi of isiTiap) for (const k of new Set(isi)) df.set(k, (df.get(k) || 0) + 1);
  const batas = Math.max(2, Math.ceil(kandidat.length * 0.2));
  _kokokCache = { pada: kini, semua, kandidat, nama: namaTiap, isi: isiTiap, df, batas };
  return _kokokCache;
}

export function skillCocok(teks, { maks = 3, ambang = 2, semua = null } = {}) {
  const paksa = /\b(mode|persona|agen|agent|role)\b/i.test(String(teks || '')) ? 'agency-agents' : null;
  const kata = new Set(KATA(teks));
  if (!kata.size) return [];
  const { kandidat, nama: namaTiap, isi: isiTiap, df, batas } = _kokokIndeks(semua);
  const hasil = kandidat.map((satu, i) => {
    const nama = namaTiap[i];
    let skor = 0;
    for (const k of new Set([...nama, ...isiTiap[i]])) {
      // cocok utuh, atau batang kata sama (test/testing, price/prices, design/designing)
        const cocok = kata.has(k) || (k.length >= 4 && [...kata].some((t) => t.slice(0, 4) === k.slice(0, 4)));
      if (!cocok) continue;
      if (nama.includes(k)) skor += 2;
      else if ((df.get(k) || 0) <= batas) skor += 1;
    }
    return Object.assign({}, satu, { skor: satu.nama === paksa ? Math.max(skor, ambang) : skor });
  });
  return hasil.filter((satu) => satu.skor >= ambang)
    .sort((a, b) => b.skor - a.skor || a.nama.localeCompare(b.nama))
    .slice(0, maks);
  /* ponytail: satu SKILL.md rusak tidak boleh mematikan satu giliran; batasnya
     sampai nama/deskripsi aneh saja. Kalau nanti butuh, naikkan ke validasi
     frontmatter saat pemindaian. */
}

/** Satu kalimat pertama deskripsi, dipotong: indeks harus tetap murah. */
function kalimatIndeks(teks, maks = 60) {
  const satu = String(teks || '').split(/(?<=\.)\s/)[0];
  return satu.length > maks ? satu.slice(0, maks - 1).trimEnd() + '…' : satu;
}

/** Indeks ringkas untuk system prompt: nama + satu kalimat deskripsi saja. */
// Cache modul: bagianPrompt() menyusun prompt TIAP permintaan model (4 bot
// paralel = 4x pindai 100+ SKILL.md). Sinkron dan gratis: TTL 10s cukup karena
// daftar skill tidak berubah saat agen bekerja; cache dibatalkan oleh
// simpanSkill/arsipkanSkill/hapusSkill lewat kosongkanSkillCache().
let _indeksCache = { pada: 0, isi: '' };

export function kosongkanSkillCache() {
  _indeksCache = { pada: 0, isi: '' };
  _kokokCache = { pada: 0, semua: null, nama: [], isi: [], df: new Map(), batas: 0 };
  _berkasSkill.clear();
  _daftarCache = { pada: 0, hasil: null };
}

export function indeksSkill({ maks = 120 } = {}) {
  const kini = Date.now();
  if (_indeksCache.pada && kini - _indeksCache.pada < 10000) return _indeksCache.isi;
  const semua = daftarSkill();
  const tampil = semua.slice(0, maks).map((satu) => '- ' + satu.nama + ': ' + kalimatIndeks(satu.deskripsi));
  const isi = semua.length ? tampil.join('\n') + (semua.length > maks ? '\n(' + (semua.length - maks) + ' keahlian lain tidak ditampilkan; pakai alat skill)' : '') : '';
  _indeksCache = { pada: kini, isi };
  return isi;
}