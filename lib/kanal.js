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

import http from 'node:http';
import { bacaBadan, samaRahasia } from './http-util.js';

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
  const hasil = { balas: '', galat: [], sesi: null, panggilan: 0 };
  for (const baris of String(teks || '').split('\n')) {
    if (!baris.trim()) continue;
    let satu;
    try { satu = JSON.parse(baris); } catch { continue; }
    if (satu.tipe === 'selesai') {
      hasil.balas = String(satu.teks || '');
      hasil.sesi = satu.sesi || null;
      hasil.panggilan = Number(satu.panggilan) || 0;
    } else if (satu.tipe === 'galat') {
      hasil.galat.push(String(satu.teks || ''));
    }
  }
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
  return async function kirim(pesan, balasan) {
    if (pesan.kanal === 'telegram' && token) {
      // sendMessage menolak >4096 karakter. Dulu balasan panjang = HTTP 400,
      // lalu retry Telegram dianggap duplikat dan jawabannya hilang.
      for (const bagian of potongTelegram(balasan)) {
        const res = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: pesan.dari, text: bagian })
        });
        if (!res.ok) throw new Error('telegram sendMessage ' + res.status);
      }
      return;
    }
    catat('[' + pesan.kanal + ':' + pesan.nama + '] ' + balasan);
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
      if (riwayat.length >= batasPesan) return balas(429, { galat: 'terlalu banyak pesan; coba lagi nanti' });
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
      const { balas: teks, galat, sesi, panggilan } = rangkumNdjson(await res2.text());
      if (teks) await pengirim(pesan, teks);
      // `balas` dikembalikan ke pemanggil webhook: bridge WhatsApp/generik
      // tidak punya jalur kirim balik seperti Telegram, jadi tanpa ini jawaban
      // agen hanya muncul di stdout dan tidak pernah sampai ke pengguna.
      return balas(200, { ok: true, sesi, panggilan, galat, balas: teks, terkirim: Boolean(teks) });
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
