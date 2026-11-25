// Orkestrasi chatroom: siapa bicara lebih dulu, berapa yang bekerja bersamaan,
// dan jaminan bahwa SETIAP bot yang dipanggil menghasilkan jawaban.
//
// Tiga masalah yang ditutup di sini:
//  1. Urutan bicara dulu mengikuti urutan pendaftaran (urutan berkas di disk),
//     jadi bot bisa menjawab sebelum bot yang tugasnya memang lebih dulu.
//  2. Satu bot gagal = `catch` di luar loop mematikan seluruh giliran, sehingga
//     bot yang belum sempat bicara tidak pernah menjawab.
//  3. Semua bot dijalankan berurutan, jadi 3+ bot menunggu satu per satu.
//
// Sengaja TIDAK memakai abstraksi besar: dua fungsi murni + satu pool kecil.

import { URUTAN_BAWAAN } from './bot.js';
import { bacaState } from './lokal.js';

/** Batas pekerja bersamaan bawaan. 1 = berurutan (satu bot bekerja). */
export const WORKER_BAWAAN = 1;
export const WORKER_MAKS = 12;

/**
 * Worker untuk mode paralel: kalau tidak disebut eksplisit, naik otomatis
 * sampai sebanyak peserta (dibatasi WORKER_MAKS) supaya pekerjaan memang
 * berjalan bersamaan; kalau disebut, tetap dihormati lewat jumlahWorker().
 */
export function workerParalel(nilai, jumlahPeserta) {
  if (nilai == null) return jumlahWorker(jumlahPeserta, jumlahPeserta);
  return jumlahWorker(nilai, jumlahPeserta);
}

/**
 * Berapa bot boleh bekerja bersamaan.
 * Nilai tak sah jatuh ke bawaan (bukan 0 - pool dengan 0 worker menggantung
 * selamanya). Hasil tidak pernah melebihi jumlah peserta, dan tidak pernah < 1.
 */
export function jumlahWorker(nilai, jumlahPeserta) {
  const peserta = Number(jumlahPeserta);
  if (!Number.isFinite(peserta) || peserta < 1) return 0;
  const mentah = nilai == null ? WORKER_BAWAAN : nilai;
  const angka = Math.floor(Number(mentah));
  if (!Number.isFinite(angka) || angka < 1) {
    return Math.min(Math.max(peserta, 1), WORKER_MAKS);
  }
  return Math.min(Math.max(angka, 1), WORKER_MAKS, Math.ceil(peserta));
}

/**
 * Urutkan peserta menurut `urutan` eksplisit; tanpa urutan, PERTAHANKAN urutan
 * masuk room (bukan tugas/abjad). Menerima dua bentuk:
 *  - daftar NAMA (string): datanya dibaca lewat `baca` (mis. bacaBot),
 *  - daftar OBJEK bot: dipakai apa adanya.
 * Sort stabil + indeks masukan memastikan bot yang tidak punya `urutan` tidak
 * berpindah posisi hanya karena namanya kebetulan lebih awal di alfabet.
 */
export function urutkanPeserta(daftar, { baca } = {}) {
  if (!Array.isArray(daftar)) return [];
  const lengkap = daftar.map((satu, indeks) => {
    let data;
    if (satu && typeof satu === 'object') data = satu;
    else {
      const bacaData = typeof baca === 'function' ? baca(String(satu)) : null;
      data = bacaData ? Object.assign({}, bacaData, { nama: bacaData.nama || String(satu) }) : { nama: String(satu) };
    }
    const mentah = data && data.urutan;
    const urutan = mentah == null || mentah === '' || !Number.isFinite(Number(mentah)) ? URUTAN_BAWAAN : Number(mentah);
    return { data, urutan, indeks };
  });
  lengkap.sort((a, b) => (a.urutan - b.urutan) || (a.indeks - b.indeks));
  return lengkap.map((satu) => satu.data);
}

/** Urutkan nama peserta saja (bentuk yang dipakai TUI/CLI): hasilnya array nama
 *  yang sudah berurutan menurut tugas. */
export function urutkanNamaPeserta(daftar, baca) {
  return urutkanPeserta(daftar, { baca }).map((satu) => satu.nama);
}

