// Daftar pilihan untuk menu interaktif TUI (/model, /effort, /token, /worker,
// /izin, /rute). Murni: tanpa I/O, tanpa model, supaya bisa diuji tanpa pty.
//
// Satu opsi = { label, ket, nilai, aktif }. `nilai` adalah objek yang nanti
// diterapkan pemanggil; `aktif` menandai nilai yang sedang dipakai supaya
// kursor langsung mendarat di situ saat menu dibuka.

import { EFFORT_SAH, TOKEN_PER_EFFORT } from './model.js';
import { TINGKAT_RUTE, nilaiTingkat, ruteAktif } from './rute.js';

const teks = (nilai) => String(nilai == null ? '' : nilai);

/** Katalog model tersimpan + baris muat ulang dari endpoint. */
export function opsiModel(konf = {}) {
  const daftar = Array.isArray(konf.models) ? konf.models.map(teks).filter(Boolean) : [];
  const aktif = teks(konf.model);
  const endpoint = teks(konf.baseUrl) || 'endpoint';
  const opsi = daftar.map((model) => ({
    label: model,
    ket: model === aktif ? 'aktif' : '',
    nilai: { model },
    aktif: model === aktif
  }));
  // Model aktif yang tidak ada di katalog tersimpan tetap harus bisa dipilih
  // ulang; tanpa baris ini kursor jatuh ke model lain tanpa disadari.
  if (aktif && !daftar.includes(aktif)) {
    opsi.unshift({ label: aktif, ket: 'aktif · di luar katalog', nilai: { model: aktif }, aktif: true });
  }
  // Baris muat ulang menyebut endpoint asal katalog: daftar ini milik endpoint
  // aktif, bukan gabungan semua endpoint yang pernah dipakai.
  opsi.push({ label: 'muat ulang katalog dari endpoint', ket: 'GET /models · ' + endpoint, nilai: { muatKatalog: true }, aktif: false });
  return { judul: 'pilih model · ' + daftar.length + ' dari ' + endpoint, opsi };
}

/** Tingkat penalaran beserta anggaran token bawaannya + status dukungan endpoint. */
export function opsiEffort(konf = {}, kem = {}) {
  const aktif = teks(konf.effort) || 'none';
  const sah = Array.isArray(kem.effortSah) ? kem.effortSah : null;
  const ditolak = Array.isArray(kem.effortDitolak) ? kem.effortDitolak : [];
  const status = (nama) => {
    if (nama === 'none') return '';
    if (kem.tanpaEffort && Number(kem.waktu)) return 'tidak didukung endpoint';
    if (ditolak.includes(nama)) return 'ditolak endpoint';
    if (sah && sah.length && !sah.includes(nama)) return 'di luar daftar didukung';
    if (sah && sah.includes(nama)) return 'didukung endpoint';
    return '';
  };
  const opsi = EFFORT_SAH.map((nama) => {
    const anggaran = TOKEN_PER_EFFORT[nama];
    const dasar = nama === 'none'
      ? 'field tidak dikirim'
      : 'max_tokens ' + anggaran;
    const ket = [dasar, status(nama), nama === aktif ? 'aktif' : ''].filter(Boolean).join(' · ');
    return { label: nama, ket, nilai: { effort: nama }, aktif: nama === aktif };
  });
  // Baris probe hanya berguna kalau endpoint+model sudah diketahui; tanpa itu
  // menu tetap membuka dan probe memakai konfigurasi saat dipilih.
  opsi.push({
    label: 'tes dukungan reasoning',
    ket: 'POST kecil per tingkat · simpan hasil untuk endpoint+model ini',
    nilai: { ujiReasoning: true },
    aktif: false
  });
  return { judul: 'pilih effort · aktif ' + aktif + (kem.sumber ? ' · sumber ' + kem.sumber : ''), opsi };
}

/** Anggaran keluaran: 0 = serahkan ke server, sisanya angka eksplisit. */
export function opsiToken(konf = {}) {
  const aktif = Number(konf.maxTokens);
  const angka = [0, 1024, 2048, 4096, 8192, 16384, 24576, 32000, 48000];
  if (Number.isFinite(aktif) && aktif > 0 && !angka.includes(aktif)) angka.push(aktif);
  angka.sort((a, b) => a - b);
  const opsi = angka.map((n) => ({
    label: n === 0 ? 'serahkan ke server' : String(n),
    ket: n === 0 ? 'tanpa max_tokens' : 'max_tokens ' + n,
    nilai: { maxTokens: n },
    aktif: (Number.isFinite(aktif) ? aktif : 0) === n
  }));
  return { judul: 'pilih anggaran token · aktif ' + (Number.isFinite(aktif) && aktif > 0 ? aktif : 'server'), opsi };
}

