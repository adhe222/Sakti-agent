/* global AbortSignal, FormData */
// Alat operasi: git, http, db, layanan, paket, lint, env, json, csv.
//
// Aturan yang sama dengan alat lain di repo ini: bukti bukan klaim. Setiap
// hasil membawa kode keluar, ukuran, dan jumlah temuan; yang tidak bisa
// dijalankan (biner tidak ada) dilaporkan apa adanya, bukan gagal ENOENT.
//
// Tiga penjaga keselamatan dipasang di sini + di lib/izin.js:
//   1. push paksa & reset --hard: WAJIB ditanya walau mode izin auto, dan
//      menyimpan ref penyelamat `refs/sakti/selamat-*` sebelum bertindak.
//   2. tulis ke basis data: SQLite dicadangkan dulu (khazanah checkpoint).
//   3. stop/restart layanan: ditanya (aturan yang sama).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cariBiner, jalurKerja, kutip } from './shell-alat.js';
import { folderProfil, msWaktuLama, ringkasShell, shell } from './lokal.js';
import { berkasKhazanah, checkpoint } from './khazanah.js';
import { HEADER_RAHASIA, fetchAman, redaksiTeks, redaksiUrl } from './jaring.js';

/* ------------------------------------------------------------- util ---- */

const potong = (teks, maks = 12000) => {
  const isi = String(teks == null ? '' : teks);
  return isi.length > maks ? isi.slice(0, maks) + '\n[...dipotong: ' + maks + ' dari ' + isi.length + ' karakter]' : isi;
};

/** Jalankan shell dan sensor rahasia dari teks hasil (perintah ikut dicetak). */
async function jalan(perintah, { cwd, waktu = 120000, rahasia = [], sinyal } = {}) {
  const hasil = await shell(perintah, { cwd, waktuMs: msWaktuLama(waktu, 120000), sinyal });
  let teks = ringkasShell(hasil);
  for (const satu of rahasia.filter(Boolean)) teks = teks.split(String(satu)).join('••••');
  return Object.assign({}, hasil, { teks });
}

function tabel(rows, kolom = null) {
  if (!Array.isArray(rows) || !rows.length) return '(0 baris)';
  const kunci = kolom && kolom.length ? kolom : Object.keys(rows[0]);
  const sel = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').slice(0, 60);
  const lebar = kunci.map((k) => Math.max(k.length, ...rows.map((row) => sel(row[k]).length)));
  const garis = (isi) => isi.map((v, i) => String(v).padEnd(lebar[i])).join('  ');
  return [garis(kunci), garis(lebar.map((n) => '-'.repeat(n))), ...rows.map((row) => garis(kunci.map((k) => sel(row[k]))))].join('\n');
}

function nilaiJalur(nilai, jalur) {
  if (!jalur) return nilai;
  let kini = nilai;
  for (const bagian of String(jalur).split('.').filter(Boolean)) {
    if (kini == null) return undefined;
    if (/^\d+$/.test(bagian) && Array.isArray(kini)) kini = kini[Number(bagian)];
    else kini = kini[bagian];
  }
  return kini;
}

