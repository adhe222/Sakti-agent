// Roster subagen: peran siap pakai, pemilihan otomatis dari teks tugas, dan
// pool worker supaya beberapa subagen bekerja BERSAMAAN.
//
// Kenapa dipisah dari alat.js: roster + pemilihan + pool itu fungsi murni yang
// bisa diuji tanpa model, jaringan, atau disk. alat.js tinggal menyalakan
// putaran() untuk tiap peran. subagen.js tidak mengimpor agent.js (agent ->
// alat -> subagen), jadi tidak ada lingkaran impor.
//
// Aturan penting: peran yang `tulis: true` (koder, penguji) TIDAK pernah dipilih
// otomatis kecuali pemanggil menyalakan `penuh`. Delegasi bawaan tetap alat baca
// seperti sebelumnya - yang berubah hanya: peran dipilih sendiri, dan beberapa
// delegasi dalam satu giliran berjalan paralel dengan batas worker.

import { jalankanParalel } from './room.js';

export const WORKER_SUBAGEN_BAWAAN = 4;
export const WORKER_SUBAGEN_MAKS = 12;

const BACA = ['status', 'daftar', 'baca', 'cari', 'diff', 'cariweb', 'web', 'pdf', 'rencana', 'skill', 'petunjuk', 'mind', 'ingatan', 'biaya'];

/**
 * Daftar peran. `kata` = pemicu pemilihan otomatis (dicocokkan ke teks tugas),
 * `alat` = alat yang boleh dipakai peran itu, `tulis` = boleh mengubah disk
 * (hanya ikut pemilihan otomatis kalau penuh=true), `murah` = pakai model
 * ringan kalau SAKTI_MODEL_MURAH disetel.
 */
export const SUBAGEN = [
  {
    nama: 'peneliti',
    label: 'peneliti web/dokumentasi',
    kapan: 'cari fakta, dokumentasi pustaka, versi terbaru, praktik yang berlaku',
    kala: ['riset', 'teliti', 'dokumentasi', 'docs', 'referensi', 'artikel', 'paper', 'versi terbaru', 'best practice', 'benchmark', 'cari tahu', 'bandingkan pustaka'],
    alat: BACA,
    prompt: 'Tugasmu riset, bukan menebak: pakai cariweb lalu buka halaman yang benar-benar perlu dengan web (aksi ekstrak). Sebut URL sumber untuk tiap klaim. Kalau pencarian gagal, tulis galatnya apa adanya - jangan mengarang isi halaman.'
  },
  {
    nama: 'penelusur',
    label: 'penelusur kode',
    kapan: 'lacak alur, temukan pemanggil/definisi, petakan modul yang tidak dikenal',
    kala: ['telusuri', 'lacak', 'di mana', 'dimana', 'struktur', 'alur', 'pemanggil', 'definisi', 'fungsi', 'modul', 'berkas mana', 'grep', 'jejak', 'peta kode', 'siapa yang memakai'],
    alat: BACA.concat(['zip']),
    prompt: 'Tugasmu menelusuri kode: mulai dari titik masuk, ikuti pemanggilan sampai definisinya, dan kutip jalur berkas:baris. Jangan menyarankan perbaikan kecuali diminta - laporkan alurnya dulu.'
  },
  {
    nama: 'arsitek',
    label: 'arsitek/ perencana',
    kapan: 'rancang pendekatan, pecah pekerjaan, timbang pilihan desain',
    kala: ['rancang', 'arsitektur', 'desain', 'pendekatan', 'strategi', 'migrasi', 'skema', 'rencana', 'pecah tugas', 'timbang', 'pilihan desain', 'refactor besar'],
    alat: BACA,
    prompt: 'Tugasmu merancang, bukan menulis kode. Hasilkan: pilihan yang ada, rekomendasi satu, langkah berurutan yang bisa dieksekusi, dan risiko yang nyata. Sebut berkas yang akan tersentuh.'
  },
  {
    nama: 'koder',
    label: 'penulis kode',
    kapan: 'implementasi/ubah/perbaiki berkas sesuai spesifikasi yang sudah jelas',
    kala: ['implementasi', 'implement', 'tulis kode', 'ubah', 'perbaiki', 'fix', 'refactor', 'tambahkan', 'tambah fitur', 'buat fitur', 'patch', 'bug', 'perbaiki kode', 'tulis ulang'],
    alat: ['status', 'daftar', 'baca', 'cari', 'tulis', 'edit', 'tambal', 'jalankan', 'terminal', 'uji', 'diff', 'folder', 'pindah', 'salin', 'khazanah', 'rencana', 'skill'],
    tulis: true,
    prompt: 'Tugasmu mengubah berkas sampai tuntas. Baca dulu berkas yang akan disentuh (baca/cari), pakai edit untuk perubahan kecil alih-alih menulis ulang, lalu jalankan uji yang relevan dan laporkan kode keluarnya. Jangan menyentuh berkas di luar lingkup tugas.'
  },
  {
    nama: 'penguji',
    label: 'penguji/ verifikator',
    kapan: 'jalankan uji, build, lint; buktikan perubahan benar atau rusak',
    kala: ['uji', 'tes', 'test', 'verifikasi', 'regresi', 'coverage', 'lint', 'build', 'gagal', 'reproduksi', 'jalankan uji'],
    alat: ['status', 'daftar', 'baca', 'cari', 'uji', 'jalankan', 'terminal', 'diff', 'biaya', 'rencana'],
    tulis: true,
    prompt: 'Tugasmu membuktikan keadaan sebenarnya: jalankan uji/build/lint yang ada, kutip perintah dan kode keluarnya, pisahkan gagal-baru dari gagal-lama. Jangan memperbaiki kode kecuali diminta - laporkan dulu buktinya.'
  },
  {
    nama: 'peninjau',
    label: 'peninjau kode/ keamanan',
    kapan: 'review diff, cari cacat logika, risiko keamanan, pelanggaran konvensi',
    kala: ['tinjau', 'review', 'periksa kualitas', 'keamanan', 'security', 'audit', 'celah', 'kerentanan', 'konsistensi', 'kode smell'],
    alat: BACA,
    prompt: 'Tugasmu meninjau, bukan menulis. Laporkan temuan sebagai daftar: tingkat (kritis/tinggi/sedang/rendah), jalur berkas:baris, alasan teknis, dan perbaikan satu baris. Temuan tanpa bukti kode tidak masuk laporan.'
  },
  {
    nama: 'perangkum',
    label: 'perangkum keluaran besar',
    kapan: 'saring log/keluaran panjang jadi poin yang bisa dipakai',
    kala: ['rangkum', 'ringkas', 'summarize', 'rangkuman', 'saring', 'ekstrak poin', 'log panjang', 'keluaran besar'],
    alat: ['status', 'daftar', 'baca', 'cari', 'diff'],
    murah: true,
    prompt: 'Tugasmu memadatkan: ambil keputusan, angka, galat, dan jalur berkas yang penting saja. Jangan menambah analisis yang tidak ada di sumber. Maksimal 15 baris.'
  },
  {
    nama: 'umum',
    label: 'subagen serba bisa',
    kapan: 'tugas mandiri yang tidak masuk peran lain',
    kala: [],
    alat: ['status', 'daftar', 'baca', 'cari', 'diff', 'cariweb', 'web', 'mind', 'ingatan', 'petunjuk', 'skill', 'rencana', 'pdf'],
    prompt: 'Kerjakan hanya tugas yang diberikan, dengan alat baca. Kalau tugasnya butuh mengubah berkas, katakan alat apa yang kurang - jangan berpura-pura sudah mengubahnya.'
  }
];

