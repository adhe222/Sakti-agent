// Integrasi opsional Agent Reach (https://github.com/Panniantong/Agent-Reach):
// pembungkus CLI `agent-reach`, tanpa menambah dependensi Python ke inti sakti.
//
// Program resmi dipasang dengan uv ke ~/.local/bin; skill-nya dipasang oleh
// `agent-reach setup` ke ~/.hermes/skills/agent-reach sehingga agen sakti bisa
// membacanya. Wrapper ini hanya menemukan, memasang, dan meneruskan perintah.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SUMBER = 'https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip';

function bisaDijalankan(jalur) {
  try {
    const st = fs.statSync(jalur);
    if (!st.isFile()) return false;
    fs.accessSync(jalur, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** Cari biner agent-reach: env, PATH, atau ~/.local/bin. */
export function jalurReach() {
  const env = String(process.env.SAKTI_CLI_REACH || '').trim();
  if (env && bisaDijalankan(env)) return env;
  const kandidat = [path.join(os.homedir(), '.local', 'bin', 'agent-reach')];
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    if (folder) kandidat.push(path.join(folder, 'agent-reach'));
  }
  return kandidat.find(bisaDijalankan) || null;
}

/** Status: versi dan lokasi. Output JSON dari Agent Reach; aman bila belum ada. */
export function statusReach() {
  const jalur = jalurReach();
  if (!jalur) return { ada: false, jalur: null, versi: '', galat: '' };
  const hasil = spawnSync(jalur, ['version'], { encoding: 'utf8', timeout: 15000 });
  let versi = '';
  try {
    const isi = JSON.parse(String(hasil.stdout || '').trim());
    versi = String((isi && isi.result && isi.result.version) || '');
  } catch { /* versi teks lama */ }
  if (!versi) versi = String(hasil.stdout || hasil.stderr || '').trim().split('\n')[0].slice(0, 80);
  return { ada: true, jalur, versi, galat: hasil.error ? String(hasil.error.message || hasil.error) : '' };
}

/** Teruskan perintah Agent Reach apa adanya. */
export function jalankanReach(sisa = [], { cwd = process.cwd(), stdio = 'inherit', env = {} } = {}) {
  const jalur = jalurReach();
  if (!jalur) {
    return { ok: false, kode: 127, galat: 'Agent Reach belum terpasang. Jalankan: sakti reach pasang' };
  }
  const hasil = spawnSync(jalur, sisa, {
    cwd, stdio, env: Object.assign({}, process.env, env)
  });
  return {
    ok: hasil.status === 0,
    kode: hasil.status == null ? 1 : hasil.status,
    signal: hasil.signal || '',
    galat: hasil.error ? String(hasil.error.message || hasil.error) : ''
  };
}

/** Cari/ pasang uv; Agent Reach resmi memakai uv tool, bukan PyPI. */
function jalurUv() {
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    const calon = path.join(folder, 'uv');
    if (bisaDijalankan(calon)) return calon;
  }
  return null;
}

/**
 * Pasang/refresh Agent Reach dengan installer resmi (uv tool).
 * Tidak memakai PyPI: paket `agent-reach` di PyPI bukan proyek ini.
 */
export function pasangReach({ stdio = 'inherit' } = {}) {
  const uv = jalurUv();
  if (!uv) {
    return { ok: false, galat: 'uv belum ada. Pasang uv: curl -LsSf https://astral.sh/uv/install.sh | sh' };
  }
  const hasil = spawnSync(uv, ['tool', 'install', '--force', SUMBER], {
    stdio, env: process.env
  });
  if (hasil.error) return { ok: false, galat: String(hasil.error.message || hasil.error) };
  return {
    ok: hasil.status === 0,
    kode: hasil.status == null ? 1 : hasil.status,
    galat: hasil.status === 0 ? '' : 'uv tool install gagal (kode ' + hasil.status + ')'
  };
}
