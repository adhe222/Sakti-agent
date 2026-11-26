// Mesin self-improvement aman: agen mengusulkan perubahan pada kode sakti-cli
// sendiri, diuji di salinan (sandbox), baru diterapkan bila lulus, dengan
// cadangan + pemulihan otomatis. Juga pemasang alat (npm/pip/apt/bin) dengan
// validasi nama ketat. Tanpa git commit; tanpa shell (argumen array).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { akarSakti, folderRumah } from './rawat.js';
import { ubahState } from './lokal.js';

export const PENGAMAN = ['lib/jaring.js', 'lib/izin.js', 'lib/diri.js'];
// Berkas milik manusia (ADR-003 K4, pola OpenSRE "SKILL.md + system prompt =
// berkas milik manusia"): prompt injection yang mengusulkan edit berkas ini
// DITOLAK di periksaJalurDiri. Nama persis di akar repo ATAU di folder mana pun
// (SKILL.md bisa ada di subfolder skill).
export const MILIK_MANUSIA = new Set(['SKILL.md', 'AGENTS.md', 'SAKTI.md', 'CLAUDE.md', '.sakti.md', '.cursorrules']);
const DILARANG_AWAL = ['.git/', 'node_modules/'];
const DILARANG_NAMA = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const LEWATI_SALIN = new Set(['.git', 'node_modules']);
export const NAMA_PAKET_RE = /^[a-zA-Z0-9@._/+-]+$/;
const UJI_WAKTU_MS = 300000;
const EKOR_MAKS = 3000;

class GalatDiri extends Error {}

export function akarDiri() {
  const a = process.env.SAKTI_DIRI_AKAR || akarSakti();
  return fs.realpathSync(a);
}
export function folderDiri() { return path.join(folderRumah(), 'diri'); }
const folderUsulan = (id) => path.join(folderDiri(), 'usulan', id);
const folderCadangan = (id) => path.join(folderDiri(), 'cadangan', id);
const berkasLog = () => path.join(folderDiri(), 'log.ndjson');
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ekor = (s, n = EKOR_MAKS) => { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s; };
const idValid = (id) => typeof id === 'string' && /^[a-z0-9-]{6,64}$/.test(id);