/**
 * Auto pilih siapa yang bekerja dan bagaimana.
 *
 * Aturan (bawaan: TIM, satu koordinator):
 *  - 0-1 bot di room => bot itu (atau agen tunggal);
 *  - bawaan / `tim` / `otomatis` => SATU koordinator membagi tugas ke rekan
 *    lewat `panggil`; rekan boleh memanggil rekan lain bila tugas di luar peran;
 *  - pesan meminta bot saling menanggapi/menunggu => SEMUA bot, berurutan;
 *  - pesan jelas minta kerja bareng (paralel/bersamaan/semua bot) => SEMUA, paralel;
 *  - `solo` => SATU bot, rekan tetap bisa dipanggil dari dalam giliran.
 *
 * `daftar` (opsional) = nama peserta berurutan; hasil menyertakan `.peserta`
 * supaya pemanggil tidak perlu memotong daftar sendiri.
 */
// `tim` bukan paralel-biasa: satu koordinator memecah kerja dan memanggil rekan
// dengan tugas BERBEDA lewat alat `panggil`, lalu menyatukan hasil. Ini yang
// mencegah semua bot mengulang pekerjaan yang sama.
const KATA_TIM = ['sebagai tim', 'mode tim', 'kerja tim', 'tim bekerja', 'satu tim', 'koordinator', 'pimpin tim', 'bagi tugas', 'berbagi tugas', 'pecah tugas', 'kerja sama', 'kerjasama', 'kolaborasi'];
// Kata tunggal `tim`/`team` butuh batas kata: jangan sampai `estimasi` memicu tim.
const KATA_TIM_RE = /\b(tim|team)\b/i;
const KATA_SERI = ['berurutan', 'serial', 'bergilir', 'bergantian', 'gantian', 'satu-satu', 'satu satu', 'satu per satu', 'menanggapi', 'tanggapi', 'menunggu', 'tunggu', 'dependen', 'bergantung', 'saling balas', 'saling koreksi', 'setelah itu', 'sebelum itu', 'lanjutkan hasil', 'dari hasil bot'];
const KATA_BARENG = ['paralel', 'bersamaan', 'berbarengan', 'bareng', 'sekalian', 'sekaligus', 'semua bot', 'kalian semua', 'seluruh tim', 'semua anggota', 'kerjakan bersama'];

/**
 * Sebutan @bot di pesan (mengikuti pola AgentMentions di Grok Bot).
 * Nama dibandingkan tanpa peduli huruf besar/kecil; `@semua`/`@all`/`@everyone`
 * memilih semua peserta. Nama tak dikenal diabaikan, bukan menahan giliran.
 */
export function sebutanPeserta(pesan, daftar = []) {
  const nama = (Array.isArray(daftar) ? daftar : []).map((satu) => String(satu == null ? '' : satu)).filter(Boolean);
  const hasil = { nama: [], semua: false, tidakDikenal: [] };
  if (!nama.length) return hasil;
  const token = [...String(pesan || '').matchAll(/@([A-Za-z0-9._-]+)/g)].map((cocok) => cocok[1].toLowerCase());
  if (!token.length) return hasil;
  const peta = new Map(nama.map((satu) => [satu.toLowerCase(), satu]));
  const SEMUA = new Set(['semua', 'all', 'everyone', 'kalian']);
  for (const satu of token) {
    if (SEMUA.has(satu)) { hasil.semua = true; continue; }
    if (peta.has(satu)) {
      const asli = peta.get(satu);
      if (!hasil.nama.includes(asli)) hasil.nama.push(asli);
    } else {
      hasil.tidakDikenal.push(satu);
    }
  }
  if (hasil.semua) hasil.nama = nama.slice();
  return hasil;
}

/** Mode room tersimpan: 'tim' (bawaan), 'solo', atau 'otomatis' (alias tim). */
export const MODE_ROOM = ['solo', 'otomatis', 'tim'];
export const MODE_ROOM_BAWAAN = 'tim';

/**
 * Baca mode room dari state. Disimpan terpisah dari daftar peserta supaya
 * `/room otomatis` sekali pasang berlaku untuk semua chatroom di mesin ini.
 * Nilai rusak jatuh ke bawaan, bukan melempar.
 */
export function modeRoomTersimpan() {
  try {
    const nilai = String((bacaState().modeRoom || '')).toLowerCase();
    return MODE_ROOM.includes(nilai) ? nilai : MODE_ROOM_BAWAAN;
  } catch { return MODE_ROOM_BAWAAN; }
}

