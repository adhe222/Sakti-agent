// `sakti serve` - satu port HTTP untuk agen ini, tanpa dependensi.
//
//   GET  /sehat            -> {ok, versi, mode, model}
//   GET  /sesi             -> daftar sesi terakhir
//   POST /chat  {pesan, sesi?}  -> NDJSON (satu JSON per baris, mengalir):
//        {"tipe":"delta","teks":"..."}
//        {"tipe":"alat","nama":"terminal","argumen":{...}}
//        {"tipe":"hasil","nama":"terminal","teks":"..."}
//        {"tipe":"status","teks":"..."}
//        {"tipe":"selesai","sesi":"..","teks":"..","panggilan":2}
//        {"tipe":"galat","teks":".."}
//
// Kenapa NDJSON, bukan WebSocket: SSE tak bisa membawa badan permintaan, dan
// WebSocket butuh dependensi. NDJSON di atas POST cukup, dan `curl -N` sudah
// kliennya.
//
// AUTH: `--host 0.0.0.0` tanpa token = siapa pun di jaringan memegang alat
// `terminal` di mesin ini (RCE). Karena itu host non-loopback WAJIB ber-token:
// SAKTI_TOKEN atau `--token`. Token dikirim sebagai `Authorization: Bearer …`,
// `X-Sakti-Token: …`, atau `?token=…`. Loopback tetap tanpa token supaya
// pemakaian sehari-hari tidak berubah.

import http from 'node:http';
import { putaran } from './agent.js';
import { ambilAntreanPanggil, jalanAntreanPanggil, konteks } from './alat.js';
import { bacaBot, botDiRoom, konteksBot, promptBot, promptKoordinatorTim } from './bot.js';
import { deteksiMode, jalankanRoom, urutkanNamaPeserta, workerParalel } from './room.js';
import { modeIzin } from './izin.js';
import { angkaWa, izinPenuh } from './wa.js';
import { arsipSesi, daftarSesi, idSesiSah, sesiBaru, sesiTerakhir } from './sesi.js';
import { bacaBadan, samaRahasia } from './http-util.js';

function json(res, kode, isi) {
  const teks = JSON.stringify(isi);
  res.writeHead(kode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(teks) });
  res.end(teks);
}

// '' BUKAN loopback: `server.listen(port, '')` mengikat ::/0.0.0.0 sehingga
// host kosong (--host=) dulu membuka server tanpa token ke seluruh jaringan.
const LOKAL = (alamat) => ['127.0.0.1', '::1', 'localhost'].includes(String(alamat || '').toLowerCase());

/** Token yang diterima: argumen dulu, lalu env. Kosong = tanpa auth. */
export const tokenServe = (token) => String(token || process.env.SAKTI_TOKEN || '').trim();

/**
 * Tolak permintaan tanpa token yang benar. Loopback + tanpa token = lolos
 * (perilaku lama). Host non-loopback + tanpa token = server menolak start,
 * bukan diam-diam terbuka.
 */
export function cekToken(req, url, token, host) {
  const harap = tokenServe(token);
  if (!harap) return LOKAL(host);
  const kepala = req.headers || {};
  const Bearer = /^Bearer\s+(.+)$/i.exec(String(kepala.authorization || '').trim());
  const kandidat = [Bearer ? Bearer[1].trim() : '', String(kepala['x-sakti-token'] || '').trim(), String(url.searchParams.get('token') || '').trim()]
    .filter(Boolean);
  return kandidat.some((satu) => samaRahasia(satu, harap));
}

