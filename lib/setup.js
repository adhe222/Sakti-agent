/* global AbortSignal */
// Setup awal: endpoint + API key + model + gateway chat.
//
// Dipisah dari sakti.js supaya bisa diuji tanpa terminal: semua pertanyaan
// lewat `tanya()` yang disuntikkan, semua cetakan lewat `cetak()`. Yang murni
// (validasi URL, susunan config, daftar preset) tidak menyentuh I/O sama sekali.
//
// Aturan yang dipegang:
//  - URL dinormalisasi lewat rapikanUrl (satu jalur dengan /pengaturan), lalu
//    `/v1` ditambahkan bila orang mengetik host saja - bukan menebak path lain.
//  - Endpoint kustom selalu boleh; preset hanya jalan pintas.
//  - API key boleh kosong untuk server lokal, tapi diberi tahu.
//  - Gateway Telegram butuh token; WhatsApp TIDAK punya kanal native di sini -
//    yang disiapkan adalah webhook generik + catatan bridge. Jangan menjanjikan
//    yang tidak ada.

import { randomBytes } from 'node:crypto';
import { rapikanUrl } from './pengaturan.js';

export const ENDPOINT_PRESET = [
  { nama: 'OpenAI', url: 'https://api.openai.com/v1' },
  { nama: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { nama: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { nama: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { nama: 'Together', url: 'https://api.together.xyz/v1' },
  { nama: 'Mistral', url: 'https://api.mistral.ai/v1' },
  { nama: 'Ollama (lokal)', url: 'http://127.0.0.1:11434/v1' },
  { nama: 'LM Studio (lokal)', url: 'http://127.0.0.1:1234/v1' }
];

export const GATEWAY_PRESET = [
  { jenis: 'none', nama: 'tanpa gateway', ket: 'pakai sakti di terminal saja' },
  { jenis: 'telegram', nama: 'Telegram', ket: 'butuh bot token dari @BotFather', butuhToken: true },
  { jenis: 'whatsapp', nama: 'WhatsApp', ket: 'native via Baileys (pairing QR, `sakti wa`)' },
  { jenis: 'generik', nama: 'Webhook generik', ket: 'POST {teks, dari} ke /kanal/generik' }
];

/**
 * URL akhir untuk config: normalisasi + `/v1` bila hanya host (bukan menebak
 * provider). Contoh: `api.deepseek.com` -> `https://api.deepseek.com/v1`.
 */
export function endpointAkhir(url) {
  const mentah = String(url == null ? '' : url).trim();
  if (!mentah) throw new Error('url endpoint kosong');
  let bersih = rapikanUrl(mentah);
  const u = new URL(bersih);
  const jalur = u.pathname.replace(/\/+$/, '');
  if (!jalur) bersih = bersih.replace(/\/+$/, '') + '/v1';
  return bersih;
}

/**
 * Susun nilai config dari jawaban setup. Melempar untuk isian yang tidak sah
 * (dengan pesan yang bisa dibaca), supaya mode interaktif bisa mengulang.
 */
export function susunKonfig({ url, key = '', model = '', gateway = {}, indikator = '', profilAlat = '', fallbacks = [] } = {}) {
  const catatan = [];
  const baseUrl = endpointAkhir(url);
  const apiKey = String(key == null ? '' : key).trim();
  if (!apiKey) catatan.push('tanpa API key: hanya cocok untuk endpoint lokal / tanpa auth');
  const namaModel = String(model == null ? '' : model).trim();
  if (!namaModel) throw new Error('model kosong - isi id model (contoh: gpt-4o-mini, deepseek-chat)');
  const jenis = String(gateway.jenis || 'none').toLowerCase();
  if (!GATEWAY_PRESET.some((g) => g.jenis === jenis)) throw new Error('gateway tidak dikenal: ' + jenis);
  // `kanal: null` WAJIT ditulis saat "tanpa gateway": simpanModel melakukan
  // merge, jadi tanpa ini gateway lama (token ikut) tetap hidup setelah user
  // memilih mematikannya.
  const nilai = { baseUrl, apiKey, model: namaModel, kanal: null };
  const ind = String(indikator || '').trim().toLowerCase();
  if (ind) nilai.indikator = ind;
  const cadangan = (Array.isArray(fallbacks) ? fallbacks : String(fallbacks || '').split(','))
    .map((satu) => String(satu == null ? '' : satu).trim()).filter(Boolean)
    .filter((satu) => satu !== namaModel);
  if (cadangan.length) {
    nilai.fallbacks = cadangan.map((satu) => ({ baseUrl, model: satu, apiKey: String(key || '') }));
  }
  const profil = String(profilAlat || '').trim().toLowerCase();
  if (profil) {
    if (!['ringan', 'standar', 'penuh'].includes(profil)) throw new Error('profil alat tidak dikenal: ' + profil);
    nilai.profilAlat = profil;
  }

  if (jenis !== 'none') {
    // Token diperiksa dulu: pesan "butuh token" lebih berguna daripada keluhan
    // port saat pengguna baru memilih Telegram.
    const token = String(gateway.token || '').trim();
    if (jenis === 'telegram' && !token) throw new Error('Telegram butuh bot token (dari @BotFather)');
    // Rahasia webhook BUKAN bot token: ini yang dikirim Telegram di header
    // X-Telegram-Bot-Api-Secret-Token. Dibuat otomatis supaya webhook tidak
    // bisa dipalsukan siapa pun yang tahu URL port.
    const rahasia = String(gateway.rahasia || '').trim()
      || (jenis === 'telegram' ? randomBytes(16).toString('hex') : '');
    const port = Number(gateway.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('port gateway tidak sah: ' + gateway.port);
    const host = String(gateway.host || '127.0.0.1').trim();
    if (!host) throw new Error('host gateway kosong');
    const serve = String(gateway.serve || 'http://127.0.0.1:4317').trim();
    nilai.kanal = { jenis, host, port, serve, token, rahasia };
    if (jenis === 'whatsapp') {
      catatan.push('WhatsApp native: jalankan `sakti wa` lalu scan QR (auth di ~/.sakti-cli/wa-auth). Butuh `npm install baileys qrcode-terminal`.');
      catatan.push('Alternatif tanpa dependensi: bridge generik POST {teks,dari} ke http://' + host + ':' + port + '/kanal/generik');
    }
    if (jenis === 'telegram') {
      catatan.push('set webhook Telegram: secret_token=' + rahasia + ' · URL https://<host-publik>:' + port + '/kanal/telegram');
      catatan.push('bot token hanya dipakai mengirim balasan; header rahasia di atas yang memverifikasi update masuk');
    }
  }
  return { nilai, catatan };
}

/** Ambil daftar model dari /models. Gagal = array kosong, bukan melempar. */
export async function ambilKatalog({ url, key = '', fetchImpl = globalThis.fetch, waktu = 8000 } = {}) {
  const dasar = String(url || '').replace(/\/+$/, '');
  if (!dasar) return [];
  try {
    const res = await fetchImpl(dasar + '/models', {
      headers: key ? { authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(waktu)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const daftar = Array.isArray(data && data.data) ? data.data : Array.isArray(data) ? data : [];
    return daftar.map((satu) => String((satu && (satu.id || satu.name)) || '')).filter(Boolean).slice(0, 40);
  } catch { return []; }
}

/** Apakah config ini belum pernah diisi endpoint/kunci? Dipakai auto-setup. */
export function perluSetup(konf = {}, { adaBerkas = false } = {}) {
  if (adaBerkas) return false;                       // sudah pernah setup/ubah
  if (konf.apiKey) return false;
  if (process.env.SAKTI_MODEL_KEY || process.env.SAKTI_MODEL_URL) return false;
  return true;
}

const angkaPilihan = (teks, maks, bawaan) => {
  const n = Number(String(teks || '').trim());
  if (!Number.isFinite(n) || n < 1 || n > maks) return bawaan;
  return Math.floor(n);
};

/**
 * Wizard interaktif. Mengembalikan { nilai, catatan } atau null bila dibatalkan
 * (Ctrl+C / jawaban kosong pada pertanyaan wajib berulang 3x).
 */
export async function setupInteraktif({ tanya, cetak = () => {}, konfAwal = {}, fetchImpl } = {}) {
  if (typeof tanya !== 'function') throw new Error('setup butuh fungsi tanya()');

  cetak('Setup sakti - endpoint, kunci, model, gateway.');
  cetak('Enter memakai nilai dalam [kurung]. Ctrl+C membatalkan.');
  cetak('');

  // 1. Endpoint: preset atau kustom.
  cetak('Endpoint API (kompatibel OpenAI):');
  ENDPOINT_PRESET.forEach((satu, i) => cetak('  ' + (i + 1) + '. ' + satu.nama.padEnd(14) + ' ' + satu.url));
  cetak('  ' + (ENDPOINT_PRESET.length + 1) + '. lain (URL kustom)');
  // `http://localhost:3000/v1` hanyalah tebakan bawaan konfigModel, bukan pilihan
  // pengguna: jangan dijadikan "bawaan" di menu (dulu menunjuk nomor 9 = kustom).
  const urlTersimpan = String(konfAwal.baseUrl || '');
  const urlBawaan = /^https?:\/\/localhost:3000\/v1\/?$/.test(urlTersimpan) ? '' : urlTersimpan;
  const indeksPreset = urlBawaan ? ENDPOINT_PRESET.findIndex((s) => s.url === urlBawaan) + 1 : 0;
  const bawaanPilih = indeksPreset > 0 ? String(indeksPreset) : (urlBawaan ? String(ENDPOINT_PRESET.length + 1) : '1');
  const pilih = angkaPilihan(await tanya('pilih nomor', { bawaan: bawaanPilih }), ENDPOINT_PRESET.length + 1, Number(bawaanPilih));
  let url = '';
  if (pilih === ENDPOINT_PRESET.length + 1) {
    // Validasi di tempat: URL jelek langsung ditanya lagi, bukan menggagalkan
    // seluruh wizard setelah semua pertanyaan dijawab.
    for (let coba = 0; coba < 3 && !url; coba += 1) {
      const jawab = await tanya('URL endpoint', { bawaan: urlBawaan });
      try { url = endpointAkhir(jawab); } catch (galat) { cetak('  ! ' + String((galat && galat.message) || galat)); }
    }
    if (!url) throw new Error('URL endpoint tidak sah setelah 3 percobaan');
  } else {
    url = ENDPOINT_PRESET[pilih - 1].url;
    cetak('  -> ' + url);
  }

  // 2. API key (disembunyikan di terminal sungguhan).
  const key = await tanya('API key', { bawaan: konfAwal.apiKey || '', rahasia: true });

  // 3. Model: coba katalog endpoint ini dulu.
  cetak('');
  cetak('Mengambil daftar model dari ' + String(url).replace(/\/+$/, '') + '/models ...');
  let katalog = [];
  try { katalog = await ambilKatalog({ url: endpointAkhir(url), key, fetchImpl }); } catch { katalog = []; }
  let model;
  if (katalog.length) {
    cetak('Model tersedia (' + katalog.length + '):');
    katalog.slice(0, 20).forEach((nama, i) => cetak('  ' + (i + 1) + '. ' + nama));
    if (katalog.length > 20) cetak('  … ' + (katalog.length - 20) + ' lagi');
    const pilihModel = await tanya('pilih nomor model (atau ketik id)', { bawaan: '1' });
    const nomor = Number(pilihModel);
    model = Number.isFinite(nomor) && nomor >= 1 && nomor <= Math.min(20, katalog.length)
      ? katalog[Math.floor(nomor) - 1]
      : String(pilihModel || '').trim() || katalog[0];
  } else {
    cetak('Katalog tidak terbaca (endpoint mati / butuh kunci). Isi id model manual.');
    // Bawaan KOSONG: pengguna wajib mengetik id model sendiri (pasang pertama
    // tidak boleh menebak model seperti 'Gratis').
    model = await tanya('id model', { bawaan: konfAwal.model || '' });
    if (!String(model || '').trim()) throw new Error('model kosong - isi id model (contoh: gpt-4o-mini, deepseek-chat)');
  }

  // 3b. Model cadangan: satu endpoint yang sama, dipakai otomatis saat model
  // utama menyerah (HTTP 500/429 berulang). Kosong = tanpa cadangan.
  cetak('');
  const cadanganTeks = await tanya('model cadangan, pisah koma (Enter = tanpa)', { bawaan: '' });
  const fallbacks = String(cadanganTeks || '').split(',').map((satu) => satu.trim()).filter(Boolean);

  // 4. Profil alat: hemat token skema untuk mesin/mode yang tidak butuh semua.
  cetak('');
  cetak('Profil alat (berapa skema alat dikirim ke model tiap panggilan):');
  cetak('  1. penuh    semua alat · konteks besar (bawaan)');
  cetak('  2. standar  kerja sehari-hari tanpa media/berat · lebih hemat');
  cetak('  3. ringan   baca/tulis/jalan saja · paling hemat');
  const pilihProfil = angkaPilihan(await tanya('pilih nomor', { bawaan: '1' }), 3, 1);
  const profilAlat = ['penuh', 'standar', 'ringan'][pilihProfil - 1];

  // 5. Gateway chat.
  cetak('');
  cetak('Gateway chat (opsional):');
  GATEWAY_PRESET.forEach((satu, i) => cetak('  ' + (i + 1) + '. ' + satu.nama.padEnd(20) + ' ' + satu.ket));
  const pilihGateway = angkaPilihan(await tanya('pilih nomor', { bawaan: '1' }), GATEWAY_PRESET.length, 1);
  const g = GATEWAY_PRESET[pilihGateway - 1];
  const gateway = { jenis: g.jenis };
  if (g.jenis !== 'none') {
    gateway.port = Number(await tanya('port kanal', { bawaan: '4318' })) || 4318;
    gateway.host = (await tanya('host kanal', { bawaan: '127.0.0.1' })) || '127.0.0.1';
    gateway.serve = (await tanya('alamat sakti serve', { bawaan: 'http://127.0.0.1:4317' })) || 'http://127.0.0.1:4317';
    if (g.butuhToken) gateway.token = await tanya('bot token', { bawaan: '', rahasia: true });
  }

  const { nilai, catatan } = susunKonfig({ url, key, model, gateway, profilAlat: profilAlat === 'penuh' ? '' : profilAlat, fallbacks });
  return { nilai, catatan };
}

/** Ringkasan hasil setup - kunci selalu disamarkan. */
export function ringkasSetup(nilai = {}) {
  const baris = [
    'endpoint : ' + (nilai.baseUrl || '-'),
    'model    : ' + (nilai.model || '-'),
    'api key  : ' + (nilai.apiKey ? String(nilai.apiKey).slice(0, 4) + '…' + String(nilai.apiKey).slice(-4) : '(kosong)')
  ];
  if (nilai.kanal) {
    baris.push('gateway  : ' + nilai.kanal.jenis + ' · ' + nilai.kanal.host + ':' + nilai.kanal.port);
  } else {
    baris.push('gateway  : tidak dipakai');
  }
  return baris.join('\n');
}
