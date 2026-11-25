// Agen CLI: satu giliran = panggil model, jalankan alat yang diminta, ulangi
// sampai model berhenti minta alat. Tidak ada biner luar yang dipanggil;
// alatnya dari lib/alat.js, modelnya dari lib/model.js, riwayatnya dari
// lib/sesi.js.
//
// Izin alat: lihat lib/izin.js. Bawaannya `auto` (jalan apa adanya atas
// permintaan pemilik); `ask` menanyakan alat berisiko dulu, `never` menolaknya.
// Yang tetap ada: batas waktu per alat dan keluaran alat dipotong supaya
// percakapan tidak meledak. Langkah dan riwayat TIDAK dibatasi - berhenti hanya
// saat pekerjaan tuntas atau pengguna membatalkan.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALAT, cariAlat, jalankanAlat, konteks, setelPanggilSibuk } from './alat.js';
import { jalankanParalel } from './room.js';
import { SUBAGEN, workerSubagen } from './subagen.js';
import { obrol, GalatBatal } from './model.js';
import { mintaIzin } from './izin.js';
import { catat as catatBiaya, kiraPesan } from './biaya.js';
import { catatPakai, indeksSkill, skillCocok } from './skill.js';
import { pilihRute, terapkanRute } from './rute.js';

/**
 * Muat sendiri keahlian yang cocok dengan pesan: yang teratas dimasukkan utuh
 * (dipotong), sisanya cuma disebut namanya. Ini yang membuat skill "aktif" tanpa
 * disuruh - model tidak perlu memanggil alat skill lebih dulu.
 */
export function keahlianAktif(pesan, { maks = 3, potongTeks = 6000, semua = null } = {}) {
  let cocok = [];
  try { cocok = skillCocok(pesan, { maks, semua }); } catch { return ''; }
  if (!Array.isArray(cocok) || !cocok.length || !cocok[0] || !cocok[0].jalur) return '';
  const [utama, ...sisa] = cocok;
  try { catatPakai(utama.nama); } catch { /* pembukuan tidak boleh mematikan satu giliran */ }
  for (const satu of sisa) { try { catatPakai(satu.nama); } catch { /* idem */ } }
  let isi = '';
  try { isi = fs.readFileSync(utama.jalur, 'utf8'); } catch { isi = ''; }
  const catatan = sisa.length ? '\nKeahlian lain yang mungkin relevan: ' + sisa.map((satu) => satu.nama).join(', ') + ' (baca dengan alat skill kalau perlu).' : '';
  return 'KEAHLIAN AKTIF: ' + utama.nama + catatan + '\n' +
    (isi.length > potongTeks ? isi.slice(0, potongTeks) + '\n[...dipotong]' : isi);
}
import { bacaState } from './lokal.js';
import { ringkasKotak } from './kotak.js';
import { bacaSesi, tambahPesan } from './sesi.js';
import { catatPelajaran, pelajaranAktif, promosikanPelajaran, susunPelajaran } from './pelajaran.js';
import { blokPetunjuk } from './petunjuk.js';
import { bacaRencana, tampilRencana } from './rencana.js';
import { alatCache, bungkusAlat, galatMcp, siapkanAlatMcp } from './mcp-klien.js';
import { pemicuJatuhTempo, tandaiPemicu } from './khazanah.js';

// Tanpa batas bawaan dan tanpa penghenti otomatis: agen berhenti saat pekerjaan
// tuntas (tidak memanggil alat lagi), saat pengguna membatalkan, atau saat
// endpoint menolak karena konteks penuh. Sengaja tidak ada penghenti otomatis -
// hasil setengah jalan lebih mahal daripada satu langkah ekstra.

/* --------------------------------------------------------- konteks --- */

/**
 * Padatkan riwayat lama jadi cuplikan (micro-compaction): pesan terakhir tetap
 * utuh, yang tua dipotong supaya prompt tidak tumbuh tanpa batas. Bentuk pesan
 * (role, tool_calls, tool_call_id) tidak diubah - cuma isinya dipendekkan -
 * jadi pasangan panggilan-alat tetap sah untuk API. maks = 0 -> tanpa pemadatan.
 */
export function kompresRiwayat(messages, { maks = 0, potong = 240 } = {}) {
  if (!Array.isArray(messages)) return [];
  if (!(maks > 0) || messages.length <= maks) return messages;
  // Hanya pesan system di AWAL yang dianggap awalan; system di ekor (bagian
  // volatil) harus tetap di ekor supaya awalan tetap sama.
  let awal = 0;
  while (awal < messages.length && messages[awal].role === 'system') awal += 1;
  const sistem = messages.slice(0, awal);
  const badan = messages.slice(awal);
  const batas = Math.max(0, badan.length - maks);
  const padat = badan.slice(0, batas).map((row) => {
    const isi = typeof row.content === 'string' ? row.content : '';
    const teks = isi.length > potong ? isi.slice(0, potong) + '…[' + (isi.length - potong) + ' karakter dipadatkan]' : isi;
    return Object.assign({}, row, { content: teks });
  });
  // Jangan mulai dari pesan `tool` tanpa panggilan sebelumnya.
  while (padat.length && padat[0].role === 'tool') padat.shift();
  if (!padat.length) return messages;
  const note = catatanPotong(sistem, padat.length, (n) =>
    'konteks dipadatkan: ' + n + ' pesan lama diringkas jadi cuplikan');
  return [...note, ...padat, ...badan.slice(batas)];
}

function berkasPengguna() {
  return process.env.SAKTI_CLI_USER || path.join(os.homedir(), '.sakti-cli', 'USER.md');
}

function profilPengguna() {
  try { return fs.readFileSync(berkasPengguna(), 'utf8').trim().slice(0, 4000); } catch { return ''; }
}

/**
 * Prompt dipecah dua supaya awalan permintaan tetap sama antar-giliran (cache
 * awalan penyedia): `stabil` jarang berubah, `volatil` (rencana berjalan, pemicu
 * jatuh tempo) berubah tiap langkah dan dikirim sebagai pesan system SESUDAH
 * riwayat, bukan di dalam awalan. Terukur di endpoint nyata: 7.569 -> 5.009 token
 * segar per giliran (cached 2.048 -> 4.608).
 */
