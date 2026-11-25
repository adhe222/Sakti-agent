// Smart route token: satu tingkat anggaran per giliran, dipilih dari kesulitan
// tugas secara deterministik. Ringan -> minimal (konteks kecil, jawaban pendek);
// sulit -> ultra (effort tinggi, ruang penuh). Tanpa model, tanpa acak, tanpa jam.
//
// Angka dasar dari pengukuran di mesin ini (docs/CELAH.md):
//   - biaya TETAP satu giliran ≈ 18.5k token (prompt 5.3k + skema alat 13.2k),
//     jadi yang benar-benar bisa dipotong agen hanyalah riwayat dan panjang
//     jawaban - tabel di bawah menyentuh keduanya, bukan hanya label effort;
//   - gateway ini menelan `reasoning_effort` (low vs ultra: 163 token keluar,
//     1.2 detik, sama persis) tapi `max_tokens` dan `prompt_tokens` dihormati,
//     jadi tingkat wajib mengubah max_tokens + batas riwayat supaya hematannya
//     nyata walau endpointnya tidak mengenal effort;
//   - `max_tokens` > 16384 dipangkas gateway ke 16384 (terukur), maka tingkat
//     paling tinggi tidak menjanjikan lebih dari itu.
//
// Semua nilai HANYA mengisi knob yang tidak diset pemanggil: --effort /
// --max-tokens / --batas-riwayat / --batas-token dan /effort, /token tetap menang.

export const TINGKAT_RUTE = ['minimal', 'low', 'medium', 'high', 'ultra'];

// effort  = label yang dikirim ke endpoint (boleh ditelan, tidak apa-apa)
// maxTokens = ruang jawaban model
// batasRiwayat = berapa pesan terakhir yang ikut dikirim
// batasToken = plafon token kiriman sebelum dipotong (0 = tanpa plafon)
export const TABEL_RUTE = {
  minimal: { effort: 'minimal', maxTokens: 1024, batasRiwayat: 6, batasToken: 12000 },
  low: { effort: 'low', maxTokens: 2048, batasRiwayat: 12, batasToken: 16000 },
  medium: { effort: 'medium', maxTokens: 4096, batasRiwayat: 24, batasToken: 24000 },
  high: { effort: 'high', maxTokens: 8192, batasRiwayat: 40, batasToken: 32000 },
  ultra: { effort: 'ultra', maxTokens: 16384, batasRiwayat: 120, batasToken: 64000 }
};

// Lantai batasToken. Biaya TETAP satu giliran di mesin ini terukur ±18,5k token
// (prompt 5,3k + skema alat 13,2k), jadi kasur di bawah nilai itu hanya memotong
// badan pesan tanpa menghemat apa pun - tingkat tidak pernah menjanjikannya.
export const LANTAI_BATAS_TOKEN = 12000;

// Batas bawah tiap tingkat di atas 'minimal'. Skor < 3 -> minimal, < 6 -> low, ...
const AMBANG = [3, 6, 9, 13];

