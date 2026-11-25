#!/usr/bin/env node
// Server MCP lewat stdio: alat `sakti` (terminal lokal, berkas, uji, ingatan,
// tugas) tersedia untuk klien MCP mana pun - pi dengan builtin:mcp, hermes,
// claude. Jalankan `sakti mcp`. Tanpa dependensi.

import readline from 'node:readline';
import { ALAT, jalankanAlat, konteks } from './lib/alat.js';

const kirim = (pesan) => process.stdout.write(JSON.stringify(pesan) + '\n');
const nama = (alat) => 'sakti_' + alat.name;
const PROTOKOL = '2024-11-05';

async function tangani(pesan) {
  const { id, method, params } = pesan || {};
  const balas = (hasil) => id != null && kirim({ jsonrpc: '2.0', id, result: hasil });
  const gagal = (kode, teks) => id != null && kirim({ jsonrpc: '2.0', id, error: { code: kode, message: teks } });

  switch (method) {
    case 'initialize':
      return balas({
        protocolVersion: PROTOKOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sakti', version: '2.1.0' },
        instructions: 'Alat sakti berjalan di terminal mesin ini (cwd ' + konteks().cwd + '). terminal menjalankan bash apa adanya, tanpa daftar putih. Nama polos (terminal, baca, mind) DAN nama berawalan sakti_ sama-sama diterima.',
      });
    case 'tools/list':
      return balas({
        // Nama POLOS yang dipakai prompt/tool-call: klien MCP yang mendaftarkan
        // alat berdasarkan daftar ini sebelumnya hanya melihat `sakti_terminal`,
        // lalu menolak panggilan `terminal`/`mind` dengan "Cannot find tool with
        // provided name". `tools/call` tetap menerima kedua bentuk.
        tools: ALAT.map((alat) => ({ name: alat.name, description: alat.description, inputSchema: alat.parameters }))
      });
    case 'tools/call': {
      const dipanggil = String((params && params.name) || '');
      const alat = ALAT.find((satu) => nama(satu) === dipanggil || satu.name === dipanggil);
      if (!alat) return gagal(-32602, 'alat tidak dikenal: ' + dipanggil);
      const teks = await jalankanAlat(alat.name, (params && params.arguments) || {}, konteks());
      const rusak = /^(GAGAL|DITOLAK|alat tidak dikenal)/.test(teks);
      return balas({ content: [{ type: 'text', text: teks }], isError: rusak });
    }
    case 'ping':
      return balas({});
    default:
      if (String(method || '').startsWith('notifications/')) return;
      return gagal(-32601, 'metode tidak didukung: ' + method);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let rantai = Promise.resolve();
rl.on('line', (baris) => {
  const teks = baris.trim();
  if (!teks) return;
  rantai = rantai.then(async () => {
    let pesan;
    try { pesan = JSON.parse(teks); } catch { return; }
    try { await tangani(pesan); } catch (galat) {
      kirim({ jsonrpc: '2.0', id: pesan && pesan.id, error: { code: -32603, message: String((galat && galat.message) || galat) } });
    }
  });
});
/* stdin habis bukan berarti selesai: tunggu antrean yang masih jalan, kalau
   tidak, panggilan terakhir hilang dan klien melihat "server mati mendadak". */
rl.on('close', () => { rantai.finally(() => process.exit(0)); });