/** Jumlah pekerja bersamaan; `null` = otomatis (room: semua peserta). */
export function opsiWorker(worker, jumlahBot = 0) {
  const aktif = worker == null ? null : Math.max(1, Math.floor(Number(worker) || 1));
  const opsi = [{
    label: 'otomatis',
    ket: 'room: semua ' + Math.max(0, jumlahBot) + ' peserta · subagen: bawaan',
    nilai: { worker: null },
    aktif: aktif == null
  }];
  for (let n = 1; n <= 12; n += 1) {
    opsi.push({
      label: String(n),
      ket: n === 1 ? 'berurutan' : 'paralel' + (n === aktif ? ' · aktif' : ''),
      nilai: { worker: n },
      aktif: n === aktif
    });
  }
  return { judul: 'pilih worker · aktif ' + (aktif == null ? 'otomatis' : aktif), opsi };
}

/** Mode izin alat berisiko. */
export function opsiIzin(mode = 'auto') {
  const aktif = teks(mode) || 'auto';
  const daftar = [
    ['auto', 'jalan apa adanya (bawaan)'],
    ['ask', 'tanya dulu untuk alat berisiko'],
    ['never', 'tolak semua alat berisiko']
  ];
  return {
    judul: 'pilih izin alat · aktif ' + aktif,
    opsi: daftar.map(([nama, ket]) => ({
      label: nama,
      ket: ket + (nama === aktif ? ' · aktif' : ''),
      nilai: { izin: nama },
      aktif: nama === aktif
    }))
  };
}

/** Smart route: off, auto, atau patok satu tingkat. */
export function opsiRute(konf = {}) {
  const aktif = ruteAktif(konf) ? (konf.ruteTingkat || 'auto') : 'off';
  const opsi = [
    { label: 'off', ket: 'pakai effort/max-tokens manual', nilai: { rute: 'off' }, aktif: aktif === 'off' },
    { label: 'auto', ket: 'tingkat dipilih dari kesulitan tugas', nilai: { rute: 'auto' }, aktif: aktif === 'auto' }
  ];
  for (const tingkat of TINGKAT_RUTE) {
    const n = nilaiTingkat(tingkat);
    opsi.push({
      label: tingkat,
      ket: 'effort ' + n.effort + ' · token ' + n.maxTokens + ' · riwayat ' + n.batasRiwayat + (aktif === tingkat ? ' · aktif' : ''),
      nilai: { rute: tingkat },
      aktif: aktif === tingkat
    });
  }
  return { judul: 'pilih smart route · aktif ' + aktif, opsi };
}

/** Menu akar `/pengaturan`: tiap baris membuka submenu nilai yang sama. */
export function opsiPengaturan(konf = {}, tambahan = {}) {
  const token = Number(konf.maxTokens) > 0 ? String(konf.maxTokens) : 'server';
  const alatAktif = String(konf.alat || '').split(',').filter(Boolean);
  return {
    judul: 'pengaturan · pilih yang diubah',
    opsi: [
      { label: 'model', ket: teks(konf.model) || '-', nilai: { menu: 'model' }, aktif: false },
      { label: 'effort', ket: (teks(konf.effort) || 'none') + ' · token ' + token, nilai: { menu: 'effort' }, aktif: false },
      { label: 'token', ket: 'max_tokens ' + token, nilai: { menu: 'token' }, aktif: false },
      { label: 'rute', ket: teks(tambahan.rute) || '-', nilai: { menu: 'rute' }, aktif: false },
      { label: 'izin', ket: teks(tambahan.izin) || '-', nilai: { menu: 'izin' }, aktif: false },
      { label: 'worker', ket: tambahan.worker == null ? 'otomatis' : String(tambahan.worker), nilai: { menu: 'worker' }, aktif: false },
      // Tiga setelan yang dulu hanya bisa lewat bendera/env, sekarang satu
      // tempat: subset alat (hemat token skema), gaya indikator, mode room.
      { label: 'alat', ket: alatAktif.length ? alatAktif.length + ' dari model' : 'semua dikirim', nilai: { menu: 'alat' }, aktif: false },
      { label: 'indikator', ket: teks(konf.indikator) || 'unicode', nilai: { menu: 'indikator' }, aktif: false },
      { label: 'room', ket: teks(tambahan.room) || 'solo', nilai: { menu: 'room' }, aktif: false }
    ]
  };
}

/** Daftar sesi/chatroom; baris aktif = sesi yang sedang dibuka. */
export function opsiSesi(rows = [], aktifId = '') {
  const daftar = (rows || []).filter(Boolean).map((row) => {
    const id = teks(row.id);
    const waktu = Number(row.waktu) ? new Date(Number(row.waktu)).toISOString().slice(5, 16).replace('T', ' ') : '-';
    return {
      label: id.slice(-10) || '(tanpa id)',
      ket: row.pesan + ' pesan · ' + waktu + (row.judul ? ' · ' + teks(row.judul) : '') + (id === teks(aktifId) ? ' · aktif' : ''),
      nilai: { sesi: id },
      aktif: id === teks(aktifId)
    };
  });
  return { judul: 'pilih sesi · ' + daftar.length, opsi: daftar };
}