export function deteksiMode(pesan, jumlahPeserta, daftar = null, opsi = {}) {
  const nama = (Array.isArray(daftar) ? daftar : []).filter((satu) => satu != null && satu !== '');
  const banyak = Number(jumlahPeserta) || nama.length || 0;
  if (banyak <= 1) {
    return { paralel: false, solo: true, peserta: nama.length ? [nama[0]] : [], alasan: 'satu bot saja' };
  }
  const teks = String(pesan || '').toLowerCase();
  const mode = opsi.mode != null ? String(opsi.mode).toLowerCase() : modeRoomTersimpan();
  const seriDiminta = KATA_SERI.some((k) => teks.includes(k));
  const barengDiminta = KATA_BARENG.some((k) => teks.includes(k));
  const timKata = KATA_TIM_RE.test(teks) || KATA_TIM.some((k) => teks.includes(k));
  // `otomatis`/bawaan kini TIM: satu koordinator membagi kerja, bukan semua
  // bot menerima pesan yang sama lalu mengulang. Kata eksplisit menang:
  // "berurutan" = serial semua, "paralel/semua bot" = paralel semua. Tanpa
  // itu, /room tim tidak akan pernah bisa diminta paralel.
  const mintaTim = timKata || ((mode === 'tim' || mode === 'otomatis') && !seriDiminta && !barengDiminta);
  // Sebutan eksplisit menang atas kata kunci mode: yang disebut itulah yang
  // menjawab. Beberapa sebutan berjalan paralel kecuali minta berurutan.
  const sebut = sebutanPeserta(pesan, nama);
  if (sebut.nama.length) {
    const seri = seriDiminta;
    // `@semua` adalah permintaan eksplisit: SEMUA peserta, jangan dikecilkan
    // jadi satu koordinator hanya karena mode room `tim`.
    if (sebut.semua) {
      return { paralel: !seri, solo: false, peserta: nama.slice(), alasan: seri ? '@semua · berurutan' : '@semua · paralel' };
    }
    // `@a @b` + minta tim: jangan jalankan keduanya pada tugas yang sama.
    // Yang disebut pertama jadi koordinator; rekan dipanggil dengan tugas beda.
    if (mintaTim && sebut.nama.length > 1) {
      const koor = sebut.nama[0];
      return { paralel: false, solo: false, tim: true, peserta: [koor], alasan: 'tim · koordinator ' + koor + ' membagi tugas ke ' + sebut.nama.length + ' bot' };
    }
    return {
      paralel: sebut.nama.length > 1 && !seri,
      solo: sebut.nama.length === 1,
      peserta: sebut.nama.slice(),
      alasan: sebut.nama.length > 1
        ? (seri ? '@sebutan · berurutan' : '@sebutan · paralel')
        : '@sebutan'
    };
  }
  if (mintaTim) {
    const koor = nama[0];
    return { paralel: false, solo: false, tim: true, peserta: koor ? [koor] : [], alasan: 'tim · koordinator ' + koor + ' membagi tugas ke ' + nama.length + ' bot' };
  }
  if (KATA_SERI.some((k) => teks.includes(k))) {
    return { paralel: false, solo: false, peserta: nama.length ? nama : [], alasan: 'berurutan (bot saling menanggapi)' };
  }
  if (KATA_BARENG.some((k) => teks.includes(k))) {
    return { paralel: true, solo: false, peserta: nama.length ? nama : [], alasan: 'paralel (pekerjaan dibagi bersamaan)' };
  }
  // Sampai di sini berarti mode solo/otomatis tanpa minta tim, tanpa sebutan,
  // dan tanpa kata serial/paralel: satu bot. `otomatis` sudah ditangani sebagai
  // tim di atas; mode `solo` tetap satu bot dan rekan dipanggil dari giliran.
  return {
    paralel: false,
    solo: true,
    peserta: nama.length ? [nama[0]] : [],
    alasan: 'satu bot (kerja tunggal) · bot lain bisa dipanggil bila tugasnya bercabang'
  };
}

