// Simpulkan peran bot dari prompt/instrusinya, tanpa perlu mengisi `tugas`
// manual. Heuristik lokal (tanpa model, tanpa biaya): kata kunci khas peran
// diberi skor, pemenang dipakai. `tugas` eksplisit selalu menang.
//
// Tujuan: koordinator tim dan alat `panggil` tetap tahu spesialisasi bot walau
// pemilik hanya menulis prompt seperti "Kamu QA yang menguji edge case...".
const PERAN = [
  {
    nama: 'produk/pm',
    kata: ['product manager', 'product owner', 'produk manager', 'manajer produk', 'prd', 'product requirements', 'product requirement', 'jobs-to-be-done', 'jtbd', 'roadmap', 'product spec', 'spesifikasi produk', 'user journey', 'alur pengguna', 'prioritas produk', 'business outcome', 'non-goals']
  },
  {
    nama: 'qa/penguji',
    kata: ['qa', 'quality assurance', 'quality', 'pengujian', 'penguji', 'menguji', 'uji', 'test', 'testing', 'regresi', 'regression', 'edge case', 'kasus tepi', 'bug', 'kualitas', 'verifikasi']
  },
  {
    nama: 'frontend/ui',
    kata: ['frontend', 'front-end', 'ui', 'ux', 'tampilan', 'antarmuka', 'css', 'html', 'react', 'vue', 'svelte', 'tailwind', 'desain antarmuka', 'komponen']
  },
  {
    nama: 'arsitek',
    kata: ['arsitek', 'arsitektur', 'architecture', 'struktur', 'perancangan', 'desain sistem', 'modul', 'pola', 'refactor', 'skalabilitas']
  },
  {
    nama: 'koder/backend',
    kata: ['backend', 'back-end', 'koder', 'coding', 'kode', 'implementasi', 'api', 'server', 'database', 'sql', 'node', 'python', 'golang', 'rust', 'java', 'fungsi', 'endpoint']
  },
  {
    nama: 'periset/analis',
    kata: ['riset', 'research', 'analisis', 'analis', 'bandingkan', 'perbandingan', 'sumber', 'studi', 'investigasi', 'data lapangan']
  },
  {
    nama: 'penulis/dokumentasi',
    kata: ['dokumentasi', 'dokumen', 'docs', 'readme', 'tutorial', 'panduan', 'artikel', 'menulis', 'penulis', 'technical writer', 'rangkuman']
  },
  {
    nama: 'keamanan',
    kata: ['keamanan', 'security', 'audit', 'vulnerability', 'kerentanan', 'pentest', 'hardening', 'ancaman', 'exploit', 'celah']
  },
  {
    nama: 'data',
    kata: ['data', 'dataset', 'etl', 'statistik', 'analitik', 'visualisasi', 'pandas', 'sql', 'laporan data']
  },
  {
    nama: 'devops',
    kata: ['devops', 'deploy', 'deployment', 'docker', 'kubernetes', 'ci/cd', 'infrastruktur', 'server', 'systemd', 'pipeline']
  },
  {
    nama: 'mobile',
    kata: ['android', 'ios', 'mobile', 'flutter', 'react native', 'kotlin', 'swift', 'aplikasi hp']
  },
  {
    nama: 'desainer',
    kata: ['desainer', 'designer', 'figma', 'wireframe', 'visual', 'mockup', 'palet', 'tipografi', 'ilustrasi']
  },
  {
    nama: 'peninjau/reviewer',
    kata: ['review', 'tinjau', 'peninjau', 'koreksi', 'memeriksa', 'audit kode', 'code review']
  },
  {
    nama: 'koordinator',
    kata: ['koordinator', 'koordinasi', 'pimpin', 'memimpin', 'bagi tugas', 'pembagian tugas', 'orkestrasi', 'manajer', 'manager', 'technical lead', 'tech lead', 'engineering manager', 'team lead', 'lead', 'orchestrate', 'orchestrator']
  }
];

const BATAS_RINGKAS = 44;

function normal(teks) {
  return String(teks == null ? '' : teks).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Buang pembuka umum ("kamu adalah ...") supaya fallback jadi frasa kerja. */
function intiPrompt(prompt) {
  const teks = normal(prompt)
    .replace(/^(kamu|anda|you)\s+(adalah|sebagai|are|is)\s+/i, '')
    .replace(/^(peran|role|tugas|job)\s*[:=-]\s*/i, '')
    .trim();
  return teks;
}

/**
 * Simpulkan peran dari teks prompt. Hasil selalu ada (minimal "asisten umum").
 * `skor`/`alasan` berguna untuk transparansi di panel bot.
 */
export function peranDariPrompt(prompt = '') {
  const teks = normal(prompt);
  let pemenang = null;
  let skorTertinggi = 0;
  for (const peran of PERAN) {
    let skor = 0;
    for (const kata of peran.kata) {
      if (!kata) continue;
      // Semua kata butuh batas kata. Substring membuat "test" cocok dengan
      // "latest", "data" dengan "metadata", dan "lead" dengan "misleading" -
      // itu yang membuat bot manajer disimpulkan sebagai QA.
      const cocok = new RegExp('(^|[^a-z0-9])' + kata.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(teks);
      if (cocok) skor += kata.includes(' ') ? 2 : 1;
    }
    if (skor > skorTertinggi) { skorTertinggi = skor; pemenang = peran.nama; }
  }
  if (pemenang) return { nama: pemenang, skor: skorTertinggi, sumber: 'kata kunci' };
  const inti = intiPrompt(prompt);
  if (inti) {
    const potong = inti.slice(0, BATAS_RINGKAS).trim();
    return { nama: potong || 'asisten umum', skor: 0, sumber: 'ringkasan prompt' };
  }
  return { nama: 'asisten umum', skor: 0, sumber: 'bawaan' };
}

/** Peran efektif bot: `tugas` eksplisit > simpulan prompt > asisten umum. */
export function tugasBot(bot = {}) {
  const eksplisit = String(bot && bot.tugas || '').trim();
  if (eksplisit) return eksplisit;
  return peranDariPrompt(bot && bot.prompt || '').nama;
}

/** Apakah peran ini hasil simpulan (bukan diisi pemilik)? */
export function peranOtomatis(bot = {}) {
  return !String(bot && bot.tugas || '').trim();
}

export const DAFTAR_PERAN = PERAN.map((satu) => satu.nama);