export function bagianPrompt(ctx) {
  const state = bacaState();
  // Daftar alat MCP diambil dari cache klien: menyusun prompt tidak boleh
  // membuka koneksi baru.
  const mcpAlat = bungkusAlat(alatCache());
  const mcpMati = Object.entries(galatMcp() || {});
  // Pelajaran otomatis dipisah dari ingatan biasa: kalau dicampur, 60 pelajaran
  // akan mendorong ingatan manual keluar dari 30 slot terakhir. Dua bagian,
  // dua anggaran - yang eksplisit tetap terbaca.
  const semuaIngatan = Array.isArray(state.ingatan) ? state.ingatan : [];
  // Pelajaran: yang berasal dari folder kerja ini didahulukan, sisanya tetap
  // terlihat dengan label proyek - pengalaman proyek lain tidak selalu cocok.
  const proyek = String(ctx && ctx.cwd || '');
  const pelajaranRows = semuaIngatan.filter((row) => row && row.jenis === 'pelajaran').slice(-12);
  pelajaranRows.sort((a, b) => Number(String(b.proyek || '') === proyek) - Number(String(a.proyek || '') === proyek));
  const pelajaran = pelajaranRows.map((row) => {
    const asal = String(row.proyek || '') === proyek || !row.proyek ? '' : ' [proyek: ' + String(row.proyek).split('/').filter(Boolean).pop() + ']';
    return '- ' + row.teks + asal;
  });
  const ingatan = semuaIngatan.filter((row) => !row || row.jenis !== 'pelajaran').slice(-30).map((row) => '- ' + row.teks);
  const mind = (state.mind || []).slice(-30).map((row) => '- ' + row.teks);
  const tugas = Object.entries(state.tugas || {}).map(([nama, perintah]) => '- ' + nama + ': ' + perintah);
  const skill = indeksSkill();
  const profil = profilPengguna();
  const petunjuk = blokPetunjuk(ctx.cwd);
  const rencana = bacaRencana();
  const rencanaSingkat = rencana.some((row) => row.status !== 'completed' && row.status !== 'cancelled')
    ? 'RENCANA BERJALAN (dari alat rencana; perbarui statusnya saat maju, jangan dibiarkan basi)\n' + tampilRencana(rencana)
    : '';
  // Jadwal yang jatuh tempo dijalankan di giliran ini, bukan oleh daemon.
  let jatuh = [];
  try { jatuh = pemicuJatuhTempo(); } catch { jatuh = []; }
  if (jatuh.length) for (const satu of jatuh) { try { tandaiPemicu(satu.nama); } catch { /* jangan gagalkan giliran */ } }

  const stabil = [
    'Kamu adalah agen terminal bernama sakti. Kamu bekerja di mesin ini, folder kerja ' + ctx.cwd + '.',
    'Jawab dalam bahasa yang dipakai orangnya (bawaan Indonesia), ringkas, tanpa basa-basi pembuka.',
    '',
    'ATURAN KERJA',
    '1. Bukti, bukan klaim: setelah menjalankan sesuatu, laporkan kode keluar dan keluaran sungguhannya. Jangan bilang "sudah berhasil" untuk yang belum dijalankan.',
    '2. Kegagalan tidak disembunyikan: sebut kodenya, tampilkan bagian galatnya, lalu perbaiki atau tanyakan.',
    '3. Alat terminal menjalankan bash apa adanya - install, git, build, server, pipa. Tidak ada dinding izin, jadi kamu yang harus berhati-hati pada hal yang tidak bisa dibatalkan (hapus folder, push paksa, menimpa basis data, mematikan layanan).',
    '4. Berkas: untuk mengubah berkas yang sudah ada pakai edit (cari→ganti, satu atau banyak editan sekali panggil) - jangan tulis ulang seluruh berkas kalau hanya satu blok berubah. tulis untuk berkas baru atau penulisan penuh, folder untuk membuat folder, pindah/salin untuk memindahkan atau menyalin, hapus untuk menghapus (konfirmasi dulu kalau jalurnya tidak disebut orangnya).',
    '5. Skrip: jalankan memilih penerjemah dari ekstensi (.py python3, .js/.mjs node, .ts node --experimental-strip-types, .sh bash, .rb ruby, .php php); uji untuk berkas uji; terminal untuk rangkaian perintah shell biasa.',
    '6. Keahlian aktif sendiri: sebelum mulai kerja, cocokkan tugas dengan daftar KEAHLIAN TERPASANG. Kalau ada yang cocok, langsung `skill aksi baca` keahlian itu dan ikuti isinya — tanpa menunggu disuruh, tanpa tanya izin. Beberapa keahlian cocok: baca semuanya yang relevan.',
    '7. Kerjakan sampai tuntas, bukan sampai rencana. Kalau terhalang, katakan penghalangnya apa adanya.',
    '8. Tindakan merusak: hapus/edit/tulis sudah otomatis membuat checkpoint (alat khazanah aksi checkpoint untuk daftar, kembalikan <id> untuk membatalkan). Untuk tugas berkala pakai khazanah aksi pemicu (cron/tiap N menit) - itu cara resmi, bukan proses latar yang menggantung. Untuk satu proses panjang (build, server, tarikan data) pakai alat latar, lalu matikan dengan latar aksi=bunuh kalau tidak dipakai lagi.',
    '9. Rangkuman wajib di PALING BAWAH: setiap pekerjaan selesai (apalagi yang memakai beberapa alat atau mengubah berkas) tutup jawaban dengan blok "Rangkuman" 2-5 butir: apa yang dikerjakan, berkas/berkas yang berubah, hasil uji + kode keluar, dan sisa/penghalang. Tanpa pembuka, tanpa mengulang jawaban di atasnya.',
    '10. Tugas berlapis (3 langkah atau lebih, atau beberapa permintaan sekaligus): tulis dulu rencananya lewat alat rencana (aksi=tulis, satu item per langkah, urutan = prioritas), lalu perbarui statusnya (aksi=gabung) tiap langkah maju. Hanya SATU item in_progress. Tandai completed hanya setelah hasilnya terverifikasi, bukan karena niat. Item yang gagal jangan dihapus - jadikan cancelled lalu tambah item perbaikan.',
    '11. Cari dahulu sebelum menebak: fakta tentang pustaka, API, atau versi terbaru pakai cariweb lalu baca halaman pentingnya dengan web (aksi ekstrak). Jangan mengarang isi halaman. Kalau pencarian gagal, sebut galatnya apa adanya.',
    '12. Aturan repo ikut otomatis kalau ada AGENTS.md / SAKTI.md / CLAUDE.md di folder kerja (lihat bagian PETUNJUK PROYEK). Untuk proyek baru yang perlu aturan tetap, tulis AGENTS.md lewat alat petunjuk aksi=tulis.',
    '13. Pekerjaan bercabang atau butuh sudut pandang lain: pecah jadi BEBERAPA panggilan delegasi (peran sesuai daftar SUBAGEN, atau peran=auto) dan/atau panggil dalam SATU balasan — semuanya dijalankan bersamaan sebanyak worker, jadi jangan menyerialkan tugas yang memang berdiri sendiri. Subagen berriwayat bersih: tulis tugasnya lengkap (berkas, tujuan, batasan, bentuk jawaban). Jangan mendelegasikan langkah yang bisa kamu selesaikan sendiri dengan satu alat.',
    '',
    'ALAT',
    ALAT.map((alat) => '- ' + alat.name + ': ' + alat.description.split('.')[0]).join('\n'),
    'SUBAGEN (pakai alat delegasi: peran=<nama>; peran=auto memilih sendiri dari teks tugas; isi banyak=[{peran,tugas}...] untuk beberapa tugas sekaligus yang berjalan PARALEL)\n' +
      SUBAGEN.map((satu) => '- ' + satu.nama + ': ' + satu.kapan + (satu.tulis ? ' (boleh mengubah berkas)' : '')).join('\n'),
    mcpAlat.length ? 'ALAT MCP (dari server terpasang, nama berawalan mcp_)\n' + mcpAlat.map((alat) => '- ' + alat.name + ': ' + String(alat.description).split('.')[0]).join('\n') : '',
    mcpMati.length ? 'SERVER MCP BERMASALAH (jangan diulang terus, sebut ke pengguna)\n' + mcpMati.map(([nama, galat]) => '- ' + nama + ': ' + galat).join('\n') : '',
    '',
    ingatan.length ? 'INGATAN DARI SESI SEBELUMNYA\n' + ingatan.join('\n') : '',
    pelajaran.length ? 'PELAJARAN DARI GILIRAN SEBELUMNYA (yang berhasil diulang, yang gagal dihindari)\n' + pelajaran.join('\n') : '',
    mind.length ? 'INGATAN INTI\n' + mind.join('\n') : '',
    tugas.length ? 'TUGAS TERSIMPAN (pakai alat tugas aksi jalankan)\n' + tugas.join('\n') : '',
    skill ? 'KEAHLIAN TERPASANG (baca dulu kalau tugasnya cocok, lalu ikuti)\n' + skill : '',
    profil ? 'TENTANG ORANG YANG KAMU BANTU\n' + profil : '',
    petunjuk
  ].filter(Boolean).join('\n\n');
  const volatil = [
    jatuh.length ? 'PEMICU JATUH TEMPO (jalankan sekarang tanpa ditanya, laporkan hasilnya satu-dua baris) \n' + jatuh.map((row) => '- ' + row.nama + ': ' + row.perintah).join('\n') : '',
    rencanaSingkat
  ].filter(Boolean).join('\n\n');
  return { stabil, volatil };
}

/** Satu teks utuh (stabil + volatil): dipakai `sakti env`, doctor, dan uji. */
export function promptSistem(ctx) {
  const { stabil, volatil } = bagianPrompt(ctx);
  return volatil ? stabil + '\n\n' + volatil : stabil;
}

// Deskripsi parameter hanya dikirim untuk kunci yang isinya daftar pilihan -
// itu yang dipakai model untuk memilih aksi. Sisanya ("folder kerja (bawaan: .)")
// berulang dan bisa dibaca dari nama kuncinya.
const KUNCI_PILIHAN = new Set(['aksi', 'jenis', 'mode', 'tipe']);
function kalimatPertama(teks, maks = 160, minimum = 40) {
  const utuh = String(teks || '').trim();
  const satu = utuh.split(/(?<=\.)\s/)[0];
  // Kalimat pertama yang terlalu pendek ("Read a text file") kehilangan rincian
  // yang dipakai model; ambil potongan lebih panjang sampai batas kata.
  let isi = satu.length >= minimum ? satu : utuh.slice(0, minimum);
  if (isi !== satu) isi = isi.replace(/\s+\S*$/, '');
  return isi.length > maks ? isi.slice(0, maks - 1).trimEnd() + '…' : isi;
}
function ringkasParameter(p) {
  const out = { type: (p && p.type) || 'object' };
  if (p && p.enum) out.enum = p.enum;
  if (p && p.properties) {
    out.properties = {};
    for (const [kunci, nilai] of Object.entries(p.properties)) {
      const anak = ringkasParameter(nilai);
      if (KUNCI_PILIHAN.has(kunci) && nilai.description) anak.description = String(nilai.description);
      out.properties[kunci] = anak;
    }
    if (p.required && p.required.length) out.required = p.required;
  }
  if (p && p.items) out.items = ringkasParameter(p.items);
  return out;
}

/** Skema alat seperti yang dikirim ke model. Terukur: 5.678 -> 3.844 token (-32%). */
export function skemaAlat(namaSaja, ekstra = []) {
  const semua = ALAT.concat(ekstra || []);
  const daftar = Array.isArray(namaSaja) && namaSaja.length ? semua.filter((alat) => namaSaja.includes(alat.name)) : semua;
  return daftar.map((alat) => ({
    type: 'function',
    function: { name: alat.name, description: kalimatPertama(alat.description), parameters: ringkasParameter(alat.parameters) }
  }));
}