function tulisAtomik(jalur, isi) {
  fs.mkdirSync(path.dirname(jalur), { recursive: true });
  const tmp = `${jalur}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, isi);
  fs.renameSync(tmp, jalur);
}

function catat(entri) {
  fs.mkdirSync(folderDiri(), { recursive: true });
  fs.appendFileSync(berkasLog(), JSON.stringify({ at: new Date().toISOString(), ...entri }) + '\n');
}

// Validasi jalur relatif terhadap akar: tolak keluar akar, symlink keluar,
// .git/, node_modules/, lockfile, dan berkas pengaman (kecuali SAKTI_DIRI_PENGAMAN=1).
export function periksaJalurDiri(berkas, akar = akarDiri()) {
  if (typeof berkas !== 'string' || !berkas.trim()) throw new GalatDiri('jalur berkas kosong');
  if (berkas.includes('\0')) throw new GalatDiri('jalur berisi NUL');
  const abs = path.resolve(akar, berkas);
  const rel = path.relative(akar, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new GalatDiri(`jalur di luar repo sakti: ${berkas}`);
  const relPosix = rel.split(path.sep).join('/');
  if (DILARANG_AWAL.some((p) => relPosix === p.slice(0, -1) || relPosix.startsWith(p)) || relPosix.split('/').includes('.git')) {
    throw new GalatDiri(`jalur terlarang: ${relPosix}`);
  }
  if (DILARANG_NAMA.has(path.basename(relPosix))) throw new GalatDiri(`lockfile tidak boleh diubah: ${relPosix}`);
  if (PENGAMAN.includes(relPosix) && process.env.SAKTI_DIRI_PENGAMAN !== '1') {
    throw new GalatDiri(`berkas pengaman tidak boleh diubah agen: ${relPosix} (butuh SAKTI_DIRI_PENGAMAN=1 dari manusia)`);
  }
  // Berkas milik manusia (ADR-003 K4): SKILL.md + berkas petunjuk menentukan
  // perilaku agen, jadi agen tidak boleh mengubahnya walau diminta - sama
  // gerbangnya dengan berkas pengaman (SAKTI_DIRI_PENGAMAN=1 dari manusia).
  if (MILIK_MANUSIA.has(path.basename(relPosix)) && process.env.SAKTI_DIRI_PENGAMAN !== '1') {
    throw new GalatDiri(`berkas milik manusia tidak boleh diubah agen: ${relPosix} (butuh SAKTI_DIRI_PENGAMAN=1 dari manusia)`);
  }
  // Symlink: leluhur terdekat yang ada harus berada di dalam akar (realpath).
  let cek = abs;
  while (!fs.existsSync(cek)) cek = path.dirname(cek);
  const nyata = fs.realpathSync(cek);
  const relNyata = path.relative(akar, nyata);
  if (relNyata.startsWith('..') || path.isAbsolute(relNyata)) throw new GalatDiri(`symlink keluar repo: ${relPosix}`);
  if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new GalatDiri(`berkas symlink ditolak: ${relPosix}`);
  if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) throw new GalatDiri(`bukan berkas biasa: ${relPosix}`);
  return { abs, rel: relPosix };
}

function jalan(cmd, args, { cwd, waktuMs = UJI_WAKTU_MS, env = {} } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: waktuMs, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const kode = r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 127) : (r.status ?? (r.signal ? 128 : 1));
  return { kode, keluaran: `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}` };
}

function salinRepo(akar, tujuan) {
  fs.cpSync(akar, tujuan, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !LEWATI_SALIN.has(path.basename(src)) || path.dirname(src) !== akar,
  });
  const nm = path.join(akar, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(tujuan, 'node_modules'), 'dir');
}

function diffSatu(rel, lama, baru) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sakti-diff-'));
  try {
    const a = path.join(d, 'a'); const b = path.join(d, 'b');
    fs.writeFileSync(a, lama ?? ''); fs.writeFileSync(b, baru);
    const r = spawnSync('diff', ['-u', '--label', lama == null ? '/dev/null' : `a/${rel}`, '--label', `b/${rel}`, a, b], { encoding: 'utf8' });
    return r.stdout || '';
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

/**
 * Rangkaian uji yang WAJIB lulus sebelum usulan layak diterapkan.
 * 1. node --check untuk setiap berkas JS yang disentuh.
 * 2. Uji langsung: berkas uji-*.mjs yang ikut disentuh.
 * 3. Uji modul: untuk setiap lib/<x>.js yang disentuh, SEMUA uji yang
 *    mengimpor modul itu (bukan cuma uji-<x>.mjs yang namanya kebetulan cocok -
 *    dulu mengubah lib/model.js tidak menyentuh uji-retry-429.mjs).
 * 4. ujiPenuh: seluruh suite (uji-jalan.sh).
 */
function ujiBerkas(cwd, rels, { ujiPenuh = false } = {}) {
  const langkah = [];
  for (const rel of rels) {
    if (/\.(m?js|cjs)$/.test(rel)) langkah.push(['node', ['--check', rel]]);
  }
  const uji = new Set();
  for (const rel of rels) {
    if (/^uji-.*\.mjs$/.test(path.basename(rel))) uji.add(rel);
  }
  // Pemilik uji dicari dari ISI berkas uji: yang mengimpor modul yang disentuh.
  const modul = new Set(rels.filter((r) => r.startsWith('lib/')).map((r) => r.slice('lib/'.length).replace(/\.(m?js|cjs)$/, '')));
  if (modul.size) {
    let daftarUji = [];
    try { daftarUji = fs.readdirSync(cwd).filter((f) => /^uji-.*\.mjs$/.test(f)); } catch { /* akar tak terbaca */ }
    for (const f of daftarUji) {
      if (uji.has(f)) continue;
      let isi = '';
      try { isi = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
      for (const m of modul) {
        if (isi.includes('/lib/' + m + '.js')) { uji.add(f); break; }
      }
    }
  }
  // Cadangan: uji-<nama-modul>.mjs tetap masuk walau tidak mengimpor langsung.
  for (const rel of rels) {
    const base = path.basename(rel).replace(/\.(m?js|cjs)$/, '');
    if (rel.startsWith('lib/') && fs.existsSync(path.join(cwd, `uji-${base}.mjs`))) uji.add(`uji-${base}.mjs`);
  }
  for (const u of uji) langkah.push(['node', [u]]);
  if (ujiPenuh && fs.existsSync(path.join(cwd, 'uji-jalan.sh'))) langkah.push(['bash', ['uji-jalan.sh']]);
  let log = '';
  for (const [cmd, args] of langkah) {
    const r = jalan(cmd, args, { cwd });
    log += `$ ${cmd} ${args.join(' ')}\n[exit ${r.kode}]\n${ekor(r.keluaran, 1500)}\n`;
    if (r.kode !== 0) return { kode: r.kode, ekor: ekor(log), langkah: langkah.length, uji: uji.size };
  }
  return { kode: 0, ekor: ekor(log || '(tidak ada uji yang relevan)'), langkah: langkah.length, uji: uji.size };
}

export function usulUbahDiri({ editan = [], berkasBaru = [], alasan = '', ujiPenuh = false } = {}) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  let sandbox = null;
  try {
    if (!String(alasan).trim()) throw new GalatDiri('alasan wajib diisi');
    if (!Array.isArray(editan) || !Array.isArray(berkasBaru)) throw new GalatDiri('editan/berkasBaru harus array');
    if (!editan.length && !berkasBaru.length) throw new GalatDiri('tidak ada editan atau berkasBaru');
    const akar = akarDiri();
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sakti-diri-'));
    salinRepo(akar, sandbox);
    const berubah = new Map(); // rel -> { lamaBuf|null }
    for (const e of editan) {
      const { rel } = periksaJalurDiri(e?.berkas, akar);
      const target = path.join(sandbox, rel);
      if (!fs.existsSync(target)) throw new GalatDiri(`berkas tidak ada untuk diedit: ${rel}`);
      if (typeof e.cari !== 'string' || !e.cari) throw new GalatDiri(`cari kosong untuk ${rel}`);
      if (typeof e.ganti !== 'string') throw new GalatDiri(`ganti harus string untuk ${rel}`);
      const teks = fs.readFileSync(target, 'utf8');
      const n = teks.split(e.cari).length - 1;
      if (n !== 1) throw new GalatDiri(`teks cari ditemukan ${n}x di ${rel} (harus tepat 1)`);
      if (!berubah.has(rel)) berubah.set(rel, { lama: fs.readFileSync(path.join(akar, rel)) });
      fs.writeFileSync(target, teks.replace(e.cari, () => e.ganti));
    }
    for (const b of berkasBaru) {
      const { rel, abs } = periksaJalurDiri(b?.berkas, akar);
      if (typeof b.isi !== 'string') throw new GalatDiri(`isi harus string untuk ${rel}`);
      if (fs.existsSync(abs) && !b.timpa) throw new GalatDiri(`berkas sudah ada: ${rel} (pakai editan atau timpa:true)`);
      if (!berubah.has(rel)) berubah.set(rel, { lama: fs.existsSync(abs) ? fs.readFileSync(abs) : null });
      fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
      fs.writeFileSync(path.join(sandbox, rel), b.isi);
    }
    const rels = [...berubah.keys()];
    let diff = '';
    const manifesBerkas = [];
    const fu = folderUsulan(id);
    for (const rel of rels) {
      const baru = fs.readFileSync(path.join(sandbox, rel));
      const lama = berubah.get(rel).lama;
      diff += diffSatu(rel, lama, baru);
      tulisAtomik(path.join(fu, 'berkas', rel), baru);
      manifesBerkas.push({ rel, baru: lama == null, hashAsli: lama == null ? null : hash(lama), hashBaru: hash(baru) });
    }
    const uji = ujiBerkas(sandbox, rels, { ujiPenuh });
    const ok = uji.kode === 0;
    const manifes = { id, alasan, at: new Date().toISOString(), akar, berkas: manifesBerkas, uji, status: ok ? 'usul' : 'gagal' };
    tulisAtomik(path.join(fu, 'diff.patch'), diff);
    tulisAtomik(path.join(fu, 'manifes.json'), JSON.stringify(manifes, null, 2));
    catat({ id, alasan, status: manifes.status, berkas: rels, uji: uji.kode });
    return { ok, id, diff, uji: { kode: uji.kode, ekor: uji.ekor, langkah: uji.langkah, jumlahUji: uji.uji }, ...(ok ? {} : { galat: `uji gagal (exit ${uji.kode})` }) };
  } catch (e) {
    catat({ id, alasan, status: 'gagal', berkas: [], galat: e.message });
    return { ok: false, id, diff: '', uji: { kode: -1, ekor: '' }, galat: e.message };
  } finally {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function bacaManifes(id) {
  if (!idValid(id)) throw new GalatDiri(`id tidak valid: ${id}`);
  const f = path.join(folderUsulan(id), 'manifes.json');
  if (!fs.existsSync(f)) throw new GalatDiri(`usulan tidak ditemukan: ${id}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const simpanManifes = (m) => tulisAtomik(path.join(folderUsulan(m.id), 'manifes.json'), JSON.stringify(m, null, 2));

