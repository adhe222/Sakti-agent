/* global AbortSignal */
// WhatsApp native lewat Baileys (opsional). Inti sakti tetap tanpa dependensi:
// modul ini hanya memuat `baileys` saat `sakti wa` benar-benar dijalankan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ambilBerkasNdjson, periksaBerkasKirim } from './kanal.js';

/** Folder auth multi-file Baileys. Jangan pernah masuk repo/git. */
export function folderAuthWa() {
  return process.env.SAKTI_CLI_WA || path.join(os.homedir(), '.sakti-cli', 'wa-auth');
}

/** Ambil teks dari semua bentuk pesan WhatsApp yang umum, termasuk pembungkus
 *  disappearing/view-once/document-with-caption/edited yang dulu menghasilkan
 *  string kosong sehingga pesannya dilewati. */
export function ekstrakTeksWa(pesan) {
  if (!pesan || typeof pesan !== 'object') return '';
  let m = pesan;
  for (let i = 0; i < 6; i += 1) {
    const dalam = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2
      || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage
      || (m.editedMessage && m.editedMessage.message);
    if (!dalam || typeof dalam !== 'object') break;
    m = dalam.message || dalam;
  }
  return String(
    m.conversation
    || (m.extendedTextMessage && m.extendedTextMessage.text)
    || (m.imageMessage && m.imageMessage.caption)
    || (m.videoMessage && m.videoMessage.caption)
    || (m.documentMessage && m.documentMessage.caption)
    || (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedButtonId)
    || (m.listResponseMessage && m.listResponseMessage.singleSelectReply && m.listResponseMessage.singleSelectReply.selectedRowId)
    || (m.templateButtonReplyMessage && m.templateButtonReplyMessage.selectedId)
    || (m.reactionMessage && '')
    || ''
  ).trim();
}

/** Pesan media murni (tanpa caption) punya isi media yang bisa diunduh.
 *  Mengembalikan { kunci, info, jenis } bila ada, atau null. Kunci dipakai
 *  unduhMediaWa untuk mengambil isi berkasnya dari Baileys. */
export function pesanMediaWa(pesan) {
  if (!pesan || typeof pesan !== 'object') return null;
  let m = pesan;
  for (let i = 0; i < 6; i += 1) {
    const dalam = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2
      || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage
      || (m.editedMessage && m.editedMessage.message);
    if (!dalam || typeof dalam !== 'object') break;
    m = dalam.message || dalam;
  }
  if (m.imageMessage) return { kunci: 'imageMessage', info: m.imageMessage, jenis: 'gambar' };
  if (m.videoMessage) return { kunci: 'videoMessage', info: m.videoMessage, jenis: 'video' };
  if (m.audioMessage) return { kunci: 'audioMessage', info: m.audioMessage, jenis: 'audio' };
  if (m.stickerMessage) return { kunci: 'stickerMessage', info: m.stickerMessage, jenis: 'stiker' };
  if (m.documentMessage) return { kunci: 'documentMessage', info: m.documentMessage, jenis: 'dokumen' };
  if (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message
    && m.documentWithCaptionMessage.message.documentMessage) {
    return { kunci: 'documentMessage', info: m.documentWithCaptionMessage.message.documentMessage, jenis: 'dokumen' };
  }
  return null;
}

/** Nama berkas aman untuk media masuk: pakai nama dokumen bila ada,
 *  kalau tidak buat dari jenis + ekstensi mime. Selalu bersih dari jalur. */
export function namaBerkasMediaWa(jenis, info, jid) {
  const asli = String((info && (info.fileName || info.title)) || '').replace(/\\/g, '/').split('/').pop().trim();
  const bersih = asli.replace(/[^A-Za-z0-9._ ()+-]/g, '_').slice(0, 120);
  if (bersih && bersih !== '.' && bersih !== '..') return bersih;
  const mime = String((info && info.mimetype) || '');
  const ekst = ({
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/opus': '.opus',
    'application/pdf': '.pdf', 'application/zip': '.zip',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt'
  }[mime]) || '';
  const nomor = String(jid || '').split('@')[0].replace(/\D/g, '') || 'tanpa-nomor';
  const stempel = new Date().toISOString().replace(/[-:]/g, '').replace('T', '').replace(/\..+$/, '');
  return 'wa-' + jenis + '-' + nomor + '-' + stempel + (ekst || '.bin');
}

