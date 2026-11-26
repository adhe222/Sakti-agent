// lib/konteks.js - context budget + eviction hasil tool (ADR-003, pola
// OpenSRE core/context_budget.py). Murni, tanpa efek samping: hitung estimasi
// token, ganti ISI hasil tool LAMA jadi stub bila total melebihi batas, sediakan
// pembersih marker internal sebelum pesan dikirim ke provider.
//
// Kontrak (lihat docs/adr/ADR-003-adopsi-opensre.md):
//   jendelaModel(nama)    -> jumlah token jendela konteks model (fallback 128k)
//   estimasiToken(teks)   -> ~0.5 token per karakter, bulat ke atas
//   evict(pesan, batas)   -> salinan pesan dgn hasil tool lama jadi stub;
//                            system + 2 pesan terakhir tidak pernah disentuh
//   bersihkanMarker(pesan)-> salinan tanpa properti _sakti_* (marker internal)
//   STUB_EVICT            -> teks stub yang dilihat model
//   KUNCI_EVICTED         -> nama properti marker ('_sakti_evicted')

// Peta jendela konteks per-keluarga model. Pencocokan AWALAN (substring, urut
// sesuai daftar) karena sakti bisa memakai model apa saja via lib/model.js -
// nama seperti "claude-opus-5.5" atau "openai/gpt-4o-2024" harus tetap kena.
const JENDELA_MODEL = [
  ['gemini', 1000000],
  ['gpt-4.1', 1000000],
  ['gpt-4o', 128000],
  ['gpt-4', 128000],
  ['gpt-5', 128000],
  ['o1', 128000],
  ['o3', 128000],
  ['claude', 200000]
];
const JENDELA_BAWAAN = 128000;

/** Jendela konteks model: cocokkan awalan keluarga (case-insensitive), fallback bawaan. */
export function jendelaModel(nama) {
  const kunci = String(nama == null ? '' : nama).toLowerCase();
  if (kunci) {
    for (const [keluarga, jendela] of JENDELA_MODEL) {
      if (kunci.includes(keluarga)) return jendela;
    }
  }
  return JENDELA_BAWAAN;
}

/** Estimasi token ~0.5/karakter (kasar tapi murah dan stabil, pola OpenSRE). */
export function estimasiToken(teks) {
  return Math.ceil(String(teks == null ? '' : teks).length / 2);
}

export const STUB_EVICT = '[output removed to fit context window, call the tool again]';
export const KUNCI_EVICTED = '_sakti_evicted';

/** Estimasi token satu pesan gaya chat sakti (content string atau objek). */
function estimasiPesan(pesan) {
  const isi = typeof pesan.content === 'string' ? pesan.content : JSON.stringify(pesan.content ?? '');
  return estimasiToken(isi);
}

/** Apakah pesan membawa hasil tool yang bisa di-stub. */
function membawaHasilTool(pesan) {
  if (pesan.role === 'tool') return true;
  if (!Array.isArray(pesan.content)) return false;
  return pesan.content.some(
    (blok) => blok && typeof blok === 'object' &&
      (blok.type === 'tool_result' || (blok.toolResult && typeof blok.toolResult === 'object'))
  );
}

/** Salinan pesan dengan SEMUA hasil tool di dalamnya diganti stub; null bila tidak ada. */
function stubkanHasil(pesan) {
  if (pesan.role === 'tool') {
    return { ...pesan, content: STUB_EVICT, [KUNCI_EVICTED]: true };
  }
  if (!Array.isArray(pesan.content)) return null;
  let berubah = false;
  const isi = pesan.content.map((blok) => {
    if (blok && typeof blok === 'object' && blok.type === 'tool_result') {
      berubah = true;
      return { ...blok, content: STUB_EVICT };
    }
    if (blok && typeof blok === 'object' && blok.toolResult && typeof blok.toolResult === 'object') {
      berubah = true;
      return { ...blok, toolResult: { ...blok.toolResult, content: [{ text: STUB_EVICT }] } };
    }
    return blok;
  });
  return berubah ? { ...pesan, content: isi, [KUNCI_EVICTED]: true } : null;
}

/**
 * Evict hasil tool lama sampai estimasi total <= batasToken. Mengembalikan
 * salinan array (tidak bermutasi masukan). Aturan:
 *   - pesan `system` dan 2 pesan TERAKHIR tidak pernah disentuh;
 *   - yang di-stub hanya pesan pembawa hasil tool (role `tool` / blok
 *     tool_result), pasangan tool_calls-nya dibiarkan agar model tahu
 *     panggilannya pernah terjadi dan bisa mengulangnya;
 *   - pesan ter-stub ditandai KUNCI_EVICTED (dibersihkan bersihkanMarker);
 *   - evict paling LAMA dulu (paling jauh dari ujung), idempoten.
 */
export function evict(pesan, batasToken) {
  const masukan = Array.isArray(pesan) ? pesan : [];
  const total = () => hasil.reduce((n, r) => n + estimasiPesan(r), 0);
  const hasil = masukan.map((r) => ({ ...r }));
  if (!(Number(batasToken) > 0) || total() <= batasToken) return hasil;

  // Zona aman: semua system di kepala + 2 pesan terakhir.
  let awalAman = 0;
  while (awalAman < hasil.length && hasil[awalAman].role === 'system') awalAman += 1;
  const ekorAman = Math.max(hasil.length - 2, awalAman);

  // Kandidat: indeks pesan pembawa hasil tool di luar zona aman, belum stub.
  const kandidat = () => {
    const daftar = [];
    for (let i = awalAman; i < ekorAman; i += 1) {
      if (membawaHasilTool(hasil[i]) && !hasil[i][KUNCI_EVICTED]) daftar.push(i);
    }
    // Terlama dulu: hasil paling jauh dari ujung paling tidak dipakai.
    return daftar;
  };

  for (const i of kandidat()) {
    if (total() <= batasToken) break;
    const stub = stubkanHasil(hasil[i]);
    if (stub) hasil[i] = stub;
  }
  return hasil;
}

/** Salinan pesan tanpa properti internal _sakti_* - dipanggil sebelum kirim ke provider. */
export function bersihkanMarker(pesan) {
  const masukan = Array.isArray(pesan) ? pesan : [];
  return masukan.map((row) => {
    const bersih = {};
    for (const k of Object.keys(row || {})) {
      if (!k.startsWith('_sakti_')) bersih[k] = row[k];
    }
    return bersih;
  });
}
