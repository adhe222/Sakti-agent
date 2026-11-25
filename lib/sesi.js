/* global AbortSignal */
// Sesi percakapan: satu berkas JSONL per sesi di ~/.sakti-cli/sesi/.
// Cukup sederhana untuk diperiksa dengan mata (satu pesan per baris), dan
// dipakai untuk melanjutkan percakapan kemarin atau mencari "kapan aku
// menyebut itu".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function folderSesi() {
  return process.env.SAKTI_CLI_SESI || path.join(os.homedir(), '.sakti-cli', 'sesi');
}

function idSah(id) {
  // ID sesi dipakai langsung sebagai nama berkas. Tanpa validasi, `sakti sesi
  // hapus ../x` / `baca ../../etc/passwd` menyentuh berkas di luar folder sesi.
  const teks = String(id == null ? '' : id).trim();
  return teks.length > 0 && teks.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(teks) && !teks.includes('..');
}

export function idSesiSah(id) { return idSah(id); }

function berkasSesi(id) {
  if (!idSah(id)) throw new Error('id sesi tidak sah: ' + id);
  return path.join(folderSesi(), String(id).trim() + '.jsonl');
}

export function sesiBaru({ judul } = {}) {
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(folderSesi(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(berkasSesi(id), '', { mode: 0o600 });
  const meta = { id, judul: String(judul || '').slice(0, 120), mulai: Date.now() };
  fs.writeFileSync(path.join(folderSesi(), id + '.json'), JSON.stringify(meta, null, 1) + '\n', { mode: 0o600 });
  return meta;
}

export function tambahPesan(id, pesan) {
  fs.mkdirSync(folderSesi(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(berkasSesi(id), JSON.stringify(Object.assign({ ts: Date.now() }, pesan)) + '\n', { mode: 0o600 });
}

export function bacaSesi(id) {
  try {
    return fs.readFileSync(berkasSesi(id), 'utf8').split('\n').filter(Boolean).map((baris) => {
      try { return JSON.parse(baris); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Daftar sesi terbaru dulu: id, judul, jumlah pesan, kapan. */
// Cache ringkas per berkas: daftar sesi dulu membaca SEMUA .jsonl penuh tiap
// render panel (343ms untuk 30+ sesi). Sekarang stat dulu, urut mtime, baca
// hanya `batas` teratas; isi yang tidak berubah dipakai ulang dari cache.
const _ringkasCache = new Map();

function ringkasBerkas(jalur, info) {
  const lama = _ringkasCache.get(jalur);
  if (lama && lama.mtimeMs === info.mtimeMs && lama.size === info.size) return lama;
  let pesan = 0;
  let judulIsi = '';
  try {
    for (const baris of fs.readFileSync(jalur, 'utf8').split('\n')) {
      if (!baris) continue;
      let row;
      try { row = JSON.parse(baris); } catch { continue; }
      pesan += 1;
      if (!judulIsi && row.role === 'user' && row.content) judulIsi = String(row.content).slice(0, 80);
    }
  } catch { /* berkas hilang di tengah baca: anggap kosong */ }
  const hasil = { mtimeMs: info.mtimeMs, size: info.size, pesan, judulIsi };
  _ringkasCache.set(jalur, hasil);
  return hasil;
}

export function daftarSesi({ batas = 20 } = {}) {
  let nama = [];
  try { nama = fs.readdirSync(folderSesi()).filter((satu) => satu.endsWith('.jsonl') && idSah(satu.slice(0, -6))); } catch { return []; }
  const kandidat = [];
  for (const satu of nama) {
    const jalur = path.join(folderSesi(), satu);
    let info;
    try { info = fs.statSync(jalur); } catch { continue; }
    kandidat.push({ id: satu.replace(/\.jsonl$/, ''), jalur, info });
  }
  const banyak = Number.isFinite(Number(batas)) ? Math.max(0, Math.floor(Number(batas))) : 20;
  if (!banyak) return [];
  kandidat.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const pilih = kandidat.slice(0, banyak);
  const rows = pilih.map(({ id, jalur, info }) => {
    const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(folderSesi(), id + '.json'), 'utf8')); } catch { return { id }; } })();
    const ringkas = ringkasBerkas(jalur, info);
    return {
      id,
      judul: meta.judul || ringkas.judulIsi || '(kosong)',
      pesan: ringkas.pesan,
      waktu: info.mtimeMs
    };
  });
  // Buang cache sesi yang berkasnya sudah tidak ada. Dulu syaratnya
  // `_ringkasCache.size > nama.length`, sehingga entri basi tetap tinggal saat
  // jumlahnya kebetulan sama dengan jumlah sesi yang ada.
  if (_ringkasCache.size) {
    const ada = new Set(kandidat.map((satu) => satu.jalur));
    for (const kunci of _ringkasCache.keys()) if (!ada.has(kunci)) _ringkasCache.delete(kunci);
  }
  return rows;
}

export function sesiTerakhir() {
  const rows = daftarSesi({ batas: 1 });
  return rows[0] ? rows[0].id : null;
}

/** Cari teks di seluruh sesi. Mengembalikan {id, role, cuplikan, ts}. */
export function cariSesi(query, { batas = 30 } = {}) {
  const jarum = String(query || '').toLowerCase().trim();
  if (!jarum) return [];
  const hasil = [];
  for (const sesi of daftarSesi({ batas: 200 })) {
    for (const row of bacaSesi(sesi.id)) {
      const teks = typeof row.content === 'string' ? row.content : JSON.stringify(row.content || '');
      const posisi = teks.toLowerCase().indexOf(jarum);
      if (posisi < 0) continue;
      hasil.push({
        id: sesi.id,
        role: row.role || '?',
        ts: row.ts || 0,
        cuplikan: teks.slice(Math.max(0, posisi - 60), posisi + jarum.length + 120).replace(/\s+/g, ' ')
      });
      if (hasil.length >= batas) return hasil;
    }
  }
  return hasil;
}

/** Salin sesi jadi sesi baru sampai pesan ke-`sampai` (bawaan: semua).
 *  Dipakai `/cabang`: lanjutkan dari titik lama tanpa mengotori jalur aslinya. */
export function cabangSesi(id, { sampai = 0, judul } = {}) {
  const isi = bacaSesi(id);
  if (!isi.length) return null;
  const batas = Number(sampai) > 0 ? Math.min(Number(sampai), isi.length) : isi.length;
  const meta = sesiBaru({ judul: judul || ('cabang ' + String(id).slice(-8)) });
  for (const row of isi.slice(0, batas)) tambahPesan(meta.id, row);
  return Object.assign({}, meta, { pesan: batas });
}

/** Ekspor sesi jadi Markdown (untuk ditempel ke PR/issue).
 *  Alat yang dipanggil diringkas: nama + ringkas argumen, hasil dipotong. */
/**
 * Saring rahasia dari teks sebelum sesi diekspor/dibagikan. Sesi memuat perintah
 * `env`, isi `.env`, dan header curl - tanpa ini ekspor = kebocoran kunci.
 * ponytail: pola, bukan parser - tangkap bentuk yang benar-benar muncul di log.
 */
export function saringRahasia(teks) {
  return String(teks == null ? '' : teks)
    // KEY=value untuk nama yang berbau rahasia (API_KEY, TOKEN, SECRET, PASSWORD…)
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_m, nama, pemisah) => nama + pemisah + '[disaring]')
    // Bearer / Basic di header
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [disaring]')
    // URL dengan kredensial: scheme://user:pass@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[disaring]@')
    // kunci gaya sk-…, ghp_…, github_pat_…, xoxb-…
    .replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[disaring]');
}

/**
 * Sesi sebagai JSON terstruktur (untuk `--json`): satu baris per pesan, isi utuh
 * atau dipotong, dengan opsi `sanitasi` untuk membuang rahasia.
 */
export function sesiJson(id, { penuh = false, sanitasi = false } = {}) {
  const isi = bacaSesi(id);
  if (!isi.length) return null;
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(folderSesi(), String(id) + '.json'), 'utf8')); } catch { return { id }; } })();
  const bersih = (teks) => (sanitasi ? saringRahasia(teks) : String(teks == null ? '' : teks));
  return {
    id,
    judul: meta.judul || '',
    dibuat: meta.mulai || meta.at || null,
    pesan: isi.map((row) => {
      const satu = { role: row.role || '?', ts: row.ts || 0, content: bersih(penuh ? row.content || '' : String(row.content || '').slice(0, 2000)) };
      if (Array.isArray(row.tool_calls)) {
        satu.tool_calls = row.tool_calls.map((panggil) => {
          const f = (panggil && panggil.function) || {};
          return { name: f.name, arguments: bersih(String(f.arguments || '')) };
        });
      }
      return satu;
    })
  };
}