export function serve({ port = 4317, host = '127.0.0.1', cwd = process.cwd(), konfModel, muatKonf, versi = '?', worker, token = '' } = {}) {
  // Worker mengatur dua hal: bot room yang berjalan bersamaan, dan pool
  // subagen di dalam tiap giliran (ctx.worker).
  // kanal 'serve': giliran dari HTTP/WA/kanal dianggap tak tepercaya (gerbang terminal).
  const ctx = konteks({ cwd, worker, kanal: 'serve' });
  const workerRoom = worker;
  const harapToken = tokenServe(token);
  // Gagal cepat, jangan biarkan server terbuka tanpa kunci.
  if (!harapToken && !LOKAL(host)) {
    throw new Error('menolak --host ' + host + ' tanpa token. Set SAKTI_TOKEN=<rahasia> (atau --token=…) supaya /chat tidak bisa dipakai orang lain menjalankan terminal di mesin ini.');
  }

  const server = http.createServer(async (req, res) => {
    // `Host` datang dari klien dan bisa sampah (`Host: [`); memakainya sebagai
    // basis `new URL` dulu melempar di luar try dan MEMATIKAN seluruh server
    // (terukur: satu permintaan `Host: [` = proses exit, semua sesi hilang).
    // Yang dipakai hanya pathname/searchParams, jadi basis tetap aman.
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return json(res, 400, { galat: 'URL permintaan tidak sah' }); }
    if (!cekToken(req, url, harapToken, host)) {
      return json(res, 401, { galat: 'butuh token: kirim Authorization: Bearer <SAKTI_TOKEN>' });
    }
    // `sakti serve` hidup lama: config dibaca ulang tiap permintaan supaya
    // `sakti model ...` / `/pengaturan` dari proses lain langsung berlaku tanpa
    // restart. Config rusak di tengah tulis = pakai salinan terakhir, jangan 500.
    let konfAktif = konfModel;
    if (typeof muatKonf === 'function') {
      try { konfAktif = muatKonf() || konfModel; } catch { konfAktif = konfModel; }
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/sehat' || url.pathname === '/health')) {
        return json(res, 200, {
          ok: true, versi,
          model: konfAktif && konfAktif.model,
          endpoint: konfAktif && konfAktif.baseUrl,
          katalog: konfAktif && Array.isArray(konfAktif.models) ? konfAktif.models.length : 0,
          izin: modeIzin(), cwd
        });
      }
      if (req.method === 'GET' && url.pathname === '/sesi') {
        return json(res, 200, { sesi: daftarSesi({ batas: Number(url.searchParams.get('batas')) || 20 }), terakhir: sesiTerakhir() });
      }
      if (req.method === 'POST' && url.pathname === '/chat') {
        const badan = await bacaBadan(req);
        const pesan = String(badan.pesan || '').trim();
        if (!pesan) return json(res, 400, { galat: 'butuh "pesan"' });
        // ADR-004: eskalasi izin penuh. Nomor di SAKTI_WA_IZIN_PENUH (chat
        // pribadi saja) diperlakukan seperti CLI lokal (kanal 'cli' = tepercaya);
        // selain itu tetap kanal 'serve' (gerbang terminal ketat). Fail-closed:
        // tanpa `dari`, grup, atau env kosong = tak tepercaya.
        const grup = badan.grup === true;
        // `dari` bisa beberapa kandidat dipisah koma (LID + nomor, ADR-004):
        // satu saja yang cocok daftar izin penuh = tepercaya.
        const kandidatDari = String(badan.dari || '').split(',').map((s) => s.trim()).filter(Boolean);
        const penuh = !grup && kandidatDari.length > 0
          && kandidatDari.some((satu) => izinPenuh().includes(angkaWa(satu)));
        const ctxPenuh = penuh ? konteks({ cwd, worker, kanal: 'cli' }) : ctx;
        let sesiId = badan.sesi || null;
        if (sesiId === true || sesiId === 'lanjut') sesiId = sesiTerakhir();
        if (sesiId && !idSesiSah(sesiId)) return json(res, 400, { galat: 'id sesi tidak sah: ' + sesiId });
        if (!sesiId) sesiId = sesiBaru({ judul: pesan.slice(0, 80) }).id;

        // `/baru` atau `/bersih` dari WA/Telegram: sesi chat itu tetap (wa-<no>),
        // jadi riwayatnya diarsipkan & dikosongkan di sini, tanpa memanggil model.
        if (/^\/(baru|bersih)$/i.test(pesan)) {
          const arsip = arsipSesi(sesiId);
          const teks = 'Sesi baru dimulai. Riwayat obrolan dikosongkan' + (arsip ? ' (arsip: ' + arsip + ').' : '.');
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ tipe: 'teks', teks }) + '\n' + JSON.stringify({ tipe: 'selesai', sesi: sesiId, teks, panggilan: 0 }) + '\n');
        }

        // Klien menutup koneksi -> giliran dibatalkan, bukan dibiarkan jalan.
        const kendali = new AbortController();
        res.on('close', () => kendali.abort());

        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        const kirim = (peristiwa) => { if (!res.writableEnded) res.write(JSON.stringify(peristiwa) + '\n'); };

        let panggilan = 0;
        try {
          // Urutan input `/bot masuk a b c` dipertahankan; mode serial/paralel/
          // solo dipilih otomatis dari isi pesan - sama seperti TUI dan CLI.
          const semua = urutkanNamaPeserta(botDiRoom(sesiId), bacaBot);
          const dasarDaftar = semua.length ? semua : [null];
          const mode = deteksiMode(pesan, dasarDaftar.length, dasarDaftar);
          const daftar = mode.peserta.length ? mode.peserta : dasarDaftar;
          const tim = mode.tim === true && daftar.length === 1 && dasarDaftar.length > 1;
          if (daftar.length > 1 || tim) {
            kirim({ tipe: 'room', peserta: daftar, bot: dasarDaftar.length, paralel: mode.paralel, tim, koordinator: tim ? daftar[0] : undefined });
          }
          const { hasil: hasilRoom, rangkum } = await jalankanRoom({
            daftar,
            worker: mode.paralel ? workerParalel(workerRoom, daftar.length) : 1,
            sinyal: kendali.signal,
            buat: async (namaBot, indeks) => {
              const bot = namaBot ? bacaBot(namaBot) : null;
              return putaran({
                pesan,
                sesiId,
                ctx: Object.assign(konteksBot(ctxPenuh, bot), {
                  pesertaGiliran: daftar,
                  panggilLangsung: tim,
                  onSubDelta: (namaRekan, teks) => kirim({ tipe: 'delta', teks, dari: namaRekan }),
                  onSubAlat: (namaRekan, namaAlat, argumen) => { panggilan += 1; kirim({ tipe: 'alat', nama: namaAlat, argumen, dari: namaRekan }); },
                  onSubHasilAlat: (namaRekan, namaAlat, teks) => kirim({ tipe: 'hasil', nama: namaAlat, teks, dari: namaRekan })
                }),
                konfModel: konfAktif,
                sinyal: kendali.signal,
                modeIzin: modeIzin(),
                tanpaUser: indeks !== 0,
                label: namaBot || undefined,
                promptEkstra: bot ? promptBot(bot) + (tim ? '\n\n' + promptKoordinatorTim(bot, dasarDaftar.filter(Boolean).map((n) => bacaBot(n)).filter(Boolean)) : '') : '',
                alat: bot && bot.alat && bot.alat.length
                  ? (!bot.alat.includes('panggil') ? [...bot.alat, 'panggil'] : bot.alat)
                  : undefined,
                model: bot ? bot.model : undefined,
                // Tak ada yang bisa ditanya lewat HTTP: mode ask berlaku sebagai tolak.
                tanyaIzin: async () => 't',
                onDelta: (teks) => kirim({ tipe: 'delta', teks, dari: namaBot || undefined }),
                // Penalaran tidak pernah masuk `content`; klien HTTP hanya
                // menerimanya bila meminta eksplisit (`nalar: true`).
                onNalar: (teks) => { if (badan.nalar === true || process.env.SAKTI_SERVE_NALAR === '1') kirim({ tipe: 'nalar', teks, dari: namaBot || undefined }); },
                onAlat: (nama, argumen) => { panggilan += 1; kirim({ tipe: 'alat', nama, argumen, dari: namaBot || undefined }); },
                onHasilAlat: (nama, teks) => kirim({ tipe: 'hasil', nama, teks }),
                onStatus: (teks) => kirim({ tipe: 'status', teks })
              });
            }
          });
          // Kegagalan per bot dikirim sebagai peristiwa, bukan menutupi bot lain.
          for (const baris of rangkum.baris) kirim({ tipe: 'galat', teks: baris });
          // Antrean panggilan antar-bot: dijalankan setelah seluruh room selesai,
          // supaya percakapan bot tidak saling menimpa riwayat sesi.
          let teksAntre = '';
          let gelombangAntre = 0;
          while (ambilAntreanPanggil(sesiId).length && gelombangAntre < 4) {
            gelombangAntre += 1;
            let hasilAntre = [];
            try {
              hasilAntre = await jalanAntreanPanggil(sesiId, {
                konfModel: konfAktif, cwd: ctx.cwd, worker: workerRoom,
                modeIzin: modeIzin(),
                // Tak ada manusia di ujung HTTP: `ask` berlaku sebagai tolak,
                // jangan jatuh ke tanyaBaris yang memblokir stdin server.
                tanyaIzin: async () => 't',
                sinyal: kendali.signal
              });
            } catch (galatAntre) {
              kirim({ tipe: 'galat', teks: 'panggilan rekan gagal: ' + String((galatAntre && galatAntre.message) || galatAntre) });
              break;
            }
            for (const blok of hasilAntre || []) {
              teksAntre += (teksAntre ? '\n\n' : '') + blok;
              kirim({ tipe: 'panggilan', teks: blok });
            }
          }
          // `teks` = gabungan jawaban yang berhasil, urut menurut tugas.
          const teks = hasilRoom
            .map((satu, i) => {
              if (!satu || !satu.ok) return null;
              const isi = typeof satu.hasil === 'string' ? satu.hasil : (satu.hasil && satu.hasil.teks) || '';
              return daftar.length > 1 ? (daftar[i] || 'agen') + ': ' + isi : isi;
            })
            .filter(Boolean)
            .join('\n\n') + (teksAntre ? (hasilRoom.some((s) => s && s.ok) ? '\n\n' : '') + teksAntre : '');
          kirim({ tipe: 'selesai', sesi: sesiId, teks, panggilan, berhasil: rangkum.berhasil, gagal: rangkum.gagal });
        } catch (galat) {
          kirim({ tipe: 'galat', teks: String((galat && galat.message) || galat) });
        }
        res.end();
        return;
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, { allow: 'GET, POST' }); return res.end(); }
      json(res, 404, { galat: 'rute tidak dikenal: ' + req.method + ' ' + url.pathname });
    } catch (galat) {
      const kode = (galat && galat.kode) || 500;
      // Badan ditolak sebelum habis dibaca (mis. 413): sisa badan masih mengalir.
      // Tanpa menutup soket, Node memakai ulang koneksi yang kotor dan permintaan
      // BERIKUTNYA gagal ECONNRESET - klien yang tidak bersalah ikut kena.
      if (!res.headersSent) {
        if (!req.readableEnded) res.setHeader('connection', 'close');
        json(res, kode, { galat: String((galat && galat.message) || galat) });
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