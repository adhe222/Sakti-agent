// Rencana kerja (todo) yang tahan lintas giliran: rencana panjang lebih dari satu
// balasan, jadi disimpan di state.json (~/.sakti-cli/state.json), bukan di riwayat
// percakapan yang bisa dipadatkan.
//
// Status: pending | in_progress | completed | cancelled (+ padanan Indonesia).
// Satu item = {id, isi, status, induk}.

import { bacaState, ubahState } from './lokal.js';

const PADANAN = {
  pending: 'pending', belum: 'pending', rencana: 'pending', todo: 'pending', baru: 'pending',
  in_progress: 'in_progress', jalan: 'in_progress', dikerjakan: 'in_progress', proses: 'in_progress', mulai: 'in_progress',
  completed: 'completed', selesai: 'completed', beres: 'completed', done: 'completed', kelar: 'completed',
  cancelled: 'cancelled', batal: 'cancelled', dibatalkan: 'cancelled', gagal: 'cancelled', dropped: 'cancelled'
};

const TANDA = { pending: '[ ]', in_progress: '[~]', completed: '[x]', cancelled: '[-]' };

export function statusSah(nilai, bawaan = 'pending') {
  const kunci = String(nilai == null ? '' : nilai).trim().toLowerCase();
  return PADANAN[kunci] || bawaan;
}

export function bacaRencana() {
  const rows = bacaState().rencana;
  return Array.isArray(rows) ? rows : [];
}

function tulis(rows) {
  // Rencana dibaca DULU lalu diganti utuh - dua agen paralel bisa saling
  // menimpa. Kunci + tulis di dalamnya; `rows` adalah hasil keputusan pemanggil.
  const akhir = rows.slice(0, 200);
  ubahState((state) => { state.rencana = akhir; });
  return akhir;
}

/** Normalisasi item mentah dari model: butuh id + isi, status dijaga sah. */
export function rapikanItem(item, indeks = 0) {
  const isi = String((item && (item.isi || item.content)) || '').replace(/\s+/g, ' ').trim();
  if (!isi) throw new Error('tiap item butuh "isi"');
  const id = String((item && item.id) || 'i' + (indeks + 1)).slice(0, 24);
  return { id, isi: isi.slice(0, 200), status: statusSah(item && item.status), induk: item && item.induk ? String(item.induk).slice(0, 24) : null };
}

/** tulis: ganti seluruh rencana. gabung: perbarui per id, tambah yang baru. */
export function simpanRencana(items, { gabung = false } = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('items kosong (pakai aksi hapus untuk mengosongkan)');
  const lama = bacaRencana();
  const peta = new Map(lama.map((row) => [row.id, row]));
  // Gabung: item lama dilengkapi dulu, jadi {"id":"b","status":"selesai"}
  // tidak dianggap item tanpa isi.
  const baru = items.map((raw, i) => (gabung && raw && raw.id && peta.has(String(raw.id))
    ? rapikanItem(Object.assign({}, peta.get(String(raw.id)), raw), i)
    : rapikanItem(raw, i)));
  if (!gabung) return tulis(baru);
  for (const row of baru) peta.set(row.id, Object.assign({}, peta.get(row.id) || {}, row));
  return tulis([...peta.values()]);
}

export function hapusRencana(id) {
  if (!id) return tulis([]);
  return tulis(bacaRencana().filter((row) => row.id !== String(id)));
}

export function ringkasRencana(rows = bacaRencana()) {
  const jumlah = { total: rows.length, pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const row of rows) jumlah[statusSah(row.status)] += 1;
  return jumlah;
}

/** Teks untuk manusia/model: urut sesuai daftar, anak menjorok di bawah induknya. */
export function tampilRencana(rows = bacaRencana()) {
  if (!rows.length) return 'rencana kosong';
  const anak = new Map();
  for (const row of rows) {
    if (!row.induk) continue;
    anak.set(row.induk, (anak.get(row.induk) || []).concat([row]));
  }
  const baris = [];
  const gambar = (row, tingkat) => {
    baris.push('  '.repeat(tingkat) + (TANDA[row.status] || '[ ]') + ' ' + row.id + '  ' + row.isi);
    for (const turun of anak.get(row.id) || []) gambar(turun, tingkat + 1);
  };
  for (const row of rows) if (!row.induk) gambar(row, 0);
  // Item yatim (induknya tidak ada) tetap ditampilkan, jangan sampai hilang.
  for (const row of rows) if (row.induk && !rows.some((lain) => lain.id === row.induk)) gambar(row, 0);
  const jumlah = ringkasRencana(rows);
  return baris.join('\n') + '\n(' + jumlah.total + ' item · ' + jumlah.in_progress + ' jalan · ' + jumlah.completed + ' selesai · ' + jumlah.pending + ' menunggu' + (jumlah.cancelled ? ' · ' + jumlah.cancelled + ' batal' : '') + ')';
}