const AWALAN_NAMA = new Map(SUBAGEN.map((satu) => [satu.nama, satu]));

/** Roster untuk prompt/tampilan: satu baris per peran. */
export function ringkasSubagen({ semua = false } = {}) {
  const baris = SUBAGEN.map((satu) => satu.nama + ' · ' + satu.label + ' · ' + satu.kapan);
  if (semua) for (const satu of SUBAGEN) baris.push('  ' + satu.nama + ' alat: ' + (satu.tulis ? 'BISA MENULIS (' : '') + (satu.alat || []).join(', ') + (satu.tulis ? ')' : ''));
  return baris.join('\n');
}

/** Nama peran yang sah (null kalau tidak ada) - dipakai validasi masukan alat. */
export function bacaSubagen(nama) {
  const kunci = String(nama || '').trim().toLowerCase();
  return AWALAN_NAMA.get(kunci) || null;
}

export function daftarNamaSubagen() {
  return SUBAGEN.map((satu) => satu.nama);
}

// Kata pendek dicocokkan per batas kata: `uji` tidak boleh menang pada kata
// "tujuan", dan `fix` tidak boleh menang pada "prefix". Kata panjang cukup
// includes karena bentuk berimbuhannya ("menguji", "perbaikan") justru yang
// sering dipakai orang.
function cocokKata(isi, kata) {
  const k = String(kata || '').toLowerCase();
  if (!k) return false;
  if (k.length <= 4) {
    const aman = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + aman + '([^a-z0-9]|$)').test(isi);
  }
  return isi.includes(k);
}

/**
 * Pilih peran yang paling cocok dengan teks tugas.
 * Hasil SELALU tidak kosong: paling buruk `umum` dengan skor 0.
 * `hanyaBaca: true` mengeluarkan peran ber-`tulis` dari kandidat - itu yang
 * membuat delegasi bawaan tetap tidak bisa mengubah berkas.
 */
export function pilihSubagen(teks, { maks = 3, hanyaBaca = false, daftar = SUBAGEN } = {}) {
  const isi = String(teks || '').toLowerCase();
  const kandidat = (Array.isArray(daftar) ? daftar : SUBAGEN)
    .filter((satu) => satu && satu.nama && (!hanyaBaca || satu.tulis !== true));
  const skor = kandidat.map((satu, urut) => {
    let nilai = 0;
    if (isi.includes(satu.nama)) nilai += 8;
    for (const kata of satu.kala || []) if (cocokKata(isi, kata)) nilai += 1;
    return { nama: satu.nama, skor: nilai, urut };
  }).filter((satu) => satu.skor > 0)
    .sort((a, b) => b.skor - a.skor || a.urut - b.urut)
    .slice(0, Math.max(1, Math.floor(Number(maks) || 1)));
  if (skor.length) return skor.map((satu) => ({ nama: satu.nama, skor: satu.skor }));
  return [{ nama: 'umum', skor: 0 }];
}

