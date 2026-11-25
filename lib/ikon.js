// Ikon alat: satu emoji per alat supaya aktivitas di TUI/CLI langsung terbaca
// (terminal, baca, tulis, git, ...). Satu sumber kebenaran - JANGAN menyalin
// peta ini ke tui.js/sakti.js, karena daftar alat terus bertambah.
export const IKON_ALAT = {
  status: '📊',
  terminal: '💻',
  daftar: '📁',
  baca: '📄',
  tulis: '📝',
  edit: '✏️',
  folder: '📂',
  pindah: '🚚',
  salin: '📋',
  jalankan: '▶️',
  cari: '🔎',
  hapus: '🗑️',
  uji: '🧪',
  py: '🐍',
  ffmpeg: '🎬',
  chromium: '🌐',
  node: '🟩',
  web: '🌍',
  pdf: '📕',
  zip: '🗜️',
  ingatan: '🧠',
  mind: '💡',
  kirim: '📤',
  kotak: '📬',
  tugas: '✅',
  skill: '🧩',
  latar: '⏳',
  biaya: '💰',
  khazanah: '🏛️',
  cariweb: '🔭',
  rencana: '🗺️',
  petunjuk: '📌',
  mcp: '🔌',
  kerja: '🛠️',
  tambal: '🩹',
  delegasi: '👥',
  panggil: '📣',
  diff: '🔀',
  wawancara: '🎤',
  git: '🌿',
  http: '🔗',
  db: '🗄️',
  layanan: '⚙️',
  paket: '📦',
  lint: '🧹',
  env: '🔐',
  json: '🧾',
  csv: '📈'
};

/** Ikon untuk alat (alias ikut: `py` -> python sudah nama alat). */
export function ikonAlat(nama) {
  const kunci = String(nama == null ? '' : nama).trim().toLowerCase();
  return IKON_ALAT[kunci] || '🔧';
}

/** Label siap tampil: "💻 terminal". */
export function labelAlat(nama) {
  return ikonAlat(nama) + ' ' + String(nama == null ? '' : nama);
}