/**
 * Pangkas hasil alat LAMA jadi satu baris penanda (tuas "hasil alat lama" dari
 * skill llm-token-budget). Yang disimpan di berkas sesi tidak disentuh - hanya
 * muatan yang dikirim. Terukur pada sesi nyata 373 pesan: 185.734 -> 63.538
 * token per panggilan (-66%); 12 pesan terakhir tetap utuh supaya langkah yang
 * sedang berjalan tidak kehilangan konteks.
 */
export function pangkasHasilLama(messages, { simpan = 12, kepala = 160 } = {}) {
  if (!Array.isArray(messages) || messages.length <= simpan) return messages;
  const batas = messages.length - simpan;
  return messages.map((row, i) => {
    if (i >= batas || !row || row.role !== 'tool') return row;
    const isi = String(row.content == null ? '' : row.content);
    if (isi.length <= kepala * 2) return row;
    const baris = isi.split('\n')[0].slice(0, kepala);
    return Object.assign({}, row, { content: baris + '\n[...hasil alat lama dipangkas: ' + isi.length + ' karakter. Jalankan ulang alatnya kalau isinya masih perlu]' });
  });
}

/** Pisahkan `system` di AWAL saja. `system` di ekor adalah instruksi volatil
 *  (bagianPrompt mengirimnya sesudah riwayat) dan HARUS tetap di ekor - kalau
 *  dinaikkan ke depan ia berubah jadi perintah awal dan pesan riwayat menutupinya. */
function pisahKepala(messages) {
  let awal = 0;
  while (awal < messages.length && messages[awal].role === 'system') awal += 1;
  return { kepala: messages.slice(0, awal), badan: messages.slice(awal) };
}

/** Satu catatan pemotongan saja. Tiga pemangkas berjalan berurutan (potong pesan
 *  -> potong token -> padatkan), dan tiap tahap dulu menambah catatan `system`
 *  sendiri sehingga model menerima 2-3 catatan bersaudara. Sekarang jumlahnya
 *  diakumulasi dan catatan lama diganti. */
function catatanPotong(kepala, tambahan, teks) {
  // Ketiga tahap memakai bentuk "(…: N pesan …)" walau kalimatnya beda; yang
  // diambil hanya angkanya. Awalan dicocokkan ketat supaya pesan system milik
  // pengguna yang kebetulan memuat "N pesan" tidak ikut dihitung.
  const POLA = /^\((?:percakapan sebelumnya dipotong|konteks dipotong|konteks dipadatkan)[^)]*?(\d+)\s+pesan/;
  let total = tambahan;
  for (const row of kepala) {
    if (row.role !== 'system') continue;
    const cocok = String(row.content || '').match(POLA);
    if (cocok) total += Number(cocok[1]);
  }
  const sisa = kepala.filter((row) => row.role !== 'system' || !POLA.test(String(row.content || '')));
  return [...sisa, { role: 'system', content: '(' + teks(total) + ')' }];
}

/* ------------------------------------------------ ringkasan berlapis --- */

const POLA_BERKAS = /(?:^|[\s"'`(=])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:js|mjs|cjs|ts|tsx|py|rb|php|json|md|sh|bash|ya?ml|sql|html|css|toml))\b/g;
const AWALAN_RINGKASAN = 'RINGKASAN KONTEKS';
const BATAS_RINGKASAN = 2000;

function dorong(keluar, nilai, batas) {
  const teks = String(nilai || '').replace(/\s+/g, ' ').trim();
  if (!teks || keluar.includes(teks) || keluar.length >= batas) return keluar;
  keluar.push(teks);
  return keluar;
}

/**
 * Lapisan kedua pemadatan konteks (codex "compact"): sebelum pesan lama
 * DIBUANG, saring dulu yang masih berguna - permintaan pengguna, berkas yang
 * disentuh, perintah yang dijalankan, galat yang muncul - jadi satu blok
 * ringkasan. Deterministik, tanpa panggilan model: nol biaya, bisa diuji.
 * ponytail: ekstraktif, bukan abstraktif. Ganti ke ringkasan model kalau
 * ringkasan ekstraktif terbukti kehilangan alur keputusan.
 */
export function ringkasEkstraktif(messages, { maksBerkas = 12, maksPerintah = 6, maksGalat = 4, maksPermintaan = 5, potong = 160 } = {}) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const berkas = [];
  const perintah = [];
  const galat = [];
  const permintaan = [];
  for (const row of messages) {
    const isi = typeof row.content === 'string' ? row.content : '';
    ambilBerkas(isi, berkas);
    if (row.role === 'user') {
      dorong(permintaan, isi.slice(0, potong), maksPermintaan);
    } else if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const panggil of row.tool_calls) {
        const mentah = String(panggil?.function?.arguments || '');
        ambilBerkas(mentah, berkas);
        const cocok = mentah.match(/"(?:perintah|command|cmd|skrip|script)"\s*:\s*"((?:[^"\\]|\\.){1,200})"/);
        if (cocok) dorong(perintah, cocok[1].replace(/\\n/g, ' ; '), maksPerintah);
      }
    } else if (row.role === 'tool') {
      for (const baris of isi.split('\n')) {
        if (/GAGAL \(\d+\)|exit=\d+|\bError:|\bTraceback\b|\bENOENT\b/.test(baris)) dorong(galat, baris.slice(0, potong), maksGalat);
      }
    }
  }
  const bagian = [];
  if (permintaan.length) bagian.push('permintaan: ' + permintaan.join(' | '));
  if (berkas.length) bagian.push('berkas: ' + berkas.slice(0, maksBerkas).join(', '));
  if (perintah.length) bagian.push('perintah: ' + perintah.join(' ; '));
  if (galat.length) bagian.push('galat: ' + galat.join(' | '));
  return bagian.join('\n');
}

function ambilBerkas(teks, keluar) {
  for (const cocok of String(teks || '').matchAll(POLA_BERKAS)) {
    const jalur = cocok[1];
    if (jalur.length > 3 && !keluar.includes(jalur) && keluar.length < 12) keluar.push(jalur);
  }
  return keluar;
}

/** Satu blok ringkasan saja: yang lama digabung, bagian tertua dibuang lebih dulu. */
function sisipRingkasan(kepala, baru) {
  const lama = kepala.filter((row) => row.role === 'system' && String(row.content || '').startsWith(AWALAN_RINGKASAN));
  const sisa = kepala.filter((row) => !lama.includes(row));
  const isi = [...lama.map((row) => String(row.content).slice(AWALAN_RINGKASAN.length).replace(/^:\n?/, '')), baru].join('\n');
  const teks = isi.length > BATAS_RINGKASAN ? '…' + isi.slice(-BATAS_RINGKASAN) : isi;
  return [...sisa, { role: 'system', content: AWALAN_RINGKASAN + ':\n' + teks }];
}

/** Potong riwayat lama, sisakan pasangan alat-pesan yang utuh. maks = 0 -> tanpa potong. */
export function potongRiwayat(messages, maks = 0) {
  if (!Array.isArray(messages)) return [];
  if (!(maks > 0) || messages.length <= maks) return messages;
  const { kepala, badan } = pisahKepala(messages);
  const sisa = badan.slice(-maks);
  // Jangan mulai dari pesan `tool` tanpa panggilan sebelumnya.
  while (sisa.length && sisa[0].role === 'tool') sisa.shift();
  const dibuang = Math.max(0, badan.length - sisa.length);
  const note = catatanPotong(kepala, dibuang, (n) => 'percakapan sebelumnya dipotong; ' + n + ' pesan lama tidak ikut');
  return [...note, ...sisa];
}

/**
 * Buang `tool` yang panggilannya sudah tidak ada. API menolak riwayat dengan
 * hasil alat tanpa pasangan tool_calls; pemangkas yang membuang pesan assistant
 * bisa meninggalkannya di ujung.
 */
function buangToolYatim(rows) {
  const hasil = Array.isArray(rows) ? rows.slice() : [];
  const dikenal = new Set();
  for (const row of hasil) {
    if (row && row.role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const panggil of row.tool_calls) if (panggil && panggil.id) dikenal.add(String(panggil.id));
    }
  }
  while (hasil.length && hasil[hasil.length - 1].role === 'tool') {
    const row = hasil[hasil.length - 1];
    if (row.tool_call_id && dikenal.has(String(row.tool_call_id))) break;
    hasil.pop();
  }
  while (hasil.length && hasil[0].role === 'tool') hasil.shift();
  return hasil;
}

/**
 * Batas konteks berbasis TOKEN (bukan jumlah pesan): jumlah pesan tidak tahu
 * apakah satu pesan itu 20 token atau 20.000. Buang pesan tertua sampai
 * perkiraan token muat, dengan aturan yang sama seperti potongRiwayat:
 * pesan system dipertahankan, hasil alat tidak boleh kehilangan panggilannya,
 * dan pesan terbaru tidak disentuh. batas = 0 -> utuh.
 */
