/* global AbortSignal */
// Klien model sendiri: satu endpoint gaya OpenAI (chat completions) dengan
// streaming SSE dan panggilan alat. Tidak memakai SDK, tidak memanggil biner
// lain - cukup fetch bawaan Node.
//
// Konfigurasi dicari berurutan: env -> ~/.sakti-cli/config.json. Berkas model
// milik alat lain hanya DIBACA sekali untuk menebak bawaan yang sudah ada di
// mesin ini; setelah config.json terisi, CLI tidak menyentuhnya lagi.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rapikanUrl } from './pengaturan.js';
import { kunciBerkas } from './lokal.js';

export function berkasKonfig() {
  return process.env.SAKTI_CLI_CONFIG || path.join(os.homedir(), '.sakti-cli', 'config.json');
}

function bacaJson(berkas) {
  try { return JSON.parse(fs.readFileSync(berkas, 'utf8')) || {}; }
  catch {
    // Berkas rusak: cadangkan sebelum pemanggil menimpanya dengan config baru.
    try {
      const info = fs.statSync(berkas);
      if (info.isFile() && info.size > 0) fs.renameSync(berkas, berkas + '.rusak-' + Date.now());
    } catch { /* tidak ada / tidak bisa dipindah */ }
    return null;
  }
}

/** Tebakan bawaan dari config pi, kalau ada. Dibaca saja, tanpa menjalankan pi. */
function tebakanPi() {
  const pi = bacaJson(path.join(os.homedir(), '.pi', 'agent', 'models.json'));
  const penyedia = pi && pi.providers && Object.values(pi.providers)[0];
  if (!penyedia || !penyedia.baseUrl) return null;
  const model = (penyedia.models && penyedia.models[0] && penyedia.models[0].id) || 'gpt-4o-mini';
  return { baseUrl: String(penyedia.baseUrl).replace(/\/+$/, ''), model, apiKey: penyedia.apiKey || '' };
}

/**
 * Rantai cadangan setelah model utama menyerah: env SAKTI_MODEL_FALLBACKS
 * ("url|model|kunci,url|model|kunci") atau config.fallbacks [{baseUrl,model,apiKey}].
 */
export function rantaiCadangan(simpan = {}) {
  const dariEnv = String(process.env.SAKTI_MODEL_FALLBACKS || '')
    .split(',').map((satu) => satu.trim()).filter(Boolean)
    .map((potongan) => {
      const [baseUrl, model, apiKey] = potongan.split('|').map((satu) => String(satu || '').trim());
      return { baseUrl: String(baseUrl || '').replace(/\/+$/, ''), model, apiKey };
    });
  const dariBerkas = Array.isArray(simpan.fallbacks) ? simpan.fallbacks : [];
  return [...dariEnv, ...dariBerkas]
    .filter((satu) => satu && satu.baseUrl && satu.model)
    .map((satu) => ({ baseUrl: String(satu.baseUrl).replace(/\/+$/, ''), model: String(satu.model), apiKey: String(satu.apiKey || '') }));
}

// Tingkat penalaran, sejajar kosakata Hermes (VALID_REASONING_EFFORTS + none).
// Dikirim apa adanya sebagai reasoning_effort; kalau endpoint menolaknya (HTTP 400),
// sekali percobaan diulang tanpa field itu - lebih baik jalan tanpa penalaran
// daripada gagal total di proksi yang tak mendukung knob ini.
export const EFFORT_SAH = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Anggaran token keluaran per tingkat. Naik seiring tingkat penalaran: makin
// dalam berpikir, makin panjang ruang jawab yang wajar. Bisa ditimpa lewat
// --max-tokens / SAKTI_MAX_TOKENS; 0 = jangan kirim max_tokens sama sekali
// (biar server yang menentukan).
export const TOKEN_PER_EFFORT = {
  none: 1024,
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
  ultra: 48000
};

/** Anggaran token untuk satu tingkat effort; '' kalau tingkat tidak sah. */
export function tokenUntukEffort(effort) {
  const level = normalEffort(effort);
  if (!level) return '';
  return TOKEN_PER_EFFORT[level] || '';
}
const ALIAS_EFFORT = { off: 'none', 'extra-high': 'xhigh', extramax: 'ultra', max_: 'max' };

/** Normalisasi nilai effort; balik '' kalau tidak sah (pemanggil memutuskan). */
export function normalEffort(nilai) {
  const teks = String(nilai == null ? '' : nilai).trim().toLowerCase();
  if (!teks) return '';
  const tebak = ALIAS_EFFORT[teks] || teks;
  return EFFORT_SAH.includes(tebak) ? tebak : '';
}

/* ------------------------------------------- kemampuan reasoning/endpoint -- */

// Endpoint berbeda-beda soal `reasoning_effort` dan `max_tokens`: ada yang
// menerima semua tingkat, ada yang hanya low..high, ada yang menolak field-nya
// sama sekali, dan ada yang mematok batas keluaran. Kemampuan itu DISIMPAN per
// endpoint+model (`config.kemampuan["<baseUrl>|<model>"]`) supaya penolakan 400
// tidak dibayar ulang tiap giliran. Umur 7 hari: provider bisa berubah, dan
// cache tua tidak boleh mengunci selamanya. `SAKTI_KEMAMPUAN_TTL` (detik)
// menimpanya; 0 = cache tidak pernah basi.
export const TTL_KEMAMPUAN_MS = 7 * 24 * 60 * 60 * 1000;
const EFFORT_NAIK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function ttlKemampuan(env = process.env) {
  const mentah = String(env.SAKTI_KEMAMPUAN_TTL == null ? '' : env.SAKTI_KEMAMPUAN_TTL).trim().toLowerCase();
  if (!mentah) return TTL_KEMAMPUAN_MS;
  if (['off', 'mati', 'false', 'no', '0'].includes(mentah)) return 0;
  const detik = Number(mentah);
  return Number.isFinite(detik) && detik > 0 ? Math.floor(detik * 1000) : TTL_KEMAMPUAN_MS;
}

/** Kunci peta kemampuan: endpoint + model (penolakan bisa khusus model). */
export function kunciKemampuan(konf = {}) {
  const model = String(konf.model == null ? '' : konf.model).trim();
  return model ? kunciEndpoint(konf.baseUrl) + '|' + model : '';
}

const KEMAMPUAN_KOSONG = () => ({ effortSah: null, effortDitolak: [], tanpaEffort: false, tanpaMaxTokens: false, maxTokensMaks: 0, sumber: '', waktu: 0 });

/** Kemampuan tersimpan untuk endpoint+model aktif; objek kosong kalau belum ada/basi. */
export function kemampuanModel(konf = {}, { sekarang = Date.now(), ttl = ttlKemampuan() } = {}) {
  const kunci = kunciKemampuan(konf);
  if (!kunci) return KEMAMPUAN_KOSONG();
  const simpan = bacaJson(berkasKonfig()) || {};
  const peta = simpan.kemampuan && typeof simpan.kemampuan === 'object' && !Array.isArray(simpan.kemampuan) ? simpan.kemampuan : {};
  const satu = peta[kunci];
  if (!satu || typeof satu !== 'object') return KEMAMPUAN_KOSONG();
  const waktu = Number(satu.waktu) || 0;
  if (ttl > 0 && (!waktu || sekarang - waktu > ttl)) return KEMAMPUAN_KOSONG();
  return {
    effortSah: Array.isArray(satu.effortSah) ? [...new Set(satu.effortSah.map(normalEffort).filter(Boolean))] : null,
    effortDitolak: Array.isArray(satu.effortDitolak) ? [...new Set(satu.effortDitolak.map(normalEffort).filter(Boolean))] : [],
    tanpaEffort: satu.tanpaEffort === true,
    tanpaMaxTokens: satu.tanpaMaxTokens === true,
    maxTokensMaks: Math.max(0, Math.floor(Number(satu.maxTokensMaks) || 0)),
    sumber: String(satu.sumber || ''),
    waktu
  };
}

