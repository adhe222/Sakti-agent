// `sakti kanal` - gateway chat multi-kanal (OpenClaw minimal).
//
// Satu port HTTP yang menerima update gaya Telegram (atau JSON generik
// {teks, dari}) lalu meneruskannya ke `sakti serve` /chat yang sudah ada.
// Tidak ada wiring agen baru di sini: satu jalur, satu sumber kebenaran.
//
//   POST /kanal/telegram   badan = update Telegram apa adanya
//   POST /kanal/generik    badan = {teks, dari, sesi?}
//   GET  /sehat
//
// Balasan: `kirim()` bisa diganti (uji memakai perekam). Bawaannya Telegram
// sendMessage bila token ada, kalau tidak -> stdout.
//
// ponytail: tanpa antrean/retry dan tanpa verifikasi tanda tangan. Tambah
// antrean persisten kalau kanal ini dipakai untuk lalu lintas nyata.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bacaBadan, samaRahasia } from './http-util.js';

// --- Berkas/media ke chat --------------------------------------------------
// Sumber: hasil alat `kirim_berkas` (baris `SAKTI_BERKAS {json}`) dan cadangan
// penanda `[[berkas:/jalur/absolut]]` di jawaban akhir. Dipakai WA dan Telegram.
const MIME_EKST = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip'
};
export const BERKAS_KANAL_MAKS_BAWAAN = 50 * 1024 * 1024;
const RE_PENANDA = /\[\[berkas:([^\]\n]+)\]\]/g;

/** Tebak MIME dari ekstensi. */
export function tebakMime(nama) {
  const ext = path.extname(String(nama || '')).slice(1).toLowerCase();
  return MIME_EKST[ext] || 'application/octet-stream';
}

function normalBerkas(info) {
  if (!info || typeof info !== 'object') return null;
  const jalur = String(info.jalur || '').trim();
  if (!jalur || !path.isAbsolute(jalur)) return null;
  const nama = String(info.nama || '').trim() || path.basename(jalur);
  return {
    jalur,
    nama,
    mime: String(info.mime || '').trim() || tebakMime(nama),
    ukuran: Number(info.ukuran) || 0,
    keterangan: info.keterangan == null ? '' : String(info.keterangan)
  };
}

/** Ambil semua `SAKTI_BERKAS {json}` dari teks bebas (hasil alat). */
export function berkasDariTeks(teks) {
  const keluar = [];
  for (const baris of String(teks || '').split('\n')) {
    const m = /^\s*SAKTI_BERKAS\s+(\{.*\})\s*$/.exec(baris);
    if (!m) continue;
    let info;
    try { info = JSON.parse(m[1]); } catch { continue; }
    const satu = normalBerkas(info);
    if (satu) keluar.push(satu);
  }
  return keluar;
}