/**
 * Jalankan tugas-tugas dengan paling banyak `worker` yang berjalan bersamaan.
 *
 * - Hasil SELALU sejajar indeks masukan, bukan urutan selesai. Tanpa ini,
 *   jawaban bot yang lebih cepat akan tampil mendahului bot yang seharusnya
 *   bicara lebih dulu.
 * - Satu tugas gagal TIDAK menghentikan yang lain; kegagalan dikembalikan
 *   sebagai `{ ok: false, galat }`.
 * - `sinyal` (AbortSignal) menghentikan pengambilan tugas baru, tapi tugas yang
 *   sudah berjalan dibiarkan selesai agar tidak ada tulisan setengah jadi.
 */
export async function jalankanParalel(tugas, { worker, sinyal } = {}) {
  const daftar = Array.isArray(tugas) ? tugas : [];
  const hasil = new Array(daftar.length);
  const batas = jumlahWorker(worker, daftar.length);
  if (!daftar.length) return hasil;

  let berikut = 0;
  const pekerja = [];
  for (let i = 0; i < batas; i += 1) {
    pekerja.push((async () => {
      for (;;) {
        if (sinyal && sinyal.aborted) return;
        const indeks = berikut;
        berikut += 1;
        if (indeks >= daftar.length) return;
        try {
          hasil[indeks] = { ok: true, hasil: await daftar[indeks](indeks) };
        } catch (galat) {
          hasil[indeks] = { ok: false, galat: String((galat && galat.message) || galat) };
        }
      }
    })());
  }
  await Promise.all(pekerja);

  // Tugas yang tidak sempat diambil karena abort: tandai jujur, bukan undefined.
  for (let i = 0; i < daftar.length; i += 1) {
    if (!hasil[i]) hasil[i] = { ok: false, galat: 'dibatalkan sebelum dijalankan', batal: true };
  }
  return hasil;
}

/**
 * Rangkum hasil pool menjadi laporan yang bisa ditampilkan/dibaca manusia.
 * `nama(indeks)` memberi label bot. Dipakai TUI dan `sakti room`.
 */
/**
 * Jalankan satu giliran room untuk jalur mana pun (TUI, CLI, HTTP, subagen).
 *
 * Dibuat karena perbaikan paralel+urutan sempat hanya masuk ke TUI, sehingga
 * `sakti "..."`, `POST /chat`, dan subagen tetap serial dan mengabaikan tugas.
 * Sekarang semua jalur memakai fungsi ini, jadi tidak bisa menyimpang lagi.
 *
 * @param daftar  nama peserta SUDAH berurutan (lihat urutkanNamaPeserta)
 * @param buat    (nama, indeks) => Promise ; dijalankan untuk tiap peserta
 * @returns hasil jalankanParalel (sejajar daftar) + ringkasannya
 */
export async function jalankanRoom({ daftar, buat, worker, sinyal } = {}) {
  const peserta = Array.isArray(daftar) ? daftar : [];
  if (!peserta.length) return { hasil: [], rangkum: { berhasil: 0, gagal: 0, batal: 0, baris: [] }, worker: 0 };
  const dipakai = jumlahWorker(worker, peserta.length);
  const hasil = await jalankanParalel(
    peserta.map((nama, indeks) => () => buat(nama, indeks)),
    { worker: dipakai, sinyal }
  );
  return {
    hasil,
    worker: dipakai,
    rangkum: rangkumHasil((i) => peserta[i] || 'agen', hasil)
  };
}

export function rangkumHasil(nama, hasil) {
  const baris = [];
  let berhasil = 0;
  let gagal = 0;
  let batal = 0;
  (hasil || []).forEach((satu, indeks) => {
    const label = typeof nama === 'function' ? nama(indeks) : String(nama || indeks);
    if (!satu) { gagal += 1; baris.push(label + ': tidak dijalankan'); return; }
    // putaran bisa selesai dengan `ok:true` tetapi `hasil.galat` (content
    // kosong, batas langkah, alat berulang). Itu bukan jawaban sukses.
    const galatDalam = satu.hasil && typeof satu.hasil === 'object' ? satu.hasil.galat : '';
    const batalDalam = Boolean(satu.batal || (satu.hasil && typeof satu.hasil === 'object' && satu.hasil.dibatalkan));
    if (satu.ok && !galatDalam && !batalDalam) { berhasil += 1; return; }
    if (batalDalam) { batal += 1; baris.push(label + ': dibatalkan'); return; }
    gagal += 1;
    baris.push(label + ': GAGAL - ' + (galatDalam || satu.galat || 'tidak ada jawaban'));
  });
  return { berhasil, gagal, batal, baris };
}