function pulihkan(akar, cadDir, daftar) {
  for (const b of daftar) {
    const abs = path.join(akar, b.rel);
    if (b.baru) fs.rmSync(abs, { force: true });
    else tulisAtomik(abs, fs.readFileSync(path.join(cadDir, b.rel)));
  }
}

export function terapkanUbahDiri(id) {
  let m;
  try {
    m = bacaManifes(id);
    if (m.status !== 'usul') throw new GalatDiri(`status usulan '${m.status}', hanya 'usul' yang bisa diterapkan`);
    if (m.uji?.kode !== 0) throw new GalatDiri('uji usulan tidak lulus');
    const akar = akarDiri();
    if (m.akar !== akar) throw new GalatDiri(`akar berbeda: usulan ${m.akar}, sekarang ${akar}`);
    // Validasi ulang + deteksi konflik (berkas asli berubah sejak usulan).
    for (const b of m.berkas) {
      const { abs } = periksaJalurDiri(b.rel, akar);
      const ada = fs.existsSync(abs);
      if (b.baru ? ada : (!ada || hash(fs.readFileSync(abs)) !== b.hashAsli)) {
        throw new GalatDiri(`konflik: ${b.rel} berubah sejak usulan dibuat; buat usulan baru`);
      }
    }
    const cad = folderCadangan(id);
    for (const b of m.berkas) if (!b.baru) tulisAtomik(path.join(cad, b.rel), fs.readFileSync(path.join(akar, b.rel)));
    tulisAtomik(path.join(cad, 'manifes.json'), JSON.stringify(m.berkas, null, 2));
    const diterapkan = [];
    try {
      for (const b of m.berkas) {
        tulisAtomik(path.join(akar, b.rel), fs.readFileSync(path.join(folderUsulan(id), 'berkas', b.rel)));
        diterapkan.push(b);
      }
      for (const b of m.berkas) {
        if (!/\.(m?js|cjs)$/.test(b.rel)) continue;
        const r = jalan('node', ['--check', b.rel], { cwd: akar, waktuMs: 60000 });
        if (r.kode !== 0) throw new GalatDiri(`node --check ${b.rel} gagal di repo asli: ${ekor(r.keluaran, 500)}`);
      }
    } catch (e) {
      pulihkan(akar, cad, diterapkan);
      throw new GalatDiri(`${e.message} (dipulihkan otomatis)`);
    }
    m.status = 'terapkan'; m.diterapkan = new Date().toISOString();
    simpanManifes(m);
    const berkas = m.berkas.map((b) => b.rel);
    catat({ id, alasan: m.alasan, status: 'terapkan', berkas });
    // Papan review: perubahan pada diri sendiri WAJIB terlihat pemilik review
    // (Febby) dan koordinator (Sulhan) lewat "mind" - dulu hasil terapkan duduk
    // diam tanpa jejak di papan kerja tim.
    try {
      ubahState((state) => {
        state.mind = Array.isArray(state.mind) ? state.mind : [];
        state.mind.push({
          teks: 'ubah-diri ' + id + ' DITERAPKAN menunggu review Febby: ' + String(m.alasan || '').slice(0, 120)
            + ' · berkas: ' + berkas.join(', ') + ' · kembalikan: ubah_diri aksi=kembalikan id=' + id,
          at: Date.now(),
          sumber: 'ubah-diri',
        });
      });
    } catch { /* papan penuh/gagal: jangan batalkan penerapan yang sudah sukses */ }
    return { ok: true, berkas, cadangan: cad };
  } catch (e) {
    catat({ id, alasan: m?.alasan || '', status: 'gagal', berkas: m?.berkas?.map((b) => b.rel) || [], galat: e.message, aksi: 'terapkan' });
    return { ok: false, berkas: [], cadangan: null, galat: e.message };
  }
}

