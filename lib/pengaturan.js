// Pengaturan model dari TUI: satu tempat untuk membaca, merapikan, dan menulis
import fs from 'node:fs';
// endpoint + API key. Murni (tanpa I/O) supaya bisa diuji tanpa terminal.

/** Kunci disamarkan: cukup ekor + kepala untuk dikenali, tengahnya jangan. */
export function maskKunci(kunci) {
  const t = String(kunci == null ? '' : kunci).trim();
  if (!t) return '(kosong)';
  if (t.length <= 8) return '•'.repeat(Math.max(4, t.length));
  return t.slice(0, 4) + '…' + t.slice(-4);
}

/**
 * URL endpoint gaya OpenAI. Tanpa skema dianggap http (enak diketik:
 * `127.0.0.1:3000/v1`), hanya http/https yang diterima, garis miring ekor dibuang.
 */
export function rapikanUrl(nilai) {
  let t = String(nilai == null ? '' : nilai).trim();
  if (!t) throw new Error('url kosong');
  if (/^\/+/.test(t)) throw new Error('url butuh host, bukan path saja: ' + nilai);
  if (/^[a-z][a-z0-9+.-]*:\/(?!\/)/i.test(t)) throw new Error('url tidak sah, skema butuh //: ' + nilai);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'http://' + t;
  if (/^[a-z][a-z0-9+.-]*:\/\/\//i.test(t)) throw new Error('url butuh host: ' + nilai);
  let u;
  try { u = new URL(t); } catch { throw new Error('url tidak sah: ' + nilai); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('hanya http/https: ' + nilai);
  if (!u.hostname) throw new Error('url butuh host: ' + nilai);
  if (u.username || u.password) throw new Error('url memuat kredensial; pakai /pengaturan key <kunci>: ' + nilai);
  // Orang sering menempel URL lengkap dari dokumentasi. Yang disimpan harus
  // BASIS API, bukan URL satu operasi - kalau tidak, model.js menempel
  // "/chat/completions" lagi dan hasilnya /chat/completions/chat/completions.
  let jalur = u.pathname.replace(/\/{2,}/g, '/');
  jalur = jalur.replace(/\/(?:chat\/completions|completions|models)\/?$/i, '');
  const dasar = (u.origin + jalur).replace(/\/+$/, '');
  // Jangan buang query: Azure/gateway memakai ?api-version=... sebagai bagian
  // dari alamat chat; tanpa itu setiap permintaan 404 tanpa penjelasan.
  return (dasar || u.origin) + (u.search || '');
}

/** Baris panel pengaturan. Nilai non-model (izin/worker/rute) dioper pemanggil.
 *  warna = konf.warnaTeks (konfigModel), kosong = 'bawaan'. */
export function barisPengaturan(konf = {}, tambahan = {}) {
  const token = Number(konf.maxTokens) > 0 ? String(konf.maxTokens) : 'serahkan ke server';
  return [
    'model    : ' + (konf.model || '-'),
    'endpoint : ' + (konf.baseUrl || '-'),
    'api key  : ' + (konf.apiKey ? maskKunci(konf.apiKey) + '  aktif' : 'belum diisi'),
    'effort   : ' + (konf.effort || 'none') + '  · token ' + token,
    'profil   : ' + (konf.profilAlat || 'penuh') + '  · nalar ' + (konf.nalar || 'sembunyi') + ' · pelajaran ' + (konf.pelajaran === 'mati' ? 'mati' : 'otomatis'),
    'warna    : ' + (String(konf.warnaTeks == null ? '' : konf.warnaTeks).trim().toLowerCase() || 'bawaan'),
    'gateway  : ' + (konf.kanal ? konf.kanal.jenis + ' · http://' + (konf.kanal.host || '127.0.0.1') + ':' + konf.kanal.port : 'tidak dipakai') + (konf.kanal && konf.kanal.token ? ' · token tersimpan' : ''),
    'config   : ' + (konf.berkas || '(belum ada)') + (() => { try { return ' · izin ' + (fs.statSync(konf.berkas).mode & 0o777).toString(8); } catch { return ''; } })(),
    'rute     : ' + (tambahan.rute || '-'),
    'izin     : ' + (tambahan.izin || '-'),
    'worker   : ' + (tambahan.worker == null ? 'bawaan' : tambahan.worker),
    'berkas   : ' + (konf.berkas || '-')
  ];
}

function pasang(kunci, nilai, baru) {
  const k = String(kunci || '').toLowerCase();
  if (['url', 'endpoint', 'baseurl', 'base-url'].includes(k)) {
    // rapikanUrl melempar untuk url jelek; di sini ditangkap supaya TUI
    // menjawab satu baris galat, bukan mati karena exception tak tertangani.
    try { baru.baseUrl = rapikanUrl(nilai); } catch (galat) { return String((galat && galat.message) || galat); }
    return null;
  }
  if (['key', 'apikey', 'api-key', 'kunci'].includes(k)) {
    const t = String(nilai == null ? '' : nilai).trim();
    if (!t) return 'kunci kosong; pakai /pengaturan hapus-key untuk mengosongkan';
    baru.apiKey = t;
    return null;
  }
  if (['model', 'nama'].includes(k)) {
    const t = String(nilai == null ? '' : nilai).trim();
    if (!t) return 'nama model kosong';
    baru.model = t;
    return null;
  }
  return 'kunci tidak dikenal: ' + kunci + ' · pakai url | key | model';
}

/**
 * Urai `/pengaturan ...`. Balikan { baru, baris, catatan, galat }.
 *  - tanpa argumen / lihat  -> baris panel
 *  - url|endpoint <url>     -> simpan baseUrl
 *  - key|apikey <kunci>     -> simpan apiKey (disamarkan saat dilaporkan)
 *  - model <id>             -> simpan model
 *  - hapus-key              -> kosongkan apiKey
 *  - url=... key=... model=...  -> beberapa sekaligus
 */
export function ubahPengaturan(sisa, konf = {}) {
  const kata = (sisa || []).map((s) => String(s)).filter((s) => s !== '');
  if (!kata.length || ['lihat', 'tampil', 'status'].includes(kata[0].toLowerCase())) {
    return { baru: {}, baris: barisPengaturan(konf), catatan: [] };
  }
  const baru = {};

  // Bentuk pasangan k=v (boleh beberapa sekaligus).
  if (kata[0].includes('=')) {
    for (const potongan of kata) {
      const pisah = potongan.indexOf('=');
      if (pisah < 1) return { baru: {}, baris: [], catatan: [], galat: 'bukan pasangan kunci=nilai: ' + potongan };
      const kunci = potongan.slice(0, pisah);
      const nilai = potongan.slice(pisah + 1);
      const salah = pasang(kunci, nilai, baru);
      if (salah) return { baru: {}, baris: [], catatan: [], galat: salah };
    }
    return { baru, baris: [], catatan: ringkas(baru, konf) };
  }

  const aksi = kata[0].toLowerCase();
  if (aksi === 'hapus-key' || aksi === 'hapuskey' || aksi === 'hapus-kunci') {
    baru.apiKey = '';
    return { baru, baris: [], catatan: ['api key dihapus'] };
  }
  const nilai = kata.slice(1).join(' ').trim();
  if (!nilai) return { baru: {}, baris: [], catatan: [], galat: 'butuh nilai sesudah ' + aksi };
  const salah = pasang(aksi, nilai, baru);
  if (salah) return { baru: {}, baris: [], catatan: [], galat: salah };
  return { baru, baris: [], catatan: ringkas(baru, konf) };
}

function ringkas(baru, konf) {
  const baris = [];
  if (baru.baseUrl) baris.push('endpoint : ' + baru.baseUrl);
  if (baru.model) baris.push('model    : ' + baru.model);
  if (baru.apiKey !== undefined) {
    baris.push('api key  : ' + (baru.apiKey ? maskKunci(baru.apiKey) + '  tersimpan' : '(dikosongkan)'));
  }
  const berkas = konf && konf.berkas ? konf.berkas : '';
  if (berkas) baris.push('berkas   : ' + berkas + '  (mode 0600)');
  return baris;
}

/**
 * Nilai yang baru disimpan bisa kalah oleh env (konfigModel: env > config).
 * Kembalikan peringatan supaya TUI tidak bilang "berlaku sekarang" padahal
 * env masih menimpa.
 */
export function peringatanTimpa(baru = {}, konf = {}, env = process.env) {
  const pesan = [];
  if (baru.baseUrl && env.SAKTI_MODEL_URL && konf.baseUrl !== baru.baseUrl) pesan.push('SAKTI_MODEL_URL menimpa endpoint tersimpan');
  if (baru.apiKey !== undefined && env.SAKTI_MODEL_KEY && konf.apiKey !== baru.apiKey) pesan.push('SAKTI_MODEL_KEY menimpa kunci tersimpan');
  if (baru.model && env.SAKTI_MODEL && konf.model !== baru.model) pesan.push('SAKTI_MODEL menimpa model tersimpan');
  return pesan;
}

/**
 * Riwayat input disimpan ke disk (~/.sakti-cli/history). Perintah yang membawa
 * kunci API tidak boleh ikut tersimpan apa adanya - samarkan nilainya, sisakan
 * bentuk perintahnya supaya masih bisa dipanggil ulang dan diisi lagi.
 */
export function sensorRiwayat(teks) {
  let t = String(teks == null ? '' : teks);
  // /pengaturan key <kunci> · /apikey <kunci> · /key <kunci>
  t = t.replace(/^(\/(?:pengaturan|setting|setelan)\s+(?:key|apikey|api-key|kunci)\s+).+$/i, '$1***');
  t = t.replace(/^\/(?:apikey|key)\s+.+$/i, (utuh) => utuh.replace(/\s+\S.*$/, ' ***'));
  // Bentuk k=v: key=... / apikey=... / api-key=... / model-key=...
  t = t.replace(/(^|\s)((?:api[-_]?key|key|model-key|kunci)=)\S+/gi, '$1$2***');
  // Bentuk shell/env dan header yang sering ditempel orang.
  t = t.replace(/(^|\s)((?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*)\S+/gi, '$1$2***');
  t = t.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***');
  // Kredensial di URL: https://user:pass@host -> https://***:***@host
  t = t.replace(/(https?:\/\/)([^\/\s:@]+):([^\/\s@]+)@/gi, '$1***:***@');
  return t;
}