/** Cabut penanda `[[berkas:/abs]]` dari jawaban. -> {teks, berkas} */
export function cabutPenandaBerkas(teks) {
  const berkas = [];
  const bersih = String(teks || '').replace(RE_PENANDA, (_, j) => {
    const satu = normalBerkas({ jalur: j.trim() });
    if (satu) berkas.push(satu);
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { teks: bersih, berkas };
}

function dedupBerkas(daftar) {
  const lihat = new Map();
  for (const b of daftar) {
    const lama = lihat.get(b.jalur);
    // Info dari kirim_berkas (punya keterangan/ukuran) menang atas penanda polos.
    if (!lama || (!lama.keterangan && b.keterangan)) lihat.set(b.jalur, lama ? { ...lama, ...b } : b);
  }
  return [...lihat.values()];
}

/** NDJSON `serve /chat` -> {balas, galat, berkas}. Fungsi murni. */
export function ambilBerkasNdjson(teks) {
  let balas = '';
  const galat = [];
  const berkas = [];
  for (const baris of String(teks || '').split('\n')) {
    if (!baris.trim()) continue;
    let satu;
    try { satu = JSON.parse(baris); } catch { continue; }
    if (!satu || typeof satu !== 'object') continue;
    if (satu.tipe === 'selesai') balas = String(satu.teks || '');
    else if (satu.tipe === 'galat') galat.push(String(satu.teks || ''));
    else if (satu.tipe === 'hasil' && satu.nama === 'kirim_berkas') berkas.push(...berkasDariTeks(satu.teks));
  }
  const dicabut = cabutPenandaBerkas(balas);
  berkas.push(...dicabut.berkas);
  return { balas: dicabut.teks || galat.join('\n'), galat, berkas: dedupBerkas(berkas) };
}

// Berkas rahasia tidak boleh keluar lewat chat walau model/penanda memintanya
// (prompt injection -> eksfiltrasi kunci). Dicek pada jalur nyata (realpath).
function alasanRahasia(nyata) {
  const rumah = os.homedir();
  const dalam = (akar) => nyata === akar || nyata.startsWith(akar + path.sep);
  const terlarangAkar = [path.join(rumah, '.ssh'), path.join(rumah, '.gnupg'), path.join(rumah, '.aws'),
    path.join(rumah, '.sakti-cli'), path.join(rumah, '.config', 'gh'), '/etc/ssh', '/proc', '/sys', '/dev'];
  if (terlarangAkar.some(dalam)) return 'folder rahasia/sistem';
  if (['/etc/shadow', '/etc/gshadow', path.join(rumah, '.netrc'), path.join(rumah, '.git-credentials'), path.join(rumah, '.npmrc')].includes(nyata)) return 'berkas kredensial';
  const nama = path.basename(nyata).toLowerCase();
  if (nama === '.env' || nama.startsWith('.env.') || /^id_(rsa|dsa|ecdsa|ed25519)/.test(nama) || /\.(pem|key|p12|pfx)$/.test(nama)) return 'berkas kunci/rahasia';
  return '';
}

export function batasBerkasKanal() {
  const n = Number(process.env.SAKTI_BERKAS_MAKS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : BERKAS_KANAL_MAKS_BAWAAN;
}

/** Validasi sebelum kirim. -> {ok:true, berkas} | {ok:false, alasan}. Tidak melempar. */
export function periksaBerkasKirim(berkas, { maks = batasBerkasKanal() } = {}) {
  const b = normalBerkas(berkas);
  if (!b) return { ok: false, alasan: 'jalur harus absolut' };
  let nyata;
  try { nyata = fs.realpathSync(b.jalur); } catch { return { ok: false, alasan: 'berkas tidak ada' }; }
  const rahasia = alasanRahasia(nyata);
  if (rahasia) return { ok: false, alasan: 'ditolak (' + rahasia + ')' };
  let st;
  try { st = fs.statSync(nyata); } catch { return { ok: false, alasan: 'berkas tidak ada' }; }
  if (!st.isFile()) return { ok: false, alasan: 'bukan berkas reguler' };
  if (st.size <= 0) return { ok: false, alasan: 'berkas kosong' };
  if (st.size > maks) return { ok: false, alasan: 'ukuran ' + st.size + ' byte melebihi batas ' + maks + ' byte (SAKTI_BERKAS_MAKS)' };
  return { ok: true, berkas: { ...b, jalur: nyata, ukuran: st.size } };
}

async function blobBerkas(jalur, mime) {
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(jalur, { type: mime });
  return new Blob([await fs.promises.readFile(jalur)], { type: mime });
}

function metodeTelegram(mime) {
  if (/^image\/(jpeg|png|webp)$/.test(mime)) return ['sendPhoto', 'photo'];
  if (mime === 'image/gif') return ['sendAnimation', 'animation'];
  if (/^video\/(mp4|quicktime|webm)$/.test(mime)) return ['sendVideo', 'video'];
  if (/^audio\/(mpeg|mp4|ogg|wav)$/.test(mime)) return ['sendAudio', 'audio'];
  return ['sendDocument', 'document'];
}

/** Update kanal -> pesan ternormalisasi. `null` = abaikan (bukan pesan teks). */
export function petakanUpdate(update, kanal = 'telegram') {
  if (!update || typeof update !== 'object') return null;
  if (kanal === 'telegram') {
    const pesan = update.message || update.edited_message;
    if (!pesan || typeof pesan.text !== 'string' || !pesan.text.trim()) return null;
    const id = pesan.chat && pesan.chat.id;
    if (id === undefined || id === null) return null;
    return {
      kanal,
      dari: String(id),
      nama: (pesan.from && (pesan.from.username || pesan.from.first_name)) || String(id),
      teks: pesan.text.trim(),
      // Telegram membalas ke chat yang sama; utas dipertahankan per chat.
      sesi: 'kanal-telegram-' + id
    };
  }
  const teks = typeof update.teks === 'string' ? update.teks.trim() : '';
  if (!teks) return null;
  const dari = String(update.dari || 'anon');
  return { kanal, dari, nama: String(update.nama || dari), teks, sesi: update.sesi || 'kanal-' + kanal + '-' + dari };
}

/** Kumpulkan NDJSON /chat jadi satu jawaban. Baris rusak dilewati, bukan meledak. */
export function rangkumNdjson(teks) {
  const hasil = { balas: '', galat: [], sesi: null, panggilan: 0, berkas: [] };
  for (const baris of String(teks || '').split('\n')) {
    if (!baris.trim()) continue;
    let satu;
    try { satu = JSON.parse(baris); } catch { continue; }
    if (!satu || typeof satu !== 'object') continue;
    if (satu.tipe === 'selesai') {
      hasil.balas = String(satu.teks || '');
      hasil.sesi = satu.sesi || null;
      hasil.panggilan = Number(satu.panggilan) || 0;
    } else if (satu.tipe === 'galat') {
      hasil.galat.push(String(satu.teks || ''));
    }
  }
  const media = ambilBerkasNdjson(teks);
  hasil.berkas = media.berkas;
  hasil.balas = cabutPenandaBerkas(hasil.balas).teks;
  if (!hasil.balas && hasil.galat.length) hasil.balas = hasil.galat.join('\n');
  return hasil;
}

/** Pecah balasan panjang agar diterima Telegram (batas 4096 karakter). */
function potongTelegram(teks, maks = 4000) {
  const isi = String(teks == null ? '' : teks);
  if (isi.length <= maks) return isi ? [isi] : [];
  const bagian = [];
  let sisa = isi;
  while (sisa.length > maks) {
    let potong = sisa.lastIndexOf('\n', maks);
    if (potong < maks * 0.5) potong = sisa.lastIndexOf(' ', maks);
    if (potong < maks * 0.5) potong = maks;
    bagian.push(sisa.slice(0, potong).trim());
    sisa = sisa.slice(potong).trim();
  }
  if (sisa) bagian.push(sisa);
  return bagian.filter(Boolean);
}

/** Kirim balasan ke kanal. Bawaannya Telegram bila token ada, selain itu stdout. */
export function buatPengirim({ token = process.env.SAKTI_TELEGRAM_TOKEN, catat = console.log, fetchImpl = globalThis.fetch } = {}) {
  const api = (metode) => 'https://api.telegram.org/bot' + token + '/' + metode;
  const kirimTeks = async (chat, teks) => {
    // sendMessage menolak >4096 karakter. Dulu balasan panjang = HTTP 400,
    // lalu retry Telegram dianggap duplikat dan jawabannya hilang.
    for (const bagian of potongTelegram(teks)) {
      const res = await fetchImpl(api('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: bagian }),
        // Sama dgn unggah: sendMessage tak boleh menggantung tanpa batas.
        signal: globalThis.AbortSignal.timeout(300000)
      });
      if (!res.ok) throw new Error('telegram sendMessage ' + res.status);
    }
  };
  const unggah = async (metode, field, chat, b) => {
    const form = new FormData();
    form.append('chat_id', String(chat));
    if (b.keterangan) form.append('caption', b.keterangan.slice(0, 1024));
    form.append(field, await blobBerkas(b.jalur, b.mime), b.nama);
    const res = await fetchImpl(api(metode), { method: 'POST', body: form, signal: globalThis.AbortSignal.timeout(300000) });
    return res;
  };
  return async function kirim(pesan, balasan, berkas = []) {
    const daftar = Array.isArray(berkas) ? berkas : [];
    if (pesan.kanal === 'telegram' && token) {
      if (balasan) await kirimTeks(pesan.dari, balasan);
      // Media hanya ke chat asal (pesan.dari). Satu berkas gagal tidak
      // menggagalkan yang lain; pengguna diberi tahu lewat teks.
      for (const satu of daftar) {
        const cek = periksaBerkasKirim(satu);
        const nama = (satu && satu.nama) || path.basename(String((satu && satu.jalur) || '?'));
        if (!cek.ok) { await kirimTeks(pesan.dari, 'gagal mengirim ' + nama + ': ' + cek.alasan).catch(() => {}); continue; }
        const b = cek.berkas;
        try {
          const [metode, field] = metodeTelegram(b.mime);
          let res = await unggah(metode, field, pesan.dari, b);
          // sendPhoto/sendVideo menolak format/ukuran tertentu; dokumen menerima apa saja <=50MB.
          if (!res.ok && metode !== 'sendDocument') res = await unggah('sendDocument', 'document', pesan.dari, b);
          if (!res.ok) throw new Error('telegram ' + res.status);
          catat('[telegram:' + pesan.nama + '] berkas ' + b.nama + ' (' + b.ukuran + ' byte)');
        } catch (galat) {
          await kirimTeks(pesan.dari, 'gagal mengirim ' + nama + ': ' + String((galat && galat.message) || galat)).catch(() => {});
        }
      }
      return;
    }
    catat('[' + pesan.kanal + ':' + pesan.nama + '] ' + balasan);
    for (const satu of daftar) catat('[' + pesan.kanal + ':' + pesan.nama + '] berkas ' + (satu && satu.jalur));
  };
}

export function serveKanal({ port = 4318, host = '127.0.0.1', serve = 'http://127.0.0.1:4317', kirim, fetchImpl = globalThis.fetch, token = '', rahasia = '', batasPesan = 20, jendelaMs = 60000 } = {}) {
  const pengirim = kirim || buatPengirim({ fetchImpl });
  const dasar = String(serve).replace(/\/+$/, '');
  // Webhook = permukaan publik: siapa pun yang bisa POST ke sini bisa menyuruh
  // agen menjalankan terminal. Token sama dengan `sakti serve` (SAKTI_TOKEN).
  // `token` = Bearer/X-Sakti-Token untuk webhook generik. `rahasia` = secret
  // token Telegram (header X-Telegram-Bot-Api-Secret-Token) - BUKAN bot token;
  // bot token hanya dipakai mengirim balasan, jangan dicampur dengan auth masuk.
  const harapToken = String(token || process.env.SAKTI_TOKEN || '').trim();
  const harapRahasia = String(rahasia || '').trim();
  const lokal = ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').toLowerCase());
  if (!harapToken && !harapRahasia && !lokal) {
    throw new Error('menolak --host ' + host + ' tanpa token. Set SAKTI_TOKEN=<rahasia> (atau --token=…) supaya webhook tidak bisa dipakai orang lain.');
  }
  const tokenCocok = (req, url) => {
    if (!harapToken && !harapRahasia) return true;
    const kepala = req.headers || {};
    const b = /^Bearer\s+(.+)$/i.exec(String(kepala.authorization || '').trim());
    const kandidat = [b ? b[1].trim() : '', String(kepala['x-sakti-token'] || '').trim(), String(url.searchParams.get('token') || '').trim()]
      .filter(Boolean);
    if (harapToken && kandidat.some((satu) => samaRahasia(satu, harapToken))) return true;
    // Telegram `setWebhook(secret_token=…)` mengirim header ini - satu-satunya
    // cara memverifikasi bahwa update benar dari Telegram, bukan peniru.
    return Boolean(harapRahasia) && samaRahasia(String(kepala['x-telegram-bot-api-secret-token'] || '').trim(), harapRahasia);
  };

  const terlihat = new Set();
  const jejak = new Map();
  const server = http.createServer(async (req, res) => {
    // Host dari klien tidak boleh menjadi basis URL: `Host: [` melempar di
    // luar try dan mematikan gateway. Hanya path/searchParams yang dipakai.
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ galat: 'URL permintaan tidak sah' }));
    }
    const balas = (kode, isi) => {
      const teks = JSON.stringify(isi);
      res.writeHead(kode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(teks) });
      res.end(teks);
    };
    // Update Telegram yang ditandai terlihat tetapi gagal diproses harus bisa
    // dikirim ulang. Tanpa catatan ini, retry dari Telegram dijawab `ulang`
    // selamanya dan pertanyaan pengguna hilang.
    let idDedupe = '';
    try {
      if (req.method === 'GET' && (url.pathname === '/sehat' || url.pathname === '/health')) {
        return balas(200, { ok: true, kanal: 'siap', serve: dasar, token: harapToken ? 'wajib' : 'tidak' });
      }
      if (!tokenCocok(req, url)) return balas(401, { galat: 'butuh token: kirim Authorization: Bearer <SAKTI_TOKEN>' });
      const cocok = req.method === 'POST' && url.pathname.match(/^\/kanal\/([a-z0-9_-]+)$/i);
      if (!cocok) return balas(404, { galat: 'rute tidak dikenal: ' + req.method + ' ' + url.pathname });
      const kanal = cocok[1].toLowerCase();
      const badan = await bacaBadan(req);
      // Telegram mengulang update yang sama bila webhook timeout. Tanpa dedupe,
      // satu pertanyaan bisa dijawab berkali-kali dan biaya token ikut berlipat.
      if (kanal === 'telegram' && badan && badan.update_id != null) {
        const id = String(badan.update_id);
        if (terlihat.has(id)) return balas(200, { ok: true, ulang: true });
        terlihat.add(id);
        idDedupe = id;
        if (terlihat.size > 200) terlihat.delete(terlihat.values().next().value);
      }
      const pesan = petakanUpdate(badan, kanal);
      if (!pesan) return balas(200, { ok: true, dilewati: true });
      // Batas per pengirim: gateway terbuka (loopback sekalipun) tidak boleh
      // dipakai membanjiri agen sampai biaya/CPU habis.
      const kunci = kanal + ':' + pesan.dari;
      const kini = Date.now();
      const riwayat = (jejak.get(kunci) || []).filter((t) => kini - t < jendelaMs);
      if (riwayat.length >= batasPesan) {
        // 429 = pemrosesan GAGAL: lepaskan dedupe supaya retry Telegram benar
        // diproses - kalau ditahan, retry dijawab 'ulang' dan pesan hilang.
        if (idDedupe) terlihat.delete(idDedupe);
        return balas(429, { galat: 'terlalu banyak pesan; coba lagi nanti' });
      }
      riwayat.push(kini);
      jejak.set(kunci, riwayat);

      const res2 = await fetchImpl(dasar + '/chat', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, harapToken ? { authorization: 'Bearer ' + harapToken } : {}),
        body: JSON.stringify({ pesan: pesan.teks, sesi: pesan.sesi }),
        // Webhook tidak boleh menggantung kalau serve menerima tapi tidak pernah
        // menutup NDJSON; Telegram akan retry terus dan dedupe menahannya.
        signal: globalThis.AbortSignal.timeout(Math.max(10000, Number(process.env.SAKTI_KANAL_WAKTU) || 600000))
      });
      if (!res2.ok) {
        if (idDedupe) terlihat.delete(idDedupe);
        return balas(502, { galat: 'serve /chat ' + res2.status });
      }
      const { balas: teks, galat, sesi, panggilan, berkas } = rangkumNdjson(await res2.text());
      if (teks || berkas.length) await pengirim(pesan, teks, berkas);
      // `balas` dikembalikan ke pemanggil webhook: bridge WhatsApp/generik
      // tidak punya jalur kirim balik seperti Telegram, jadi tanpa ini jawaban
      // agen hanya muncul di stdout dan tidak pernah sampai ke pengguna.
      return balas(200, { ok: true, sesi, panggilan, galat, balas: teks, berkas, terkirim: Boolean(teks || berkas.length) });
    } catch (galat) {
      // Gagal di tengah (serve mati, kirim Telegram error): lepaskan tanda
      // dedupe supaya retry Telegram benar-benar diproses, bukan dijawab ulang.
      if (idDedupe) terlihat.delete(idDedupe);
      const kode = (galat && galat.kode) || 500;
      if (!res.headersSent) {
        if (!req.readableEnded) res.setHeader('connection', 'close');
        balas(kode, { galat: String((galat && galat.message) || galat) });
        if (!req.readableEnded) req.destroy();
      } else {
        res.end();
        if (!req.readableEnded) req.destroy();
      }
    }
  });

  return new Promise((selesai, gagal) => {
    server.once('error', gagal);
    server.listen(port, host, () => selesai({ server, port: server.address().port, host }));
  });
}