export function kembalikanUbahDiri(id) {
  let m;
  try {
    m = bacaManifes(id);
    if (m.status !== 'terapkan') throw new GalatDiri(`status '${m.status}', hanya usulan yang diterapkan bisa dikembalikan`);
    const akar = akarDiri();
    const cad = folderCadangan(id);
    if (!fs.existsSync(path.join(cad, 'manifes.json'))) throw new GalatDiri(`cadangan tidak ditemukan: ${cad}`);
    for (const b of m.berkas) periksaJalurDiri(b.rel, akar);
    pulihkan(akar, cad, m.berkas);
    m.status = 'kembali'; m.dikembalikan = new Date().toISOString();
    simpanManifes(m);
    const berkas = m.berkas.map((b) => b.rel);
    catat({ id, alasan: m.alasan, status: 'kembali', berkas });
    return { ok: true, berkas };
  } catch (e) {
    catat({ id, alasan: m?.alasan || '', status: 'gagal', berkas: [], galat: e.message, aksi: 'kembali' });
    return { ok: false, berkas: [], galat: e.message };
  }
}

export function riwayatUbahDiri({ batas = 20 } = {}) {
  const f = berkasLog();
  if (!fs.existsSync(f)) return [];
  const per = new Map();
  for (const baris of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!baris.trim()) continue;
    let e; try { e = JSON.parse(baris); } catch { continue; }
    if (!e.id || e.jenis === 'pasang') continue;
    const lama = per.get(e.id);
    // Gagal terapkan/kembali tidak menimpa status usulan yang valid.
    if (lama && e.status === 'gagal' && e.aksi) { lama.galat = e.galat; continue; }
    per.set(e.id, { id: e.id, alasan: e.alasan || lama?.alasan || '', at: e.at, status: e.status,
      berkas: e.berkas?.length ? e.berkas : (lama?.berkas || []), ...(e.galat ? { galat: e.galat } : {}) });
  }
  return [...per.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, Math.max(1, Number(batas) || 20));
}