/** Simpan tambahan kemampuan untuk endpoint+model aktif; peta dibatasi 16 entri. */
export function simpanKemampuan(konf = {}, tambahan = {}) {
  const kunci = kunciKemampuan(konf);
  if (!kunci) return null;
  const lama = bacaJson(berkasKonfig()) || {};
  const peta = Object.assign({}, lama.kemampuan && typeof lama.kemampuan === 'object' ? lama.kemampuan : {});
  const sebelum = peta[kunci] && typeof peta[kunci] === 'object' ? peta[kunci] : {};
  const baru = Object.assign({}, sebelum, tambahan, { waktu: Date.now() });
  if (Array.isArray(baru.effortSah)) baru.effortSah = [...new Set(baru.effortSah.map(normalEffort).filter(Boolean))];
  if (Array.isArray(baru.effortDitolak)) baru.effortDitolak = [...new Set(baru.effortDitolak.map(normalEffort).filter(Boolean))];
  peta[kunci] = baru;
  const urut = Object.keys(peta).sort((a, b) => (Number(peta[b] && peta[b].waktu) || 0) - (Number(peta[a] && peta[a].waktu) || 0));
  const pangkas = {};
  for (const k of urut.slice(0, 16)) pangkas[k] = peta[k];
  simpanModel({ kemampuan: pangkas });
  return baru;
}

/**
 * Effort yang aman dikirim: '' = jangan kirim field, 'none' = memang minta
 * tanpa penalaran. Nilai yang ditolak/tidak didukung diturunkan ke tingkat
 * terdekat di bawahnya; tidak pernah dinaikkan diam-diam (biaya).
 */
export function effortAman(level, kem = {}) {
  const asal = normalEffort(level);
  if (!asal) return '';
  if (asal === 'none') return 'none';
  if (kem.tanpaEffort) return '';
  const ditolak = new Set(Array.isArray(kem.effortDitolak) ? kem.effortDitolak : []);
  const sah = Array.isArray(kem.effortSah) && kem.effortSah.length ? new Set(kem.effortSah) : null;
  const boleh = (nama) => !ditolak.has(nama) && (!sah || sah.has(nama));
  if (boleh(asal)) return asal;
  const i = EFFORT_NAIK.indexOf(asal);
  for (let j = i - 1; j >= 0; j -= 1) if (boleh(EFFORT_NAIK[j])) return EFFORT_NAIK[j];
  return '';
}

/** max_tokens yang aman: 0 = jangan kirim; dipotong ke batas yang terbukti. */
export function maxTokensAman(angka, kem = {}) {
  const n = Math.floor(Number(angka) || 0);
  if (kem.tanpaMaxTokens) return 0;
  if (!(n > 0)) return 0;
  const maks = Math.max(0, Math.floor(Number(kem.maxTokensMaks) || 0));
  return maks > 0 ? Math.min(n, maks) : n;
}

/** Ringkas kemampuan reasoning/max_tokens untuk panel; '' kalau belum ada. */
export function ringkasKemampuan(kem = {}) {
  if (!kem || !Number(kem.waktu)) return '';
  if (kem.tanpaEffort) return 'effort tidak didukung endpoint';
  const bagian = [];
  if (Array.isArray(kem.effortSah) && kem.effortSah.length) bagian.push('didukung ' + kem.effortSah.join('|'));
  if (Array.isArray(kem.effortDitolak) && kem.effortDitolak.length) bagian.push('ditolak ' + kem.effortDitolak.join('|'));
  if (kem.maxTokensMaks) bagian.push('max_tokens≤' + kem.maxTokensMaks);
  if (kem.tanpaMaxTokens) bagian.push('max_tokens tidak didukung');
  if (kem.sumber) bagian.push('sumber ' + kem.sumber);
  return bagian.join(' · ');
}

/**
 * Baca pesan 400: knob mana yang ditolak, apakah field-nya (bukan nilainya),
 * daftar nilai effort yang disebut provider, dan batas max_tokens numerik.
 * Sengaja konservatif: yang tidak jelas TIDAK dicache, hanya diulang sekali.
 */
export function klasifikasi400(teks, badan = {}) {
  const rendah = String(teks == null ? '' : teks).toLowerCase();
  const soalEffort = Boolean(badan.reasoning_effort) && /reasoning|effort/.test(rendah);
  const soalToken = Boolean(badan.max_tokens) && /max_tokens|max tokens|max_completion_tokens|maximum context|context length|token/.test(rendah);
  const tolakField = /(not supported|unsupported|unrecognized|unknown (?:parameter|argument|field)|not allowed|invalid parameter|tidak didukung)/.test(rendah);
  let batasToken = 0;
  if (soalToken) {
    // Utamakan frasa BATAS ("supports at most 16384", "maximum is 8192"), bukan
    // angka yang kita minta. Dulu regex menangkap `max_tokens: 48000` sehingga
    // batas palsu 48000 di-cache dan setiap giliran gagal dua kali.
    const frasa = rendah.match(/supports?\s+(?:at\s+most|up\s+to)\D{0,40}(\d{2,7})/)
      || rendah.match(/(?:max(?:imum)?|maks(?:imal)?)\s*(?:allowed\s*)?(?:output|completion)?\s*tokens?\D{0,30}(\d{2,7})/);
    const cocok = frasa || rendah.match(/(?:max_tokens|max_completion_tokens)[^0-9]{0,80}(\d{2,7})/);
    if (cocok) batasToken = Math.max(0, Math.floor(Number(cocok[1]) || 0));
  }
  let effortSah = null;
  if (soalEffort) {
    const cocok = rendah.match(/(?:one of|salah satu|must be one of|allowed values?)[:\s]*([a-z0-9_,\s-]+)/);
    if (cocok) {
      const daftar = [...new Set(cocok[1].split(/[,\s]+/).map(normalEffort).filter(Boolean))];
      if (daftar.length) effortSah = daftar;
    }
  }
  return { soalEffort, soalToken, tolakField, batasToken, effortSah };
}

