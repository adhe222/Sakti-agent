/* global AbortSignal */
// WhatsApp native lewat Baileys (opsional). Inti sakti tetap tanpa dependensi:
// modul ini hanya memuat `baileys` saat `sakti wa` benar-benar dijalankan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** Baca jawaban akhir dari NDJSON `serve /chat`. */
export function balasNdjson(teks) {
  let balas = '';
  const galat = [];
  for (const baris of String(teks || '').split('\n')) {
    if (!baris.trim()) continue;
    let satu;
    try { satu = JSON.parse(baris); } catch { continue; }
    if (satu.tipe === 'selesai') balas = String(satu.teks || '');
    else if (satu.tipe === 'galat') galat.push(String(satu.teks || ''));
  }
  return { balas: balas || galat.join('\n'), galat };
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
  if (!muatModul) {
    try {
      const cek = await fetchImpl(dasar + '/sehat', { signal: AbortSignal.timeout(1500) });
      if (!cek.ok) cetak('! serve ' + dasar + ' menjawab status ' + cek.status + '; jalankan `sakti serve`');
    } catch {
      cetak('! serve belum hidup di ' + dasar + '; jalankan `sakti serve` di terminal lain');
    }
  }

  const kirimKeAgen = async (teks, jid) => {
    const res = await fetchImpl(dasar + '/chat', {
      method: 'POST',
      headers: kepalaServe,
      body: JSON.stringify({ pesan: teks, sesi: prefixSesi + (jid.endsWith('@g.us') ? 'grup-' : '') + idWa(jid) }),
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
          const pengirim = diGrup ? (pesan.key.participant || '') : jid;
          const teks = ekstrakTeksWa(pesan.message);
          if (!teks) continue;
          if (izin.length) {
            const cocok = izin.some((satu) => angkaWa(satu) === angkaWa(pengirim) || angkaWa(satu) === angkaWa(jid));
            if (!cocok) { cetak('dilewati (tidak di izin): ' + idWa(pengirim)); continue; }
            if (!diGrup && (pesan.key.chat === 'status@broadcast')) continue;
          }
          try { await soket.sendPresenceUpdate('composing', jid); } catch { /* opsional */ }
          const hasil = await kirimKeAgen(teks, jid);
          const balasan = String(hasil.balas || '').trim();
          if (!balasan) { cetak('tanpa balasan untuk ' + idWa(jid)); continue; }
          for (const bagian of potongPesan(balasan, maksPesan)) {
            await soket.sendMessage(jid, { text: bagian }, { quoted: pesan });
          }
          cetak('[' + idWa(jid) + '] ' + teks.slice(0, 80) + ' -> ' + balasan.slice(0, 80));
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