export function periksaNamaPaket(nama) {
  if (typeof nama !== 'string' || !nama || nama.length > 214) return 'nama kosong/terlalu panjang';
  if (!NAMA_PAKET_RE.test(nama)) return 'nama berisi karakter terlarang';
  if (nama.startsWith('-') || nama.includes('..') || nama.includes('//')) return 'nama berbentuk opsi/jalur/URL';
  return null;
}

/** Nama dasar paket tanpa versi: `prettier@3` -> `prettier`, `@a/b@1` -> `@a/b`, `ruff==0.5` -> `ruff`. */
export function namaDasarPaket(mesin, nama) {
  const s = String(nama || '');
  if (mesin === 'npm') return s.replace(/(.)@[^@/]*$/, '$1');
  if (mesin === 'pip') return s.replace(/[=<>~!].*$/, '');
  return s;
}

/**
 * Allowlist dari env SAKTI_PASANG_IZIN="npm:prettier,pip:ruff,jq" (tanpa awalan = semua mesin).
 * Kosong/tak di-set = tak dibatasi. Kembalikan true bila boleh. Mesin `bin` (hanya cek PATH) tak dibatasi.
 */
export function pasangDiizinkan(mesin, nama, teks = process.env.SAKTI_PASANG_IZIN) {
  const daftar = String(teks || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!daftar.length || mesin === 'bin') return true;
  const dasar = namaDasarPaket(mesin, nama);
  return daftar.some((e) => {
    const m = /^(npm|pip|apt|bin):(.+)$/.exec(e);
    const [em, en] = m ? [m[1], m[2]] : [null, e];
    return (em === null || em === mesin) && (en === nama || en === dasar);
  });
}