/** Angka WhatsApp ternormalisasi: `0811…`, `+62 811…`, dan JID `62811…@s.whatsapp.net`
 *  semuanya menjadi `62811…` supaya daftar izin benar-benar cocok. */
export function angkaWa(nilai) {
  let angka = String(idWa(nilai || '')).replace(/\D/g, '');
  if (/^0\d+$/.test(angka)) angka = '62' + angka.slice(1);
  return angka;
}

/** JID tanpa sufiks device (`628…:12@s.whatsapp.net` -> `628…@s.whatsapp.net`). */
export function rapikanJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0] + (String(jid || '').includes('@') ? '@' + String(jid).split('@')[1] : '');
}

/** Apakah pesan boleh diproses menurut daftar izin (izin kosong = tolak).
 *  - Chat pribadi: nomor pengirim harus ada di izin.
 *  - Grup: participant (pengirim sebenarnya) harus ada di izin, ATAU grupnya
 *    dideklarasikan eksplisit dengan JID lengkap `...@g.us` (semua anggota grup itu boleh). */
export function waDiizinkan(izin, { jid, pengirim, diGrup }) {
  const daftar = (izin || []).map((s) => String(s).trim()).filter(Boolean);
  if (!daftar.length) return false;
  if (daftar.includes('*')) return true;
  // pengirim boleh string atau daftar kandidat (LID + nomor alt/pemetaan): cocok bila salah satu ada di izin.
  const kandidat = (Array.isArray(pengirim) ? pengirim : [pengirim]).filter(Boolean);
  const angkaIzin = daftar.filter((s) => !s.endsWith('@g.us')).map(angkaWa).filter(Boolean);
  const cocok = (daftarKandidat) => daftarKandidat.some((k) => { const a = angkaWa(k); return !!a && angkaIzin.includes(a); });
  if (diGrup) {
    const grupJid = rapikanJid(jid);
    if (daftar.some((s) => s.endsWith('@g.us') && rapikanJid(s) === grupJid)) return true;
    return cocok(kandidat);
  }
  return cocok(kandidat.length ? kandidat : [jid]);
}

/** Nomor telepon untuk LID dari pemetaan Baileys `<auth>/lid-mapping-<lid>_reverse.json` (hanya baca). */
export function nomorDariLid(lid, authDir = folderAuthWa()) {
  const angka = String(idWa(lid || '')).replace(/\D/g, '');
  if (!angka || !authDir) return '';
  try {
    const isi = JSON.parse(fs.readFileSync(path.join(authDir, 'lid-mapping-' + angka + '_reverse.json'), 'utf8'));
    const nomor = String(typeof isi === 'string' || typeof isi === 'number' ? isi : '').replace(/\D/g, '');
    return nomor;
  } catch { return ''; }
}

/** Kandidat identitas pengirim: JID asli, alt (remoteJidAlt/participantAlt), dan nomor hasil pemetaan LID. */
export function kandidatPengirimWa(key = {}, { diGrup = false, authDir = folderAuthWa() } = {}) {
  const utama = rapikanJid(diGrup ? (key.participant || '') : (key.remoteJid || ''));
  const alt = rapikanJid(diGrup ? (key.participantAlt || '') : (key.remoteJidAlt || ''));
  const hasil = [utama, alt].filter(Boolean);
  for (const j of [utama, alt]) {
    if (j.endsWith('@lid')) { const n = nomorDariLid(j, authDir); if (n) hasil.push(n + '@s.whatsapp.net'); }
  }
  return [...new Set(hasil)];
}

/**
 * Daftar izin PENUH (ADR-004): nomor WA yang boleh akses sistem penuh lewat
 * serve (kanal 'cli' = tepercaya: terminal bebas pola bahaya, ubah_diri/
 * pasang_alat jalan). Env SAKTI_WA_IZIN_PENUH, koma, dinormalisasi angkaWa
 * (08xx -> 628xx). '*' DILARANG: tidak pernah cocok siapa pun. Kosong = mati
 * (perilaku lama: semua pengirim WA tetap kanal 'serve').
 */