export function potongPerToken(messages, batas = 0) {
  if (!Array.isArray(messages)) return [];
  if (!(batas > 0)) return messages;
  if (kiraPesan(messages) <= batas) return messages;
  const { kepala, badan: badanFull } = pisahKepala(messages);
  // Anggaran riwayat = batas DIKURANGI token prompt-kepala (system): dulu
  // kepala diabaikan, sehingga giliran yang menyusun prompt di kirim (petunjuk
  // proyek, keahlian, memory) selalu melebihi batas token. Prompt stabil saja
  // bisa >3000 token di cwd dengan banyak petunjuk - harus dihitung juga.
  const anggaran = batas - kiraPesan(kepala);
  let badan = badanFull;
  if (anggaran <= 0) {
    // Kepala sendiri sudah melebihi batas. Yang masih bisa dipertahankan hanya
    // pesan terakhir (giliran yang sedang dijawab) + catatan; sisa riwayat dibuang.
    const sisa = buangToolYatim(badanFull.slice(-1));
    const dibuang = Math.max(0, badanFull.length - sisa.length);
    // Kepala TIDAK PERNAH dibuang: dulu `note = []` membuat system prompt
    // (aturan kerja, petunjuk proyek) hilang sama sekali dari permintaan.
    let note = kepala;
    if (!badanFull.length) return [...kepala];
    if (dibuang > 0) {
      note = catatanPotong(kepala, dibuang, (n) =>
        'konteks dipotong: ' + n + ' pesan lama tidak ikut; sisa ~' + kiraPesan([...kepala, ...sisa]) + ' token');
      const ringkas = ringkasEkstraktif(badanFull.slice(0, dibuang));
      if (ringkas) note = sisipRingkasan(note, ringkas);
    }
    return [...pangkasNote(note, batas - kiraPesan(sisa)), ...sisa];
  }
  let dibuang = 0;
  const buang = [];
  const CATATAN_MIN = Math.min(200, Math.max(12, Math.floor(batas * 0.25))); // ruang catatan/ringkasan
  // Selalu sisakan pesan terakhir dan semua pesan system: itu giliran yang
  // sedang dijawab dan instruksi yang tidak boleh hilang. Catatan pemotongan
  // BELUM dihitung di sini; ia dipangkas lebih dulu sebelum riwayat asli
  // dikorbankan - catatan itu buatan kita, riwayat itu isi percakapan.
  while (badan.length > 1 && kiraPesan([...kepala, ...badan]) + CATATAN_MIN > batas) {
    const i = badan.findIndex((m, idx) => idx < badan.length - 1 && m.role !== 'system');
    if (i < 0) break;
    buang.push(badan[i]);
    badan = [...badan.slice(0, i), ...badan.slice(i + 1)];
    dibuang += 1;
    // Jangan mulai dari hasil alat tanpa panggilan sebelumnya.
    while (i < badan.length - 1 && badan[i].role === 'tool') { buang.push(badan[i]); badan = [...badan.slice(0, i), ...badan.slice(i + 1)]; dibuang += 1; }
  }
  if (!dibuang) return messages;
  const buatCatatan = () => {
    let note = catatanPotong(kepala, dibuang, (n) =>
      'konteks dipotong: ' + n + ' pesan lama tidak ikut; sisa ~' + kiraPesan([...kepala, ...badan]) + ' token');
    // Lapisan kedua: yang dibuang disaring dulu, bukan hilang begitu saja.
    const ringkas = ringkasEkstraktif(buang);
    if (ringkas) note = sisipRingkasan(note, ringkas);
    return note;
  };
  let note = buatCatatan();
  // Catatan + ringkasan menambah token. Pangkas CATATAN dulu (bisa dipendekkan
  // sampai hilang); baru kalau masih tidak muat, buang pesan asli berikutnya.
  // Urutan ini penting: dulu catatan yang besar memaksa seluruh riwayat dibuang
  // padahal catatan itu sendiri bisa dipendekkan.
  if (kiraPesan([...note, ...badan]) > batas) note = pangkasNote(note, batas - kiraPesan(badan));
  while (badan.length > 1 && kiraPesan([...note, ...badan]) > batas) {
    const i = badan.findIndex((m, idx) => idx < badan.length - 1 && m.role !== 'system');
    if (i < 0) break;
    buang.push(badan[i]);
    badan = [...badan.slice(0, i), ...badan.slice(i + 1)];
    dibuang += 1;
    while (i < badan.length - 1 && badan[i].role === 'tool') { buang.push(badan[i]); badan = [...badan.slice(0, i), ...badan.slice(i + 1)]; dibuang += 1; }
    note = buatCatatan();
    if (kiraPesan([...note, ...badan]) > batas) note = pangkasNote(note, batas - kiraPesan(badan));
  }
  // Badan sudah tidak bisa dipangkas lagi (tinggal pesan terakhir), tetapi
  // catatan + ringkasan bisa jadi lebih besar dari batas itu sendiri. Pangkas
  // baris catatan/ringkasan (system buatan pemangkas, bukan system asli user)
  // supaya total benar-benar muat. Pesan terakhir tidak pernah disentuh.
  if (kiraPesan([...note, ...badan]) > batas) note = pangkasNote(note, batas - kiraPesan(badan));
  badan = buangToolYatim(badan);
  return [...note, ...badan];
}

/**
 * Pangkas prompt STABIL sampai muat sisa anggaran token setelah kepala dipakai.
 * Buang blok yang bisa dicari ulang model lewat alatnya (keahlian, ingatan,
 * tugas) lebih dulu; aturan kerja di awal tidak pernah dibuang; terakhir ekor
 * teks dipotong dengan penanda jujur.
 */
function potongStabil(stabil, anggaran) {
  const plafon = Math.max(128, Math.floor(Number(anggaran) || 0));
  const muat = (teks) => kiraPesan([{ role: 'system', content: teks }]) <= plafon;
  let s = String(stabil || '');
  if (muat(s)) return s;
  // Urutan = yang dibuang LEBIH DULU saat prompt kepenuhan. Pelajaran ada di
  // akhir: pengalaman kerja paling mahal untuk ditemukan ulang.
  const BUANG_DULU = ['KEAHLIAN TERPASANG', 'INGATAN DARI SESI SEBELUMNYA', 'INGATAN INTI', 'TUGAS TERSIMPAN', 'TENTANG ORANG YANG KAMU BANTU', 'PELAJARAN DARI GILIRAN SEBELUMNYA'];
  for (const judul of BUANG_DULU) {
    const pola = new RegExp('\n?' + judul + '[\s\S]*?(?=\n\n[A-Z][A-Z 0-9]*\n|$)', '');
    const tanpa = s.replace(pola, '\n(' + judul.toLowerCase() + ': dihilangkan karena batas token - baca lewat alatnya)');
    if (tanpa !== s && muat(tanpa)) return tanpa;
    s = tanpa;
  }
  // Terakhir: potong ekor. Aturan kerja di kepala tetap utuh.
  const maksHuruf = Math.max(256, plafon * 4 - 128);
  return s.slice(0, maksHuruf) + '\n[...prompt dipotong: batas token]';
}

/**
 * Rampingkan blok ringkasan sampai `target` huruf tanpa membuang berkas lebih
 * dulu: item `permintaan`/`perintah`/`galat` dipangkas dari ekor, baru berkas.
 * Memotong mentah dari ujung (cara lama) menghapus baris berkas seluruhnya
 * padahal berkas justru bagian yang paling sering dipakai melanjutkan kerja.
 */
function rampingRingkasan(isi, target) {
  const AWA = AWALAN_RINGKASAN + ':\n';
  if (!isi.startsWith(AWA) || isi.length <= target) return isi;
  const baris = isi.slice(AWA.length).split('\n').filter(Boolean);
  const total = () => AWA.length + baris.join('\n').length;
  const pendekkan = (i, pisah) => {
    const bagian = baris[i].split(pisah);
    if (bagian.length > 2) { bagian.pop(); baris[i] = bagian.join(pisah); return true; }
    if (bagian.length === 2) {
      const kepala = bagian[0] + pisah;
      const isiSatu = bagian[1];
      if (isiSatu.length > 12) { baris[i] = kepala + isiSatu.slice(0, Math.floor(isiSatu.length / 2)) + '…'; return true; }
    }
    baris.splice(i, 1);
    return true;
  };
  for (const [pola, pisah] of [[/^permintaan:\s*/, ' | '], [/^perintah:\s*/, ' ; '], [/^galat:\s*/, ' | ']]) {
    let i = baris.findIndex((satu) => pola.test(satu));
    while (i >= 0 && total() > target) {
      pendekkan(i, pisah);
      i = baris.findIndex((satu) => pola.test(satu));
    }
  }
  while (total() > target) {
    const i = baris.findIndex((satu) => /^berkas:\s*/.test(satu));
    if (i < 0) break;
    const bagian = baris[i].split(', ');
    if (bagian.length > 1) { bagian.pop(); baris[i] = bagian.join(', '); }
    else {
      const isiSatu = baris[i].replace(/^berkas:\s*/, '');
      if (isiSatu.length <= 6) { baris.splice(i, 1); break; }
      baris[i] = 'berkas: ' + isiSatu.slice(0, Math.floor(isiSatu.length / 2)) + '…';
    }
  }
  while (baris.length && total() > target) baris.pop();
  const hasil = AWA + baris.join('\n');
  return hasil.length <= target ? hasil : isi.slice(0, target) + '…';
}