export function pasangAlat({ mesin, nama, alasan = '' } = {}) {
  const hasil = (o) => { catat({ jenis: 'pasang', mesin, nama, alasan, ok: o.ok, kode: o.kode, sudahAda: o.sudahAda }); return o; };
  const salah = periksaNamaPaket(nama);
  if (salah) return hasil({ ok: false, kode: -1, keluaran: `ditolak: ${salah}`, sudahAda: false });
  if (!pasangDiizinkan(mesin, nama)) return hasil({ ok: false, kode: -1, keluaran: 'ditolak: bukan daftar SAKTI_PASANG_IZIN', sudahAda: false });
  // Skrip pemasangan (npm lifecycle, pip setup.py/sdist) MATI kecuali manusia set SAKTI_PASANG_SKRIP=1.
  const skrip = process.env.SAKTI_PASANG_SKRIP === '1';
  const ada = (r) => ({ ok: true, kode: 0, keluaran: ekor(r.keluaran, 1500), sudahAda: true });
  const pasang = (r) => ({ ok: r.kode === 0, kode: r.kode, keluaran: ekor(r.keluaran), sudahAda: false });
  const W = 900000;
  if (mesin === 'bin') {
    const r = jalan('sh', ['-c', 'command -v "$1"', 'sh', nama]);
    if (r.kode === 0) return hasil(ada(r));
    return hasil({ ok: false, kode: r.kode, keluaran: `${nama} tidak ditemukan di PATH; pasang lewat mesin npm/pip/apt`, sudahAda: false });
  }
  if (mesin === 'npm') {
    const r = jalan('npm', ['ls', '-g', '--depth=0', nama]);
    if (r.kode === 0 && r.keluaran.includes(nama.replace(/@[^@/]+$/, ''))) return hasil(ada(r));
    return hasil(pasang(jalan('npm', ['install', '-g', ...(skrip ? [] : ['--ignore-scripts']), '--', nama], { waktuMs: W })));
  }
  if (mesin === 'pip') {
    const venv = path.join(folderRumah(), 'venv');
    const py = path.join(venv, 'bin', 'python');
    if (!fs.existsSync(py)) {
      const r = jalan('python3', ['-m', 'venv', venv], { waktuMs: 120000 });
      if (r.kode !== 0) return hasil({ ok: false, kode: r.kode, keluaran: `gagal membuat venv ${venv}: ${ekor(r.keluaran, 800)}`, sudahAda: false });
    }
    const r = jalan(py, ['-m', 'pip', 'show', nama.replace(/[=<>].*$/, '')]);
    if (r.kode === 0) return hasil(ada(r));
    const p = pasang(jalan(py, ['-m', 'pip', 'install', ...(skrip ? [] : ['--only-binary=:all:']), '--', nama], { waktuMs: W }));
    if (p.ok) p.keluaran += `\n(terpasang di venv ${venv}; jalankan dengan ${py})`;
    return hasil(p);
  }
  if (mesin === 'apt') {
    const r = jalan('dpkg', ['-s', nama]);
    if (r.kode === 0 && /Status: install ok installed/.test(r.keluaran)) return hasil(ada(r));
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      return hasil({ ok: false, kode: -1, keluaran: 'apt butuh root; minta manusia memasang', sudahAda: false });
    }
    return hasil(pasang(jalan('apt-get', ['install', '-y', '--no-install-recommends', '--', nama], { waktuMs: W, env: { DEBIAN_FRONTEND: 'noninteractive' } })));
  }
  return hasil({ ok: false, kode: -1, keluaran: `mesin tidak dikenal: ${mesin} (npm|pip|apt|bin)`, sudahAda: false });
}
