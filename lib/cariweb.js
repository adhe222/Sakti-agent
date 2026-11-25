/* global AbortSignal */
// Pencarian & pembacaan web tanpa kunci API, lewat endpoint MCP publik:
// Parallel (search.parallel.ai/mcp) sebagai utama, Exa (mcp.exa.ai/mcp) sebagai
// cadangan. Keduanya menerima JSON-RPC 2.0 lewat POST dan tidak butuh kredensial.
//
// Parsing dipisah dari jaringan supaya bisa diuji tanpa internet:
//   uraiBalasan(teks)   - JSON atau SSE -> objek JSON-RPC
//   uraiCariKe(teks)    - pesan alat -> [{judul, url, cuplikan}]
// ponytail: dua vendor keyless; tambah backend berbayar kalau salah satu tutup.

const PARALLEL = 'https://search.parallel.ai/mcp';
const EXA = 'https://mcp.exa.ai/mcp';
// ponytail: DuckDuckGo HTML dibuang - sejak Nov 2026 semua permintaan dari sini
// dijawab HTTP 202 tanpa hasil, jadi vendor keyless MCP yang dipakai.
const UA = 'sakti-cli/1.0 (+https://github.com/)';
const WAKTU_BAWAAN = 40000;

/** JSON-RPC biasa atau balasan SSE (`data: {...}`) -> objeknya. */
export function uraiBalasan(teks) {
  const isi = String(teks || '').trim();
  if (!isi) throw new Error('balasan kosong');
  if (isi.startsWith('{')) return JSON.parse(isi);
  const baris = isi.split('\n').filter((satu) => satu.startsWith('data:'));
  for (const satu of baris) {
    try { return JSON.parse(satu.slice(5).trim()); } catch { /* lanjut */ }
  }
  throw new Error('balasan bukan JSON/SSE: ' + isi.slice(0, 120));
}

/** Isi pesan teks dari hasil tools/call (MCP membungkusnya di content[].text). */
export function teksAlat(jawab) {
  if (jawab && jawab.error) throw new Error('MCP: ' + (jawab.error.message || JSON.stringify(jawab.error).slice(0, 200)));
  const isi = (((jawab || {}).result || {}).content) || [];
  const teks = isi.map((satu) => satu && satu.text).filter(Boolean).join('\n');
  if (!teks) throw new Error('MCP tidak mengembalikan teks');
  return teks;
}

/** Balasan web_search (Parallel) atau web_search_exa (Exa) -> [{judul, url, cuplikan}]. */
export function uraiCariKe(teks, { maks = 8 } = {}) {
  const isi = String(teks || '').trim();
  let data;
  try { data = JSON.parse(isi); } catch {
    // Exa mengembalikan teks bebas: ambil URL + judul dari barisnya.
    const hasil = [];
    const pola = /^(?:Title:\s*(.+))?$|^URL:\s*(\S+)$|^Text:\s*(.+)$/gm;
    let judul = '';
    let url = '';
    let cuplikan = '';
    const simpan = () => { if (url) hasil.push({ judul: judul || url, url, cuplikan: cuplikan.slice(0, 300) }); judul = ''; url = ''; cuplikan = ''; };
    let cocok;
    while ((cocok = pola.exec(isi)) && hasil.length < maks) {
      // Pola punya grup opsional: di ujung teks ia cocok string kosong dan
      // lastIndex tidak maju -> loop abadi (dulu bikin cariweb menggantung).
      if (cocok[0] === '') { pola.lastIndex += 1; continue; }
      // Urutan baris Exa: Title, URL, Text. Simpan SAAT Title berikutnya muncul,
      // bukan saat URL - kalau tidak, judul terhapus sebelum sempat dipakai.
      if (cocok[1]) { simpan(); judul = cocok[1].trim(); }
      else if (cocok[2]) url = cocok[2].trim();
      else if (cocok[3]) cuplikan = cocok[3].trim();
    }
    simpan();
    return hasil.slice(0, maks);
  }
  const rows = (data.results || data.data || []);
  return rows.slice(0, maks).map((row) => ({
    judul: String(row.title || row.name || row.url || '').slice(0, 200),
    url: String(row.url || row.link || ''),
    cuplikan: String((row.excerpts || [])[0] || row.text || row.snippet || '').replace(/\s+/g, ' ').slice(0, 400)
  })).filter((row) => row.url);
}

/** Isi halaman hasil web_fetch -> {judul, url, teks}. */
export function uraiAmbil(teks) {
  const data = JSON.parse(String(teks || '').trim());
  const row = ((data.results || [])[0]) || {};
  const isi = (row.excerpts || []).join('\n\n') || row.content || row.text || '';
  return { judul: String(row.title || ''), url: String(row.url || ''), teks: String(isi) };
}

async function mcpPanggil(url, nama, argumen, { waktu = WAKTU_BAWAAN } = {}) {
  const balas = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: nama, arguments: argumen } }),
    signal: AbortSignal.timeout(waktu)
  });
  if (!balas.ok) throw new Error('HTTP ' + balas.status + ' dari ' + url);
  return teksAlat(uraiBalasan(await balas.text()));
}

/**
 * Cari di web. Utama Parallel (kaya kutipan), cadangan Exa. Galat dari keduanya
 * dikumpulkan apa adanya - bukan disembunyikan jadi "tidak ada hasil".
 */
export async function cariWeb(query, { maks = 8, waktu = WAKTU_BAWAAN } = {}) {
  const isi = String(query || '').trim();
  if (!isi) throw new Error('query kosong');
  const galat = [];
  try {
    const teks = await mcpPanggil(PARALLEL, 'web_search', { objective: isi, search_queries: [isi] }, { waktu });
    const hasil = uraiCariKe(teks, { maks });
    if (hasil.length) return hasil;
    galat.push('parallel: tidak ada hasil');
  } catch (e) { galat.push('parallel: ' + String((e && e.message) || e)); }
  try {
    const teks = await mcpPanggil(EXA, 'web_search_exa', { query: isi, objective: isi, numResults: Math.min(Math.max(maks, 1), 10) }, { waktu });
    const hasil = uraiCariKe(teks, { maks });
    if (hasil.length) return hasil;
    galat.push('exa: tidak ada hasil');
  } catch (e) { galat.push('exa: ' + String((e && e.message) || e)); }
  throw new Error('pencarian gagal (' + galat.join('; ') + ')');
}

/** Baca satu halaman jadi teks siap baca (bukan HTML mentah). */
export async function ambilWeb(url, { waktu = WAKTU_BAWAAN } = {}) {
  const teks = await mcpPanggil(PARALLEL, 'web_fetch', { urls: [String(url)], objective: 'ambil isi halaman apa adanya' }, { waktu });
  return uraiAmbil(teks);
}