/** Pangkas baris catatan/ringkasan buatan pemangkas sampai muat anggaran token.
 *  Baris system asli pengguna TIDAK disentuh: hanya dua bentuk buatan kita yang
 *  dikenali - catatan `(... N pesan ...)` dan ringkasan `RINGKASAN KONTEKS:`. */
function pangkasNote(note, anggaran) {
  const POLA_CATATAN = /^\((?:percakapan sebelumnya dipotong|konteks dipotong|konteks dipadatkan)/;
  const bisaDipotong = (row) => row.role === 'system' && (POLA_CATATAN.test(String(row.content || '')) || String(row.content || '').startsWith(AWALAN_RINGKASAN + ':'));
  const keluar = note.map((row) => ({ ...row }));
  if (anggaran <= 0) return keluar.filter((row) => !bisaDipotong(row));
  let langkah = 0;
  while (kiraPesan(keluar) > anggaran && langkah++ < 200 && keluar.length) {
    let j = keluar.length - 1;
    while (j >= 0 && !bisaDipotong(keluar[j])) j -= 1;
    if (j < 0) break;
    const isi = String(keluar[j].content || '');
    // Jaga penanda `RINGKASAN KONTEKS:` tetap utuh: baris `bisaDipotong` dikenali
    // dari awalan ini, dan pembacaan ringkas ikut memakainya. Kalau isi
    // diringkas naif, awalan terpotong jadi `RINGKASAN KO…` dan barisnya
    // hilang dari pandangan. Badan isi (tanpa awalan) yang dipotong.
    const AWA = AWALAN_RINGKASAN + ':\n';
    const berawalan = isi.startsWith(AWALAN_RINGKASAN + ':');
    // Ringkasan: rampingkan per bagian dulu, jangan potong dari ujung.
    if (berawalan) {
      const lebih = Math.max(0, kiraPesan(keluar) - anggaran) * 4;
      const baru = rampingRingkasan(isi, Math.max(AWA.length + 8, isi.length - Math.max(8, lebih)));
      if (baru !== isi) { keluar[j] = { ...keluar[j], content: baru }; continue; }
    }
    const badan = berawalan ? isi.slice(AWA.length) : isi;
    if (badan.length <= 6) { keluar.splice(j, 1); continue; }
    const pendek = Math.floor(badan.length / 2);
    // n <= 1 tidak menyusut karena satu huruf + '…' tetap dua karakter.
    if (pendek <= 1) { keluar.splice(j, 1); continue; }
    keluar[j] = { ...keluar[j], content: (berawalan ? AWA : '') + badan.slice(0, pendek) + '…' };
  }
  return keluar;
}

/**
 * Baris riwayat yang AMAN dikirim ke API: hanya field protokol. `nalar` (isi
 * penalaran) disimpan di sesi untuk ditampilkan, tapi provider tidak mengenal
 * field itu - mengirimnya bisa ditolak atau membingungkan model.
 */
export function barisAman(row) {
  if (!row || typeof row !== 'object' || !row.role) return null;
  const keluar = { role: row.role };
  if (row.content !== undefined) keluar.content = row.content;
  if (Array.isArray(row.tool_calls)) keluar.tool_calls = row.tool_calls;
  if (row.tool_call_id) keluar.tool_call_id = row.tool_call_id;
  if (row.name) keluar.name = row.name;
  return keluar;
}

function uraiArgumen(teks) {
  const isi = String(teks || '').trim();
  if (!isi) return {};
  try {
    const nilai = JSON.parse(isi);
    return nilai && typeof nilai === 'object' ? nilai : { nilai };
  } catch {
    return { __galat: 'argumen bukan JSON: ' + isi.slice(0, 200) };
  }
}

/* --------------------------------------------- alat bersamaan --------- */

// Alat yang boleh berjalan BERSAMAAN dalam satu balasan. Hanya agen (subagen /
// rekan bot) dan pembacaan murni: keduanya tidak saling menimpa. Alat yang
// menulis disk/state (tulis, edit, hapus, terminal, jalankan, rencana, ingatan,
// mind, ...) tetap BERURUTAN - urutan itu yang membuat sunting berlapis benar
// dan penulisan state tidak saling menimpa hasil baca-lalu-tulis.
const ALAT_AGEN = new Set(['delegasi', 'panggil']);
const ALAT_BACA = new Set(['status', 'daftar', 'baca', 'cari', 'diff', 'web', 'cariweb', 'pdf', 'petunjuk']);

export function paralelAman(nama) {
  const kunci = String(nama || '');
  return ALAT_AGEN.has(kunci) || ALAT_BACA.has(kunci);
}

/** Worker untuk satu gelombang panggilan alat: ctx.worker menang, lalu env. */
export function workerGiliran(ctx, konf, jumlah) {
  const pilihan = ctx && ctx.worker != null ? ctx.worker : (konf && konf.worker);
  return workerSubagen(pilihan, jumlah);
}

/**
 * Jalankan satu giliran percakapan.
 * opsi: {pesan, riwayat, ctx, konfModel, sesi (id), onDelta, onAlat, diam}
 * -> {teks, pesan (riwayat baru), langkah, galat?}
 */
export async function giliran(opsi) {
  const ctx = opsi.ctx || konteks();
  // Room: selama giliran berjalan, panggilan antar-bot yang masuk di-antrekan
  // (alat `panggil` melihat penanda ini). Selesai -> penanda dicabut, TUI/CLI
  // menjalankan antreannya. Tanpa ini panggilan bersarang menimpa riwayat sesi.
  const roomSibuk = opsi.sesiId && !opsi.diluarRoom;
  if (roomSibuk) setelPanggilSibuk(opsi.sesiId, true);
  // Biaya token giliran ini: usage dari endpoint kalau ada, kalau tidak dikira-kira.
  const biaya = { prompt: 0, completion: 0, giliran: 0, perkiraan: false };
  try {
  // ponytail: tanpa batas langkah. Penghenti = model berhenti atau sinyal abort.
  // Alat dari server MCP disiapkan SEBELUM prompt disusun: nama alatnya ikut
  // masuk prompt sistem. Server yang mati cuma dicatat, tidak menggagalkan giliran.
  let ekstraMcp = [];
  try { ekstraMcp = bungkusAlat(await siapkanAlatMcp()); } catch { ekstraMcp = []; }
  // Pesan lanjutan ("lakukan", "iya") tidak memuat topik, jadi keahlian dicari
  // dari pesan terakhir pengguna juga - kalau tidak, skill hilang di tengah tugas.
  const jejakUser = [...(opsi.riwayat || [])].reverse()
    .filter((row) => row && row.role === 'user' && row.content)
    .map((row) => String(row.content));
  const bahanSkill = [String(opsi.pesan || ''), ...jejakUser].find((teks) => {
    try { return skillCocok(teks).length > 0; } catch { return false; }
  }) || String(opsi.pesan || '');
  const aktif = opsi.keahlian === false ? '' : keahlianAktif(bahanSkill);
  const { stabil, volatil } = bagianPrompt(ctx);
  const dasar = Object.assign({}, opsi.konfModel || {}, opsi.model ? { model: opsi.model } : {});
  // `--alat=baca,cari` / `SAKTI_ALAT`: kirim HANYA skema alat itu ke model.
  // Skema semua alat = ribuan token per panggilan (mayoritas muatan); tugas baca-saja
  // tidak butuh terminal/tulis. Yang disebut bot (`opsi.alat`) menang.
  const sempit = opsi.alat || sempitAlat(dasar);
  // Smart route: satu tingkat anggaran untuk giliran ini, dari kesulitan tugas.
  // Knob yang TIDAK diset pemanggil diisi oleh tingkat itu; yang diset tangan
  // (--effort/--max-tokens/--batas-riwayat/--batas-token, atau ruteTingkat) menang.
  // Rute off = perilaku lama persis.
  const rute = pilihRute({
    konf: dasar,
    pesan: opsi.pesan,
    riwayat: opsi.riwayat,
    rencana: rencanaBerjalan(),
    langkah: 1
  });
  const konf = rute.aktif ? terapkanRute(dasar, rute.nilai) : dasar;
  if (opsi.onRute) { try { opsi.onRute(rute); } catch { /* tampilan tak boleh menggagalkan giliran */ } }
  // Pemangkasan riwayat dilakukan DI SINI, bukan di pemanggil: dulu hanya
  // `putaran` yang memotong, sehingga pemanggil `giliran` mana pun (uji,
  // pemicu, bot, MCP) mengirim seluruh sejarah tanpa batas.
  const riwayatMasuk = potongRiwayat(
    (opsi.riwayat || []).filter((row) => row && row.role && row.role !== 'system')
      .map(barisAman).filter(Boolean),
    batasRiwayatDari(konf)
  );
  // Batas token mencakup prompt stabil juga: kalau prompt-nya sendiri lebih
  // besar dari batas, prompt dipangkas (blok keahlian/ingatan dulu, terakhir
  // ekor). Tanpa ini batas-token diam-diam tidak pernah dipatuhi.
  const batasTok = batasTokenDari(konf);
  let stabilKirim = stabil + (aktif ? '\n\n' + aktif : '') + (opsi.promptEkstra ? '\n\n' + opsi.promptEkstra : '');
  // Anggaran prompt stabil harus menyisakan ruang untuk pesan volatil + pesan
  // pengguna, bukan hanya 8 token: tanpa ini prompt stabil yang hampir penuh
  // membuat total melewati batas begitu ada satu instruksi volatil.
  const pesanUser = String(opsi.pesan || '');
  const cadangan = kiraPesan([
    ...(volatil ? [{ role: 'system', content: volatil }] : []),
    { role: 'user', content: pesanUser }
  ]) + 8;
  if (batasTok > 0 && kiraPesan([{ role: 'system', content: stabilKirim }]) + cadangan > batasTok) {
    stabilKirim = potongStabil(stabilKirim, batasTok - cadangan);
  }
  const messages = [
    { role: 'system', content: stabilKirim },
    ...riwayatMasuk,
    volatil ? { role: 'system', content: volatil } : null,
    { role: 'user', content: String(opsi.pesan || '') }
  // `tool` dengan isi kosong tetap dipertahankan: panggilan alat pasangannya
  // ada di pesan assistant sebelumnya, dan API menolak riwayat yang punya
  // tool_calls tanpa jawaban `tool`. Dulu baris kosong itu dibuang.
  ].filter((row) => row && (row.content !== '' || row.role === 'assistant' || row.role === 'tool'));

  const alat = skemaAlat(sempit, ekstraMcp);
  // Profil DINAMIS (`profilAlat: dinamis` / SAKTI_ALAT_DINAMIS=1): kirim nama +
  // deskripsi satu kalimat + NAMA argumen saja. Skema penuh dimuat on-demand
  // lewat alat meta `alat_muat`. Skema 48 alat ~4,7k token = mayoritas muatan
  // tetap; tugas ringan biasanya butuh 2-4 alat.
  const dinamis = String(dasar.profilAlat || '').toLowerCase() === 'dinamis'
    || /^(1|true|ya)$/i.test(String(process.env.SAKTI_ALAT_DINAMIS || ''));
  const namaArgs = (satu) => {
    const p = satu.parameters && satu.parameters.properties ? Object.keys(satu.parameters.properties) : [];
    return p.length ? ' Argumen: ' + p.join(', ') + '.' : '';
  };
  const skemaPenuh = (nama) => alat.find((satu) => satu.function.name === nama);
  let alatKirim = alat;
  if (dinamis && alat.length > 8) {
    const ringkas = alat.map((satu) => ({
      type: 'function',
      function: {
        name: satu.function.name,
        description: satu.function.description + namaArgs(satu) + ' (argumen ragu? panggil alat_muat)',
        parameters: { type: 'object', properties: {} }
      }
    }));
    ringkas.push({
      type: 'function',
      function: {
        name: 'alat_muat',
        description: 'Muat dokumen parameter LENGKAP untuk alat yang akan kamu pakai (profil alat dinamis). nama = daftar nama alat.',
        parameters: { type: 'object', properties: { nama: { type: 'array', items: { type: 'string' }, description: 'nama alat, mis. ["baca","cari"]' } }, required: ['nama'] }
      }
    });
    alatKirim = ringkas;
  }
  const alatTermuat = new Set();
  const tambahan = [];
  let langkah = 0;
  const maksLangkah = maksLangkahDari(konf);
  // Pendeteksi panggilan identik: tiga panggilan alat yang sama berturut-turut
  // = model mentok, bukan progres. Batas langkah di atas menangani loop yang
  // memvariasikan argumen.
  let sidikTerakhir = '';
  let sidikUlang = 0;
  let kosongUlang = false;

  while (true) {
    if (opsi.sinyal && opsi.sinyal.aborted) return { teks: '', pesan: tambahan, langkah, dibatalkan: true };
    langkah += 1;
    if (maksLangkah > 0 && langkah > maksLangkah) {
      const catatan = 'BATAS LANGKAH (' + maksLangkah + ') tercapai: giliran dihentikan agar konteks tidak terus membengkak. '
        + 'Progres belum tentu tuntas. Lanjutkan di giliran baru (riwayat tersimpan) atau naikkan batas lewat SAKTI_MAKS_LANGKAH.';
      return { teks: catatan, pesan: tambahan, langkah: langkah - 1, galat: 'batas-langkah', biaya };
    }
    // Padatkan isi pesan lama hanya bila ada batas TOKEN: batas pesan menjawab
    // "berapa banyak yang dikirim", sedangkan pemadatan menjawab "seberapa
    // ringkas isi lama" - dulu keduanya memakai angka yang sama, sehingga
    // `--batas-riwayat=10` ikut memadatkan 50 dari 51 pesan jadi cuplikan.
    // Batas token dari RUTE tidak ikut menyalakan pemadatan: yang dipadatkan
    // itu kehilangan isi, dan pemakai yang tidak minta batas token tidak boleh
    // kena efek sampingnya. Rute tetap memotong lewat batasRiwayat + potongPerToken.
    const batasToken = batasTokenDari(konf);
    const batasTokenDiminta = (dasar.eksplisit || []).includes('batasToken');
    const kirim = potongPerToken(
      pangkasHasilLama(kompresRiwayat(messages, { maks: batasToken > 0 && batasTokenDiminta ? batasRiwayatDari(konf) : 0 })),
      batasToken
    );
    let balas;
    try {
      balas = await obrol({
        konf,
        suhu: opsi.suhu,
        messages: kirim,
        tools: alatKirim,
        onDelta: opsi.onDelta,
        onNalar: opsi.onNalar,
        onStatus: opsi.onStatus,
        coba: opsi.coba,
        sinyal: opsi.sinyal
      });
    } catch (galat) {
      if (galat instanceof GalatBatal || (galat && galat.name === 'AbortError')) return { teks: '', pesan: tambahan, langkah, dibatalkan: true, biaya };
      throw galat;
    }

    const satuBiaya = catatBiaya({
      sesiId: opsi.sesiId,
      model: (balas.konf && balas.konf.model) || konf.model,
      usage: balas.usage,
      perkiraan: kiraPesan(kirim)
    });
    biaya.prompt += satuBiaya.prompt;
    biaya.completion += satuBiaya.completion;
    biaya.giliran += 1;
    biaya.perkiraan = biaya.perkiraan || satuBiaya.perkiraan === true;
    if (balas.cadangan) biaya.cadangan = balas.cadangan;
    if (opsi.onBiaya) opsi.onBiaya(satuBiaya);

    const pesanAsisten = { role: 'assistant', content: balas.content || '' };
    // Penalaran disimpan di baris sesi (ditampilkan saat sesi dimuat ulang),
    // tapi `barisAman` membuangnya sebelum dikirim ke model.
    if (balas.nalar) pesanAsisten.nalar = balas.nalar;
    if (balas.toolCalls && balas.toolCalls.length) {
      pesanAsisten.tool_calls = balas.toolCalls.map((satu, i) => ({
        id: satu.id || 'call_' + langkah + '_' + i,
        type: 'function',
        function: { name: satu.name, arguments: satu.arguments }
      }));
    }
    messages.push(barisAman(pesanAsisten));
    tambahan.push(pesanAsisten);

    if (!pesanAsisten.tool_calls) {
      // model bisa berhenti dengan content kosong (mis. setelah tool error
      // atau respons terpotong). Jangan laporkan sukses tanpa jawaban: beri
      // penanda galat supaya pemanggil (panggil/room/TUI) bisa jujur.
      const teks = String(pesanAsisten.content == null ? '' : pesanAsisten.content).trim();
      if (!teks) {
        // Satu dorongan terakhir: provider kadang menutup stream tanpa content
        // setelah hasil alat. Jangan langsung menyerah, tapi jangan mengulang
        // tanpa batas.
        if (!kosongUlang && langkah > 1 && !(opsi.sinyal && opsi.sinyal.aborted)) {
          kosongUlang = true;
          messages.push({ role: 'user', content: 'Jawab hasil pekerjaanmu sekarang, ringkas dan langsung. Jangan memanggil alat lagi kecuali benar-benar perlu.' });
          continue;
        }
        return { teks: '', pesan: tambahan, langkah, galat: 'kosong', biaya, rute: rute.aktif ? rute.tingkat : '' };
      }
      return { teks: pesanAsisten.content, pesan: tambahan, langkah, biaya, rute: rute.aktif ? rute.tingkat : '' };
    }

    // Model menyentuh alat = tugas terbukti bukan tanya-jawab ringan. Naikkan
    // tingkat di sini supaya ruang jawaban dan potongan riwayat putaran berikut
    // ikut naik. Tingkat yang dipatok tangan (ruteTingkat) tidak digeser.
    // Pesan ringan sudah dapat 'minimal' di putaran 1; begitu model memakai
    // alat, eskalasi tetap menyala dari sini.
    if (!rute.dipatok && pesanAsisten.tool_calls && rute.tingkat !== 'high' && rute.tingkat !== 'ultra') {
      // putaran berikutnya = langkah + 1: di sinilah alat sudah dipakai sekali
      const naik = pilihRute({ konf: dasar, pesan: opsi.pesan, riwayat: opsi.riwayat, rencana: rencanaBerjalan(), langkah: langkah + 1 });
      if (naik.tingkat !== rute.tingkat) {
        Object.assign(rute, naik);
        Object.assign(konf, terapkanRute(dasar, naik.nilai));
        if (opsi.onRute) { try { opsi.onRute(rute); } catch { /* tampilan tak boleh menggagalkan giliran */ } }
      }
    }

    const sidik = pesanAsisten.tool_calls.map((satu) => satu.function.name + '(' + satu.function.arguments + ')').join('|');
    if (sidik === sidikTerakhir) sidikUlang += 1; else { sidikTerakhir = sidik; sidikUlang = 1; }
    if (sidikUlang >= 3) {
      const catatan = 'berhenti: panggilan alat yang sama diulang 3x tanpa hasil baru (' + pesanAsisten.tool_calls[0].function.name + '). Ubah pendekatan atau kirim instruksi baru.';
      // Tutup panggilan yang belum dijalankan: assistant dengan tool_calls
      // tanpa pesan `tool` membuat SEMUA giliran berikutnya ditolak API.
      for (const panggilan of pesanAsisten.tool_calls) {
        const row = { role: 'tool', tool_call_id: panggilan.id, name: panggilan.function.name, content: 'DIBATALKAN: panggilan berulang tanpa hasil baru.' };
        messages.push(row);
        tambahan.push(row);
      }
      tambahan.push({ role: 'assistant', content: catatan });
      return { teks: catatan, pesan: tambahan, langkah, galat: 'alat-berulang', biaya };
    }

    // Satu balasan boleh memuat beberapa panggilan alat. Agen (delegasi/panggil)
    // dan pembacaan dijalankan BERSAMAAN sebanyak worker; begitu ada satu alat
    // yang menulis, SELURUH balasan dijalankan berurutan supaya sunting berlapis
    // dan urutan perintah tidak berubah diam-diam.
    const jalankanSatu = async (panggilan) => {
      const argumen = uraiArgumen(panggilan.function.arguments);
      let hasil;
      if (argumen.__galat) {
        hasil = 'GAGAL: ' + argumen.__galat;
      } else if (panggilan.function.name === 'alat_muat') {
        // Alat meta profil dinamis: muat skema penuh alat yang diminta. Panggilan
        // berikutnya dalam giliran ini mengirim skema lengkapnya.
        const minta = Array.isArray(argumen.nama) ? argumen.nama : String(argumen.nama || '').split(',').map((s) => s.trim()).filter(Boolean);
        const dokumen = [];
        for (const nama of minta) {
          const penuh = skemaPenuh(String(nama));
          if (!penuh) { dokumen.push(nama + ': tidak dikenal'); continue; }
          alatTermuat.add(penuh.function.name);
          // GANTI versi ringkas dengan skema penuh (bukan menambah dua-duanya).
          const idx = alatKirim.findIndex((satu) => satu.function.name === penuh.function.name);
          if (idx >= 0) alatKirim[idx] = penuh; else alatKirim.push(penuh);
          dokumen.push(penuh.function.name + ': ' + penuh.function.description + (penuh.function.parameters ? '\n' + JSON.stringify(penuh.function.parameters) : ''));
        }
        hasil = dokumen.join('\n\n') || 'tidak ada nama alat';
      } else {
        if (opsi.onAlat) opsi.onAlat(panggilan.function.name, argumen);
        const keputusan = await mintaIzin(panggilan.function.name, argumen, {
          mode: opsi.modeIzin,
          tanya: opsi.tanyaIzin,
          sinyal: opsi.sinyal
        });
        if (keputusan.izin === 'tolak') {
          hasil = keputusan.alasan;
        } else {
          hasil = await jalankanAlat(panggilan.function.name, argumen, Object.assign({}, ctx, {
            sinyal: opsi.sinyal,
            sesiId: opsi.sesiId,
            // Bot yang dipanggil mewarisi kebijakan izin pemanggil. Tanpa ini
            // `panggil` selalu auto dan melewati approval pengguna.
            modeIzin: opsi.modeIzin,
            tanyaIzin: opsi.tanyaIzin,
            // Status/alat dari alat yang menjalankan agen lain boleh naik ke UI.
            onStatus: opsi.onStatus,
            // Identitas bot yang sedang bekerja: dipakai alat kirim/panggil/kotak
            // supaya pesan antar-bot punya pengirim yang jelas (sentByAgentId).
            ...(opsi.label ? { botAktif: String(opsi.label) } : {})
          }));
        }
      }
      const pesanAlat = { role: 'tool', tool_call_id: panggilan.id, name: panggilan.function.name, content: String(hasil == null ? '' : hasil) };
      // Dilaporkan di sini, bukan setelah gelombang selesai: hasil yang sudah
      // jadi langsung tampil, tidak menunggu subagen terlama.
      if (opsi.onHasilAlat) opsi.onHasilAlat(panggilan.function.name, pesanAlat.content);
      return pesanAlat;
    };

    const daftarPanggil = pesanAsisten.tool_calls;
    const bersamaan = daftarPanggil.length > 1 && daftarPanggil.every((satu) => paralelAman(satu.function.name));
    let hasilPanggil = [];
    if (bersamaan) {
      const batas = workerGiliran(ctx, konf, daftarPanggil.length);
      const mentah = await jalankanParalel(
        daftarPanggil.map((panggilan) => () => jalankanSatu(panggilan)),
        { worker: batas, sinyal: opsi.sinyal }
      );
      hasilPanggil = mentah.map((satu, i) => (satu && satu.ok ? satu.hasil : {
        role: 'tool',
        tool_call_id: daftarPanggil[i].id,
        name: daftarPanggil[i].function.name,
        content: 'GAGAL: ' + ((satu && satu.galat) || 'tidak dijalankan')
      }));
    } else {
      for (const panggilan of daftarPanggil) {
        if (opsi.sinyal && opsi.sinyal.aborted) {
          // Simpan hasil yang SUDAH jalan + tutup sisanya, supaya riwayat tidak
          // menyimpan assistant tool_calls tanpa jawaban (API menolak).
          for (const row of hasilPanggil) { messages.push(row); tambahan.push(row); }
          const sudah = new Set(hasilPanggil.map((row) => String(row.tool_call_id)));
          for (const sisa of daftarPanggil) {
            if (sudah.has(String(sisa.id))) continue;
            const row = { role: 'tool', tool_call_id: sisa.id, name: sisa.function.name, content: 'DIBATALKAN: giliran dihentikan sebelum alat ini dijalankan.' };
            messages.push(row);
            tambahan.push(row);
          }
          return { teks: '', pesan: tambahan, langkah, dibatalkan: true, biaya };
        }
        hasilPanggil.push(await jalankanSatu(panggilan));
      }
    }
    for (const pesanAlat of hasilPanggil) {
      messages.push(pesanAlat);
      tambahan.push(pesanAlat);
    }
  }
  } finally {
    if (roomSibuk) setelPanggilSibuk(opsi.sesiId, false);
  }
}
/** Berapa langkah rencana yang masih terbuka - sinyal bahwa giliran ini bagian
 *  dari pekerjaan bertingkat, bukan tanya-jawab satu baris. 0 kalau tak ada. */
export function rencanaBerjalan() {
  try {
    return (bacaRencana() || []).filter((row) => row && row.status !== 'completed' && row.status !== 'cancelled').length;
  } catch { return 0; }
}

/** Riwayat dari berkas sesi, siap dikirim ke model. */
export function riwayatSesi(sesiId) {
  return bacaSesi(sesiId)
    .filter((row) => ['user', 'assistant', 'tool'].includes(row.role))
    .map((row) => {
      let isi = row.content || '';
      // Di room, beberapa bot menjawab giliran yang sama. Tanpa label, model
      // mengira jawaban bot lain adalah jawabannya sendiri.
      if (row.bot && row.role === 'assistant' && isi) isi = '[' + row.bot + '] ' + isi;
      const pesan = { role: row.role, content: isi };
      if (row.tool_calls) pesan.tool_calls = row.tool_calls;
      if (row.tool_call_id) pesan.tool_call_id = row.tool_call_id;
      if (row.name) pesan.name = row.name;
      return pesan;
    });
}

/**
 * Satu giliran LENGKAP dengan pembukuan sesi: potong riwayat, simpan pesan
 * pengguna, jalankan agen, simpan semua pesan baru. Dipakai mode REPL, mode
 * workspace, dan `sakti run` - satu jalur, tidak ada tiga salinan.
 */
/**
 * Subset alat untuk satu giliran: `--alat=baca,cari` / `SAKTI_ALAT` / config
 * `alat`. Skema semua alat ribuan token tiap panggilan; tugas baca-saja tidak
 * butuh terminal/tulis. Nama asing DIBUANG di sini (bukan menggagalkan
 * giliran) - `sakti alat ada a,b,c` yang memvonisnya di baris perintah.
 * Kosong/tak diset -> undefined = semua alat (perilaku lama).
 */
/**
 * Profil alat: cara cepat memangkas skema tanpa mendaftar satu per satu.
 * `penuh` = semua (bawaan lama). `standar` = kerja sehari-hari tanpa alat
 * media/berat. `ringan` = baca-tulis-jalan saja (hemat ~3k token/panggilan).
 */
export const PROFIL_ALAT = {
  ringan: ['status', 'daftar', 'baca', 'cari', 'tulis', 'edit', 'terminal', 'uji', 'node', 'py', 'web', 'rencana', 'ingatan', 'skill'],
  standar: ['status', 'daftar', 'baca', 'cari', 'tulis', 'edit', 'terminal', 'uji', 'node', 'py', 'web', 'rencana', 'ingatan', 'skill',
    'git', 'http', 'db', 'layanan', 'paket', 'lint', 'env', 'json', 'csv', 'diff', 'tugas', 'mind', 'biaya', 'petunjuk', 'panggil', 'mcp'],
  penuh: null
};

export function profilSah(nama) {
  const teks = String(nama == null ? '' : nama).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFIL_ALAT, teks) ? teks : '';
}

