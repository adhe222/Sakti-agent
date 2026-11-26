// Fitur yang dipinjam dari opencode / codex / hermes / openclaw:
//   - kerja()     : worktree git per-sesi supaya agen paralel tidak saling menimpa (opencode/podclaw)
//   - tambal()    : patch berbasis baris + cek konteks, gagal keras kalau tidak cocok (opencode `patch`)
//   - mesinLuar() : deteksi CLI agen lain yang terpasang (interop codex/opencode/claude)
//   - delegasiLuar(): serahkan satu tugas ke CLI itu
import fs from 'node:fs';
import path from 'node:path';
import { shell, bacaState, ubahState } from './lokal.js';
import { kutip, jalurKerja } from './shell-alat.js';

const AKAR_WORKTREE = () => path.join(process.env.SAKTI_HOME || process.env.HOME, '.sakti-cli', 'kerja');

const git = (cwd, baris) => shell(`git ${baris}`, { cwd, waktuMs: 60000 });

function wajibRepo(hasil) {
  // `shell()` mengembalikan {keluaran, galat, kode}. Dulu di sini dibaca
  // `stdout`/`stderr` (tidak ada) sehingga SETIAP aksi `kerja` melempar
  // "Cannot read properties of undefined (reading 'trim')" - alatnya mati total.
  const pesan = String((hasil && (hasil.galat || hasil.keluaran)) || '').trim();
  if (hasil.kode !== 0) throw new Error(`git gagal (kode ${hasil.kode}): ${pesan.slice(0, 400)}`);
  return String((hasil && hasil.keluaran) || '').trim();
}

const KANDIDAT_MESIN = { codex: 'codex exec', opencode: 'opencode run', claude: 'claude -p' };

/** Daftar CLI agen lain yang benar-benar ada di PATH. */
export function mesinLuar() {
  const dirPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const ada = [];
  for (const [nama, baris] of Object.entries(KANDIDAT_MESIN)) {
    // ponytail: cek PATH, bukan `--version` (mahal). Tambah probe versi kalau perlu diagnostik.
    const jalur = dirPath.map((d) => path.join(d, nama))
      .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (jalur) ada.push({ nama, baris, jalur });
  }
  return ada;
}

/** Jalankan satu tugas lewat CLI agen luar; kembalikan teks jawabannya. */
export async function delegasiLuar(mesin, tugas, { cwd = process.cwd(), waktu = 600000 } = {}) {
  const peta = mesinLuar().find((m) => m.nama === mesin);
  if (!peta) throw new Error(`mesin "${mesin}" tidak terpasang (ada: ${mesinLuar().map((m) => m.nama).join(', ') || 'tidak ada'})`);
  const kutip = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const hasil = await shell(`${peta.baris} ${kutip(tugas)}`, { cwd, waktuMs: waktu });
  if (hasil.kode !== 0) throw new Error(`${mesin} keluar ${hasil.kode}: ${String(hasil.galat || hasil.keluaran || '').trim().slice(0, 800)}`);
  return String(hasil.keluaran || '').trim();
}

function catatKerja(jalur, data) {
  ubahState((st) => { st.kerja = Object.assign({}, st.kerja, { [jalur]: data }); });
}

export function daftarKerja() {
  return bacaState().kerja || {};
}

/** Aksi worktree: buat | daftar | gabung | hapus. */
export async function kerja({ aksi = 'daftar', nama, cabang, cwd = process.cwd() }) {
  const akar = wajibRepo(await git(cwd, 'rev-parse --show-toplevel'));
  const catatan = daftarKerja();

  if (aksi === 'daftar') {
    const blok = wajibRepo(await git(akar, 'worktree list --porcelain')).split('\n\n').filter(Boolean);
    return blok.map((b) => {
      const baris = b.split('\n');
      const jalur = baris.find((l) => l.startsWith('worktree ')).slice(9);
      const cab = (baris.find((l) => l.startsWith('branch ')) || '').slice(7).replace('refs/heads/', '');
      return { jalur, cabang: cab, dibuatSakti: Boolean(catatan[jalur]) };
    });
  }

  if (!nama) throw new Error('butuh "nama" untuk aksi buat/gabung/hapus');
  if (/[/\\\s]/.test(nama)) throw new Error('nama kerja: tanpa spasi atau garis miring');
  const tujuan = path.join(AKAR_WORKTREE(), nama);
  const cabangNama = String(cabang || `sakti/${nama}`);
  // Nama cabang masuk ke baris perintah git. Validasi dulu supaya tidak bisa
  // dipakai sebagai opsi git (`--upload-pack=...`) atau injeksi shell; kutip()
  // saja tidak mencegah opsi karena kutipan tetap satu argumen.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(cabangNama) || cabangNama.startsWith('-')) {
    throw new Error('nama cabang tidak sah: ' + cabangNama);
  }

  if (aksi === 'buat') {
    if (fs.existsSync(tujuan)) throw new Error(`worktree sudah ada: ${tujuan}`);
    fs.mkdirSync(path.dirname(tujuan), { recursive: true });
    const sudahAdaCabang = (await git(akar, `rev-parse --verify --quiet ${kutip(cabangNama)}`)).kode === 0;
    const tambah = sudahAdaCabang ? `worktree add ${kutip(tujuan)} ${kutip(cabangNama)}` : `worktree add -b ${kutip(cabangNama)} ${kutip(tujuan)}`;
    wajibRepo(await git(akar, tambah));
    catatKerja(tujuan, { nama, cabang: cabangNama, induk: akar, dibuat: new Date().toISOString() });
    return { jalur: tujuan, cabang: cabangNama };
  }

  if (!fs.existsSync(tujuan)) throw new Error(`worktree tidak ada: ${tujuan}`);

  if (aksi === 'hapus') {
    wajibRepo(await git(akar, `worktree remove --force ${kutip(tujuan)}`));
    ubahState((st) => { if (st.kerja) delete st.kerja[tujuan]; });
    return { dihapus: tujuan };
  }

  if (aksi === 'gabung') {
    const kotor = wajibRepo(await git(tujuan, 'status --porcelain'));
    if (kotor) throw new Error(`worktree masih kotor, commit dulu:\n${kotor.slice(0, 600)}`);
    wajibRepo(await git(akar, `merge --no-ff ${kutip(cabangNama)} -m ${kutip(`gabung kerja ${nama}`)}`));
    return { digabung: cabangNama, ke: akar };
  }

  throw new Error(`aksi kerja tidak dikenal: ${aksi}`);
}