export function konfigModel(flag = {}) {
  const simpan = bacaJson(berkasKonfig()) || {};
  const tebakan = tebakanPi() || {};
  const baseUrlMentah = flag['model-url'] || process.env.SAKTI_MODEL_URL || simpan.baseUrl || tebakan.baseUrl || 'http://localhost:3000/v1';
  // Satu normalisasi untuk semua jalur masuk (env, config, berkas pi): URL
  // lengkap /chat/completions yang ditempel dari dokumentasi tidak boleh
  // berakhir jadi /chat/completions/chat/completions.
  let baseUrl = String(baseUrlMentah).replace(/\/+$/, '');
  try { baseUrl = rapikanUrl(baseUrl); } catch { /* biarkan; ujiModel yang melaporkan */ }
  const model = flag.model || process.env.SAKTI_MODEL || simpan.model || tebakan.model || 'Gratis';
  // Katalog DISIMPAN PER ENDPOINT. Ganti endpoint = daftar model lama tidak
  // boleh ikut tampil; yang dipakai hanya peta milik baseUrl aktif.
  const katalog = katalogEndpoint(simpan, baseUrl);
  // Kunci: nilai tersimpan yang EKSPLISIT (termasuk '' dari hapus-key) tidak
  // boleh jatuh ke tebakan pi - dulu `simpan.apiKey || tebakan.apiKey` membuat
  // kunci pi asli terkirim ke endpoint yang dipasang orang lain.
  const kunciFlag = flag['model-key'];
  const kunciEnv = process.env.SAKTI_MODEL_KEY;
  const apiKey = kunciFlag != null && kunciFlag !== ''
    ? String(kunciFlag)
    : (kunciEnv != null && kunciEnv !== ''
      ? String(kunciEnv)
      : (Object.prototype.hasOwnProperty.call(simpan, 'apiKey')
        ? String(simpan.apiKey == null ? '' : simpan.apiKey)
        : String(tebakan.apiKey || '')));
  // `effort: none` berarti tidak mengirim field sama sekali.
  const effort = normalEffort(flag.effort || flag.reasoning || process.env.SAKTI_EFFORT || simpan.effort);
  // Anggaran token: angka eksplisit menang (0 = jangan kirim), selain itu ikut tingkat.
  const mentahToken = flag['max-tokens'] != null ? flag['max-tokens'] : (process.env.SAKTI_MAX_TOKENS != null ? process.env.SAKTI_MAX_TOKENS : simpan.maxTokens);
  const angka = Number(mentahToken);
  const maxTokens = mentahToken != null && mentahToken !== '' && Number.isFinite(angka) && angka >= 0
    ? Math.floor(angka)
    : (tokenUntukEffort(effort) || 0);
  // Batas riwayat: `--batas-riwayat` / SAKTI_BATAS_RIWAYAT / config.batasRiwayat.
  const mentahBatas = flag['batas-riwayat'] != null ? flag['batas-riwayat'] : (process.env.SAKTI_BATAS_RIWAYAT != null ? process.env.SAKTI_BATAS_RIWAYAT : simpan.batasRiwayat);
  const batasRiwayat = Number(mentahBatas);
  // Smart route: tingkat anggaran dipilih dari kesulitan tugas (lib/rute.js).
  // `rute:false` / SAKTI_RUTE=off mematikannya; `ruteTingkat` mematok satu tingkat
  // tanpa peduli skor. `eksplisit` = knob yang benar-benar diset tangan (bendera,
  // env, atau config) - rute hanya mengisi yang TIDAK ada di daftar itu, jadi
  // `--effort high` / `--max-tokens 256` / `--batas-riwayat 4` tetap menang.
  const batasRiwayatNilai = Number.isFinite(batasRiwayat) && batasRiwayat > 0 ? Math.floor(batasRiwayat) : undefined;
  const batasTokenNilai = (() => {
    const mentah = flag['batas-token'] != null ? flag['batas-token'] : (process.env.SAKTI_BATAS_TOKEN != null ? process.env.SAKTI_BATAS_TOKEN : simpan.batasToken);
    const nilai = Math.floor(Number(mentah));
    return Number.isFinite(nilai) && nilai > 0 ? nilai : undefined;
  })();
  // Batas langkah per giliran (lihat agent.js). Disimpan di config supaya
  // `{"maksLangkah": 120}` benar-benar dipakai, bukan hanya env.
  const mentahLangkah = flag['maks-langkah'] != null ? flag['maks-langkah'] : (process.env.SAKTI_MAKS_LANGKAH != null ? process.env.SAKTI_MAKS_LANGKAH : simpan.maksLangkah);
  const teksLangkah = mentahLangkah == null ? '' : String(mentahLangkah).trim().toLowerCase();
  const angkaLangkah = Math.floor(Number(mentahLangkah));
  const maksLangkah = ['0', 'off', 'false', 'no', 'unlimited', 'tanpa-batas'].includes(teksLangkah)
    ? 0
    : (Number.isFinite(angkaLangkah) && angkaLangkah > 0 ? Math.min(angkaLangkah, 400) : undefined);
  const eksplisit = [];
  if (effort) eksplisit.push('effort', 'maxTokens'); // maxTokens ikut turunan effort
  else if (mentahToken != null && mentahToken !== '' && Number.isFinite(angka) && angka >= 0) eksplisit.push('maxTokens');
  if (batasRiwayatNilai != null) eksplisit.push('batasRiwayat');
  if (batasTokenNilai != null) eksplisit.push('batasToken');
  const ruteNilai = flag.rute != null ? flag.rute
    : (process.env.SAKTI_RUTE != null ? process.env.SAKTI_RUTE : simpan.rute);
  const ruteTingkatNilai = flag['rute-tingkat'] || process.env.SAKTI_RUTE_TINGKAT || simpan.ruteTingkat || '';
  // Subset alat: `--alat=baca,cari` / SAKTI_ALAT / config.alat. Disaring lagi
  // oleh sempitAlat() di agent.js, jadi salah ketik tidak mematikan giliran.
  const mentahAlat = flag.alat != null ? flag.alat : (process.env.SAKTI_ALAT != null ? process.env.SAKTI_ALAT : simpan.alat);
  const alatNilai = Array.isArray(mentahAlat)
    ? mentahAlat.map(String).join(',')
    : (mentahAlat != null && mentahAlat !== true ? String(mentahAlat) : '');
  // Gaya indikator TUI (`/indikator`, `SAKTI_INDIKATOR`, config.indikator).
  // Divalidasi di lib/status.js (`gayaSah`) supaya nilai sampah tidak
  // menghasilkan bingkai kosong.
  const indikatorNilai = String(flag.indikator != null ? flag.indikator
    : (process.env.SAKTI_INDIKATOR != null ? process.env.SAKTI_INDIKATOR : (simpan.indikator || ''))).trim().toLowerCase();
  return {
    baseUrl,
    model, apiKey, effort, maxTokens,
    rute: ruteNilai,
    ruteTingkat: ruteTingkatNilai,
    eksplisit,
    batasRiwayat: batasRiwayatNilai,
    batasToken: batasTokenNilai,
    maksLangkah,
    alat: alatNilai,
    indikator: indikatorNilai,
    models: katalog.models,
    katalogWaktu: katalog.waktu,
    katalogCoba: katalog.coba,
    katalogDari: katalog.url,
    fallbacks: rantaiCadangan(simpan),
    // Gateway chat dari `sakti setup` (telegram|whatsapp|generik): dipakai
    // `sakti kanal` sebagai nilai bawaan, bukan hanya dokumentasi.
    kanal: (simpan && simpan.kanal && typeof simpan.kanal === 'object') ? simpan.kanal : null,
    // Profil alat (ringan/standar/penuh) + setelan tampilan penalaran/pelajaran
    // ikut dibaca supaya `/pengaturan` dan doctor melihat keadaan sebenarnya.
    profilAlat: String(flag['profil-alat'] != null ? flag['profil-alat']
      : (process.env.SAKTI_PROFIL_ALAT != null ? process.env.SAKTI_PROFIL_ALAT : (simpan.profilAlat || ''))).trim().toLowerCase(),
    nalar: String(simpan.nalar || ''),
    pelajaran: String(simpan.pelajaran || ''),
    berkas: berkasKonfig()
  };
}