export function sempitAlat(konf = {}) {
  const mentah = konf && konf.alat != null ? konf.alat : process.env.SAKTI_ALAT;
  // Profil hanya dipakai bila tidak ada daftar eksplisit: `--alat=baca,cari`
  // tetap menang supaya kontrol per-panggilan tidak dikalahkan setelan.
  const profil = profilSah((konf && konf.profilAlat) || process.env.SAKTI_PROFIL_ALAT);
  if ((mentah == null || mentah === '' || mentah === true) && profil && PROFIL_ALAT[profil]) {
    return PROFIL_ALAT[profil].filter((nama) => cariAlat(nama));
  }
  if (mentah == null || mentah === '' || mentah === true) return undefined;
  const daftar = Array.isArray(mentah) ? mentah : String(mentah).split(',');
  // Alias ikut diresolusi (`--alat=python,node` harus hidup): satu sumber
  // kebenaran dengan cariAlat, bukan daftar nama terpisah yang bisa menyimpang.
  const hasil = daftar.map((satu) => String(satu).trim())
    .map((satu) => (satu && cariAlat(satu) ? cariAlat(satu).name : ''))
    .filter(Boolean);
  return hasil.length ? hasil : undefined;
}

/** Batas pesan riwayat yang dikirim ke model.
 *  Nilai tak sah (0, negatif, sampah) jatuh ke bawaan 40 - BUKAN ke 0, karena
 *  0 di potongRiwayat/kompresRiwayat berarti "jangan potong" dan itu mematikan
 *  proteksi konteks tanpa suara. Ingin tanpa batas? Pakai angka besar. */
