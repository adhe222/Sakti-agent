// lib/jaring.js - pengaman jaringan untuk alat http/web (anti-SSRF) dan redaksi.
//
// - alamatPrivat(ip): true untuk loopback/privat/link-local/metadata/ULA/mapped.
// - periksaUrl(url): resolve DNS, tolak bila salah satu alamat privat.
// - fetchAman(url, opsi): fetch dengan redirect manual (maks 5), cek tiap hop.
// - redaksiHeader / redaksiUrl / redaksiTeks: sensor kredensial jadi '***'.
// Override sadar: SAKTI_IZIN_PRIVAT=1 mematikan blokir alamat privat.
// Sisa risiko: DNS rebinding antara lookup dan connect (TOCTOU) tidak ditutup.

import dns from 'node:dns/promises';
import net from 'node:net';

export const MAKS_REDIRECT = 5;

export function izinPrivat() {
  return process.env.SAKTI_IZIN_PRIVAT === '1';
}

function ipv4KeAngka(ip) {
  return ip.split('.').reduce((n, b) => n * 256 + Number(b), 0);
}

const BLOK_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([b, p]) => [ipv4KeAngka(b), p]);

function privatV4(ip) {
  const n = ipv4KeAngka(ip);
  return BLOK_V4.some(([dasar, p]) => {
    const topeng = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
    return ((n & topeng) >>> 0) === ((dasar & topeng) >>> 0);
  });
}

/** true bila ip (v4/v6) tidak boleh dihubungi alat jaringan. Bukan IP = false. */
export function alamatPrivat(ip) {
  let a = String(ip || '').trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zona = a.indexOf('%');
  if (zona >= 0) a = a.slice(0, zona);
  if (net.isIPv4(a)) return privatV4(a);
  if (!net.isIPv6(a)) return false;
  if (a === '::' || a === '::1') return true;
  // Bentuk lengkap/aneh IPv6: periksa lewat 128-bit penuh. Regex bentuk
  // kanonikal saja lolos untuk 0:0:0:0:0:ffff:7f00:1 (= ::ffff:127.0.0.1),
  // ::7f00:1 (compatible), dan 64:ff9b::7f00:1 (NAT64) - semua menjangkau
  // loopback/alamat privat saat fetch nyata.
  const luas = (function () {
    if (a.includes('::')) {
      const [kiri, kanan = ''] = a.split('::');
      const gk = kiri ? kiri.split(':') : [];
      const gk2 = kanan ? kanan.split(':') : [];
      const kurang = 8 - gk.length - gk2.length;
      if (kurang < 0) return null;
      // Ekor titik (dotted-quad) bukan hex: serahkan ke regex mapped di bawah.
      if (gk.concat(gk2).some((g) => g.includes('.'))) return null;
      return gk.concat(Array(kurang).fill('0'), gk2).map((g) => parseInt(g || '0', 16));
    }
    const grup = a.split(':');
    return grup.length === 8 && !grup.some((g) => g.includes('.')) ? grup.map((g) => parseInt(g || '0', 16)) : null;
  })();
  if (luas) {
    const nol = (i, n) => luas.slice(i, i + n).every((g) => g === 0);
    const ip4 = [luas[6] >> 8, luas[6] & 255, luas[7] >> 8, luas[7] & 255].join('.');
    if (nol(0, 5) && luas[5] === 0xffff) return privatV4(ip4); // ::ffff:0:0/96 mapped
    if (nol(0, 6)) return privatV4(ip4); // ::/96 IPv4-compatible (deprecated) - blok
    if (luas[0] === 0x64 && luas[1] === 0xff9b && nol(2, 4)) return privatV4(ip4); // NAT64 64:ff9b::/96
  }
  // IPv4-mapped bentuk kanonikal dengan ekor titik (tetap didukung).
  const mapped = a.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privatV4(mapped[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16);
    return privatV4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  const awal = parseInt(a.split(':')[0] || '0', 16);
  if ((awal & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((awal & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((awal & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Tolak URL yang host-nya resolve ke alamat privat. Lempar Error bila ditolak. */
export async function periksaUrl(url, { lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('url tidak sah: ' + url); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('protokol ditolak: ' + u.protocol);
  if (izinPrivat()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let alamat;
  if (net.isIP(host)) alamat = [{ address: host }];
  else {
    try { alamat = await lookup(host, { all: true, verbatim: true }); } catch (galat) {
      throw new Error('DNS gagal untuk ' + host + ': ' + ((galat && galat.code) || galat));
    }
  }
  const buruk = alamat.find((x) => alamatPrivat(x.address));
  if (buruk) {
    throw new Error('DIBLOKIR SSRF: ' + host + ' -> ' + buruk.address +
      ' (alamat privat/loopback/metadata). Izinkan sadar: SAKTI_IZIN_PRIVAT=1');
  }
  return u;
}

/** fetch dengan redirect manual + cek SSRF tiap hop. opsi.redirect diabaikan. */
export async function fetchAman(url, opsi = {}, { fetchImpl = globalThis.fetch, lookup } = {}) {
  let sekarang = String(url);
  let init = Object.assign({}, opsi, { redirect: 'manual' });
  for (let hop = 0; ; hop += 1) {
    await periksaUrl(sekarang, { lookup });
    const res = await fetchImpl(sekarang, init);
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const ke = res.headers.get('location');
    if (!ke) return res;
    if (hop >= MAKS_REDIRECT) throw new Error('redirect lebih dari ' + MAKS_REDIRECT + ' kali');
    try { await res.body?.cancel(); } catch { /* abaikan */ }
    const asal = new URL(sekarang);
    const tujuan = new URL(ke, sekarang);
    // 303 (dan 301/302 untuk POST) berubah jadi GET tanpa body, seperti browser.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method && init.method.toUpperCase() === 'POST')) {
      init = Object.assign({}, init, { method: 'GET', body: undefined });
    }
    // Kredensial tidak dibawa lintas origin.
    if (tujuan.origin !== asal.origin && init.headers) {
      const h = Object.assign({}, init.headers);
      for (const k of Object.keys(h)) if (HEADER_RAHASIA.has(k.toLowerCase())) delete h[k];
      init = Object.assign({}, init, { headers: h });
    }
    sekarang = tujuan.toString();
  }
}

export const HEADER_RAHASIA = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'x-auth-token']);
const PARAM_RAHASIA = /^(token|access_token|refresh_token|id_token|api_key|apikey|key|secret|client_secret|password|sandi|sig|signature|auth)$/i;

export function redaksiHeader(header = {}) {
  const hasil = {};
  for (const [k, v] of Object.entries(header || {})) hasil[k] = HEADER_RAHASIA.has(k.toLowerCase()) ? '***' : v;
  return hasil;
}

export function redaksiUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return String(url); }
  if (u.username || u.password) { u.username = u.username ? '***' : ''; u.password = u.password ? '***' : ''; }
  for (const k of [...u.searchParams.keys()]) if (PARAM_RAHASIA.test(k)) u.searchParams.set(k, '***');
  return u.toString().replace(/%2A%2A%2A/g, '***');
}

/** Sensor nilai rahasia yang diketahui + pola umum di teks bebas. */
export function redaksiTeks(teks, rahasia = []) {
  let t = String(teks == null ? '' : teks);
  for (const r of rahasia) if (r && String(r).length >= 4) t = t.split(String(r)).join('***');
  t = t.replace(/\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-auth-token)(\s*[:=]\s*)([^\r\n]+)/gi, '$1$2***');
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
  t = t.replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|key|secret|client_secret|password|sig|signature)=)[^&\s"'#]+/gi, '$1***');
  return t;
}