export function simpanModel(nilai) {
  const berkas = berkasKonfig();
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  return kunciBerkas(berkas, () => {
    const lama = bacaJson(berkas) || {};
    const baru = Object.assign({}, lama, nilai);
    // Tulis ke berkas sementara lalu rename: mati listrik di tengah tulis tidak
    // boleh meninggalkan config.json setengah jadi (kunci + endpoint hilang).
    const sementara = berkas + '.tmp-' + process.pid;
    fs.writeFileSync(sementara, JSON.stringify(baru, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(sementara, berkas);
    // mode pada writeFileSync hanya berlaku saat berkas BARU dibuat; berkas yang
    // sudah ada (mis. dibuat tangan dengan 0644) tetap longgar. Kunci API ada di
    // sini - rapikan izinnya setiap kali ditulis.
    try { fs.chmodSync(berkas, 0o600); } catch { /* filesystem tanpa chmod */ }
    return baru;
  });
}

export class GalatModel extends Error {}
export class GalatBatal extends Error {}

/** URL katalog model untuk basis API apa pun: <baseUrl>/models. */
export function urlKatalog(baseUrl) {
  const s = String(baseUrl || '').replace(/\/+$/, '');
  const q = s.indexOf('?');
  return q < 0 ? s + '/models' : s.slice(0, q).replace(/\/+$/, '') + '/models' + s.slice(q);
}

/** <baseUrl>/chat/completions tanpa memutus ?api-version=... di ujung. */
export function urlChat(baseUrl) {
  const s = String(baseUrl || '');
  const q = s.indexOf('?');
  const dasar = (q < 0 ? s : s.slice(0, q)).replace(/\/+$/, '');
  return dasar + '/chat/completions' + (q < 0 ? '' : s.slice(q));
}

/* ------------------------------------------------- katalog per endpoint -- */

// Katalog model hanya berlaku untuk endpoint asalnya. Disimpan sebagai peta
// `katalog: { "<baseUrl>": { models, waktu } }` supaya berpindah endpoint
// (proksi lokal, 9router, provider lain) tidak menampilkan daftar model asing.
// Umur bawaan 6 jam; `SAKTI_KATALOG_TTL` (detik) menimpanya, 0/off = jangan
// segarkan sendiri.
export const TTL_KATALOG_MS = 6 * 60 * 60 * 1000;

/** Umur katalog dari env, dalam milidetik. 0 = penyegaran otomatis dimatikan. */
export function ttlKatalog(env = process.env) {
  const mentah = String(env.SAKTI_KATALOG_TTL == null ? '' : env.SAKTI_KATALOG_TTL).trim().toLowerCase();
  if (!mentah) return TTL_KATALOG_MS;
  if (['off', 'mati', 'false', 'no', '0'].includes(mentah)) return 0;
  const detik = Number(mentah);
  if (!Number.isFinite(detik) || detik < 0) return TTL_KATALOG_MS;
  return Math.floor(detik * 1000);
}

/** Basis endpoint sebagai kunci peta: tanpa garis miring ekor. */
export function kunciEndpoint(baseUrl) {
  return String(baseUrl == null ? '' : baseUrl).trim().replace(/\/+$/, '');
}

function bersihDaftar(daftar) {
  const unik = new Set();
  for (const satu of Array.isArray(daftar) ? daftar : []) {
    const teks = String(satu == null ? '' : satu).trim();
    if (teks) unik.add(teks);
  }
  return [...unik];
}

/**
 * Katalog tersimpan untuk satu endpoint: { models, waktu, url }.
 * Config lama (models + modelsUrl, atau models tanpa asal) tetap terbaca;
 * tanpa cap waktu katalog lama dianggap basi supaya segera disegarkan.
 */
export function katalogEndpoint(simpan = {}, baseUrl = '') {
  const url = kunciEndpoint(baseUrl);
  const peta = simpan && simpan.katalog && typeof simpan.katalog === 'object' && !Array.isArray(simpan.katalog)
    ? simpan.katalog
    : {};
  const satu = url ? peta[url] : null;
  if (satu && Array.isArray(satu.models)) {
    return {
      models: bersihDaftar(satu.models),
      waktu: Number(satu.waktu) || 0,
      coba: Number(satu.coba) || 0,
      url
    };
  }
  // Kompatibilitas config lama: hanya kalau belum ada peta sama sekali, supaya
  // daftar milik endpoint lain tidak bocor ke endpoint yang baru dipasang.
  if (!Object.keys(peta).length && Array.isArray(simpan && simpan.models)) {
    const asal = kunciEndpoint(simpan && simpan.modelsUrl);
    if (!asal || asal === url) {
      return { models: bersihDaftar(simpan.models), waktu: Number(simpan.modelsWaktu) || 0, coba: 0, url };
    }
  }
  return { models: [], waktu: 0, coba: 0, url };
}

/** Katalog tersimpan untuk endpoint mana pun, dibaca dari config sekarang. */
export function katalogTersimpan(baseUrl) {
  return katalogEndpoint(bacaJson(berkasKonfig()) || {}, baseUrl);
}

/**
 * Periksa model TURUNAN (model murah subagen, rantai cadangan, model bot)
 * terhadap katalog endpoint masing-masing - bukan hanya model aktif.
 * item = { label, model, baseUrl?, models? }.
 * Status: 'ada' | 'tidak' (katalog ada, nama tidak tercantum) | 'belum'
 * (endpoint itu belum punya katalog; tidak bisa dinilai, jangan dituduh salah).
 */
export function periksaModelTurunan(konf = {}, turunan = []) {
  const hasil = [];
  for (const satu of Array.isArray(turunan) ? turunan : []) {
    const nama = String((satu && satu.model) || '').trim();
    if (!nama) continue;
    const baseUrl = kunciEndpoint((satu && satu.baseUrl) || konf.baseUrl);
    const daftar = Array.isArray(satu && satu.models)
      ? bersihDaftar(satu.models)
      : (baseUrl === kunciEndpoint(konf.baseUrl) ? bersihDaftar(konf.models) : katalogTersimpan(baseUrl).models);
    const status = !daftar.length ? 'belum' : (daftar.includes(nama) ? 'ada' : 'tidak');
    hasil.push({ label: String((satu && satu.label) || 'model'), nama, baseUrl, status });
  }
  return hasil;
}

/** Baris peringatan hanya untuk yang TERBUKTI tidak ada; 'belum' didiamkan. */
export function ringkasModelTurunan(hasil = []) {
  return (Array.isArray(hasil) ? hasil : [])
    .filter((satu) => satu && satu.status === 'tidak')
    .map((satu) => satu.label + ' "' + satu.nama + '" tidak ada di katalog ' + satu.baseUrl);
}

/** Apakah katalog endpoint aktif perlu diambil ulang dari GET /models? */
export function perluSegarkanKatalog(konf = {}, { ttl = ttlKatalog(), sekarang = Date.now() } = {}) {
  // TTL 0/off = jangan menyentuh jaringan sendiri; pemanggil yang memaksa
  // (`sakti model katalog`, baris "muat ulang" di TUI) tetap boleh.
  if (!ttl) return false;
  // `coba` = percobaan terakhir yang sampai ke endpoint, termasuk endpoint
  // chat-saja yang tidak punya /models. Tanpa itu, setiap `sakti model` akan
  // memboroskan satu POST /chat/completions untuk memastikan hal yang sama.
  const waktu = Math.max(Number(konf.katalogWaktu) || 0, Number(konf.katalogCoba) || 0);
  if (!waktu) return true; // belum pernah dicoba / katalog lama tanpa cap waktu
  return sekarang - waktu >= ttl;
}

/** Umur cap waktu katalog sebagai teks pendek untuk panel/laporan. */
export function umurKatalog(waktu, sekarang = Date.now()) {
  const t = Number(waktu) || 0;
  if (!t) return 'tanpa cap waktu';
  const detik = Math.max(0, Math.floor((sekarang - t) / 1000));
  if (detik < 60) return 'baru saja';
  const menit = Math.floor(detik / 60);
  if (menit < 60) return menit + ' menit lalu';
  const jam = Math.floor(menit / 60);
  if (jam < 48) return jam + ' jam lalu';
  return Math.floor(jam / 24) + ' hari lalu';
}

/** Simpan katalog milik endpoint aktif; cermin `models`/`modelsUrl` ikut ditulis. */
export function simpanKatalog(konf = {}, daftar = [], { waktu = Date.now() } = {}) {
  const url = kunciEndpoint(konf.baseUrl);
  const models = bersihDaftar(daftar);
  const lama = bacaJson(berkasKonfig()) || {};
  const peta = Object.assign({}, lama.katalog && typeof lama.katalog === 'object' ? lama.katalog : {});
  if (url) peta[url] = { models, waktu };
  // Peta tidak boleh tumbuh tanpa batas: sisakan 8 endpoint terbaru.
  const urut = Object.keys(peta).sort((a, b) => (Number(peta[b] && peta[b].waktu) || 0) - (Number(peta[a] && peta[a].waktu) || 0));
  const pangkas = {};
  for (const kunci of urut.slice(0, 8)) pangkas[kunci] = peta[kunci];
  simpanModel({ katalog: pangkas, models, modelsUrl: url, modelsWaktu: waktu });
  return { models, waktu, url };
}

/**
 * Catat bahwa GET /models sudah dicoba untuk endpoint ini tetapi tidak
 * menghasilkan katalog (proksi chat-saja / katalog kosong). Daftar model yang
 * sudah tersimpan TIDAK disentuh; hanya cap `coba` yang diperbarui supaya
 * percobaan yang sama tidak diulang tiap perintah.
 */
export function catatCobaKatalog(konf = {}, { waktu = Date.now() } = {}) {
  const url = kunciEndpoint(konf.baseUrl);
  if (!url) return null;
  const lama = bacaJson(berkasKonfig()) || {};
  const peta = Object.assign({}, lama.katalog && typeof lama.katalog === 'object' ? lama.katalog : {});
  const sebelumnya = peta[url] && typeof peta[url] === 'object' ? peta[url] : {};
  peta[url] = {
    models: bersihDaftar(sebelumnya.models),
    waktu: Number(sebelumnya.waktu) || 0,
    coba: waktu
  };
  const urut = Object.keys(peta).sort((a, b) => (Number(peta[b] && (peta[b].coba || peta[b].waktu)) || 0) - (Number(peta[a] && (peta[a].coba || peta[a].waktu)) || 0));
  const pangkas = {};
  for (const kunci of urut.slice(0, 8)) pangkas[kunci] = peta[kunci];
  simpanModel({ katalog: pangkas });
  return peta[url];
}

// Satu sinkronisasi per endpoint+kunci pada satu waktu: beberapa jalur (TUI
// startup, menu /model, perintah pengaturan) bisa meminta bersamaan.
const sinkronBerjalan = new Map();

/**
 * Segarkan katalog endpoint aktif dari GET /models, lalu simpan.
 * Tidak pernah melempar. Hasil: { ok, url, katalog, waktu, berubah, sumber,
 * pesan, ms }. `ok: true, segar: true` = katalog tersimpan masih muda, tidak
 * ada permintaan jaringan. Katalog tersimpan dipertahankan bila endpoint gagal.
 */
export async function sinkronKatalog(konf = {}, { paksa = false, ttl = ttlKatalog(), waktu = 15000, fetch: ambil = globalThis.fetch } = {}) {
  const mulai = Date.now();
  const url = kunciEndpoint(konf.baseUrl);
  const tersimpan = Array.isArray(konf.models) ? konf.models : [];
  if (!url) return { ok: false, url, katalog: tersimpan, waktu: Number(konf.katalogWaktu) || 0, berubah: false, sumber: 'kosong', pesan: 'endpoint kosong', ms: 0 };
  if (!paksa && !perluSegarkanKatalog(konf, { ttl })) {
    const ada = tersimpan.length > 0;
    const waktu = Math.max(Number(konf.katalogWaktu) || 0, Number(konf.katalogCoba) || 0);
    return {
      ok: ada, url, katalog: tersimpan, waktu, berubah: false, segar: true,
      sumber: ada ? 'tersimpan' : 'kosong',
      pesan: ada
        ? tersimpan.length + ' model masih segar'
        : 'katalog /models tidak tersedia untuk endpoint ini · dicoba ' + umurKatalog(waktu)
    };
  }
  const kunci = url + '|' + String(konf.apiKey || '');
  if (sinkronBerjalan.has(kunci)) return sinkronBerjalan.get(kunci);

  const janji = (async () => {
    const hasil = await ujiModel(konf, { waktu, fetch: ambil });
    const ms = Date.now() - mulai;
    if (hasil.ok && Array.isArray(hasil.katalog) && hasil.katalog.length) {
      const sebelum = tersimpan.join('\n');
      const baru = simpanKatalog(konf, hasil.katalog);
      return {
        ok: true, url, katalog: baru.models, waktu: baru.waktu, ms,
        berubah: sebelum !== baru.models.join('\n'), sumber: 'endpoint', status: hasil.status,
        pesan: baru.models.length + ' model dari ' + url
      };
    }
    // Sampai ke endpoint tetapi tidak ada /models: catat percobaannya supaya
    // perintah berikutnya tidak memboroskan probe yang sama; daftar tersimpan
    // (kalau ada) tetap dipakai.
    const coba = hasil.ok ? catatCobaKatalog(konf) : null;
    return {
      ok: false, url, katalog: tersimpan, waktu: Number(konf.katalogWaktu) || 0, ms,
      coba: coba ? coba.coba : 0,
      berubah: false, sumber: tersimpan.length ? 'tersimpan' : 'kosong', status: hasil.status,
      pesan: hasil.pesan + (tersimpan.length ? ' · memakai ' + tersimpan.length + ' model tersimpan' : '')
    };
  })();
  sinkronBerjalan.set(kunci, janji);
  try { return await janji; } finally { sinkronBerjalan.delete(kunci); }
}

/**
 * Uji endpoint + kunci TANPA mengubah konfigurasi. Coba GET /models dulu
 * (murah, sekaligus katalog); kalau endpoint tak punya /models, jatuh ke
 * POST /chat/completions satu token. Tidak pernah melempar: hasil selalu objek
 * supaya TUI/CLI bisa melaporkan satu baris, bukan mati karena exception.
 */
export async function ujiModel(konf = {}, { waktu = 12000, fetch: ambil = globalThis.fetch, prompt = 'ping' } = {}) {
  const mulai = Date.now();
  const baseUrl = String(konf.baseUrl || '').replace(/\/+$/, '');
  const model = konf.model;
  const kepala = konf.apiKey ? { authorization: 'Bearer ' + konf.apiKey } : {};
  const hasil = (tambahan) => Object.assign({ ok: false, tahap: 'tidak', baseUrl, model, ms: Date.now() - mulai }, tambahan);
  if (!baseUrl) return hasil({ pesan: 'endpoint kosong' });

  let statusKatalog = 0;
  try {
    const jawab = await ambil(urlKatalog(baseUrl), { headers: kepala, signal: AbortSignal.timeout(waktu) });
    statusKatalog = jawab.status;
    if (jawab.status === 401 || jawab.status === 403) return hasil({ tahap: 'katalog', status: jawab.status, pesan: 'kunci ditolak (' + jawab.status + ')' });
    if (jawab.ok) {
      let isi = null;
      try { isi = await jawab.json(); } catch { /* katalog bukan JSON: tetap terhubung */ }
      const daftar = ((isi && (isi.data || isi.models)) || []).map((satu) => satu && (satu.id || satu.name)).filter(Boolean);
      // Katalog kosong belum membuktikan chat bisa dipakai; lanjut ke uji chat.
      if (daftar.length) return hasil({ ok: true, tahap: 'katalog', status: jawab.status, katalog: daftar, pesan: daftar.length + ' model di katalog' });
    } else if (![404, 405, 501].includes(jawab.status)) {
      // Hanya 404/405/501 yang berarti "tidak ada /models"; galat lain nyata.
      return hasil({ tahap: 'katalog', status: jawab.status, pesan: 'HTTP ' + jawab.status + ' dari ' + urlKatalog(baseUrl) });
    }
  } catch (galat) {
    const pesan = String((galat && galat.message) || galat);
    return hasil({ tahap: 'katalog', pesan: 'tidak terjangkau: ' + pesan });
  }

  try {
    const jawab = await ambil(urlChat(baseUrl), {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, kepala),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(waktu)
    });
    if (jawab.status === 401 || jawab.status === 403) return hasil({ tahap: 'chat', status: jawab.status, pesan: 'kunci ditolak (' + jawab.status + ')' });
    if (!jawab.ok) {
      const teks = await jawab.text().catch(() => '');
      return hasil({ tahap: 'chat', status: jawab.status, pesan: 'HTTP ' + jawab.status + (teks ? ': ' + teks.slice(0, 200) : '') });
    }
    // 2xx belum tentu chat completions: portal login/WAF kerap menjawab 200
    // HTML untuk semua path. Tanpa cek body, probe akan bilang OK palsu.
    let isi = null;
    try { isi = await jawab.json(); } catch {
      return hasil({ tahap: 'chat', status: jawab.status, pesan: 'HTTP ' + jawab.status + ' tetapi balasan bukan JSON (portal/login?)' });
    }
    if (isi && isi.error) {
      const pesanGalat = typeof isi.error === 'string' ? isi.error : (isi.error.message || JSON.stringify(isi.error));
      return hasil({ tahap: 'chat', status: jawab.status, pesan: 'HTTP ' + jawab.status + ' memuat error: ' + String(pesanGalat).slice(0, 200) });
    }
    if (!isi || !Array.isArray(isi.choices)) {
      return hasil({ tahap: 'chat', status: jawab.status, pesan: 'balasan JSON tanpa choices (bukan chat completions)' });
    }
    return hasil({ ok: true, tahap: 'chat', status: jawab.status, katalog: [], pesan: (statusKatalog === 200 ? 'katalog kosong' : '/models tidak tersedia (HTTP ' + statusKatalog + ')') + ', tapi /chat/completions menjawab' });
  } catch (galat) {
    return hasil({ tahap: 'chat', pesan: 'tidak terjangkau: ' + String((galat && galat.message) || galat) });
  }
}

/**
 * Uji dukungan reasoning endpoint+model aktif: satu POST kecil per tingkat
 * (max_tokens 16). Hasilnya disimpan di `config.kemampuan` supaya panggilan
 * berikutnya langsung memakai tingkat yang didukung, bukan membayar 400 lagi.
 * Bukan panggilan otomatis - hanya `sakti model reasoning` / `/effort tes`.
 */
export async function probeReasoning(konf = {}, { fetch: ambil = globalThis.fetch, waktu = 20000, tingkat = EFFORT_NAIK, onHasil } = {}) {
  const baseUrl = String(konf.baseUrl || '').replace(/\/+$/, '');
  const kepala = Object.assign({ 'content-type': 'application/json' }, konf.apiKey ? { authorization: 'Bearer ' + konf.apiKey } : {});
  const hasil = [];
  const diterima = [];
  const ditolak = [];
  let tanpaEffort = false;
  let tanpaMaxTokens = false;
  let lengkap = true;
  const kabar = (baris) => { hasil.push(baris); if (onHasil) { try { onHasil(baris); } catch { /* tampilan */ } } };
  const kirim = (badan) => ambil(urlChat(baseUrl), {
    method: 'POST', headers: kepala, body: JSON.stringify(badan), signal: AbortSignal.timeout(waktu)
  });

  if (!baseUrl) return { baseUrl, model: konf.model, hasil: [], diterima, ditolak, tanpaEffort, tanpaMaxTokens, lengkap: false, tersimpan: false, pesan: 'endpoint kosong' };

  for (const level of tingkat) {
    const badan = { model: konf.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, temperature: 0, stream: false, reasoning_effort: level };
    let jawab;
    try { jawab = await kirim(badan); }
    catch (galat) {
      lengkap = false;
      kabar({ level, status: 'galat', pesan: 'tidak terjangkau: ' + String((galat && galat.message) || galat) });
      break;
    }
    if (jawab.ok) {
      let isi = null;
      try { isi = await jawab.json(); } catch { /* katalog bukan JSON: tetap hidup */ }
      const rinci = isi && isi.usage && isi.usage.completion_tokens_details;
      const tokenPenalaran = rinci && Number.isFinite(Number(rinci.reasoning_tokens)) ? Number(rinci.reasoning_tokens) : null;
      diterima.push(level);
      kabar({ level, status: 'ok', tokenPenalaran });
      continue;
    }
    const teks = await jawab.text().catch(() => '');
    if (jawab.status === 401 || jawab.status === 403) {
      lengkap = false;
      kabar({ level, status: 'kunci ditolak', pesan: 'HTTP ' + jawab.status });
      break;
    }
    // 503 "upstream_overloaded" untuk satu nilai effort = nilai itu ditolak,
    // bukan outage - asalkan tingkat lain sudah terbukti 200.
    if (jawab.status >= 500 && diterima.length && /upstream_overloaded|provider upstream sedang overload/i.test(teks)) {
      ditolak.push(level);
      kabar({ level, status: 'ditolak', pesan: 'HTTP ' + jawab.status + ' upstream_overloaded (level lain 200)' });
      continue;
    }
    const kls = klasifikasi400(teks, badan);
    if (jawab.status === 400 && kls.soalEffort) {
      ditolak.push(level);
      if (kls.tolakField) {
        tanpaEffort = true;
        kabar({ level, status: 'ditolak', pesan: 'field reasoning_effort tidak didukung' });
        break;
      }
      kabar({ level, status: 'ditolak', pesan: kls.effortSah ? 'provider menyebut: ' + kls.effortSah.join('|') : (teks.slice(0, 160) || 'HTTP 400') });
      continue;
    }
    if (jawab.status === 400 && !kls.soalEffort && kls.soalToken && kls.tolakField) {
      // max_tokens yang ditolak, bukan reasoning: ulangi tingkat ini tanpanya.
      tanpaMaxTokens = true;
      const tanpaToken = Object.assign({}, badan);
      delete tanpaToken.max_tokens;
      let jawab2;
      try { jawab2 = await kirim(tanpaToken); }
      catch (galat) {
        lengkap = false;
        kabar({ level, status: 'galat', pesan: 'tidak terjangkau: ' + String((galat && galat.message) || galat) });
        break;
      }
      if (jawab2.ok) {
        diterima.push(level);
        kabar({ level, status: 'ok', tokenPenalaran: null, pesan: 'tanpa max_tokens' });
        continue;
      }
      lengkap = false;
      kabar({ level, status: 'galat', pesan: 'HTTP ' + jawab2.status });
      break;
    }
    lengkap = false;
    kabar({ level, status: 'galat', pesan: 'HTTP ' + jawab.status + (teks ? ': ' + teks.slice(0, 160) : '') });
    break;
  }

  // Probe yang berhenti di tengah jalan tidak boleh mengunci cache: kecuali
  // field-nya terbukti tidak didukung, hasil parsial tidak disimpan.
  const tersimpan = Boolean(konf.model) && (lengkap || tanpaEffort);
  if (tersimpan) {
    simpanKemampuan(konf, {
      sumber: 'probe',
      effortSah: diterima,
      effortDitolak: ditolak,
      tanpaEffort,
      tanpaMaxTokens
    });
  }
  return { baseUrl, model: konf.model, hasil, diterima, ditolak, tanpaEffort, tanpaMaxTokens, lengkap, tersimpan };
}

/** Putus jaringan / HTTP 429 / 5xx: layak dicoba ulang. `potong` = sebagian
    jawaban sudah terkirim, jadi mengulang akan menduplikasi teks. */
export class GalatJaringan extends GalatModel {
  constructor(pesan, { potong = false } = {}) {
    super(pesan);
    this.name = 'GalatJaringan';
    this.potong = potong;
  }
}

/** Jeda menyambung ulang: 0.4s, 0.8s, 1.6s, 3.2s, maks 8s. */
const jedaUlang = (n) => new Promise((selesai) => setTimeout(selesai, Math.min(8000, 400 * 2 ** (n - 1))));

/** Satu percobaan panggilan model. Mengembalikan {content, toolCalls, usage}. */
/**
 /** Penanda promosi/gateway yang kadang ditempel ke akhir jawaban model. */
 const POLA_GATEWAY = /^[ \t]*(?:🛡\uFE0F?\s*)?Warning\b[^\n]*(?:key ini resmi|IkonaOniAI)[^\n]*$/gim;

 /** Buang baris promosi gateway dari jawaban akhir. */
 export function bersihkanPesanGateway(teks) {
   return String(teks == null ? '' : teks)
     .replace(POLA_GATEWAY, '')
     .replace(/\n{3,}/g, '\n\n')
     .trimEnd();
 }

 /**
  * Saring delta streaming tanpa menahan seluruh jawaban. Simpan sedikit ekor
  * supaya penanda yang terbelah antar-chunk tidak sempat tercetak.
  */
 export function saringDeltaGateway() {
   let tunda = '';
   let diblokir = false;
   const penanda = /🛡|key ini resmi|Warning\s*[|:]\s*key/i;
   return {
     dorong(teks, emit) {
       if (diblokir || !teks) return;
       tunda += String(teks);
       const pos = tunda.search(penanda);
       if (pos >= 0) {
         const aman = tunda.slice(0, pos);
         if (aman) emit(aman);
         tunda = '';
         diblokir = true;
         return;
       }
       const simpan = 64;
       if (tunda.length > simpan) {
         emit(tunda.slice(0, -simpan));
         tunda = tunda.slice(-simpan);
       }
     },
     selesai(emit) {
       if (!diblokir && tunda) emit(tunda);
       tunda = '';
     }
   };
 }

 /** Potongan penalaran (thinking) dari satu delta SSE. Provider berbeda-beda:
 * DeepSeek `reasoning_content`, OpenRouter `reasoning`, sebagian proksi
 * `thinking`/`analysis`, dan kadang berbentuk objek `{text}`. Murni - dipakai
 * jalur stream maupun non-stream, dan diuji tanpa jaringan.
 */
export function ambilNalar(delta = {}) {
  if (!delta || typeof delta !== 'object') return '';
  for (const kunci of ['reasoning_content', 'reasoning', 'thinking', 'analysis']) {
    const nilai = delta[kunci];
    if (typeof nilai === 'string' && nilai) return nilai;
    if (nilai && typeof nilai === 'object') {
      const teks = nilai.text || nilai.content || nilai.thinking;
      if (typeof teks === 'string' && teks) return teks;
    }
  }
  return '';
}

export async function sekali({ konf, messages, tools, stream = true, onDelta, onNalar, waktu = 240000, suhu = 0.3, sinyal, _ulang = false, _tanpaUsage = false }) {
  const badan = { model: konf.model, messages, stream };
  // Minta pemakaian token pada stream: tanpa ini /biaya dan bilah status
  // buta di jalur streaming (usage tidak pernah dikirim). Endpoint lama yang
  // menolak field ini diulang tanpa `_tanpaUsage`.
  if (stream && !_tanpaUsage) badan.stream_options = { include_usage: true };
  if (tools && tools.length) { badan.tools = tools; badan.tool_choice = 'auto'; }
  if (suhu != null) badan.temperature = suhu;
  // Kemampuan endpoint+model yang sudah terbukti (dari 400 sebelumnya atau
  // probe): effort diturunkan ke tingkat yang didukung, max_tokens dipotong.
  const kem = kemampuanModel(konf);
  const effortDiminta = normalEffort(konf.effort);
  const effort = effortAman(effortDiminta, kem);
  if (effort && effort !== 'none') badan.reasoning_effort = effort;
  // 0 / kosong = serahkan ke server. Angka positif = batas keluaran eksplisit.
  const batasToken = maxTokensAman(konf.maxTokens, kem);
  if (Number.isFinite(batasToken) && batasToken > 0) badan.max_tokens = Math.floor(batasToken);

  let balas;
  try {
    balas = await fetch(urlChat(konf.baseUrl), {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, konf.apiKey ? { authorization: 'Bearer ' + konf.apiKey } : {}),
      body: JSON.stringify(badan),
      // keepalive: satu giliran bisa berlangsung menit-menit; tanpa ini koneksi
      // HTTP yang menganggur panjang diputus perantara (gejala: "model tidak
      // terjangkau" di langkah ke-N, bukan di awal).
      keepalive: true,
      signal: sinyal ? AbortSignal.any([AbortSignal.timeout(waktu), sinyal]) : AbortSignal.timeout(waktu)
    });
  } catch (galat) {
    if (sinyal && sinyal.aborted) throw new GalatBatal('dibatalkan');
    throw new GalatJaringan('model tidak terjangkau di ' + konf.baseUrl + ' (' + String((galat && galat.message) || galat) + ')');
  }
  if (balas.status === 401 || balas.status === 403) throw new GalatModel('kunci model ditolak (' + balas.status + '): isi SAKTI_MODEL_KEY atau ' + konf.berkas);
  if (!balas.ok) {
    const teks = await balas.text().catch(() => '');
    const pesan = 'model menjawab HTTP ' + balas.status + ': ' + teks.slice(0, 300);
    // Endpoint balas 400 untuk reasoning_effort / max_tokens. Jangan gagalkan
    // giliran: catat kemampuan yang terbukti (per endpoint+model), lalu ulangi
    // SEKALI dengan nilai yang sudah dikoreksi. Kalau pesan tidak cukup jelas,
    // buang kedua field untuk percobaan ini saja - jangan mengunci cache dengan
    // tebakan. `_ulang` mencegah piutaran 400 tanpa akhir.
    if (balas.status === 400 && !_ulang) {
      // Endpoint lama menolak `stream_options`: ulang sekali tanpa field itu
      // (usage lalu diperkirakan, seperti sebelum 3.33.6).
      if (badan.stream_options && /stream_options/i.test(teks)) {
        return sekali({ konf, messages, tools, stream, onDelta, onNalar, waktu, suhu, sinyal, _ulang: true, _tanpaUsage: true });
      }
      const kls = klasifikasi400(teks, badan);
      const catat = {};
      if (kls.soalEffort) {
        if (kls.effortSah) catat.effortSah = kls.effortSah;
        else if (kls.tolakField) catat.tanpaEffort = true;
        else catat.effortDitolak = [badan.reasoning_effort];
      }
      if (kls.soalToken) {
        if (kls.batasToken > 0) catat.maxTokensMaks = kls.batasToken;
        else if (kls.tolakField) catat.tanpaMaxTokens = true;
      }
      if (Object.keys(catat).length) {
        catat.sumber = '400';
        simpanKemampuan(konf, catat);
      }
      const kemBaru = Object.keys(catat).length ? kemampuanModel(konf) : kem;
      const effortBaru = Object.keys(catat).length ? effortAman(effortDiminta, kemBaru) : 'none';
      const tokenBaru = Object.keys(catat).length ? maxTokensAman(Number(konf.maxTokens) || 0, kemBaru) : 0;
      // Endpoint yang pesannya hanya menyalahkan SATU knob kadang menolak knob
      // lain juga. Kalau dukungan effort belum terbukti, jangan pertahankan
      // effort saat mengulang - percobaan kedua harus benar-benar bersih.
      const sentuhEffort = Boolean(catat.effortSah || catat.effortDitolak || catat.tanpaEffort);
      const sokongEffort = Array.isArray(kemBaru.effortSah) && kemBaru.effortSah.includes(effortBaru);
      const effortRetry = sentuhEffort || sokongEffort ? effortBaru : 'none';
      const sama = effortRetry === (badan.reasoning_effort || '') && tokenBaru === Number(badan.max_tokens || 0);
      const adaKnob = Boolean(badan.reasoning_effort || badan.max_tokens);
      if (!sama && adaKnob) {
        return sekali({
          konf: Object.assign({}, konf, { effort: effortRetry || 'none', maxTokens: tokenBaru }),
          messages, tools, stream, onDelta, onNalar, waktu, suhu, sinyal, _ulang: true
        });
      }
      if (adaKnob) {
        // Cache tidak mengubah payload (mis. daftar izin menyebut nilai yang
        // sama): jangan ulang payload identik, buang knob untuk percobaan ini.
        return sekali({
          konf: Object.assign({}, konf, { effort: 'none', maxTokens: 0 }),
          messages, tools, stream, onDelta, onNalar, waktu, suhu, sinyal, _ulang: true
        });
      }
    }
    // 503 berbody `upstream_overloaded` sering BUKAN overload: provider menolak
    // nilai reasoning_effort tertentu (terbukti: DeepSeek/GLM menolak `ultra`,
    // level lain 200 di endpoint yang sama). Turunkan SEKALI ke tingkat di
    // bawahnya; cache hanya ditulis kalau penurunannya benar-benar berhasil.
    // Tanpa effort di payload, 503 tetap dianggap overload nyata dan di-retry.
    // Sebagian proksi membalas 503 `service_busy`/`layanan sedang sibuk` bukan
    // karena overload, melainkan karena tingkat effort tidak didukung. Jangan
    // hanya mengenali teks `upstream_overloaded`: endpoint ini membalas JSON
    // `{"type":"error","error":{"code":"service_busy"}}` untuk `ultra`, padahal
    // `high`/`medium`/`low` 200. Tanpa perluasan ini, 4 percobaan identik
    // berakhir "menyerah" padahal satu tingkat di bawah langsung berhasil.
    if (balas.status >= 500 && badan.reasoning_effort && !_ulang
      && /upstream_overloaded|overload|service_busy|layanan sedang sibuk|\bbusy\b|reasoning[_ -]?effort/i.test(teks)) {
      const level = badan.reasoning_effort;
      const kemTurun = Object.assign({}, kem, { effortDitolak: [...(kem.effortDitolak || []), level] });
      const turun = effortAman(effortDiminta, kemTurun);
      if (turun !== level) {
        const hasil = await sekali({
          konf: Object.assign({}, konf, { effort: turun || 'none' }),
          messages, tools, stream, onDelta, onNalar, waktu, suhu, sinyal, _ulang: true
        });
        simpanKemampuan(konf, { effortDitolak: [level], sumber: '503' });
        return hasil;
      }
    }
    // 429 dan 5xx (termasuk 502/503 dari proksi) biasanya sementara.
    if (balas.status === 429 || balas.status >= 500) throw new GalatJaringan(pesan);
    throw new GalatModel(pesan);
  }

  if (!stream) {
    let data;
    try { data = await balas.json(); } catch (galat) {
      if (sinyal && sinyal.aborted) throw new GalatBatal('dibatalkan');
      throw new GalatJaringan('balasan terputus saat dibaca (' + String((galat && galat.message) || galat) + ')');
    }
    const pilihan = (data.choices && data.choices[0]) || {};
    const pesan = pilihan.message || {};
    // Non-stream juga bisa membawa penalaran utuh di `message.reasoning_content`.
    const nalar = ambilNalar(pesan);
    return { content: bersihkanPesanGateway(pesan.content || ''), toolCalls: normalPanggilan(pesan.tool_calls), usage: data.usage || null, nalar };
  }

  let isi = '';
  let nalar = '';
  const saring = typeof onDelta === 'function' ? saringDeltaGateway() : null;
  const kumpul = [];
  let usage = null;
  let galatStream = '';
  let selesaiAlasan = '';
  const pembaca = balas.body.getReader();
  const pengurai = new TextDecoder();
  let sisa = '';

  const proses = (baris) => {
    const teks = baris.trim();
    if (!teks.startsWith('data:')) return false;
    const isiData = teks.slice(5).trim();
    if (isiData === '[DONE]') return true;
    let paket;
    try { paket = JSON.parse(isiData); } catch { return false; }
    if (paket.usage) usage = paket.usage;
    // Sebagian proksi menutup stream dengan amplop error, bukan memutus koneksi.
    // Tanpa ini jawaban separuh dikembalikan sebagai sukses dan tidak di-retry.
    if (paket.error) {
      const isiGalat = paket.error && (paket.error.message || paket.error.code || paket.error.type);
      galatStream = 'stream berhenti: ' + String(isiGalat || JSON.stringify(paket.error)).slice(0, 300);
      return true;
    }
    const pilihan = (paket.choices && paket.choices[0]) || {};
    if (pilihan.finish_reason) selesaiAlasan = String(pilihan.finish_reason);
    const delta = pilihan.delta || {};
    if (delta.content) { isi += delta.content; if (saring) saring.dorong(delta.content, onDelta); }
    // Penalaran tidak pernah masuk `content`/riwayat: hanya ditampilkan (atau
    // disembunyikan) dan dihitung panjangnya untuk label giliran.
    const potongNalar = ambilNalar(delta);
    if (potongNalar) { nalar += potongNalar; if (onNalar) onNalar(potongNalar); }
    for (const bagian of delta.tool_calls || []) {
      // Proksi tertentu hanya mengirim `index` pada fragmen pertama. Fragmen
      // argumen sesudahnya harus MENEMPEL ke panggilan terakhir, bukan membuat
      // entri baru dengan nama kosong (argumen JSON jadi terpotong).
      let pos;
      if (Number.isInteger(bagian.index)) pos = bagian.index;
      else if (kumpul.length && !bagian.id) pos = kumpul.length - 1;
      else pos = kumpul.length;
      if (!kumpul[pos]) kumpul[pos] = { id: '', name: '', arguments: '' };
      if (bagian.id) kumpul[pos].id = bagian.id;
      const fungsi = bagian.function || {};
      if (fungsi.name) kumpul[pos].name += fungsi.name;
      if (fungsi.arguments) kumpul[pos].arguments += fungsi.arguments;
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await pembaca.read();
      if (done) break;
      sisa += pengurai.decode(value, { stream: true });
      const barisBaris = sisa.split('\n');
      sisa = barisBaris.pop();
      let selesai = false;
      for (const baris of barisBaris) {
        if (proses(baris)) { selesai = true; sisa = ''; break; }
      }
      if (selesai) { pembaca.cancel().catch(() => {}); break; }
    }
  } catch (galat) {
    if (sinyal && sinyal.aborted) throw new GalatBatal('dibatalkan');
    // Sudah ada yang tercetak? Jangan ulang, teksnya akan dobel.
    throw new GalatJaringan('koneksi putus di tengah jawaban (' + isi.length + ' karakter masuk: ' + String((galat && galat.message) || galat) + ')', { potong: isi.length > 0 || kumpul.length > 0 });
  }
  // Flush TextDecoder: byte terakhir dari karakter multi-byte bisa tertahan di
  // buffer internal kalau stream berakhir tepat di tengah codepoint.
  sisa += pengurai.decode();
  if (sisa) proses(sisa);
  if (saring) saring.selesai(onDelta);
  if (galatStream) throw new GalatJaringan(galatStream, { potong: isi.length > 0 || kumpul.length > 0 });

  const toolCalls = kumpul.filter((satu) => satu && satu.name);
  let content = bersihkanPesanGateway(isi);
  // Jawaban yang berhenti karena batas token TIDAK boleh tampak selesai.
  if (!toolCalls.length && content && selesaiAlasan === 'length') content += '\n[...jawaban terpotong: batas token]';
  if (!toolCalls.length && content && selesaiAlasan === 'content_filter') content += '\n[...jawaban dihentikan filter penyedia]';
  return { content, toolCalls, usage, nalar, selesai: selesaiAlasan };
}