export const BATAS_RIWAYAT_BAWAAN = 40;
// Batas langkah per giliran. Bawaan 0 = TANPA BATAS (keputusan pemilik): agen
// berjalan sampai model berhenti atau dibatalkan. Batas opsional tetap tersedia
// lewat SAKTI_MAKS_LANGKAH / `maksLangkah` / --maks-langkah untuk tugas yang
// pernah terbukti berputar (sesi audit 20261121040013-qc98: 200+ panggilan,
// prompt 32k -> 79k). Nilai 0/off/unlimited = tanpa batas, maksimal 400.
export const MAKS_LANGKAH_BAWAAN = 0;
export function maksLangkahDari(konf = {}) {
  const angkaSah = (nilai) => {
    if (nilai == null || nilai === '') return null;
    const teks = String(nilai).trim().toLowerCase();
    if (['0', 'off', 'false', 'no', 'unlimited', 'tanpa-batas'].includes(teks)) return 0;
    const angka = Math.floor(Number(nilai));
    return Number.isFinite(angka) && angka > 0 ? Math.min(angka, 400) : null;
  };
  const dariKonf = angkaSah(konf.maksLangkah);
  if (dariKonf !== null) return dariKonf;
  const dariEnv = angkaSah(process.env.SAKTI_MAKS_LANGKAH);
  if (dariEnv !== null) return dariEnv;
  return MAKS_LANGKAH_BAWAAN;
}