export function eksporSesi(id, { penuh = false, sanitasi = false } = {}) {
  const isi = bacaSesi(id);
  if (!isi.length) return null;
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(folderSesi(), String(id) + '.json'), 'utf8')); } catch { return { id }; } })();
  const baris = ['# Sesi ' + (meta.judul || id), '', '- id: `' + id + '`', '- pesan: ' + isi.length, ''];
  for (const row of isi) {
    const peran = row.role === 'user' ? 'Pengguna' : row.role === 'assistant' ? 'Agen' : row.role === 'tool' ? 'Alat' : String(row.role || '?');
    const mentah = penuh ? String(row.content || '') : String(row.content || '').slice(0, 2000);
    const teks = sanitasi ? saringRahasia(mentah) : mentah;
    baris.push('## ' + peran, '', teks, '');
    if (Array.isArray(row.tool_calls)) {
      for (const panggil of row.tool_calls) {
        const f = (panggil && panggil.function) || {};
        const args = sanitasi ? saringRahasia(String(f.arguments || '')) : String(f.arguments || '');
        baris.push('- alat: `' + f.name + '` ' + args.replace(/\s+/g, ' ').slice(0, 200));
      }
      baris.push('');
    }
  }
  return baris.join('\n');
}

export function hapusSesi(id) {
  // Balik jumlah berkas yang benar-benar terhapus: 0 berarti sesi tidak ada,
  // dan pemanggil tidak boleh mengaku berhasil. ID tak sah tidak pernah
  // menyentuh path.join di luar folder sesi.
  if (!idSah(id)) return 0;
  let jumlah = 0;
  for (const akhiran of ['.jsonl', '.json']) {
    try { fs.unlinkSync(path.join(folderSesi(), String(id).trim() + akhiran)); jumlah += 1; } catch { /* sudah tidak ada */ }
  }
  return jumlah;
}