/**
 * Satu panggilan model, dengan penyambungan ulang otomatis saat koneksi putus
 * (galat jaringan, HTTP 429, 5xx). Percobaan `coba` kali (bawaan 4, env
 * SAKTI_MODEL_COBA) dengan jeda berlipat 0.4s..8s. Pengulangan dilewati kalau
 * sebagian jawaban sudah dikirim ke pemanggil - supaya tidak dobel cetak.
 *
 * Kalau percobaan habis, model berikutnya di `konf.fallbacks` dicoba dengan
 * jatah percobaan sendiri; hasilnya membawa `cadangan` (nama model pengganti)
 * supaya pemanggil bisa melaporkannya.
 */
export async function obrol({ coba = Number(process.env.SAKTI_MODEL_COBA) || 4, onStatus, ...opsi }) {
  const jumlah = Math.max(1, Math.round(Number(coba) || 1));
  const utama = opsi.konf || {};
  const rantai = [utama, ...(utama.fallbacks || []).map((satu) => Object.assign({}, utama, satu, {
    // Cadangan tanpa kunci sendiri mewarisi kunci utama. Dulu `apiKey: ''`
    // menimpa kunci utama sehingga endpoint cadangan dijawab 401.
    apiKey: String((satu && satu.apiKey) || utama.apiKey || '')
  }))];
  let terakhir = null;
  const kabar = (teks) => { if (onStatus) { try { onStatus(teks); } catch { /* abaikan */ } } };

  for (let t = 0; t < rantai.length; t += 1) {
    const konf = rantai[t];
    for (let n = 1; n <= jumlah; n += 1) {
      try {
        const hasil = await sekali(Object.assign({}, opsi, { konf }));
        return Object.assign({}, hasil, { konf, cadangan: t > 0 ? konf.model : null });
      } catch (galat) {
        // Putus jaringan di tengah jawaban: ulangi hanya kalau belum ada yang
        // tercetak. Galat model (404 model tidak dikenal, 400 format) TIDAK
        // diulang di endpoint yang sama, tetapi model CADANGAN tetap dicoba -
        // dulu rantai fallback mati justru pada kegagalan yang paling umum.
        if (galat instanceof GalatJaringan && !galat.potong) {
          terakhir = galat;
          if (n >= jumlah) break;
          kabar('koneksi terputus - menyambung ulang ' + n + '/' + (jumlah - 1));
          await jedaUlang(n);
          if (opsi.sinyal && opsi.sinyal.aborted) throw new GalatBatal('dibatalkan');
          continue;
        }
        if (galat instanceof GalatModel && !(galat instanceof GalatJaringan) && rantai[t + 1]) {
          terakhir = galat;
          break;
        }
        throw galat;
      }
    }
    const berikut = rantai[t + 1];
    if (berikut) kabar(konf.model + ' menyerah - pindah ke cadangan ' + berikut.model);
  }
  throw new GalatModel(String((terakhir && terakhir.message) || 'gagal') + ' [menyerah setelah ' + jumlah + ' percobaan' + (rantai.length > 1 ? ' × ' + rantai.length + ' model' : '') + ']');
}

function normalPanggilan(daftar) {
  return (daftar || []).map((satu) => ({
    id: satu.id || '',
    name: (satu.function && satu.function.name) || '',
    arguments: (satu.function && satu.function.arguments) || '{}'
  })).filter((satu) => satu.name);
}