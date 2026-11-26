// ADR-005 K3: kumpulan kunci per endpoint + rotasi saat 429 (kedua), 402,
// 401/403. Nilai kunci TIDAK PERNAH ditulis ke state - hanya fingerprint
// sha256 16-hex pertama (pola Hermes borrowed-secret).
import { createHash } from 'node:crypto';
import { bacaState, ubahState } from './lokal.js';

/** Fingerprint kunci: sha256, 16 hex pertama. Nilai kunci tidak pernah disimpan. */
export function sidikKunci(kunci) {
  return 'sha256:' + createHash('sha256').update(String(kunci == null ? '' : kunci)).digest('hex').slice(0, 16);
}

/** Nama env kandidat untuk baseUrl: https://api.x.com/v1 -> API_X_COM. */
export function namaEnvDari(baseUrl) {
  const host = String(baseUrl || '').replace(/^https?:\/\//, '');
  // 'api.x.com/v1' -> 'API_X_COM' (TLD ikut: dua host beda TLD = env beda).
  const bagian = host.split(/[^\w]+/).filter(Boolean).filter((p) => p.toLowerCase() !== 'www');
  return bagian.join('_').toUpperCase();
}

/** Semua kunci untuk satu endpoint: kunci utama + <NAMA>_API_KEY_2..9 dari env. */
export function kandidatKunci({ baseUrl = '', apiKey = '', poolStrategi = '' } = {}) {
  const hasil = [];
  if (apiKey != null && String(apiKey) !== '') hasil.push({ kunci: String(apiKey), sumber: 'config', label: 'utama' });
  const nama = namaEnvDari(baseUrl);
  if (nama) {
    for (let i = 2; i <= 9; i += 1) {
      const nilai = process.env[nama + '_API_KEY_' + i];
      if (nilai != null && String(nilai).trim() !== '') hasil.push({ kunci: String(nilai).trim(), sumber: 'env:' + nama + '_API_KEY_' + i, label: nama + '_API_KEY_' + i });
    }
  }
  const strategi = String(poolStrategi || process.env.SAKTI_POOL_STRATEGI || 'fill_first').toLowerCase();
  const now = Date.now();
  const hidup = hasil.filter((satu) => {
    const meta = bacaState().kunciPool || {};
    const m = meta[sidikKunci(satu.kunci)];
    return !(m && m.cooldown_sampai && now < m.cooldown_sampai);
  });
  const daftar = hidup.length ? hidup : hasil; // semua cooldown: coba tetap (jangan mati total)
  if (strategi === 'random') return [...daftar].sort(() => Math.random() - 0.5);
  if (strategi === 'least_used') {
    const meta = bacaState().kunciPool || {};
    return [...daftar].sort((a, b) => ((meta[sidikKunci(a.kunci)] || {}).request_count || 0) - ((meta[sidikKunci(b.kunci)] || {}).request_count || 0));
  }
  if (strategi === 'round_robin') {
    const meta = bacaState().kunciPool || {};
    return [...daftar].sort((a, b) => ((meta[sidikKunci(a.kunci)] || {}).last_at || 0) - ((meta[sidikKunci(b.kunci)] || {}).last_at || 0));
  }
  return daftar; // fill_first
}

/** Catat hasil pemakaian satu kunci. status = 'ok'|'429'|'402'|'401'|'403'|galat lain. */
export function catatPakaiKunci(kunci, status) {
  const fp = sidikKunci(kunci);
  ubahState((state) => {
    if (!state.kunciPool || typeof state.kunciPool !== 'object') state.kunciPool = {};
    const m = state.kunciPool[fp] || { request_count: 0 };
    m.request_count += 1;
    m.last_status = String(status);
    m.last_at = Date.now();
    if (status === 402) m.cooldown_sampai = Date.now() + 60 * 60 * 1000; // 402: cooldown 60 menit
    state.kunciPool[fp] = m;
  });
}

export const COOLDOWN_KUNCI_MS = 60 * 60 * 1000;
