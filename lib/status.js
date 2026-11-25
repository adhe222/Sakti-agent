// Bilah status gaya Hermes (ui-tui `appChrome.tsx`): indikator kerja yang
// berputar + kata kerja berganti-ganti, model, konteks token, biaya giliran,
// cabang git, dan notice. Semua MURNI - tanpa I/O, tanpa model - supaya bisa
// diuji tanpa pty dan dipakai ulang CLI/TUI/serve.
//
// Yang diadopsi dari Hermes:
//  - `FaceTicker`: satu kolom indikator (spinner/emoji/ascii) + kata kerja
//    yang berganti tiap 2.5s + durasi; verb TIDAK ikut berganti saat giliran
//    memakai kata kerja tetap (mis. "menyusun…").
//  - `StatusRule`: model │ konteks (persen + isi/maks) · biaya · cabang,
//    dipadatkan saat sempit (cost hilang dulu, lalu ctx detail).
//  - gaya indikator bisa dipilih: `unicode` (braille), `ascii`, `emoji`.

/** Kata kerja bergiliran (Hermes `content/verbs.ts`, versi Indonesia ringkas). */
export const KATA_KERJA = [
  'menimbang', 'menelaah', 'membaca', 'menyusun', 'mengurai', 'menyigi',
  'memeriksa', 'menghitung', 'merancang', 'menguji', 'membandingkan', 'menyimpulkan'
];

export const GAYA_INDIKATOR = ['unicode', 'ascii', 'emoji'];

const BINGKAI_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BINGKAI_ASCII = ['|', '/', '-', '\\'];
// Fase bulan: delapan bingkai, lebar 2 kolom SERAGAM, jelas berputar. Emoji
// acak (🌀🤔✨…) terbaca seperti hiasan, bukan progres; yang ini satu rangkaian.
const BINGKAI_EMOJI = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

/** UTF-8? Non-UTF8 (C locale) → paksa ascii supaya tidak jadi kotak. */
export function gayaSah(nilai, { utf8 = true } = {}) {
  const teks = String(nilai == null ? '' : nilai).trim().toLowerCase();
  if (!utf8) return 'ascii';
  return GAYA_INDIKATOR.includes(teks) ? teks : 'unicode';
}

/** Satu bingkai indikator untuk detik `ms` (murni: waktu masuk, bukan Date.now). */
export function bingkaiIndikator(gaya, ms) {
  const daftar = gaya === 'emoji' ? BINGKAI_EMOJI : gaya === 'ascii' ? BINGKAI_ASCII : BINGKAI_UNICODE;
  const jeda = gaya === 'emoji' ? 600 : gaya === 'ascii' ? 120 : 100;
  return daftar[Math.floor(Math.max(0, Number(ms) || 0) / jeda) % daftar.length];
}

/** Kata kerja bergiliran tiap 2.5s, dengan kata kerja tetap bila diberikan. */
export function kataKerjaUntuk(ms, tetap = '') {
  if (tetap) return String(tetap);
  return KATA_KERJA[Math.floor(Math.max(0, Number(ms) || 0) / 2500) % KATA_KERJA.length];
}

/** 12.345 -> 12.3k ; 999 -> 999 (Hermes `compactNumber`). */
export function angkaRingkas(nilai) {
  const n = Math.max(0, Number(nilai) || 0);
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'j';
}

/**
 * Persen konteks + label. `dipakai`/`maks` = token; maks 0 = tidak diketahui
 * (endpoint tidak melaporkan) -> label jatuh ke token total saja.
 */
export function konteksStatus({ dipakai = 0, maks = 0, total = 0, perkiraan = false } = {}) {
  const mark = perkiraan ? '~' : '';
  if (maks > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((dipakai / maks) * 100)));
    return { pct, label: mark + angkaRingkas(dipakai) + '/' + angkaRingkas(maks), baret: true };
  }
  const isi = total || dipakai;
  return { pct: null, label: isi > 0 ? mark + angkaRingkas(isi) + ' tok' : '', baret: false };
}

/** Bar konteks 8 kolom: aman (hijau) -> waspada (kuning) -> penuh (merah). */
export function baretKonteks(pct) {
  if (pct == null) return '';
  const lebar = 8;
  const isi = Math.max(0, Math.min(lebar, Math.round((pct / 100) * lebar)));
  const warna = pct >= 90 ? 'merah' : pct >= 70 ? 'kuning' : 'hijau';
  return { isi: '█'.repeat(isi) + '░'.repeat(lebar - isi), warna };
}