/** Alat untuk satu peran. `penuh` = semua alat (model boleh apa saja). */
export function alatSubagen(peran, { penuh = false } = {}) {
  if (penuh) return null;
  const data = typeof peran === 'string' ? bacaSubagen(peran) : peran;
  if (!data) return null;
  const daftar = Array.isArray(data.alat) && data.alat.length ? data.alat.slice() : null;
  return daftar;
}

/** Instruksi subagen: peran + tugas + aturan balasan. */
export function promptSubagen(peran, tugas, { cwd = '' } = {}) {
  const data = typeof peran === 'string' ? bacaSubagen(peran) : peran;
  const pakai = data || bacaSubagen('umum');
  return [
    'Kamu SUBAGEN "' + pakai.nama + '" (' + pakai.label + '), bukan agen utama. Riwayatmu bersih - tugas di bawah satu-satunya konteks, jadi jangan bertanya balik: tidak ada manusia di ujung percakapan ini.',
    pakai.prompt,
    tugas ? 'TUGAS:\n' + String(tugas).trim() : '',
    cwd ? 'Folder kerja: ' + cwd + '.' : '',
    'Balas ringkas: temuan, jalur berkas:baris yang penting, perintah yang dijalankan + kode keluarnya. Tanpa pembuka, tanpa mengulang tugas.'
  ].filter(Boolean).join('\n');
}

/**
 * Batas pekerja subagen. Bawaan 4 (bukan 1): subagen biasanya tugas terpisah
 * yang tidak saling menunggu, jadi menyerialkannya cuma menambah waktu.
 * Nilai tak sah jatuh ke bawaan, hasil selalu 1..min(12, jumlah tugas).
 */
export function workerSubagen(nilai, jumlahTugas) {
  const jumlah = Math.floor(Number(jumlahTugas));
  if (!Number.isFinite(jumlah) || jumlah < 1) return 0;
  const mentah = nilai == null
    ? (process.env.SAKTI_WORKER_SUBAGEN != null ? process.env.SAKTI_WORKER_SUBAGEN : (process.env.SAKTI_WORKER != null ? process.env.SAKTI_WORKER : WORKER_SUBAGEN_BAWAAN))
    : nilai;
  const angka = Math.floor(Number(mentah));
  const batas = Number.isFinite(angka) && angka >= 1 ? angka : WORKER_SUBAGEN_BAWAAN;
  return Math.min(batas, WORKER_SUBAGEN_MAKS, jumlah);
}

/**
 * Jalankan daftar tugas subagen lewat pool.
 * `eksekusi(item, indeks)` mengembalikan teks. Hasil sejajar indeks masukan -
 * urutan tidak bergantung siapa selesai dulu - dan satu tugas gagal tidak
 * membatalkan yang lain.
 */
export async function jalankanTugas(daftar, { worker, sinyal, eksekusi } = {}) {
  const tugas = (Array.isArray(daftar) ? daftar : []).filter((satu) => satu && String(satu.tugas || '').trim());
  if (!tugas.length) return { worker: 0, hasil: [] };
  const dipakai = workerSubagen(worker, tugas.length);
  const mentah = await jalankanParalel(
    tugas.map((satu, indeks) => () => eksekusi(satu, indeks)),
    { worker: dipakai, sinyal }
  );
  return {
    worker: dipakai,
    hasil: tugas.map((satu, indeks) => {
      const hasil = mentah[indeks] || { ok: false, galat: 'tidak dijalankan' };
      return Object.assign({}, satu, hasil.ok
        ? { ok: true, teks: String(hasil.hasil == null ? '' : hasil.hasil) }
        : { ok: false, teks: '', galat: hasil.galat, batal: hasil.batal === true });
    })
  };
}

/** Teks hasil pool: satu blok per subagen, urut masukan. */
export function rangkaiSubagen(hasil, { worker } = {}) {
  const daftar = Array.isArray(hasil) ? hasil : [];
  if (!daftar.length) return '(tidak ada subagen yang dijalankan)';
  const kepala = daftar.length > 1
    ? ['subagen: ' + daftar.length + ' · worker: ' + (worker == null ? '?' : worker)]
    : [];
  const blok = daftar.map((satu, indeks) => {
    const label = '[' + (indeks + 1) + '/' + daftar.length + ' ' + (satu.peran || 'umum') + ']';
    if (!satu.ok) return label + ' GAGAL: ' + (satu.galat || 'tanpa keterangan');
    return label + '\n' + (satu.teks || '(selesai tanpa jawaban)');
  });
  return kepala.concat(blok).join('\n');
}