/** Daftar bot; Enter menandai masuk/lepas room. */
export function opsiBot(rows = [], room = []) {
  const diRoom = new Set((room || []).map(teks));
  const daftar = (rows || []).filter(Boolean).map((bot) => {
    const nama = teks(bot.nama);
    const masuk = diRoom.has(nama);
    return {
      label: nama,
      ket: [bot.model || 'model bawaan', bot.tugas ? 'tugas ' + bot.tugas : '', masuk ? 'di room · Enter lepas' : 'di luar · Enter masuk'].filter(Boolean).join(' · '),
      nilai: { bot: nama, masuk: !masuk },
      aktif: masuk
    };
  });
  return { judul: 'bot · Enter masuk/lepas room', opsi: daftar };
}

/** Panel samping: satu baris per panel + baris tutup. */
export function opsiPanel(aktif = null) {
  const daftar = [
    ['bot', 'daftar bot'],
    ['alat', 'alat tersedia'],
    ['skill', 'keahlian'],
    ['ingatan', 'ingatan'],
    ['tugas', 'tugas tersimpan'],
    ['rencana', 'rencana kerja'],
    ['chatroom', 'daftar sesi'],
    ['pengaturan', 'ringkasan pengaturan']
  ];
  return {
    judul: 'pilih panel · aktif ' + (aktif || 'tutup'),
    opsi: [
      { label: '(tutup)', ket: 'sembunyikan panel', nilai: { panel: null }, aktif: aktif == null },
      ...daftar.map(([nama, ket]) => ({ label: nama, ket, nilai: { panel: nama }, aktif: aktif === nama }))
    ]
  };
}

/** Perintah kustom tersimpan; Enter menjalankan prompt-nya. */
export function opsiPerintah(rows = []) {
  const daftar = (rows || []).filter(Boolean).map((satu) => ({
    label: '/' + teks(satu.nama),
    ket: teks(satu.keterangan) || 'prompt tersimpan',
    nilai: { perintah: teks(satu.nama) },
    aktif: false
  }));
  return { judul: 'perintah kustom · ' + daftar.length, opsi: daftar };
}

/** Kursor naik/turun, memutar di ujung daftar. */
export function geserPilihan(indeks, delta, jumlah) {
  const total = Math.max(0, Math.floor(Number(jumlah) || 0));
  if (!total) return 0;
  const awal = Math.max(0, Math.min(total - 1, Math.floor(Number(indeks) || 0)));
  return ((awal + Math.floor(Number(delta) || 0)) % total + total) % total;
}

/**
 * Jendela daftar yang muat di layar. Kursor selalu terlihat; daftar panjang
 * (katalog model) digulir, bukan dipotong tanpa jejak.
 */
export function jendelaPilihan(indeks, jumlah, ruang) {
  const total = Math.max(0, Math.floor(Number(jumlah) || 0));
  const n = Math.min(total, Math.max(1, Math.floor(Number(ruang) || 1)));
  if (!n) return { awal: 0, n: 0 };
  const i = Math.max(0, Math.min(total - 1, Math.floor(Number(indeks) || 0)));
  let awal = i >= n ? i - n + 1 : 0;
  awal = Math.min(awal, total - n);
  return { awal, n };
}

/**
 * Menu subset alat (`/alat` di TUI): satu baris per alat + baris `semua alat`,
 * yang aktif ditandai. `konf.alat` berisi koma-list nama ('') = semua.
 * Murni - daftar nama datang dari pemanggil supaya modul ini tidak mengimpor
 * tabel alat (alat.js memuat fs/proses; pilih.js harus tetap bisa diuji murni).
 */
export function opsiAlat(namaAlat = [], konf = {}) {
  const aktif = String(teks(konf.alat) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const semuaAktif = !aktif.length;
  const opsi = [{ label: 'semua alat', ket: semuaAktif ? 'aktif · skema penuh' : 'kirim skema semua alat', nilai: { alat: '' }, aktif: semuaAktif }];
  for (const nama of namaAlat) {
    const kena = aktif.includes(nama);
    opsi.push({ label: nama, ket: kena ? 'dikirim' : 'tidak dikirim', nilai: { alatToggle: nama }, aktif: kena });
  }
  return { judul: 'alat yang dikirim ke model · ' + (semuaAktif ? 'semua ' + namaAlat.length : aktif.length + '/' + namaAlat.length) + ' · Enter toggle · s = semua', opsi };
}