function uraiFilter(filter) {
  const daftar = [];
  for (const bagian of String(filter || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const cocok = /^([^=!<>~]+)(!=|>=|<=|=|>|<|~)?(.*)$/.exec(bagian);
    if (!cocok) continue;
    daftar.push({ kunci: cocok[1].trim(), op: cocok[2] || '=', nilai: cocok[3].trim() });
  }
  return daftar;
}

function cocok(nilai, filter) {
  for (const satu of filter) {
    const punya = nilaiJalur(nilai, satu.kunci);
    const teks = punya == null ? '' : String(punya);
    const angka = Number(punya);
    const target = satu.nilai;
    if (satu.op === '=' && teks !== target) return false;
    if (satu.op === '!=' && teks === target) return false;
    if (satu.op === '~' && !teks.toLowerCase().includes(target.toLowerCase())) return false;
    if (satu.op === '>' && !(angka > Number(target))) return false;
    if (satu.op === '<' && !(angka < Number(target))) return false;
    if (satu.op === '>=' && !(angka >= Number(target))) return false;
    if (satu.op === '<=' && !(angka <= Number(target))) return false;
  }
  return true;
}

/**
 * Agregasi cepat tanpa skrip: hitung, jumlah:<field>, kelompok:<field>.
 * Dijalankan setelah filter/urut dan sebelum dipotong `batas`.
 */
function agregat(rows, spec) {
  const teks = String(spec == null ? '' : spec).trim();
  if (!teks) return rows;
  const daftar = Array.isArray(rows) ? rows : [rows];
  const [mode, field] = teks.split(':').map((s) => String(s || '').trim());
  const m = mode.toLowerCase();
  if (m === 'hitung' || m === 'count') return [{ jumlah: daftar.length }];
  if (m === 'jumlah' || m === 'sum') {
    if (!field) throw new Error('agregat jumlah butuh field: jumlah:<field>');
    return [{ field, jumlah: daftar.reduce((n, row) => n + (Number(row && row[field]) || 0), 0) }];
  }
  if (m === 'kelompok' || m === 'group') {
    if (!field) throw new Error('agregat kelompok butuh field: kelompok:<field>');
    const hitung = new Map();
    for (const row of daftar) {
      const kunci = String((row && row[field]) == null ? '' : row[field]);
      hitung.set(kunci, (hitung.get(kunci) || 0) + 1);
    }
    return [...hitung.entries()].sort((a, b) => b[1] - a[1]).map(([kunci, n]) => ({ [field]: kunci, jumlah: n }));
  }
  throw new Error('agregat tidak dikenal: ' + mode + ' (hitung|jumlah:<field>|kelompok:<field>)');
}

function saring(rows, { filter = '', pilih = '', urut = '', batas = 0 } = {}) {
  let hasil = Array.isArray(rows) ? rows.slice() : [rows];
  const f = uraiFilter(filter);
  if (f.length) hasil = hasil.filter((row) => cocok(row, f));
  const kolom = String(pilih || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (kolom.length) hasil = hasil.map((row) => { const baru = {}; for (const k of kolom) baru[k] = nilaiJalur(row, k); return baru; });
  const u = /^([^:]+)(?::(asc|desc))?$/i.exec(String(urut || '').trim());
  if (u) {
    const kunci = u[1].trim();
    const arah = (u[2] || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    hasil.sort((a, b) => {
      const x = nilaiJalur(a, kunci);
      const y = nilaiJalur(b, kunci);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * arah;
      return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y)) * arah;
    });
  }
  const n = Number(batas);
  if (Number.isFinite(n) && n > 0) hasil = hasil.slice(0, n);
  return hasil;
}

function bacaTeks(args, konf, namaDefault) {
  const sumber = String(args.sumber || '').trim();
  if (sumber && sumber !== '-') {
    const jalur = path.resolve((konf && konf.cwd) || process.cwd(), sumber);
    if (!fs.existsSync(jalur)) throw new Error('berkas tidak ada: ' + jalur);
    return { teks: fs.readFileSync(jalur, 'utf8'), jalur };
  }
  if (typeof args.teks === 'string') return { teks: args.teks, jalur: namaDefault };
  throw new Error('butuh "sumber" (berkas) atau "teks" (isi langsung)');
}

/* -------------------------------------------------------------- git ---- */

async function gitBin() {
  const biner = cariBiner([process.env.SAKTI_GIT, 'git']);
  if (!biner) throw new Error('git tidak terpasang. Pasang: apt install git');
  return biner;
}

async function gitJalan(cwd, arg, waktu = 60000) {
  const biner = await gitBin();
  const hasil = await shell(kutip(biner) + ' ' + arg.map(kutip).join(' '), { cwd, waktuMs: msWaktuLama(waktu, 60000) });
  return { hasil, teks: ringkasShell(hasil) };
}

/**
 * Nilai yang masuk ke argv git sebagai POSISI (remote, cabang, ref) tidak boleh
 * dimulai `-`: git membacanya sebagai opsi. Tanpa ini `remote="--mirror"` atau
 * `reset nama="--hard"` melewati pagar konfirmasi karena alat hanya memeriksa
 * flag `paksa`/`mode`.
 */
function posisiGit(nilai, label = 'nilai') {
  const teks = String(nilai == null ? '' : nilai).trim();
  if (!teks) throw new Error(label + ' kosong');
  if (teks.startsWith('-')) throw new Error(label + ' tidak boleh dimulai dengan -: ' + teks);
  if (/[\u0000-\u001f]/.test(teks)) throw new Error(label + ' memuat karakter kontrol');
  return teks;
}

/**
 * Ref penyelamat sebelum tindakan yang tidak bisa dibatalkan: HEAD + keadaan
 * kerja (stash create tidak mengubah pohon kerja). Bisa dipulihkan dengan
 * `git reset --hard <ref>` atau `git stash apply <titik>`.
 */
async function simpanPenyelamat(cwd, { wajib = false } = {}) {
  const kepala = await gitJalan(cwd, ['rev-parse', 'HEAD'], 15000);
  const head = kepala.hasil.kode === 0 ? kepala.hasil.keluaran.trim() : '';
  const simpan = await gitJalan(cwd, ['stash', 'create', 'sakti-selamat-' + Date.now()], 20000);
  if (simpan.hasil.kode !== 0 && wajib) {
    // Index konflik membuat `stash create` gagal. Dulu fungsi ini diam-diam
    // memakai HEAD, lalu reset --hard menghapus perubahan yang "dijanjikan"
    // terselamatkan. Lebih baik menolak tindakan.
    throw new Error('penyelamat gagal (stash: ' + String(simpan.hasil.keluaran || '').trim().slice(0, 160) + '); tindakan dibatalkan agar perubahan tidak hilang');
  }
  const titik = simpan.hasil.kode === 0 && String(simpan.hasil.keluaran).trim() ? String(simpan.hasil.keluaran).trim() : head;
  if (!titik) return null;
  const ref = 'refs/sakti/selamat-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const buat = await gitJalan(cwd, ['update-ref', ref, titik], 15000);
  if (buat.hasil.kode !== 0) return null;
  return { ref, titik, head, pulih: 'git reset --hard ' + ref + '   (atau: git stash apply ' + titik + ')' };
}

/**
 * Pecah SQL jadi pernyataan tanpa memotong `;` di dalam string/komentar.
 * `sql.split(';')` membuat `select 'a;b'` dianggap dua pernyataan - perintah
 * baca yang sah jadi ditolak sebagai tulis, dan `insert ... 'a;b'` menghitung
 * pernyataan lebih dari satu.
 */
export function pecahSql(sql) {
  const teks = String(sql == null ? '' : sql);
  const keluar = [];
  let kini = '';
  let kutip = '';
  let komentar = '';
  for (let i = 0; i < teks.length; i += 1) {
    const ch = teks[i];
    const berikut = teks[i + 1];
    if (komentar === 'baris') {
      kini += ch;
      if (ch === '\n') komentar = '';
      continue;
    }
    if (komentar === 'blok') {
      kini += ch;
      if (ch === '*' && berikut === '/') { kini += berikut; i += 1; komentar = ''; }
      continue;
    }
    if (kutip) {
      kini += ch;
      if (ch === kutip) {
        if (berikut === kutip) { kini += berikut; i += 1; }
        else kutip = '';
      }
      continue;
    }
    if (ch === '-' && berikut === '-') { komentar = 'baris'; kini += ch; continue; }
    if (ch === '/' && berikut === '*') { komentar = 'blok'; kini += ch; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { kutip = ch; kini += ch; continue; }
    if (ch === ';') { keluar.push(kini); kini = ''; continue; }
    kini += ch;
  }
  keluar.push(kini);
  return keluar.map((s) => s.trim()).filter(Boolean);
}

/**
 * Apakah SQL ini menulis? Diperiksa di LUAR string dan komentar, supaya
 * `select 'delete'` tetap dianggap baca, sedangkan
 * `WITH x AS (...) DELETE FROM t` (yang lolos dari cek awalan) tetap tertangkap.
 */
function sqlMenulis(sql) {
  const bersih = String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  return /\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|attach|detach|vacuum|reindex)\b/i.test(bersih)
    || /\bpragma\s+[a-z_]+\s*=/i.test(bersih)
    // SELECT ... INTO menulis (tabel baru / OUTFILE) - bukan baca.
    || /\bselect\b[^;]*\binto\b/i.test(bersih);
}

export function folderDbBackup() {
  return path.join(path.dirname(berkasKhazanah()), 'dbbackup');
}

/**
 * Cadangan WAJIB sebelum menulis ke Postgres/MySQL. SQLite dicadangkan lewat
 * khazanah checkpoint (salinan berkas); server jaringan tidak punya "berkas",
 * jadi dump penuh ke ~/.sakti-cli/dbbackup. Gagal mencadangkan = tulis
 * dibatalkan - bukan dilanjutkan dengan risiko.
 */
async function cadangkanSql(mesin, url, env, cwd, waktu) {
  const u = new URL(url);
  const folder = folderDbBackup();
  fs.mkdirSync(folder, { recursive: true });
  const cap = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + mesin;
  const berkas = path.join(folder, cap + '.sql');
  const sandi = decodeURIComponent(u.password || '');
  const rahasia = sandi ? [sandi] : [];
  let perintah;
  if (mesin === 'postgres') {
    const dump = cariBiner(['pg_dump']);
    if (!dump) throw new Error('penulisan dibatalkan: pg_dump tidak terpasang (apt install postgresql-client) - cadangan wajib sebelum menulis');
    perintah = kutip(dump) + ' ' + ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username || 'postgres'),
      '-d', u.pathname.replace(/^\//, '') || 'postgres', '-f', berkas, '--no-owner', '--no-privileges'].map(kutip).join(' ');
  } else {
    const dump = cariBiner(['mysqldump']);
    if (!dump) throw new Error('penulisan dibatalkan: mysqldump tidak terpasang (apt install mariadb-client) - cadangan wajib sebelum menulis');
    perintah = kutip(dump) + ' ' + ['-h', u.hostname, '-P', u.port || '3306', '-u', decodeURIComponent(u.username || 'root'),
      '--single-transaction', '--result-file=' + berkas, u.pathname.replace(/^\//, '')].map(kutip).join(' ');
  }
  const hasil = await shell(perintah, { cwd, waktuMs: Math.max(120000, msWaktuLama(waktu, 0)), env });
  if (hasil.kode !== 0) {
    let pesan = String(hasil.galat || hasil.keluaran || '').trim().slice(0, 300);
    for (const satu of rahasia) pesan = pesan.split(satu).join('••••');
    try { fs.unlinkSync(berkas); } catch { /* belum dibuat */ }
    throw new Error('cadangan gagal, tulis dibatalkan: ' + pesan);
  }
  let byte = 0;
  try { byte = fs.statSync(berkas).size; } catch { /* abaikan */ }
  return { berkas, byte };
}

function pecahDaftar(nilai) {
  if (Array.isArray(nilai)) return nilai.map(String).filter(Boolean);
  return String(nilai == null ? '' : nilai).split(',').map((s) => s.trim()).filter(Boolean);
}

/* --------------------------------------------------------- ALAT_OPS ---- */

export const ALAT_OPS = [
  {
    name: 'git',
    label: 'Git (status/diff/commit/branch/stash)',
    description: 'Git in the work folder: status, diff, log, commit (add + message), branch (list/create/delete), pindah (checkout), stash (push/list/pop/apply), push, pull, reset (soft|mixed|hard). Force push and reset --hard always save a rescue ref refs/sakti/selamat-* and ask the owner first.',
    parameters: {
      type: 'object',
      properties: {
        aksi: { type: 'string', description: 'status|diff|log|commit|branch|pindah|stash|push|pull|reset|selamat|tag|clean (bawaan status)' },
        pesan: { type: 'string', description: 'pesan commit / pesan stash' },
        berkas: { type: 'array', items: { type: 'string' }, description: 'berkas untuk add/diff/restore (kosong = semua)' },
        semua: { type: 'boolean', description: 'commit: add -A dulu (bawaan true bila berkas kosong)' },
        nama: { type: 'string', description: 'nama branch / nama unit' },
        hapus: { type: 'boolean', description: 'branch: hapus (butuh nama)' },
        sub: { type: 'string', description: 'stash: push|list|pop|apply' },
        remote: { type: 'string', description: 'remote push/pull (bawaan origin)' },
        cabang: { type: 'string', description: 'branch tujuan push (bawaan HEAD)' },
        paksa: { type: 'boolean', description: 'push paksa (--force-with-lease) atau clean -fd - WAJIB konfirmasi' },
        mode: { type: 'string', description: 'reset: soft|mixed|hard (hard WAJIB konfirmasi)' },
        jumlah: { type: 'number', description: 'log: berapa commit (bawaan 20)' },
        cwd: { type: 'string', description: 'folder repo (bawaan folder kerja)' },
        waktu: { type: 'number', description: 'batas waktu ms' }
      },
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const cwd = args.cwd ? path.resolve(konf.cwd, String(args.cwd)) : konf.cwd;
      const aksi = String(args.aksi || 'status').toLowerCase();
      const waktu = msWaktuLama(args.waktu, 60000);
      const berkas = pecahDaftar(args.berkas);

      if (aksi === 'status') {
        const { hasil, teks } = await gitJalan(cwd, ['status', '--porcelain=v1', '-b'], waktu);
        if (hasil.kode !== 0) return teks;
        const baris = String(hasil.keluaran || '').split('\n').filter(Boolean);
        const kepala = baris.find((b) => b.startsWith('## ')) || '';
        const perubahan = baris.filter((b) => !b.startsWith('## '));
        const hitung = { ubah: 0, tambah: 0, hapus: 0, lain: 0 };
        for (const b of perubahan) {
          const x = b[0];
          const y = b[1];
          if (x === '?' || y === '?') hitung.tambah += 1;
          else if (x === 'D' || y === 'D') hitung.hapus += 1;
          else hitung.ubah += 1;
        }
        return [kepala.replace(/^## /, 'cabang: '), 'perubahan: ' + perubahan.length + ' (ubah ' + hitung.ubah + ', baru ' + hitung.tambah + ', hapus ' + hitung.hapus + ')',
          potong(perubahan.slice(0, 60).join('\n'))].filter(Boolean).join('\n');
      }
      if (aksi === 'diff') {
        const arg = ['diff', ...(args.semua === true ? ['--cached'] : []), ...(berkas.length ? ['--', ...berkas] : [])];
        const { teks } = await gitJalan(cwd, arg, waktu);
        return teks;
      }
      if (aksi === 'log') {
        const { teks } = await gitJalan(cwd, ['log', '--oneline', '-n', String(Math.max(1, Math.min(200, Number(args.jumlah) || 20)))], waktu);
        return teks;
      }
      if (aksi === 'branch') {
        if (!args.nama) {
          const { teks } = await gitJalan(cwd, ['branch', '-vv'], waktu);
          return teks;
        }
        const nama = posisiGit(String(args.nama).replace(/[\s~^:?*[\\]/g, '-'), 'nama branch');
        if (args.hapus) return (await gitJalan(cwd, ['branch', '-D', nama], waktu)).teks + '\ncatatan: branch terhapus lokal; commit-nya bisa dipulihkan lewat git reflog';
        return (await gitJalan(cwd, ['branch', nama], waktu)).teks;
      }
      if (aksi === 'pindah') {
        if (!args.nama) throw new Error('pindah butuh "nama" branch');
        const nama = posisiGit(args.nama, 'nama branch');
        const cek = await gitJalan(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + nama], 15000);
        const arg = cek.hasil.kode === 0 ? ['checkout', nama] : ['checkout', '-b', nama];
        return (await gitJalan(cwd, arg, waktu)).teks;
      }
      if (aksi === 'stash') {
        const sub = String(args.sub || 'push').toLowerCase();
        if (sub === 'list') return (await gitJalan(cwd, ['stash', 'list'], waktu)).teks;
        if (sub === 'push') return (await gitJalan(cwd, ['stash', 'push', '-m', String(args.pesan || 'sakti')], waktu)).teks;
        if (sub === 'pop') return (await gitJalan(cwd, ['stash', 'pop'], waktu)).teks;
        if (sub === 'apply') return (await gitJalan(cwd, ['stash', 'apply', ...(args.nama ? [posisiGit(args.nama, 'stash')] : [])], waktu)).teks;
        throw new Error('sub stash tidak dikenal: ' + sub + ' (push|list|pop|apply)');
      }
      if (aksi === 'commit') {
        if (!String(args.pesan || '').trim()) throw new Error('commit butuh "pesan"');
        if (berkas.length) {
          const add = await gitJalan(cwd, ['add', '--', ...berkas], waktu);
          // `git add` gagal (jalur tidak ada) tidak boleh dilanjutkan ke commit:
          // commit akan memasukkan apa pun yang sudah staged sebelumnya.
          if (add.hasil.kode !== 0) return add.teks;
        } else if (args.semua !== false) await gitJalan(cwd, ['add', '-A'], waktu);
        const { hasil, teks } = await gitJalan(cwd, ['commit', '-m', String(args.pesan)], waktu);
        if (hasil.kode !== 0) return teks;
        const sha = await gitJalan(cwd, ['rev-parse', '--short', 'HEAD'], 15000);
        const stat = await gitJalan(cwd, ['show', '--stat', '--oneline', 'HEAD'], waktu);
        return teks + '\ncommit: ' + String(sha.hasil.keluaran).trim() + '\n' + potong(stat.hasil.keluaran, 3000);
      }
      if (aksi === 'push') {
        const paksa = args.paksa === true;
        let catatan = '';
        if (paksa) {
          const selamat = await simpanPenyelamat(cwd);
          catatan = selamat ? '\npenyelamat: ' + selamat.ref + ' · pulih: ' + selamat.pulih : '\npenyelamat: TIDAK dibuat (repo tanpa commit?)';
        }
        const remote = posisiGit(args.remote || 'origin', 'remote');
        const cabang = posisiGit(args.cabang || 'HEAD', 'cabang');
        const arg = ['push', ...(paksa ? ['--force-with-lease'] : []), remote, cabang];
        const { teks } = await gitJalan(cwd, arg, Math.max(waktu, 120000));
        return teks + catatan;
      }
      if (aksi === 'pull') {
        return (await gitJalan(cwd, ['pull', '--ff-only', posisiGit(args.remote || 'origin', 'remote')], Math.max(waktu, 120000))).teks;
      }
      if (aksi === 'reset') {
        const mode = String(args.mode || 'mixed').toLowerCase();
        if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('mode reset: soft|mixed|hard');
        let catatan = '';
        if (mode === 'hard') {
          const selamat = await simpanPenyelamat(cwd, { wajib: true });
          catatan = selamat
            ? '\npenyelamat: ' + selamat.ref + ' (HEAD ' + selamat.head.slice(0, 8) + ') · pulih: ' + selamat.pulih
            : '\npenyelamat: TIDAK dibuat (repo tanpa commit?)';
        }
        const target = posisiGit(args.nama || 'HEAD', 'target reset');
        return (await gitJalan(cwd, ['reset', '--' + mode, target], waktu)).teks + catatan;
      }
      if (aksi === 'tag') {
        if (!args.nama) return (await gitJalan(cwd, ['tag', '--sort=-creatordate'], waktu)).teks || '(tanpa tag)';
        const nama = posisiGit(String(args.nama).replace(/[\s~^:?*[\\]/g, '-'), 'nama tag');
        if (args.hapus) return (await gitJalan(cwd, ['tag', '-d', nama], waktu)).teks;
        const pesan = String(args.pesan || '').trim();
        return (await gitJalan(cwd, pesan ? ['tag', '-a', nama, '-m', pesan] : ['tag', nama], waktu)).teks
          || 'tag dibuat: ' + nama;
      }
      if (aksi === 'clean') {
        // Pratinjau adalah bawaan: `git clean -nd` tidak menghapus apa pun.
        // `paksa: true` baru menjalankan `-fd` (dan wajib konfirmasi di agent).
        if (args.paksa !== true) return (await gitJalan(cwd, ['clean', '-nd'], waktu)).teks || '(tidak ada berkas tak terlacak)';
        return (await gitJalan(cwd, ['clean', '-fd'], waktu)).teks || '(tidak ada yang dihapus)';
      }
      if (aksi === 'selamat') {
        const selamat = await simpanPenyelamat(cwd);
        if (!selamat) throw new Error('tidak bisa membuat ref penyelamat (repo kosong / bukan repo)');
        return 'penyelamat: ' + selamat.ref + '\ntitik: ' + selamat.titik + '\npulih: ' + selamat.pulih;
      }
      throw new Error('aksi git tidak dikenal: ' + aksi + ' (status|diff|log|commit|branch|pindah|stash|push|pull|reset|selamat)');
    }
  },
  {
    name: 'http',
    label: 'HTTP API',
    description: 'Call an HTTP API with real headers, bearer token and JSON body: method GET/POST/PUT/PATCH/DELETE, timeout, optional file output. Returns status, content-type, size, elapsed and the body (token redacted).',
    parameters: {
      type: 'object',
      properties: {
        metode: { type: 'string', description: 'GET|POST|PUT|PATCH|DELETE (bawaan GET)' },
        url: { type: 'string', description: 'alamat http(s)' },
        header: { type: 'object', description: 'header tambahan {nama: nilai}' },
        token: { type: 'string', description: 'bearer token (Authorization: Bearer ...)' },
        badan: { description: 'body JSON (objek) atau teks' },
        keluar: { type: 'string', description: 'simpan body ke berkas ini' },
        form: { type: 'object', description: 'multipart/form-data {nama: nilai} (alternatif badan)' },
        pengguna: { type: 'string', description: 'basic auth: nama pengguna' },
        sandi: { type: 'string', description: 'basic auth: sandi' },
        ulang: { type: 'number', description: 'coba ulang 0-3x untuk GET/HEAD/PUT/DELETE saat jaringan gagal atau 502/503/504 (bawaan 0)' },
        waktu: { type: 'number', description: 'batas waktu ms (bawaan 30000)' },
        maks: { type: 'number', description: 'batas karakter body yang ditampilkan (bawaan 8000)' }
      },
      required: ['url'],
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('url harus http(s)://');
      const metode = String(args.metode || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(metode)) throw new Error('metode tidak dikenal: ' + metode);
      const header = Object.assign({}, args.header || {});
      const token = String(args.token || '');
      if (token) header.authorization = 'Bearer ' + token;
      if (args.pengguna != null) {
        header.authorization = 'Basic ' + Buffer.from(String(args.pengguna) + ':' + String(args.sandi || '')).toString('base64');
      }
      let badan;
      if (args.form && typeof args.form === 'object' && metode !== 'GET' && metode !== 'HEAD') {
        const fd = new FormData();
        for (const [k, v] of Object.entries(args.form)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        badan = fd;
        for (const k of Object.keys(header)) if (k.toLowerCase() === 'content-type') delete header[k];
      } else if (args.badan != null && metode !== 'GET' && metode !== 'HEAD') {
        badan = typeof args.badan === 'string' ? args.badan : JSON.stringify(args.badan);
        if (!Object.keys(header).some((k) => k.toLowerCase() === 'content-type')) header['content-type'] = 'application/json';
      }
      const mulai = Date.now();
      // Hanya metode idempoten yang diulang: mengulang POST bisa membuat dua
      // pesanan/dua tiket. 502/503/504 juga hanya untuk metode itu.
      const idempoten = ['GET', 'HEAD', 'PUT', 'DELETE'].includes(metode);
      const ulang = idempoten ? Math.max(0, Math.min(3, Number(args.ulang) || 0)) : 0;
      let res;
      for (let percobaan = 0; ; percobaan += 1) {
        try {
          // fetchAman: tolak host privat/metadata (SSRF) + redirect manual maks 5.
          res = await fetchAman(url, { method: metode, headers: header, body: badan, signal: AbortSignal.timeout(Number(args.waktu) || 30000), keepalive: true });
          if (percobaan < ulang && [502, 503, 504].includes(res.status)) {
            await new Promise((siap) => setTimeout(siap, 300 * (percobaan + 1)));
            continue;
          }
        } catch (galat) {
          const pesan = String((galat && galat.message) || galat);
          if (/^DIBLOKIR SSRF|^protokol ditolak|^url tidak sah/.test(pesan)) throw new Error(pesan);
          if (percobaan < ulang) { await new Promise((siap) => setTimeout(siap, 300 * (percobaan + 1))); continue; }
          throw new Error('permintaan gagal: ' + redaksiTeks(pesan, [token, args.sandi]));
        }
        break;
      }
      const teks = await res.text().catch(() => '');
      const ms = Date.now() - mulai;
      const baris = [metode + ' ' + redaksiUrl(url), 'status: ' + res.status + ' ' + res.statusText,
        'tipe: ' + (res.headers.get('content-type') || '?'), 'ukuran: ' + teks.length + ' kar', 'waktu: ' + ms + 'ms'];
      const simpan = String(args.keluar || '').trim();
      if (simpan) {
        const berkas = jalurKerja(konf.cwd, simpan, 'keluar');
        // Jangan menimpa berkas baik dengan halaman galat, dan HEAD tidak punya
        // body: dulu `keluar` menulis '' sehingga berkas jadi 0 byte.
        if (!res.ok) {
          baris.push('TIDAK disimpan: status ' + res.status + ' (berkas lama tidak disentuh)');
        } else if (metode === 'HEAD') {
          baris.push('TIDAK disimpan: HEAD tidak punya body');
        } else {
          fs.mkdirSync(path.dirname(berkas), { recursive: true });
          const sementara = berkas + '.tmp-' + process.pid;
          fs.writeFileSync(sementara, teks);
          fs.renameSync(sementara, berkas);
          baris.push('disimpan: ' + berkas + ' (' + Math.round(teks.length / 1024) + ' KiB)');
        }
      }
      // Token tidak boleh ikut tercetak walau pemanggil mengirimnya.
      let tampil = potong(teks, Math.max(200, Number(args.maks) || 8000));
      if (token) tampil = tampil.split(token).join('••••');
      // Kredensial (header auth/cookie, token di query) disensor '***'.
      // Nilai header rahasia yang dikirim (mis. x-api-key) juga disensor bila dipantulkan server.
      const nilaiRahasia = Object.entries(args.header || {}).filter(([k]) => HEADER_RAHASIA.has(k.toLowerCase())).map(([, v]) => String(v).replace(/^(Bearer|Basic)\s+/i, ''));
      tampil = redaksiTeks(tampil, [args.sandi, ...nilaiRahasia]);
      return baris.join('\n') + (tampil ? '\n\n' + tampil : '');
    }
  },
  {
    name: 'db',
    label: 'Basis data (SQLite/Postgres/MySQL)',
    description: 'Query SQLite (built-in node:sqlite), Postgres (psql) or MySQL (mysql). Read-only by default: SELECT/PRAGMA/EXPLAIN/WITH only. Writes need tulis=true and SQLite is checkpointed (backup file) first; network DB writes must be backed up by you.',
    parameters: {
      type: 'object',
      properties: {
        mesin: { type: 'string', description: 'sqlite|postgres|mysql|auto (bawaan auto dari sumber)' },
        sumber: { type: 'string', description: 'jalur berkas .db (sqlite) atau URL koneksi' },
        sql: { type: 'string', description: 'satu atau beberapa pernyataan SQL' },
        param: { type: 'array', items: {}, description: 'nilai parameter (?) untuk SQLite - jangan menyusun SQL dari input' },
        tulis: { type: 'boolean', description: 'izinkan INSERT/UPDATE/DELETE/DDL (WAJIB konfirmasi)' },
        batas: { type: 'number', description: 'maks baris ditampilkan (bawaan 50)' },
        format: { type: 'string', description: 'tabel|json|csv (bawaan tabel)' },
        waktu: { type: 'number', description: 'batas waktu ms' }
      },
      required: ['sumber', 'sql'],
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const sql = String(args.sql || '').trim();
      if (!sql) throw new Error('butuh "sql"');
      const sumber = String(args.sumber || '').trim();
      if (!sumber) throw new Error('butuh "sumber" (berkas .db atau URL koneksi)');
      const mesin = (String(args.mesin || 'auto').toLowerCase() === 'auto'
        ? (/^postgres(ql)?:\/\//i.test(sumber) ? 'postgres' : /^mysql:\/\//i.test(sumber) ? 'mysql' : 'sqlite')
        : String(args.mesin).toLowerCase());
      const param = Array.isArray(args.param) ? args.param : [];
      if (param.length && mesin !== 'sqlite') throw new Error('param hanya didukung untuk SQLite');
      const pernyataan = pecahSql(sql);
      const bacaSemua = pernyataan.every((s) => /^(select|pragma|explain|with|values)\b/i.test(s) && !sqlMenulis(s));
      if (!bacaSemua && args.tulis !== true) {
        throw new Error('DITOLAK: kueri ini menulis (bukan SELECT/PRAGMA/EXPLAIN/WITH). Set tulis=true setelah pemilik menyetujui - SQLite akan dicadangkan dulu.');
      }
      const batas = Math.max(1, Math.min(5000, Number(args.batas) || 50));
      const format = String(args.format || 'tabel').toLowerCase();
      const tampil = (rows, kolom) => {
        const pakai = Array.isArray(rows) ? rows.slice(0, batas) : [];
        const lebih = Array.isArray(rows) && rows.length > batas ? '\n… ' + (rows.length - batas) + ' baris lagi (naikkan batas)' : '';
        if (format === 'json') return potong(JSON.stringify(pakai, null, 1)) + lebih;
        if (format === 'csv') {
          const kunci = kolom && kolom.length ? kolom : (pakai[0] ? Object.keys(pakai[0]) : []);
          const sel = (v) => (v == null ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v)).replace(/"/g, '""');
          return [kunci.join(','), ...pakai.map((row) => kunci.map((k) => '"' + sel(row[k]) + '"').join(','))].join('\n') + lebih;
        }
        return tabel(pakai, kolom) + lebih;
      };

      if (mesin === 'sqlite') {
        const berkas = sumber === ':memory:' ? ':memory:' : path.resolve(konf.cwd, sumber);
        const adaBerkas = berkas !== ':memory:' && fs.existsSync(berkas);
        // Berkas baru boleh dibuat (CREATE TABLE), tapi BACA ke berkas yang
        // tidak ada harus gagal jelas - bukan database kosong yang menipu.
        if (berkas !== ':memory:' && !adaBerkas && bacaSemua) throw new Error('berkas SQLite tidak ada: ' + berkas);
        let ckp = null;
        if (!bacaSemua && adaBerkas) {
          // WAL: commit terbaru hidup di <berkas>-wal, bukan di berkas utama.
          // Gabungkan WAL dulu supaya salinan cadangan memuat transaksi terakhir.
          try {
            const wal = new sqlite.DatabaseSync(berkas);
            try { wal.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } finally { wal.close(); }
          } catch { /* sqlite tidak ada: checkpoint(berkas) tetap berusaha salin apa adanya */ }
          ckp = checkpoint(berkas);
          if (!ckp) throw new Error('gagal mencadangkan ' + berkas + ' - tulis dibatalkan');
        }
        let sqlite;
        try { sqlite = await import('node:sqlite'); } catch { throw new Error('node:sqlite tidak tersedia di node ini (butuh node >= 22)'); }
        const db = new sqlite.DatabaseSync(berkas);
        try {
          if (!bacaSemua) {
            if (param.length) {
              if (pernyataan.length !== 1) throw new Error('param hanya untuk satu pernyataan tulis');
              db.prepare(sql).run(...param);
            } else db.exec(sql);
            const catatanCkp = ckp
              ? ' · checkpoint ' + ckp.id + ' (pulih: sakti khazanah kembalikan ' + ckp.id + ')'
              : (berkas === ':memory:' ? ' · :memory: tanpa cadangan' : ' · berkas baru, tanpa cadangan');
            return 'OK tulis: ' + pernyataan.length + ' pernyataan' + catatanCkp;
          }
          if (param.length && pernyataan.length !== 1) throw new Error('param hanya untuk satu pernyataan baca');
          let rows = [];
          let kolom = [];
          for (const satu of pernyataan) {
            const stmt = db.prepare(satu);
            const hasilBaca = param.length ? stmt.all(...param) : stmt.all();
            if (hasilBaca.length || !rows.length) {
              rows = hasilBaca;
              kolom = hasilBaca[0] ? Object.keys(hasilBaca[0]) : [];
            }
          }
          return 'sqlite: ' + berkas + ' · ' + rows.length + ' baris\n' + tampil(rows, kolom);
        } finally { try { db.close(); } catch { /* sudah */ } }
      }

      const rahasia = [];
      let perintah;
      let env = {};
      const u = new URL(sumber);
      const sandi = decodeURIComponent(u.password || '');
      if (sandi) rahasia.push(sandi);
      if (mesin === 'postgres') {
        const psql = cariBiner(['psql']);
        if (!psql) throw new Error('psql tidak terpasang. Pasang: apt install postgresql-client');
        env = Object.assign({}, process.env, sandi ? { PGPASSWORD: sandi } : {});
        const arg = ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username || 'postgres'), '-d', u.pathname.replace(/^\//, '') || 'postgres', '-A', '-P', 'pager=off', '-c', sql];
        perintah = kutip(psql) + ' ' + arg.map(kutip).join(' ');
      } else if (mesin === 'mysql') {
        const mysql = cariBiner(['mysql']);
        if (!mysql) throw new Error('mysql tidak terpasang. Pasang: apt install mariadb-client');
        env = Object.assign({}, process.env, sandi ? { MYSQL_PWD: sandi } : {});
        const arg = ['-h', u.hostname, '-P', u.port || '3306', '-u', decodeURIComponent(u.username || 'root'), '-D', u.pathname.replace(/^\//, ''), '--batch', '-e', sql];
        perintah = kutip(mysql) + ' ' + arg.map(kutip).join(' ');
      } else {
        throw new Error('mesin db tidak dikenal: ' + mesin + ' (sqlite|postgres|mysql)');
      }
      // Tulis ke server jaringan: dump penuh DULU. Gagal dump = tulis batal.
      let cadangan = null;
      if (!bacaSemua) cadangan = await cadangkanSql(mesin, sumber, env, konf.cwd, args.waktu);
      const asli = await shell(perintah, { cwd: konf.cwd, waktuMs: msWaktuLama(args.waktu, 120000), env });
      let teks = ringkasShell(asli);
      for (const satu of rahasia) teks = teks.split(satu).join('••••');
      const catatan = cadangan
        ? '\ncadangan: ' + cadangan.berkas + ' (' + Math.max(0, Math.round(cadangan.byte / 1024)) + ' KiB)'
        : '';
      return teks + catatan;
    }
  },
  {
    name: 'layanan',
    label: 'Layanan (systemd/pm2/docker)',
    description: 'Check, start, stop, restart a service via systemd, pm2 or docker, and read the last log lines. stop/restart always asks the owner first.',
    parameters: {
      type: 'object',
      properties: {
        aksi: { type: 'string', description: 'cek|start|stop|restart|daftar|log (bawaan cek)' },
        nama: { type: 'string', description: 'nama unit/pm2/container' },
        mesin: { type: 'string', description: 'systemd|pm2|docker|auto (bawaan auto)' },
        baris: { type: 'number', description: 'log: jumlah baris (bawaan 40)' },
        waktu: { type: 'number', description: 'batas waktu ms' }
      },
      required: ['aksi'],
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const aksi = String(args.aksi || 'cek').toLowerCase();
      const nama = String(args.nama || '').trim();
      if (!['cek', 'start', 'stop', 'restart', 'daftar', 'log'].includes(aksi)) throw new Error('aksi layanan tidak dikenal: ' + aksi);
      const sudah = String(args.mesin || 'auto').toLowerCase();
      const sys = cariBiner(['systemctl']);
      const pm2 = cariBiner(['pm2']);
      const docker = cariBiner(['docker']);
      let mesin = sudah;
      if (mesin === 'auto') {
        mesin = '';
        if (sys && nama) {
          const cek = await shell(kutip(sys) + ' list-unit-files ' + kutip(nama + '.service') + ' --no-pager --no-legend', { cwd: konf.cwd, waktuMs: 15000 });
          if (String(cek.keluaran || '').trim()) mesin = 'systemd';
        }
        if (!mesin && docker && nama) {
          const cek = await shell(kutip(docker) + ' ps -a --format ' + kutip('{{.Names}}') + ' --filter ' + kutip('name=' + nama), { cwd: konf.cwd, waktuMs: 15000 });
          if (String(cek.keluaran || '').split('\n').some((s) => s.trim() === nama)) mesin = 'docker';
        }
        if (!mesin && pm2 && nama) {
          const cek = await shell(kutip(pm2) + ' describe ' + kutip(nama), { cwd: konf.cwd, waktuMs: 20000 });
          if (cek.kode === 0) mesin = 'pm2';
        }
        if (!mesin) mesin = sys ? 'systemd' : docker ? 'docker' : pm2 ? 'pm2' : '';
        if (!mesin) throw new Error('tidak ada systemctl/pm2/docker di mesin ini');
      }
      const waktu = msWaktuLama(args.waktu, 60000);
      const perintahUntuk = (sub) => {
        if (mesin === 'systemd') {
          const bin = sys || cariBiner(['systemctl']);
          if (!bin) throw new Error('systemd tidak tersedia');
          if (sub === 'daftar') return kutip(bin) + ' list-units --type=service --state=running --no-pager --no-legend | head -40';
          if (sub === 'log') return kutip(bin) + ' status ' + kutip(nama) + ' --no-pager -n ' + Math.max(1, Number(args.baris) || 40) + ' 2>&1 | tail -' + Math.max(5, Number(args.baris) || 40);
          if (sub === 'cek') return kutip(bin) + ' is-active ' + kutip(nama) + '; ' + kutip(bin) + ' is-enabled ' + kutip(nama) + ' 2>/dev/null';
          return kutip(bin) + ' ' + sub + ' ' + kutip(nama);
        }
        if (mesin === 'docker') {
          const bin = docker || cariBiner(['docker']);
          if (!bin) throw new Error('docker tidak tersedia');
          if (sub === 'daftar') return kutip(bin) + ' ps -a --format ' + kutip('{{.Names}}\t{{.Status}}\t{{.Image}}');
          if (sub === 'log') return kutip(bin) + ' logs --tail ' + Math.max(1, Number(args.baris) || 40) + ' ' + kutip(nama) + ' 2>&1';
          if (sub === 'cek') return kutip(bin) + ' ps -a --filter ' + kutip('name=' + nama) + ' --format ' + kutip('{{.Names}}\t{{.Status}}');
          return kutip(bin) + ' ' + sub + ' ' + kutip(nama);
        }
        const bin = pm2 || cariBiner(['pm2']);
        if (!bin) throw new Error('pm2 tidak tersedia');
        if (sub === 'daftar') return kutip(bin) + ' list';
        if (sub === 'log') return kutip(bin) + ' logs ' + kutip(nama) + ' --nostream --lines ' + Math.max(1, Number(args.baris) || 40);
        if (sub === 'cek') return kutip(bin) + ' describe ' + kutip(nama) + ' | head -20';
        return kutip(bin) + ' ' + sub + ' ' + kutip(nama);
      };
      if (!nama && !['daftar'].includes(aksi)) throw new Error('butuh "nama" layanan untuk aksi ' + aksi);
      const { teks } = await jalan(perintahUntuk(aksi === 'log' ? 'log' : aksi), { cwd: konf.cwd, waktu });
      return 'mesin: ' + mesin + '\n' + teks;
    }
  },
  {
    name: 'paket',
    label: 'Paket (install/audit)',
    description: 'Install and audit dependencies for npm, pip or apt with a structured log: what was installed, exit code, duration, and audit findings (npm audit JSON, pip outdated, apt upgradable).',
    parameters: {
      type: 'object',
      properties: {
        aksi: { type: 'string', description: 'install|audit|daftar (bawaan audit)' },
        mesin: { type: 'string', description: 'npm|pip|apt|auto (bawaan auto dari folder kerja)' },
        nama: { type: 'array', items: { type: 'string' }, description: 'paket yang dipasang (aksi install)' },
        global: { type: 'boolean', description: 'install global (npm -g / pip --user tidak dipakai)' },
        waktu: { type: 'number', description: 'batas waktu ms (bawaan 300000)' }
      },
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const aksi = String(args.aksi || 'audit').toLowerCase();
      const cwd = konf.cwd;
      const paket = pecahDaftar(args.nama);
      let mesin = String(args.mesin || 'auto').toLowerCase();
      if (mesin === 'auto') {
        if (fs.existsSync(path.join(cwd, 'package.json'))) mesin = 'npm';
        else if (['requirements.txt', 'pyproject.toml', 'Pipfile'].some((f) => fs.existsSync(path.join(cwd, f)))) mesin = 'pip';
        else mesin = 'apt';
      }
      if (!['npm', 'pip', 'apt'].includes(mesin)) throw new Error('mesin paket tidak dikenal: ' + mesin);
      const mulai = Date.now();
      let perintah;
      if (aksi === 'install') {
        if (!paket.length) throw new Error('install butuh "nama" paket');
        perintah = mesin === 'npm' ? 'npm install ' + (args.global ? '-g ' : '') + paket.map(kutip).join(' ')
          : mesin === 'pip' ? 'python3 -m pip install ' + paket.map(kutip).join(' ')
            : 'DEBIAN_FRONTEND=noninteractive apt-get install -y ' + paket.map(kutip).join(' ');
      } else if (aksi === 'audit') {
        perintah = mesin === 'npm' ? 'npm audit --json'
          : mesin === 'pip' ? 'python3 -m pip list --outdated --format=json'
            : 'apt list --upgradable 2>/dev/null';
      } else if (aksi === 'daftar') {
        perintah = mesin === 'npm' ? 'npm ls --depth=0'
          : mesin === 'pip' ? 'python3 -m pip list'
            : 'dpkg -l | head -40';
      } else throw new Error('aksi paket tidak dikenal: ' + aksi + ' (install|audit|daftar)');

      const hasil = await jalan(perintah, { cwd, waktu: msWaktuLama(args.waktu, 300000) });
      const teks = hasil.teks;
      const ms = Date.now() - mulai;
      let temuan = null;
      if (aksi === 'audit') {
        const mentah = String(hasil.keluaran || '');
        try {
          const data = JSON.parse(mentah);
          if (mesin === 'npm') temuan = { rentan: (data.metadata && data.metadata.vulnerabilities) || null };
          else if (mesin === 'pip') temuan = { usang: Array.isArray(data) ? data.length : null };
        } catch {
          if (mesin === 'apt') temuan = { upgradable: mentah.split('\n').filter((s) => s.includes('upgradable') || /^\S+\//.test(s)).length };
        }
      }
      const log = { waktu: new Date().toISOString(), mesin, aksi, paket, kode: hasil.kode, ms, temuan };
      let jalurLog = '';
      try {
        const folder = process.env.SAKTI_CLI_LOG || path.join(folderProfil(), 'log');
        fs.mkdirSync(folder, { recursive: true });
        jalurLog = path.join(folder, 'paket-' + new Date().toISOString().slice(0, 10) + '.jsonl');
        fs.appendFileSync(jalurLog, JSON.stringify(log) + '\n');
      } catch { /* log tidak boleh menggagalkan */ }
      return teks + '\nlog: ' + JSON.stringify(log) + (jalurLog ? '\nberkas log: ' + jalurLog : '');
    }
  },
  {
    name: 'lint',
    label: 'Lint/format/typecheck',
    description: 'Run lint, format-check or typecheck with structured output: auto-detects package.json scripts, eslint, prettier, tsc, ruff, black, mypy, gofmt. Returns exit code plus error/warning counts. perbaiki=true applies fixes when the tool supports it.',
    parameters: {
      type: 'object',
      properties: {
        aksi: { type: 'string', description: 'lint|format|typecheck|auto (bawaan auto)' },
        cwd: { type: 'string', description: 'folder proyek' },
        berkas: { type: 'array', items: { type: 'string' }, description: 'berkas tertentu (kosong = proyek)' },
        perbaiki: { type: 'boolean', description: 'terapkan perbaikan otomatis bila ada' },
        waktu: { type: 'number', description: 'batas waktu ms (bawaan 180000)' }
      },
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const cwd = args.cwd ? path.resolve(konf.cwd, String(args.cwd)) : konf.cwd;
      const aksi = String(args.aksi || 'auto').toLowerCase();
      const berkas = pecahDaftar(args.berkas);
      const target = berkas.length ? ' ' + berkas.map(kutip).join(' ') : '';
      const paketJson = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { return null; } })();
      const skrip = (paketJson && paketJson.scripts) || {};
      const kandidat = [];
      if (aksi === 'auto' || aksi === 'lint') {
        if (skrip.lint) kandidat.push({ nama: 'npm run lint', perintah: 'npm run lint --silent' + (berkas.length ? ' -- ' + berkas.map(kutip).join(' ') : '') });
        if (cariBiner(['eslint'])) kandidat.push({ nama: 'eslint', perintah: kutip(cariBiner(['eslint'])) + ' ' + (args.perbaiki ? '--fix ' : '') + '--format json' + (target || ' .') });
        if (cariBiner(['ruff'])) kandidat.push({ nama: 'ruff', perintah: kutip(cariBiner(['ruff'])) + ' check' + (args.perbaiki ? ' --fix' : '') + (target || ' .') });
      }
      if (aksi === 'auto' || aksi === 'format') {
        if (skrip.format) kandidat.push({ nama: 'npm run format', perintah: 'npm run format --silent' });
        if (cariBiner(['prettier'])) kandidat.push({ nama: 'prettier', perintah: kutip(cariBiner(['prettier'])) + ' ' + (args.perbaiki ? '--write' : '--check') + (target || ' .') });
        if (cariBiner(['black'])) kandidat.push({ nama: 'black', perintah: kutip(cariBiner(['black'])) + ' ' + (args.perbaiki ? '' : '--check ') + (target || '.') });
      }
      if (aksi === 'auto' || aksi === 'typecheck') {
        if (skrip.typecheck) kandidat.push({ nama: 'npm run typecheck', perintah: 'npm run typecheck --silent' });
        if (cariBiner(['tsc'])) kandidat.push({ nama: 'tsc', perintah: kutip(cariBiner(['tsc'])) + ' --noEmit' });
        if (cariBiner(['mypy'])) kandidat.push({ nama: 'mypy', perintah: kutip(cariBiner(['mypy'])) + (target || ' .') });
        if (cariBiner(['gofmt'])) kandidat.push({ nama: 'gofmt', perintah: 'gofmt -l .' });
      }
      if (!kandidat.length) throw new Error('tidak ada lint/format/typecheck yang dikenali di ' + cwd + ' (npm script, eslint, prettier, tsc, ruff, black, mypy, gofmt)');
      const habis = [];
      for (const satu of kandidat) {
        const hasil = await jalan(satu.perintah, { cwd, waktu: msWaktuLama(args.waktu, 180000) });
        let galat = null;
        let peringatan = null;
        const mentah = String(hasil.keluaran || '');
        try {
          const data = JSON.parse(mentah);
          if (Array.isArray(data)) {
            galat = data.reduce((n, b) => n + (Number(b.errorCount) || 0), 0);
            peringatan = data.reduce((n, b) => n + (Number(b.warningCount) || 0), 0);
          }
        } catch { /* bukan eslint json */ }
        if (galat == null) {
          galat = (mentah.match(/\berror\b/gi) || []).length;
          peringatan = (mentah.match(/\bwarning\b/gi) || []).length;
        }
        habis.push({ alat: satu.nama, kode: hasil.kode, galat, peringatan,
          ringkas: (mentah.split('\n').filter((b) => /error|warning|✖|would reformat|Found \d+/.test(b))[0] || '').trim().slice(0, 160) });
        // Berhenti di alat pertama yang benar-benar menemukan masalah? Tidak:
        // lint, format, dan typecheck menjawab pertanyaan berbeda. Jalankan
        // semua yang diminta, laporkan masing-masing.
      }
      // Satu objek JSON utuh: skrip bisa JSON.parse seluruh keluaran, manusia
      // membaca field `ringkas` di dalamnya.
      return JSON.stringify({
        aksi,
        cwd,
        hasil: habis,
        ringkas: habis.map((s) => s.alat + ': exit ' + s.kode + ' · ' + s.galat + ' galat · ' + s.peringatan + ' peringatan' + (s.ringkas ? ' · ' + s.ringkas : ''))
      }, null, 1);
    }
  },
  {
    name: 'env',
    label: 'Baca .env (rahasia diredaksi)',
    description: 'Read a .env file and redact secrets: keys matching TOKEN/SECRET/PASS/KEY/AUTH/PRIVATE are shown as •••• with their length. kunci filters keys; buka=true reveals values and always asks the owner first.',
    parameters: {
      type: 'object',
      properties: {
        berkas: { type: 'string', description: 'jalur .env (bawaan .env)' },
        kunci: { type: 'array', items: { type: 'string' }, description: 'hanya kunci ini / berawalan ini' },
        buka: { type: 'boolean', description: 'tampilkan nilai rahasia (WAJIB konfirmasi)' }
      },
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const jalur = path.resolve(konf.cwd, String(args.berkas || '.env'));
      if (!fs.existsSync(jalur)) throw new Error('.env tidak ada: ' + jalur);
      const baris = fs.readFileSync(jalur, 'utf8').split('\n');
      const filter = pecahDaftar(args.kunci).map((s) => s.toLowerCase());
      const RAHASIA = /(TOKEN|SECRET|PASS|PWD|KEY|AUTH|CREDENTIAL|SIGNATURE|PRIVATE|DSN|CONN)/i;
      const hasil = [];
      for (const barisAsli of baris) {
        const barisBersih = barisAsli.replace(/\s+#.*$/, '');
        const cocok = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(barisBersih);
        if (!cocok) continue;
        const kunci = cocok[1];
        if (filter.length && !filter.some((f) => kunci.toLowerCase() === f || kunci.toLowerCase().startsWith(f))) continue;
        let nilai = cocok[2].trim();
        const dikutip = /^(['"])(.*)\1$/.exec(nilai);
        if (dikutip) nilai = dikutip[2];
        const rahasia = RAHASIA.test(kunci);
        hasil.push(kunci + '=' + (rahasia && !args.buka ? '•••• (' + String(nilai).length + ' kar)' : nilai));
      }
      if (!hasil.length) return 'tidak ada kunci cocok di ' + jalur;
      return 'berkas: ' + jalur + ' · ' + hasil.length + ' kunci' + (args.buka ? ' (nilai ditampilkan)' : ' (rahasia diredaksi)') + '\n' + hasil.join('\n');
    }
  },
  {
    name: 'json',
    label: 'Query JSON',
    description: 'Query/filter structured JSON without a temp script: sumber (file) or teks (inline), jalur (dot path like data.items), filter "k=v,k2~teks", pilih (comma fields), urut (field[:asc|desc]), batas, format json|tabel.',
    parameters: {
      type: 'object',
      properties: {
        sumber: { type: 'string', description: 'berkas JSON ("-" untuk teks)' },
        teks: { type: 'string', description: 'JSON langsung' },
        jalur: { type: 'string', description: 'jalur titik: data.items atau hasil.0' },
        filter: { type: 'string', description: 'k=v, umur>10, nama~teks' },
        pilih: { type: 'string', description: 'kolom dipisah koma' },
        urut: { type: 'string', description: 'field atau field:desc' },
        batas: { type: 'number', description: 'maks baris (bawaan 20)' },
        agregat: { type: 'string', description: 'hitung | jumlah:<field> | kelompok:<field>' },
        format: { type: 'string', description: 'json|tabel (bawaan tabel)' }
      },
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const { teks } = bacaTeks(args, konf, 'json');
      let data;
      try { data = JSON.parse(teks); } catch (galat) { throw new Error('JSON tidak sah: ' + String((galat && galat.message) || galat)); }
      const dipilih = nilaiJalur(data, args.jalur);
      if (dipilih === undefined) throw new Error('jalur tidak ada: ' + args.jalur);
      const hasil = agregat(saring(dipilih, args), args.agregat);
      if (String(args.format || 'tabel').toLowerCase() === 'json') return potong(JSON.stringify(hasil, null, 1));
      return Array.isArray(hasil) ? tabel(hasil) : tabel([hasil]);
    }
  },
  {
    name: 'csv',
    label: 'Query CSV',
    description: 'Query/filter CSV without a temp script: header detected, delimiter auto (comma/semicolon/tab), filter "k=v,k2~teks", pilih, urut field[:desc], batas, format json|tabel|csv.',
    parameters: {
      type: 'object',
      properties: {
        sumber: { type: 'string', description: 'berkas CSV ("-" untuk teks)' },
        teks: { type: 'string', description: 'CSV langsung' },
        pemisah: { type: 'string', description: 'pemisah (bawaan deteksi: , ; tab)' },
        filter: { type: 'string', description: 'k=v, angka>10, nama~teks' },
        pilih: { type: 'string', description: 'kolom dipisah koma' },
        urut: { type: 'string', description: 'field atau field:desc' },
        batas: { type: 'number', description: 'maks baris (bawaan 20)' },
        agregat: { type: 'string', description: 'hitung | jumlah:<field> | kelompok:<field>' },
        format: { type: 'string', description: 'tabel|json|csv (bawaan tabel)' }
      },
      additionalProperties: false
    },
    async jalankan(args, konf) {
      const { teks } = bacaTeks(args, konf, 'csv');
      const isi = String(teks).replace(/^\uFEFF/, '');
      let pemisah = args.pemisah ? String(args.pemisah) : '';
      if (!pemisah) {
        const barisPertama = isi.split('\n')[0] || '';
        const pilihan = [',', ';', '\t', '|'];
        pemisah = pilihan.sort((a, b) => barisPertama.split(b).length - barisPertama.split(a).length)[0];
      }
      // Parser CSV penuh: tanda kutip ganda boleh memuat pemisah DAN newline
      // (satu record bisa beberapa baris). Versi lama memecah per baris dulu,
      // jadi field ber-kutip yang berisi newline terbelah jadi record palsu.
      const pecahCsv = (teks, p) => {
        const records = [];
        let sel = [];
        let kini = '';
        let dalam = false;
        for (let i = 0; i < teks.length; i += 1) {
          const ch = teks[i];
          if (dalam) {
            if (ch === '"' && teks[i + 1] === '"') { kini += '"'; i += 1; }
            else if (ch === '"') dalam = false;
            else kini += ch;
            continue;
          }
          if (ch === '"') { dalam = true; continue; }
          if (ch === p) { sel.push(kini); kini = ''; continue; }
          if (ch === '\n') { sel.push(kini); records.push(sel); sel = []; kini = ''; continue; }
          if (ch === '\r') continue;
          kini += ch;
        }
        if (kini !== '' || sel.length) { sel.push(kini); records.push(sel); }
        // Baris kosong (mis. newline di akhir berkas) bukan record.
        return records.filter((row) => row.some((nilai) => String(nilai).trim() !== ''));
      };
      const semuaBaris = pecahCsv(isi, pemisah);
      if (!semuaBaris.length) return '(CSV kosong)';
      const kepala = semuaBaris[0];
      const rows = semuaBaris.slice(1).map((sel) => {
        const row = {};
        kepala.forEach((k, i) => { row[k] = sel[i] == null ? '' : sel[i]; });
        return row;
      });
      const hasil = agregat(saring(rows, args), args.agregat);
      const format = String(args.format || 'tabel').toLowerCase();
      if (format === 'json') return potong(JSON.stringify(hasil, null, 1));
      if (format === 'csv') {
        const kunci = Object.keys(hasil[0] || {});
        const sel = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        return [kunci.join(','), ...hasil.map((row) => kunci.map((k) => sel(row[k])).join(','))].join('\n');
      }
      return hasil.length + ' baris · ' + kepala.length + ' kolom\n' + tabel(hasil);
    }
  }
];