/**
 * Susun bilah status jadi daftar segmen (murni). Pemanggil yang memilih warna
 * dan memotong sesuai lebar terminal - di sini hanya urutan + bobot prioritas.
 * Urutan Hermes: indikator │ model │ konteks │ biaya │ cabang │ notice.
 */
export function segmenStatus({
  sibuk = false, ms = 0, gaya = 'unicode', kerjaTetap = '', model = '',
  konteks = {}, biaya = '', cabang = '', notice = '', izin = 'auto', antrean = 0, galat = 0
} = {}) {
  const segmen = [];
  if (sibuk) {
    const bingkai = bingkaiIndikator(gaya, ms);
    const kata = kataKerjaUntuk(ms, kerjaTetap);
    segmen.push({ kunci: 'indikator', teks: bingkai + ' ' + kata, ket: 'kerja', prioritas: 0 });
    // Durasi baru berguna setelah 1 detik; di bawah itu angkanya berkedip
    // (50ms, 169ms, …) tanpa informasi.
    if (ms >= 1000) segmen.push({ kunci: 'durasi', teks: durasiRingkas(ms), ket: 'kerja', prioritas: 3 });
  } else if (notice) {
    segmen.push({ kunci: 'notice', teks: notice, ket: 'info', prioritas: 2 });
  } else {
    segmen.push({ kunci: 'indikator', teks: 'siap', ket: 'siap', prioritas: 0 });
  }
  if (model) segmen.push({ kunci: 'model', teks: model, ket: 'model', prioritas: 0 });
  const ktx = konteksStatus(konteks);
  if (ktx.label) segmen.push({ kunci: 'konteks', teks: ktx.label, ket: 'konteks', prioritas: 1, pct: ktx.pct });
  if (biaya) segmen.push({ kunci: 'biaya', teks: biaya, ket: 'biaya', prioritas: 4 });
  if (cabang) segmen.push({ kunci: 'cabang', teks: cabang, ket: 'cabang', prioritas: 2 });
  if (antrean > 0) segmen.push({ kunci: 'antrean', teks: 'antre ' + antrean, ket: 'antrean', prioritas: 2 });
  // Langkah gagal giliran ini: kelihatan walau transkripnya sudah tergulir.
  if (galat > 0) segmen.push({ kunci: 'galat', teks: 'gagal ' + galat, ket: 'galat', prioritas: 2 });
  if (izin && izin !== 'auto') segmen.push({ kunci: 'izin', teks: 'izin ' + izin, ket: 'izin', prioritas: 1 });
  return segmen;
}

function durasiRingkas(ms) {
  const kasar = Math.max(0, Math.round(Number(ms) || 0));
  if (kasar < 1000) return kasar + 'ms';
  const dtk = kasar / 1000;
  if (dtk < 60) return dtk.toFixed(1) + 's';
  const menit = Math.floor(dtk / 60);
  const sisa = Math.round(dtk % 60);
  return menit + 'm' + (sisa ? ' ' + sisa + 's' : '');
}

/**
 * Buang segmen prioritas rendah sampai muat `lebar` kolom. Prioritas besar =
 * dibuang lebih dulu (biaya -> antrean/cabang -> konteks -> model/indikator
 * tidak pernah dibuang). `lebarTeks` disuntikkan supaya modul tetap murni.
 */
export function padatkanSegmen(segmen, lebar, lebarTeks = (t) => String(t).length, pemisah = ' · ') {
  const hasil = segmen.map((satu) => Object.assign({}, satu));
  const hitung = () => hasil.reduce((n, s) => n + lebarTeks(s.teks), 0) + Math.max(0, hasil.length - 1) * lebarTeks(pemisah);
  const bisaBuang = hasil.filter((s) => s.prioritas > 0).sort((a, b) => b.prioritas - a.prioritas);
  for (const buang of bisaBuang) {
    if (hitung() <= lebar) break;
    const i = hasil.indexOf(buang);
    if (i >= 0) hasil.splice(i, 1);
  }
  return hasil;
}

/** Satu string siap cetak dari segmen yang sudah dipadatkan. */
export function teksStatus(segmen, pemisah = ' · ') {
  return segmen.map((s) => s.teks).join(pemisah);
}