export function izinPenuh(env = process.env.SAKTI_WA_IZIN_PENUH) {
  return String(env || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*')
    .map((s) => angkaWa(s))
    .filter(Boolean);
}

/** Cek /sehat serve: 3 percobaan, backoff 500ms, 1000ms. true bila sehat. */
export async function cekSehat({ dasar, fetchImpl = globalThis.fetch, cetak = () => {}, percobaan = 3, jedaMs = 500 }) {
  let terakhir = '';
  for (let i = 0; i < percobaan; i += 1) {
    try {
      const cek = await fetchImpl(dasar + '/sehat', { signal: AbortSignal.timeout(1500) });
      if (cek.ok) return true;
      terakhir = 'status ' + cek.status;
    } catch (galat) {
      terakhir = String((galat && galat.message) || galat);
    }
    if (i < percobaan - 1) await new Promise((siap) => setTimeout(siap, jedaMs * (i + 1)));
  }
  cetak('! serve ' + dasar + ' tidak sehat setelah ' + percobaan + ' percobaan (' + terakhir + '); jalankan `sakti serve` di terminal lain');
  return false;
}

/** Nomor/ID yang ditampilkan ke pengguna. */
export function idWa(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/** Timestamp pesan Baileys bisa number, Long, atau string. Selalu detik. */
export function detikPesan(nilai) {
  if (nilai == null) return 0;
  let n = nilai;
  if (typeof n === 'object' && typeof n.toNumber === 'function') n = n.toNumber();
  else if (typeof n === 'object' && n.low != null) n = n.low;
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Pecah balasan panjang agar tidak ditolak WhatsApp (batas aman 3500). */
export function potongPesan(teks, maks = 3500) {
  const isi = String(teks == null ? '' : teks);
  const batas = Math.max(200, Number(maks) || 3500);
  if (isi.length <= batas) return isi ? [isi] : [];
  const bagian = [];
  let sisa = isi;
  while (sisa.length > batas) {
    let potong = sisa.lastIndexOf('\n', batas);
    if (potong < batas * 0.5) potong = sisa.lastIndexOf(' ', batas);
    if (potong < batas * 0.5) potong = batas;
    bagian.push(sisa.slice(0, potong).trim());
    sisa = sisa.slice(potong).trim();
  }
  if (sisa) bagian.push(sisa);
  return bagian;
}

/** Logger diam: Baileys memanggil .child()/.trace() dll, bukan console. */
function loggerDiam() {
  const satu = {
    level: 'silent',
    child() { return satu; },
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}
  };
  return satu;
}

export { ambilBerkasNdjson };

/** Baca jawaban akhir dari NDJSON `serve /chat` (+ berkas dari kirim_berkas / [[berkas:]]). */
export function balasNdjson(teks) {
  return ambilBerkasNdjson(teks);
}

/** Berkas tervalidasi -> isi sendMessage Baileys. */
export function isiMediaWa(b) {
  const caption = b.keterangan ? b.keterangan.slice(0, 1024) : undefined;
  const pakai = (o) => { if (caption) o.caption = caption; return o; };
  if (b.mime.startsWith('image/')) return pakai({ image: { url: b.jalur }, mimetype: b.mime });
  if (b.mime.startsWith('video/')) return pakai({ video: { url: b.jalur }, mimetype: b.mime });
  if (b.mime.startsWith('audio/')) return { audio: { url: b.jalur }, mimetype: b.mime };
  return pakai({ document: { url: b.jalur }, fileName: b.nama, mimetype: b.mime });
}

/** Kirim daftar berkas ke satu JID. Gagal per berkas -> teks 'gagal mengirim ...', tidak melempar. */
export async function kirimBerkasWa(soket, jid, berkas = [], { quoted, cetak = () => {} } = {}) {
  let terkirim = 0;
  const opsi = quoted ? { quoted } : undefined;
  for (const satu of berkas) {
    const nama = (satu && satu.nama) || path.basename(String((satu && satu.jalur) || '?'));
    const cek = periksaBerkasKirim(satu);
    let alasan = cek.ok ? '' : cek.alasan;
    if (cek.ok) {
      try {
        await soket.sendMessage(jid, isiMediaWa(cek.berkas), opsi);
        terkirim += 1;
        cetak('berkas terkirim ke ' + idWa(jid) + ': ' + cek.berkas.nama + ' (' + cek.berkas.ukuran + ' byte)');
        continue;
      } catch (galat) {
        alasan = String((galat && galat.message) || galat);
      }
    }
    cetak('berkas gagal ' + nama + ': ' + alasan);
    try { await soket.sendMessage(jid, { text: 'gagal mengirim ' + nama + ': ' + alasan }, opsi); } catch { /* soket putus */ }
  }
  return terkirim;
}

/**
 * Unduh isi media pesan WA ke folder unduhan. Mengembalikan info berkas
 * { jalur, nama, mime, ukuran, jenis } atau null bila tidak ada media /
 * gagal unduh (galat dicetak, pesan tetap diproses sebagai teks).
 */
export async function unduhMediaWa(modul, pesan, {
  folder = path.join(process.env.SAKTI_UNDUHAN || path.join(os.homedir(), 'unduhan')),
  cetak = () => {}, jid = ''
} = {}) {
  const media = pesanMediaWa(pesan.message);
  if (!media) return null;
  if (typeof modul.downloadMediaMessage !== 'function') {
    cetak('unduh media dilewati: baileys tidak punya downloadMediaMessage');
    return null;
  }
  fs.mkdirSync(folder, { recursive: true });
  const nama = namaBerkasMediaWa(media.jenis, media.info, jid);
  const jalur = path.join(folder, nama);
  // Tulis ke berkas sementara lalu rename: unduhan gagal tidak boleh menghapus
  // berkas lama dengan nama sama (bug lama: unlink langsung menghapus yang baik).
  const bagian = path.join(folder, '.bagian-' + process.pid + '-' + Date.now() + '-' + nama);
  try {
    const isi = await modul.downloadMediaMessage(pesan, 'buffer', {}, { logger: modul.loggerDiam ? modul.loggerDiam() : undefined, reuploadRequest: modul.soket ? modul.soket.updateMediaMessage : undefined });
    if (!isi || !isi.length) throw new Error('isi kosong');
    fs.writeFileSync(bagian, isi);
    fs.renameSync(bagian, jalur);
    const info = {
      jalur, nama, jenis: media.jenis,
      mime: String(media.info.mimetype || 'application/octet-stream'),
      ukuran: isi.length
    };
    cetak('media masuk: ' + nama + ' (' + media.jenis + ', ' + isi.length + ' B)');
    return info;
  } catch (galat) {
    cetak('gagal unduh media ' + nama + ': ' + String((galat && galat.message) || galat));
    try { fs.unlinkSync(bagian); } catch { /* tidak jadi ada */ }
    return null;
  }
}

/**
 * Jalankan klien WhatsApp. `muatModul` bisa diganti di uji supaya tidak perlu
 * akun WhatsApp sungguhan. Mengembalikan `{ soket, berhenti }` segera setelah
 * listener terpasang; proses tetap hidup karena soket Baileys.
 */
export async function jalanWa({
  serve = process.env.SAKTI_SERVE || 'http://127.0.0.1:4317',
  token = process.env.SAKTI_TOKEN || '',
  authDir = folderAuthWa(),
  izin = String(process.env.SAKTI_WA_IZIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  grup = process.env.SAKTI_WA_GRUP === '1',
  sesiPrefix = 'wa-',
  fetchImpl = globalThis.fetch,
  cetak = (...a) => console.log(...a),
  qrCetak = null,
  muatModul = null,
  sambungUlang = true,
  maksPesan = 3500,
  nomor = '',
  jedaPairingMs = 5000,
  umurMaksDetik = process.env.SAKTI_WA_UMUR_MAKS == null ? 120 : Number(process.env.SAKTI_WA_UMUR_MAKS)
} = {}) {
  let nomorBersih = String(nomor || '').replace(/\D/g, '');
  // Nomor Indonesia yang diketik lokal (08xx) harus jadi 628xx. Tanpa kode
  // negara, JID yang dikirim ke WhatsApp tidak sah dan socket ditutup.
  if (/^08\d+$/.test(nomorBersih)) nomorBersih = '62' + nomorBersih.slice(1);
  if (nomorBersih && !/^\d{8,15}$/.test(nomorBersih)) {
    throw new Error('nomor WhatsApp harus 8-15 angka; 08xx otomatis jadi 628xx, selain itu pakai kode negara tanpa +/spasi/tanda hubung');
  }

  const prefixSesi = String(sesiPrefix || 'wa-').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'wa-';
  const umurMaks = Number.isFinite(Number(umurMaksDetik)) && Number(umurMaksDetik) >= 0
    ? Number(umurMaksDetik) : 120;
  const sudahDiproses = new Set();

  let modul;
  try {
    modul = muatModul ? await muatModul() : await import('baileys');
  } catch {
    throw new Error('baileys belum terpasang. Jalankan: npm install baileys qrcode-terminal');
  }
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = modul;
  if (typeof makeWASocket !== 'function' || typeof useMultiFileAuthState !== 'function') {
    throw new Error('modul baileys tidak lengkap (makeWASocket/useMultiFileAuthState tidak ada)');
  }
  const { default: qrcode } = qrCetak ? { default: null } : await import('qrcode-terminal').catch(() => ({ default: null }));
  const tampilQr = qrCetak || ((teks) => {
    if (qrcode && typeof qrcode.generate === 'function') qrcode.generate(teks, { small: true });
    else cetak('QR (tempel ke generator QR): ' + teks);
  });

  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  // Percobaan pairing yang gagal meninggalkan creds.json dengan
  // registered:false tetapi me/pairingCode sudah terisi. Baileys lalu
  // menganggap ini sesi lama dan server menutupnya 401 sebelum QR/pairing
  // baru sempat diminta. Arsipkan auth yang belum terdaftar, jangan hapus.
  if (nomorBersih) {
    const berkasCreds = path.join(authDir, 'creds.json');
    try {
      const lama = JSON.parse(fs.readFileSync(berkasCreds, 'utf8'));
      if (!lama || lama.registered !== true) {
        const cadangan = authDir + '.belum-terdaftar-' + Date.now();
        fs.renameSync(authDir, cadangan);
        fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
        cetak('Auth pairing lama belum terdaftar; dipindah ke ' + cadangan);
      }
    } catch (galat) {
      if (galat && galat.code !== 'ENOENT') {
        const cadangan = authDir + '.rusak-' + Date.now();
        try { fs.renameSync(authDir, cadangan); fs.mkdirSync(authDir, { recursive: true, mode: 0o700 }); } catch { /* biarkan error asli */ }
        cetak('auth lama tidak bisa dibaca (' + String(galat.message || galat) + '); dipindah ke ' + cadangan);
      }
    }
  }
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let versi = null;
  try {
    if (typeof fetchLatestBaileysVersion === 'function') versi = (await fetchLatestBaileysVersion()).version;
  } catch { /* memakai versi bawaan baileys */ }

  let soket = null;
  let berhenti = false;
  let pairingDiminta = false;
  // Jangan memakai label buatan seperti 'sakti-cli': WhatsApp menolak
  // companion_platform_display saat pairing dan bisa menutup socket.
  const browser = Browsers && typeof Browsers.ubuntu === 'function'
    ? Browsers.ubuntu('Chrome')
    : ['Ubuntu', 'Chrome', '22.04.4'];
  const dasar = String(serve).replace(/\/+$/, '');
  const kepalaServe = Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {});

  // Beri petunjuk nyata sebelum pesan pertama gagal dengan "fetch failed".
  // Coba 3x dengan backoff (serve bisa baru saja dinyalakan bersamaan).
  if (!muatModul) await cekSehat({ dasar, fetchImpl, cetak });

  // S1: izin kosong = TOLAK semua. Terbuka hanya bila sadar: izin ['*'] atau SAKTI_WA_TERBUKA=1.
  const terbuka = izin.includes('*') || process.env.SAKTI_WA_TERBUKA === '1';
  if (terbuka) cetak('! PERINGATAN: WA terbuka untuk SEMUA pengirim (izin "*" / SAKTI_WA_TERBUKA=1). Siapa pun bisa memerintah agen.');
  else if (!izin.length) cetak('! SAKTI_WA_IZIN kosong: semua pesan DITOLAK. Isi nomor (koma) atau SAKTI_WA_TERBUKA=1 untuk membuka.');
  // S6: antrean serial per JID supaya jawaban satu percakapan urut.
  const antreanJid = new Map();

  const kirimKeAgen = async (teks, jid, pengirim = []) => {
    const res = await fetchImpl(dasar + '/chat', {
      method: 'POST',
      headers: kepalaServe,
      body: JSON.stringify({
        pesan: teks,
        sesi: prefixSesi + (jid.endsWith('@g.us') ? 'grup-' : '') + idWa(jid),
        // ADR-004: identitas pengirim utk eskalasi izin penuh di serve.
        // Grup selalu grup:true (tak pernah eskalasi); chat pribadi pakai
        // kandidat pengirim (LID dipetakan; gagal petakan = kosong = fail-closed).
        dari: jid.endsWith('@g.us') ? '' : (pengirim.length ? pengirim.join(',') : ''),
        grup: jid.endsWith('@g.us')
      }),
      // Tanpa batas waktu, `serve` yang menerima tapi menggantung membuat
      // handler WhatsApp macet selamanya dan pesan berikutnya menumpuk.
      signal: AbortSignal.timeout(Math.max(10000, Number(process.env.SAKTI_WA_WAKTU) || 600000))
    });
    if (!res.ok) throw new Error('serve /chat ' + res.status);
    return balasNdjson(await res.text());
  };

  async function mulai() {
    soket = makeWASocket({
      auth: state,
      ...(versi ? { version: versi } : {}),
      logger: loggerDiam(),
      printQRInTerminal: false,
      browser,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    soket.ev.on('creds.update', saveCreds);

    // Pairing code baru boleh diminta setelah websocket siap (event qr).
    // Memanggil requestPairingCode tepat setelah makeWASocket bisa gagal
    // "Connection Closed" karena handshake belum selesai.
    async function mintaPairing() {
      if (!nomorBersih || pairingDiminta || (state.creds && state.creds.registered)) return;
      pairingDiminta = true;
      try {
        if (typeof soket.requestPairingCode !== 'function') {
          throw new Error('Baileys ini tidak mendukung requestPairingCode; upgrade atau pakai QR');
        }
        // Beberapa versi Baileys mengirim QR sebelum pair-device benar-benar
        // siap. Jeda kecil mencegah Boom 428 'Connection Closed'.
        if (jedaPairingMs > 0) await new Promise((selesai) => setTimeout(selesai, jedaPairingMs));
        const kode = await soket.requestPairingCode(nomorBersih);
        const rapi = String(kode || '').replace(/\s+/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
        cetak('Pairing code untuk ' + nomorBersih + ': ' + (rapi || kode));
        cetak('Buka WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon.');
      } catch (galat) {
        pairingDiminta = false;
        cetak('gagal meminta pairing code: ' + String((galat && galat.message) || galat));
      }
    }

    soket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update || {};
      if (qr) {
        // Saat memakai --nomor, QR memang bisa tetap dipancarkan server; abaikan
        // supaya pengguna tidak bingung memilih dua jalur pairing.
        if (nomorBersih) { await mintaPairing(); return; }
        cetak('Scan QR ini dengan WhatsApp > Perangkat tertaut:');
        tampilQr(qr);
        cetak('auth tersimpan di ' + authDir + ' (mode 700)');
      }
      if (connection === 'open') cetak('WhatsApp tersambung · balasan dari ' + dasar);
      if (connection === 'close') {
        const kode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : null;
        if (kode === DisconnectReason.loggedOut || kode === 401) {
          cetak('WhatsApp logout. Hapus ' + authDir + ' lalu jalankan `sakti wa` untuk pairing ulang.');
          return;
        }
        if (sambungUlang && !berhenti) {
          // Kode pairing lama sudah kedaluwarsa setelah socket ditutup; izinkan
          // permintaan kode baru pada socket berikutnya.
          if (!(state.creds && state.creds.registered)) pairingDiminta = false;
          cetak('WhatsApp terputus (kode ' + (kode == null ? '?' : kode) + '); menyambung ulang 3s...');
          setTimeout(() => { if (!berhenti) mulai().catch((galat) => cetak('gagal menyambung ulang: ' + String(galat && galat.message || galat))); }, 3000);
        }
      }
    });

    soket.ev.on('messages.upsert', async (peristiwa) => {
      // `append` = riwayat lama yang diputar ulang saat reconnect/history sync.
      // Tanpa filter ini bot bisa menjawab pesan lama berhari-hari lalu.
      const jenis = String((peristiwa && peristiwa.type) || '').toLowerCase();
      if (jenis && jenis !== 'notify') return;
      const daftar = (peristiwa && peristiwa.messages) || [];
      for (const pesan of daftar) {
        try {
          if (!pesan || !pesan.message || !pesan.key || pesan.key.fromMe) continue;
          const idPesan = String(pesan.key.id || '');
          if (idPesan) {
            if (sudahDiproses.has(idPesan)) continue;
            sudahDiproses.add(idPesan);
            if (sudahDiproses.size > 2000) sudahDiproses.delete(sudahDiproses.values().next().value);
          }
          const waktuPesan = detikPesan(pesan.messageTimestamp);
          const usiaPesan = waktuPesan ? Math.floor(Date.now() / 1000) - waktuPesan : 0;
          if (umurMaks > 0 && usiaPesan > umurMaks) {
            cetak('dilewati (pesan lama ' + usiaPesan + 's): ' + idWa(pesan.key.remoteJid || ''));
            continue;
          }
          const jid = rapikanJid(pesan.key.remoteJid || '');
          if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
          const diGrup = jid.endsWith('@g.us');
          if (diGrup && !grup) continue;
          const pengirim = kandidatPengirimWa(pesan.key, { diGrup, authDir });
          const teks = ekstrakTeksWa(pesan.message);
          const adaMedia = !!pesanMediaWa(pesan.message);
          if (!teks && !adaMedia) continue;
          if (!terbuka && !waDiizinkan(izin, { jid, pengirim, diGrup })) {
            cetak('dilewati (tidak di izin): ' + ((pengirim.length ? pengirim : [jid]).map(idWa).join(' / ')));
            continue;
          }
          const proses = async () => {
            try {
              try { await soket.sendPresenceUpdate('composing', jid); } catch { /* opsional */ }
              // Media (dokumen/gambar/video/audio/stiker) diunduh dulu bila ada,
              // lalu jalurnya diberitahu ke agen bersama teks/caption.
              const mediaInfo = await unduhMediaWa(modul, pesan, { jid, cetak });
              const teksAgen = [teks, mediaInfo ? '[media diterima: ' + mediaInfo.jalur + ' (' + mediaInfo.jenis + ', ' + mediaInfo.mime + ', ' + mediaInfo.ukuran + ' B)]' : ''].filter(Boolean).join('\n');
              if (!teksAgen) return;
              const hasil = await kirimKeAgen(teksAgen, jid, pengirim);
              const balasan = String(hasil.balas || '').trim();
              const berkas = Array.isArray(hasil.berkas) ? hasil.berkas : [];
              if (!balasan && !berkas.length) { cetak('tanpa balasan untuk ' + idWa(jid)); return; }
              for (const bagian of potongPesan(balasan, maksPesan)) {
                await soket.sendMessage(jid, { text: bagian }, { quoted: pesan });
              }
              if (berkas.length) await kirimBerkasWa(soket, jid, berkas, { quoted: pesan, cetak });
              cetak('[' + idWa(jid) + '] ' + teks.slice(0, 80) + ' -> ' + balasan.slice(0, 80));
            } catch (galat) {
              cetak('pesan gagal diproses: ' + String((galat && galat.message) || galat));
            }
          };
          // Rantai per JID: pesan berikut dari JID sama menunggu yang sebelumnya; JID lain paralel.
          const sebelum = antreanJid.get(jid) || Promise.resolve();
          const berikut = sebelum.then(proses);
          antreanJid.set(jid, berikut);
          berikut.finally(() => { if (antreanJid.get(jid) === berikut) antreanJid.delete(jid); });
        } catch (galat) {
          cetak('pesan gagal diproses: ' + String((galat && galat.message) || galat));
        }
      }
    });
    return soket;
  }

  await mulai();
  return {
    soket,
    authDir,
    berhenti() {
      berhenti = true;
      try { soket.end(undefined); } catch { /* sudah */ }
    }
  };
}