/**
 * Impor sesi (opencode `session import`): terima berkas lokal atau URL, bentuk
 * `sesiJson()` (`{judul, pesan:[{role,content,tool_calls,ts}]}`) atau JSONL
 * polos (satu pesan per baris). Pesan disaring bentuknya, bukan dipercaya
 * mentah: role di luar user/assistant/tool dibuang, isi bukan string = ''.
 * Mengembalikan id sesi BARU - sumber tidak pernah ditimpa.
 */
export async function imporSesi(sumber, { fetch: ambil = globalThis.fetch } = {}) {
  const teks = await bacaSumber(sumber, ambil);
  if (!teks.ok) return { ok: false, galat: teks.galat };
  let data;
  try { data = JSON.parse(teks.isi); } catch {
    // JSONL: satu objek per baris (bentuk berkas sesi sakti sendiri). Baris
    // rusak dilewati, bukan menggagalkan seluruh impor; minimal satu pesan sah.
    const rows = [];
    for (const baris of teks.isi.split('\n')) {
      if (!baris.trim()) continue;
      try { rows.push(JSON.parse(baris)); } catch { /* baris rusak */ }
    }
    if (!rows.length) return { ok: false, galat: 'bukan JSON dan bukan JSONL: ' + sumber };
    data = { pesan: rows };
  }
  const pesan = data && typeof data === 'object'
    ? (Array.isArray(data) ? data : (Array.isArray(data.pesan) ? data.pesan : null))
    : null;
  if (!pesan) return { ok: false, galat: 'tidak ada daftar "pesan" di ' + sumber };
  // ID panggilan alat dibuat unik lintas pesan. Dulu `call_impor_i` diulang
  // untuk setiap pesan asisten, sehingga dua panggilan berbeda memakai id sama
  // dan API menolak riwayatnya ("duplicate tool_call_id").
  let urutPanggil = 0;
  const idDikenal = new Set();
  const bersih = [];
  for (const row of pesan) {
    if (!row || !['user', 'assistant', 'tool'].includes(String(row.role))) continue;
    const role = String(row.role);
    const satu = { role, content: String(row.content == null ? '' : row.content) };
    if (Array.isArray(row.tool_calls)) {
      satu.tool_calls = [];
      for (const panggil of row.tool_calls) {
        if (!panggil || !panggil.function || !panggil.function.name) continue;
        urutPanggil += 1;
        const id = String(panggil.id || ('call_impor_' + urutPanggil));
        if (idDikenal.has(id)) continue;
        idDikenal.add(id);
        satu.tool_calls.push({
          id,
          type: 'function',
          function: { name: String(panggil.function.name), arguments: String(panggil.function.arguments || '{}') }
        });
      }
      if (!satu.tool_calls.length) delete satu.tool_calls;
    }
    if (role === 'tool') {
      // Hasil alat tanpa panggilan pasangannya = riwayat tidak sah; API akan
      // menolak seluruh sesi. Buang, jangan diteruskan mentah.
      if (!row.tool_call_id || !idDikenal.has(String(row.tool_call_id))) continue;
      satu.tool_call_id = String(row.tool_call_id);
    }
    if (role === 'assistant' && !satu.content && !satu.tool_calls) continue;
    if (row.name) satu.name = String(row.name);
    bersih.push(satu);
  }
  if (!bersih.length) return { ok: false, galat: 'tidak ada pesan user/assistant/tool yang sah di ' + sumber };
  const judulMentah = String(data.judul || data.title || '').trim();
  const judul = (judulMentah || ('impor ' + path.basename(String(sumber)))).slice(0, 120);
  const baru = sesiBaru({ judul });
  for (const row of bersih) tambahPesan(baru.id, row);
  return { ok: true, id: baru.id, pesan: bersih.length, judul: baru.judul };
}

async function bacaSumber(sumber, ambil) {
  const teks = String(sumber || '');
  try {
    if (/^https?:\/\//i.test(teks)) {
      const balas = await ambil(teks, { signal: AbortSignal.timeout(20000) });
      if (!balas.ok) return { ok: false, galat: 'HTTP ' + balas.status + ' dari ' + teks };
      return { ok: true, isi: await balas.text() };
    }
    return { ok: true, isi: fs.readFileSync(teks.startsWith('~') ? path.join(os.homedir(), teks.slice(1)) : teks, 'utf8') };
  } catch (galat) {
    return { ok: false, galat: 'sumber tak terbaca: ' + teks + ' (' + String((galat && galat.message) || galat) + ')' };
  }
}