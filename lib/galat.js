// Kontrak galat tunggal sakti-cli (ADR-001).
// Semua lapisan melempar SaktiError (atau dibungkus via bungkus()) agar
// TUI, CLI, serve, dan WA bisa menampilkan pesan + petunjuk yang seragam.

export const KODE = Object.freeze({
  UMUM: 'E_UMUM',
  MASUKAN: 'E_MASUKAN',
  IZIN: 'E_IZIN',
  JARINGAN: 'E_JARINGAN',
  WAKTU: 'E_WAKTU',
  MODEL: 'E_MODEL',
  ALAT: 'E_ALAT',
  BATAL: 'E_BATAL',
  TIDAK_ADA: 'E_TIDAK_ADA',
});

// kode yang aman diulang otomatis bila tidak ditentukan eksplisit
const ULANG_BAWAAN = new Set([KODE.JARINGAN, KODE.WAKTU]);

export class SaktiError extends Error {
  constructor(pesan, { kode = KODE.UMUM, petunjuk = '', sebab, dapatDiulang } = {}) {
    super(String(pesan ?? ''), sebab !== undefined ? { cause: sebab } : undefined);
    this.name = 'SaktiError';
    this.kode = kode;
    this.petunjuk = petunjuk;
    this.sebab = sebab;
    this.dapatDiulang = dapatDiulang ?? ULANG_BAWAAN.has(kode);
  }

  toJSON() {
    return {
      name: this.name,
      kode: this.kode,
      pesan: this.message,
      petunjuk: this.petunjuk || undefined,
      dapatDiulang: this.dapatDiulang,
      sebab: this.sebab instanceof Error ? this.sebab.message : this.sebab,
    };
  }
}

// Tebak kode dari galat mentah (Node/fetch/AbortSignal) bila kode tidak diberi.
export function tebakKode(err) {
  if (!err) return KODE.UMUM;
  const nama = err.name || '';
  const kode = err.code || err.cause?.code || '';
  if (nama === 'TimeoutError' || kode === 'ETIMEDOUT') return KODE.WAKTU;
  if (nama === 'AbortError') return KODE.BATAL;
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(kode)) return KODE.JARINGAN;
  if (kode === 'ENOENT') return KODE.TIDAK_ADA;
  if (kode === 'EACCES' || kode === 'EPERM') return KODE.IZIN;
  if (/fetch failed/i.test(err.message || '')) return KODE.JARINGAN;
  return KODE.UMUM;
}

// Bungkus galat apa pun menjadi SaktiError tanpa kehilangan sebab aslinya.
// SaktiError yang sudah ada dikembalikan apa adanya (kode lama dipertahankan).
export function bungkus(err, kode, { petunjuk, pesan } = {}) {
  if (err instanceof SaktiError) {
    if (petunjuk && !err.petunjuk) err.petunjuk = petunjuk;
    return err;
  }
  const asli = err instanceof Error ? err : new Error(String(err));
  return new SaktiError(pesan || asli.message || 'galat tanpa pesan', {
    kode: kode || tebakKode(asli),
    petunjuk: petunjuk || '',
    sebab: asli,
  });
}

// Satu format tampilan untuk pengguna: "galat [KODE]: pesan" + petunjuk.
// Stack hanya bila debug (atau env SAKTI_DEBUG=1).
export function pesanPengguna(err, { debug = process.env.SAKTI_DEBUG === '1' } = {}) {
  const e = bungkus(err);
  const baris = [`galat [${e.kode}]: ${e.message}`];
  if (e.petunjuk) baris.push(`petunjuk: ${e.petunjuk}`);
  if (e.dapatDiulang) baris.push('(bisa dicoba lagi)');
  if (debug) {
    const tumpuk = (e.sebab instanceof Error ? e.sebab.stack : null) || e.stack;
    if (tumpuk) baris.push(tumpuk);
  }
  return baris.join('\n');
}