const BARIS_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Terapkan unified-diff ke satu berkas. Atomik: semua hunk harus cocok sebelum ditulis. */
export function tambal({ berkas, tambalan, cwd = process.cwd(), terapkan = true }) {
  // Tambalan MENULIS berkas: jalur dikunci ke folder kerja seperti alat tulis
  // lain. Sebelumnya jalurAman() dipakai sehingga `berkas=../../x` bisa
  // menimpa berkas di luar folder kerja.
  const jalur = jalurKerja(cwd, berkas, 'berkas tambalan');
  const asli = fs.readFileSync(jalur, 'utf8');
  const masukan = String(tambalan || '').split('\n');

  const hunk = [];
  let kini = null;
  for (const l of masukan) {
    if (/^(---|\+\+\+)/.test(l)) continue;
    const kepala = l.match(BARIS_HUNK);
    if (kepala) {
      kini = { mulai: Number(kepala[1]), buang: [], tambah: [] };
      hunk.push(kini);
      continue;
    }
    if (!kini) {
      if (l.trim()) throw new Error(`baris di luar hunk: ${l.slice(0, 80)}`);
      continue;
    }
    if (l.startsWith('\\')) continue;
    if (l.startsWith('-')) kini.buang.push(l.slice(1));
    else if (l.startsWith('+')) kini.tambah.push(l.slice(1));
    else if (l.startsWith(' ') || l === '') { kini.buang.push(l.slice(1)); kini.tambah.push(l.slice(1)); }
    else if (l.trim()) throw new Error(`baris hunk tak dikenal: ${l.slice(0, 80)}`);
  }
  if (!hunk.length) throw new Error('tambalan kosong: tidak ada hunk @@');

  const baris = asli.split('\n');
  let hasil = baris.slice();
  // Dari belakang: nomor baris hunk sebelumnya tetap sah setelah sisipan/buangan.
  for (const h of hunk.slice().sort((a, b) => b.mulai - a.mulai)) {
    // Hunk sisipan murni (`@@ -N,0 ...`) menunjuk baris SEBELUM sisipan, jadi
    // indeksnya N (bukan N-1). `@@ -0,0` berarti sisipkan di awal berkas.
    const mulai = h.buang.length ? h.mulai - 1 : h.mulai;
    if (mulai < 0 || mulai > hasil.length) throw new Error(`hunk @@ -${h.mulai} di luar berkas (${hasil.length} baris)`);
    const potong = hasil.slice(mulai, mulai + h.buang.length);
    if (potong.join('\n') !== h.buang.join('\n')) {
      throw new Error(`hunk @@ -${h.mulai} tidak cocok. Harap:\n${h.buang.join('\n').slice(0, 400)}\nAda:\n${potong.join('\n').slice(0, 400)}`);
    }
    hasil = hasil.slice(0, mulai).concat(h.tambah, hasil.slice(mulai + h.buang.length));
  }

  const akhir = hasil.join('\n');
  if (terapkan && akhir !== asli) {
    // Rename atomik: target tidak pernah terlihat separuh terulis bila crash.
    const sementara = jalur + '.tmp-' + process.pid;
    fs.writeFileSync(sementara, akhir);
    fs.renameSync(sementara, jalur);
  }
  return { berkas: jalur, hunk: hunk.length, diterapkan: terapkan, berubah: akhir !== asli };
}