function normalTingkat(nilai) {
  return String(nilai == null ? '' : nilai).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Nama tingkat yang sah, atau '' kalau tidak dikenal. Menerima 'Ultra ', 'x_high'. */
export function tingkatSah(nilai) {
  const teks = normalTingkat(nilai);
  return TINGKAT_RUTE.includes(teks) ? teks : '';
}

/** Naik satu (atau n) tingkat, mentok di 'ultra'. Nama tak sah dianggap 'medium'. */
export function naikTingkat(tingkat, n = 1) {
  const awal = tingkatSah(tingkat) || 'medium';
  const i = TINGKAT_RUTE.indexOf(awal);
  return TINGKAT_RUTE[Math.min(i + Math.max(0, Math.floor(Number(n) || 0)), TINGKAT_RUTE.length - 1)];
}

/** Salinan nilai satu tingkat - pemanggil tidak bisa mengotori tabel. */
export function nilaiTingkat(tingkat) {
  const baku = tingkatSah(tingkat) || 'medium';
  return Object.assign({ tingkat: baku }, TABEL_RUTE[baku], {
    batasToken: Math.max(LANTAI_BATAS_TOKEN, TABEL_RUTE[baku].batasToken)
  });
}

const POLA = {
  berat: /\b(audit|security|aman|vulnerab\w*|celah|exploit\w*|race\s*condition|concurr\w*|konkuren|bypass|idor|xss|inject\w*|sqli|cve|refactor\w*|migrat\w*|rollback|transaksi|atomic|deadlock|memory\s*leak|kebocoran|optimi[sz]\w*|perf\w*|benchmark|profiling|arsitektur|skala|distributed|idempoten|root\s*cause|akar\s*masalah)\b/g,
  uji: /\b(uji|testing|qa|regress\w*|edge\s*case|kasus\s*tepi|negative|boundary|sign-?off|verifi\w*)\b/g,
  kerja: /\b(buat|tambah|ubah|edit|hapus|install|deploy|build|compile|jalankan|implement\w*|pasang|perbaiki|fix|patch|rakit|susun|generate)\b/g,
  langkah: /\b(lalu|kemudian|setelah\s*itu|pertama|kedua|ketiga|urutan|langkah|selanjutnya|then|next)\b/g,
  berkas: /(?:^|[\s"'`(])[\w@~./-]*\/[\w.-]+|(?:^|[\s"'`(])[\w-]+\.(?:js|mjs|cjs|ts|py|sh|bash|json|md|sql|go|rs|java|kt|yaml|yml|toml)\b/g,
  kode: /```|<\/?[a-z][\s\S]*?>|\bfunction\s+\w+\s*\(|=>/g,
  daftar: /^[ \t]*(?:\d+[.)]|[-*])[ \t]+/gm,
  ringan: /\b(halo|hai|hello|hi|ok|oke|apa|siapa|kapan|dimana|di mana|kenapa|why|berapa|jelaskan|terjemah\w*|ringkas\w*|summar\w*|translate|thanks|terima\s*kasih|iya|tidak|bantu|cerita)\b/g
};

function hitung(teks, nama) {
  const pola = new RegExp(POLA[nama].source, POLA[nama].flags.includes('g') ? POLA[nama].flags : POLA[nama].flags + 'g');
  const semua = teks.match(pola);
  return semua ? semua.length : 0;
}

/**
 * Skor kesulitan 0..N dari pesan + keadaan giliran. Deterministik.
 * Alasan ikut kembali supaya `/rute` dan jejak bisa menjelaskan pilihan.
 */
export function skorKesulitan(opsi = {}) {
  const pesan = String(opsi.pesan == null ? '' : opsi.pesan);
  const rendah = pesan.toLowerCase();
  let skor = 0;
  const alasan = [];
  const tambah = (n, label) => { if (n > 0) { skor += n; alasan.push(label + '+' + n); } };

  tambah(Math.min(6, Math.floor(pesan.length / 200)), 'panjang');

  const berkas = hitung(rendah, 'berkas');
  tambah(berkas >= 3 ? 3 : berkas >= 1 ? 2 : 0, 'berkas');

  const kode = hitung(pesan, 'kode');
  tambah(kode >= 3 ? 3 : kode >= 1 ? 2 : 0, 'kode');

  const berat = hitung(rendah, 'berat');
  tambah(Math.min(6, berat * 2), 'berat');

  const uji = hitung(rendah, 'uji');
  tambah(Math.min(3, uji), 'uji');

  const kerja = hitung(rendah, 'kerja');
  tambah(Math.min(3, kerja), 'kerja');

  const langkah = hitung(rendah, 'langkah') + hitung(rendah, 'daftar');
  tambah(langkah >= 3 ? 2 : langkah >= 1 ? 1 : 0, 'langkah');

  const riwayat = Array.isArray(opsi.riwayat) ? opsi.riwayat.length : 0;
  tambah(riwayat > 30 ? 2 : riwayat > 10 ? 1 : 0, 'riwayat');

  tambah(Math.min(2, Math.max(0, Math.floor(Number(opsi.rencana) || 0))), 'rencana');

  // Tanya-jawab murni (tanpa berkas, kode, atau kata kerja berat/kerja) ditahan
  // di dua skor terendah: inilah yang paling sering dibayar mahal di chat pendek.
  if (!berat && !kerja && !berkas && !kode && hitung(rendah, 'ringan') > 0) {
    skor = Math.min(skor, 2);
    alasan.push('ringan');
  }

  return { skor, alasan };
}

/** Skor -> tingkat. */
export function tingkatDariSkor(skor) {
  const n = Number(skor) || 0;
  for (let i = 0; i < AMBANG.length; i++) if (n < AMBANG[i]) return TINGKAT_RUTE[i];
  return TINGKAT_RUTE[TINGKAT_RUTE.length - 1];
}

/** Rute aktif? Bawaan on; `rute:false`, `--rute=off`, `SAKTI_RUTE=off` mematikannya. */
export function ruteAktif(konf = {}) {
  const nilai = konf.rute != null ? konf.rute : process.env.SAKTI_RUTE;
  if (nilai == null) return true;
  if (nilai === false) return false;
  const teks = String(nilai).trim().toLowerCase();
  return !(teks === 'off' || teks === '0' || teks === 'false' || teks === 'no');
}

/** Tingkat yang dipatok tangan: `--rute-tingkat`, `SAKTI_RUTE_TINGKAT`, `ruteTingkat`, atau `SAKTI_RUTE=<tingkat>`. */
export function tingkatPatok(konf = {}) {
  return tingkatSah(konf.ruteTingkat)
    || tingkatSah(process.env.SAKTI_RUTE_TINGKAT)
    || tingkatSah(konf.rute)
    || tingkatSah(process.env.SAKTI_RUTE);
}

/**
 * Satu keputusan rute untuk satu giliran.
 *   langkah = nomor putaran dalam giliran ini (1 = panggilan model pertama).
 * Begitu model menyentuh alat, tugas terbukti bukan hal ringan: putaran ke-2
 * dipaksa minimal 'high', ke-4 'ultra'. Ini eskalasi yang diminta, dan ia jalan
 * walau skor awalnya rendah.
 * Pesan ringan tetap dapat tingkat 'minimal': riwayatnya dipotong ke 6 baris
 * dan ruang jawabannya 1.024 token, jadi hematnya nyata (terukur 5.623 ->
 * 3.752 token pada riwayat 24).
 */
export function pilihRute(opsi = {}) {
  const konf = opsi.konf || {};
  const patok = tingkatPatok(konf);
  const { skor, alasan } = skorKesulitan(opsi);
  const langkah = Math.max(1, Math.floor(Number(opsi.langkah) || 1));
  const aktif = patok ? true : ruteAktif(konf);
  let tingkat = patok || tingkatDariSkor(skor);
  let naik = '';

  if (!patok && aktif) {
    if (langkah >= 4) {
      if (tingkat !== 'ultra') { naik = 'alat-berulang'; tingkat = 'ultra'; }
    } else if (langkah >= 2 && TINGKAT_RUTE.indexOf(tingkat) < TINGKAT_RUTE.indexOf('high')) {
      naik = 'pakai-alat';
      tingkat = 'high';
    }
  }
  // Tugas berat: aktif walau rute dimatikan? Tidak - knob off tetap off. Yang
  // mati rutenya tetap `aktif:false` dan pemanggil memakai tingkat patok/bawaan.
  const aktifAkhir = patok ? true : ruteAktif(konf);

  return { aktif: aktifAkhir, tingkat: aktifAkhir ? tingkat : '', skor, alasan, naik, dipatok: Boolean(patok), nilai: nilaiTingkat(tingkat) };
}

/**
 * Isi knob konfigurasi dari tingkat, HANYA yang tidak diset eksplisit.
 * `konf.eksplisit` (dari konfigModel) daftar knob hasil --effort/--max-tokens/
 * --batas-riwayat/--batas-token; knob di luar daftar itu ikut tingkat.
 */
export function terapkanRute(konf = {}, nilai = {}) {
  const keluar = Object.assign({}, konf);
  if (!nilai || !nilai.tingkat) return keluar;
  const eksplisit = new Set(Array.isArray(konf.eksplisit) ? konf.eksplisit : []);
  const setelan = { effort: nilai.effort, maxTokens: nilai.maxTokens, batasRiwayat: nilai.batasRiwayat, batasToken: nilai.batasToken };
  for (const [knob, isi] of Object.entries(setelan)) {
    if (eksplisit.has(knob) || isi == null) continue;
    keluar[knob] = isi;
  }
  keluar.ruteTingkat = nilai.tingkat;
  return keluar;
}

/** Satu baris untuk status TUI / jejak. */
export function formatRute(keputusan) {
  if (!keputusan) return '';
  if (!keputusan.aktif) return 'rute:off';
  const n = keputusan.nilai;
  return 'rute:' + keputusan.tingkat
    + ' (skor ' + keputusan.skor
    + (keputusan.dipatok ? ', dipatok' : '')
    + (keputusan.naik ? ', naik ' + keputusan.naik : '')
    + ', tok≤' + n.maxTokens + ', riwayat ' + n.batasRiwayat + ', konteks≤' + n.batasToken + ')';
}
