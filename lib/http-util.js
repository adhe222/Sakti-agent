// Utilitas HTTP bersama untuk `sakti serve` dan `sakti kanal`.
//
// Satu tempat untuk membaca badan permintaan: batas ukuran, galat ber-kode
// (413 terlalu besar, 400 bukan JSON), dan hasil `{}` untuk badan kosong.
// Sebelumnya fungsi ini disalin identik di kanal.js dan serve.js.

import crypto from 'node:crypto';

export const BATAS_BADAN = 1 << 20; // 1 MB: satu pesan, bukan unggahan berkas

/**
 * Bandingkan token/rahasia dalam waktu tetap. `===` berhenti di karakter
 * pertama yang beda sehingga potongan token bisa ditebak dari waktu balasan.
 */
export function samaRahasia(a, b) {
  const kiri = Buffer.from(String(a == null ? '' : a));
  const kanan = Buffer.from(String(b == null ? '' : b));
  return kiri.length === kanan.length && crypto.timingSafeEqual(kiri, kanan);
}

/** Baca badan permintaan sampai habis lalu parse sebagai JSON. */
export async function bacaBadan(req, batas = BATAS_BADAN) {
  let jumlah = 0;
  const potongan = [];
  for await (const bagian of req) {
    jumlah += bagian.length;
    if (jumlah > batas) throw Object.assign(new Error('badan terlalu besar'), { kode: 413 });
    potongan.push(bagian);
  }
  if (!potongan.length) return {};
  try {
    const data = JSON.parse(Buffer.concat(potongan).toString('utf8'));
    // `null`, angka, dan string adalah JSON sah tetapi bukan badan permintaan:
    // pemanggil membaca `badan.pesan` dan dulu melempar TypeError -> 500.
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      throw Object.assign(new Error('badan harus objek JSON'), { kode: 400 });
    }
    return data;
  } catch (galat) {
    if (galat && galat.kode) throw galat;
    throw Object.assign(new Error('badan bukan JSON'), { kode: 400 });
  }
}