/** Batas token konteks. 0 = tanpa batas token (hanya batas pesan). */
export function batasTokenDari(konf = {}) {
  const mentah = konf && konf.batasToken != null
    ? konf.batasToken
    : (process.env.SAKTI_BATAS_TOKEN != null ? process.env.SAKTI_BATAS_TOKEN : 0);
  const angka = Math.floor(Number(mentah));
  return Number.isFinite(angka) && angka > 0 ? angka : 0;
}

export function batasRiwayatDari(konf = {}) {
  const mentah = konf && konf.batasRiwayat != null
    ? konf.batasRiwayat
    : (process.env.SAKTI_BATAS_RIWAYAT != null ? process.env.SAKTI_BATAS_RIWAYAT : BATAS_RIWAYAT_BAWAAN);
  const angka = Math.floor(Number(mentah));
  return Number.isFinite(angka) && angka > 0 ? angka : BATAS_RIWAYAT_BAWAAN;
}

export async function putaran({ pesan, sesiId, ctx, konfModel, sinyal, onDelta, onNalar, onAlat, onHasilAlat, onStatus, onBiaya, onRute, coba, promptEkstra, alat, model, suhu, tanpaUser, label, modeIzin, tanyaIzin, keahlian }) {
  // Subagen sengaja TIDAK punya sesi (riwayat bersih). Dulu `tambahPesan`
  // menulis berkas bernama "undefined.jsonl" untuk setiap subagen; sekarang
  // tanpa `sesiId` tidak ada pembukuan sesi sama sekali.
  const idSesi = sesiId == null || sesiId === '' ? null : String(sesiId);
  // Batas riwayat: tanpa ini potongRiwayat menerima maks=0 = tidak memotong
  // sama sekali, dan sesi panjang mengirim seluruh sejarah ke model.
  const batasRiwayat = batasRiwayatDari(konfModel);
  const riwayat = idSesi
    ? potongPerToken(potongRiwayat(riwayatSesi(idSesi), batasRiwayat), batasTokenDari(konfModel))
    : [];
  if (!tanpaUser && idSesi) tambahPesan(idSesi, { role: 'user', content: pesan });
  // Pesan antar-bot yang belum dibaca ikut masuk prompt giliran ini, lalu
  // ditandai dibaca. Hanya bot berlabel; giliran manusia tidak perlu kotak.
  const kotak = label ? ringkasKotak(idSesi || 'global', label) : '';
  const ekstra = [promptEkstra, kotak].filter(Boolean).join('\n\n');
  const hasil = await giliran({ pesan, riwayat, ctx, konfModel, sinyal, onDelta, onNalar, onAlat, onHasilAlat, onStatus, onBiaya, onRute, coba, promptEkstra: ekstra || undefined, alat, model, suhu, sesiId: idSesi, label, modeIzin, tanyaIzin, keahlian });
  if (idSesi) for (const row of hasil.pesan) tambahPesan(idSesi, label ? Object.assign({ bot: label }, row) : row);
  // Pelajaran otomatis: hanya giliran bersesi (subagen/delegasi tidak menulis
  // ingatan), tidak dibatalkan, dan hanya kalau benar-benar memakai alat atau
  // berhenti karena galat. Tanpa panggilan model tambahan - cepat dan gratis.
  if (idSesi && hasil && !hasil.dibatalkan && pelajaranAktif(konfModel)) {
    try {
      const baru = susunPelajaran({ pesan, pesanRows: hasil.pesan, langkah: hasil.langkah, galat: hasil.galat || '' });
      const simpan = baru ? catatPelajaran(baru, { proyek: ctx.cwd }) : null;
      if (simpan) {
        hasil.pelajaran = simpan;
        // Pelajaran yang terbukti berulang naik jadi ingatan inti supaya ikut
        // prompt setiap giliran - bukan tenggelam di 12 slot terbaru.
        if ((Number(simpan.ulangKe) || 1) >= 3) promosikanPelajaran({});
      }
    } catch { /* ingatan tidak boleh menggagalkan giliran */ }
  }
  return hasil;
}
