# sakti — CLI agen terminal mandiri

Agen terminal satu perintah: bisa menjalankan alat, mengingat, bekerja tim, dan mengobrol lewat WhatsApp/TUI
---

## Kelebihan

- **Mandiri penuh** — inti Node.js stdlib saja; tanpa engine pihak lain. WhatsApp native opsional lewat `npm install` (Baileys).
- **Agen yang benar-benar bekerja** — bukan cuma menjawab: membaca/menulis berkas, menjalankan shell, mencari web, memanggil ffmpeg/chromium, menguji, sampai tuntas.
- **Tim bot dalam satu room** — beberapa bot dengan peran berbeda (koordinator, arsitek, backend, QA) menjawab di satu chatroom; koordinator membagi tugas lewat alat `panggil`, subagen berjalan paralel (1–12 worker).
- **Ingatan & keahlian** — ingatan permanen lintas sesi (`ingatan`, `mind`), perintah bernama (`tugas`), dan pustaka keahlian `SKILL.md` yang otomatis dipakai saat cocok dengan tugas.
- **Kanal lengkap** — TUI layar penuh, sekali jalan untuk skrip, server HTTP lokal, jembatan WhatsApp, gateway chatroom.
- **Aman secara bawaan** — izin berlapis per kanal, filter env rahasia untuk proses anak, credential pool dengan rotasi kunci otomatis, checkpoint undo untuk edit/hapus.
- **Hemat konteks** — pemangkasan riwayat pintar, profil alat dinamis, hasil alat panjang ditumpahkan ke berkas (bukan memenuhi prompt).
- **Perkakas langsung** — semua alat agen bisa dipanggil langsung dari terminal tanpa model: baca/tulis/edit/cari/zip/web/pdf/ffmpeg.

---

## 1. Pasang

Syarat: Node >= 20. Inti tanpa dependensi; WhatsApp native butuh `npm install` (Baileys).

```sh
git clone https://github.com/adhe222/Sakti-agent.git
cd Sakti-agent
bash pasang.sh             # salin ke ~/.local/share/sakti-cli + npm install + langsung `sakti setup`
bash pasang.sh --rea       # sekaligus pasang REA (reverse engineering) + daftarkan MCP
bash pasang.sh --reach     # sekaligus pasang Agent Reach
```

Tanpa pemasangan permanen: jalankan langsung dari folder repo.

```sh
node sakti.js setup        # wizard: endpoint + API key + model + cadangan + profil alat + gateway
node sakti.js doctor       # periksa endpoint, izin config, gateway, hook, mesin luar
```

Setelah `pasang.sh`, perintah `sakti` tersedia global.

---

## 2. Mulai cepat

```sh
sakti                      # TUI workspace layar penuh (transkrip, kotak masukan, panel)
sakti -p "halo"            # sekali jalan: cetak jawaban, keluar (untuk skrip)
sakti run "pasang dependensi, jalankan uji, laporkan hasilnya"
sakti setup                # ulang wizard konfigurasi
sakti doctor               # cek kesehatan
sakti --version
```

Contoh TUI (layar penuh):

```
┌ transkrip ──────────────────────────────┐
│ kamu: perbaiki laporan yang salah       │
│ sakti: [alat baca] 2 berkas … selesai   │
└─────────────────────────────────────────┘
 masukan: _                                │ Enter kirim · Ctrl+O panel
```

---

## 3. Konfigurasi

`setup` menulis `~/.sakti-cli/config.json`:

| kunci | isi |
|---|---|
| `endpoint` | URL API kompatibel OpenAI (mis. OpenRouter) |
| `apiKey` | kunci endpoint |
| `model` | model utama |
| `fallbacks` | daftar cadangan `url\|model\|kunci` |

Semua kunci bisa ditimpa env: `SAKTI_MODEL_URL`, `SAKTI_MODEL_KEY`, `SAKTI_MODEL`, `SAKTI_TOKEN`.

Lokasi data (bisa dipindah lewat env):

| env | bawaan | isi |
|---|---|---|
| `SAKTI_CLI_STATE` | `~/.sakti-cli/state.json` | state sesi, room, pool kunci |
| `SAKTI_CLI_HOME` / `SAKTI_HOME` | `~/.sakti-cli` | akar data (config, sesi, log, skill) |
| `SAKTI_CLI_SPILL` | `~/.sakti-cli/spill` | hasil alat panjang |
| `SAKTI_CLI_CKP` | `~/.sakti-cli/ckp` | checkpoint (undo edit/hapus) |
| `SAKTI_UNDUHAN` | `~/unduhan` | media WA masuk |

`SAKTI_CLI_STATE` = kontrak profil terpisah: arahkan ke berkas/folder lain untuk isolasi penuh (profil kerja, mesin bersama, dsb).

---

## 4. Mode jalan

| mode | perintah | gunanya |
|---|---|---|
| TUI workspace | `sakti` | layar penuh: transkrip, panel alat/skill, palet `/` |
| Sekali jalan | `sakti -p "..."` | cetak jawaban lalu keluar; pas untuk skrip/pipe |
| Gateway WhatsApp | `sakti wa` | jembatan WA ↔ agen (Baileys) |
| Server HTTP | `sakti serve` | API chat lokal di `127.0.0.1:4317` |
| Chatroom tim | `sakti chatroom` | beberapa bot satu room |
| Telegram | `sakti telegram` | jembatan Telegram |

---

## 5. Perintah utama

### 5.1 Obrolan & agen

```sh
sakti run "tugas bebas"          # agen bekerja: alat dipanggil otomatis sampai tuntas
sakti -p "ringkas diff ini"      # sekali jalan
sakti sesi                       # daftar sesi; lanjutkan sesi lama
sakti biaya lihat                # pemakaian token: total + sesi ini + 5 panggilan terakhir
```

### 5.2 Alat langsung (tanpa model)

Alat yang sama yang dipakai agen bisa dipanggil langsung:

```sh
sakti status                     # cwd, versi node/python/git, sisa disk
sakti terminal "npm install"     # shell apa adanya
sakti baca src/a.js              # baca berkas (offset/limit)
sakti tulis catatan.md teks="isi"
sakti edit src/a.js cari="lama" ganti="baru"          # ganti satu blok + diff
sakti edit src/a.js --editan='[{"cari":"x","ganti":"y"}]'   # banyak editan
sakti folder src/baru            # mkdir -p
sakti pindah lama.txt baru.txt   ·  sakti salin a/ b/  ·  sakti hapus folder/
sakti jalankan skrip/deploy.sh   # penerjemah dari ekstensi (.py/.js/.sh/...)
sakti uji uji/hitung.test.js     # runner dari nama berkas
sakti cari "TODO"                # grep -rn (skip node_modules/.git)
sakti py kode="print(1+1)"       ·  sakti node kode="console.log(1)"
sakti ffmpeg probe video.mp4     ·  sakti chromium screenshot https://...
sakti web https://contoh.id      ·  sakti pdf teks dokumen.pdf
sakti zip buat dari=./src ke=src.zip
```

### 5.3 Ingatan & pengetahuan

```sh
sakti ingatan lihat              # catatan permanen lintas sesi
sakti ingatan tambah "pelajaran: ..."
sakti mind daftar                # fakta inti proyek (dibagi semua bot)
sakti mind tambah "deploy: pm2 restart sakti"
sakti tugas simpan build "npm run build && npm test"   # perintah bernama
sakti tugas jalankan build
sakti skill                      # pustaka keahlian SKILL.md
sakti update                     # segarkan katalog model + indeks skill
```

### 5.4 Subagen & tim bot

```sh
sakti subagen                        # daftar peran: peneliti, koder, penguji, peninjau, ...
sakti subagen pilih "<teks tugas>"   # peran otomatis utk tugas itu
sakti delegasi peran=koder tugas="perbaiki bug X"       # subagen berriwayat bersih
sakti delegasi banyak='[{"peran":"peneliti","tugas":".."},{"peran":"penguji","tugas":".."}]'  # PARALEL
sakti bot baru riset prompt="kamu analis data"    # buat bot — langsung masuk room bawaan
sakti bot masuk riset                # masukkan bot ke room bawaan (semua sesi baru ikut)
sakti bot masuk semua                # semua bot masuk room
sakti bot lepas riset                # keluarkan TEPAT bot itu dari room
sakti bot lepas semua                # kosongkan room (hanya kamu)
sakti bot room                       # lihat isi room bawaan
sakti bot set riset worker=3         # bot itu pakai 3 subagen bersamaan
sakti chatroom                       # room & pesan antar-bot
```

Di dalam TUI sama saja, ditulis sebagai perintah garis miring:

```
/bot baru kode prompt="kamu penulis kode Node.js"   ← sekaligus masuk room
/bot masuk kode riset   ·  /bot masuk semua   ·  /bot   (panel interaktif)
/bot lepas kode         ·  /bot lepas semua
```

### 5.5 WhatsApp

```sh
sakti wa                           # nyalakan jembatan WA (butuh npm install utk Baileys)
sakti wa --izin 62812xxxx          # daftar putih pengirim
```

| env | arti |
|---|---|
| `SAKTI_WA_IZIN` | daftar nomor boleh chat (koma). Kosong = tolak semua |
| `SAKTI_WA_TERBUKA=1` | semua orang boleh chat (mode dev) |
| `SAKTI_WA_IZIN_PENUH` | nomor dgn akses penuh (kanal cli) — hanya nomor ini bisa alat sistem |

Alur izin (ADR-004): tanpa `SAKTI_WA_IZIN` dan tanpa `TERBUKA` → semua pesan ditolak (fail-closed). Nomor di `IZIN_PENUH` mendapat kanal `cli`; lainnya kanal `serve` (gerbang ketat).

### 5.6 Server HTTP

```sh
sakti serve                        # bind 127.0.0.1:4317
curl -s localhost:4317/sehat       # cek hidup
curl -s -X POST localhost:4317/chat -d '{"pesan":"halo"}'
```

---

## 6. Keamanan & izin

### 6.1 Lapisan kanal (ADR-004 Amandemen 1)

Kanal tak tepercaya (`serve`/`wa`, bukan `cli`/`mcp`) hanya boleh alat daftar putih:
`rencana, ingatan, mind, kirim, kotak, web, cari`. Alat lain (terminal, env, db,
layanan, http, ubah_diri, ...) ditolak. Akses penuh hanya lewat nomor
`SAKTI_WA_IZIN_PENUH` (kanal cli).

### 6.2 Filter env proses anak (ADR-005 K2)

Alat shell tidak mewarisi env rahasia. Nama var yang cocok
`/TOKEN|SECRET|KEY|PASSWORD|SANDI|CREDENTIAL|PASSWD|AUTH/i` dibuang sebelum
proses anak jalan. Pengecualian: `SAKTI_ENV_PASSTHRU=GITHUB_TOKEN,VAR_LAIN` (koma).

### 6.3 Credential pool (ADR-005 K3)

Beberapa kunci per endpoint: `NAMA_API_KEY_2..9` atau `fallbacks`. Rotasi otomatis:
429 = retry 1x lalu pindah kunci; 402 = cooldown 60 menit; 401 = pindah. Strategi
`SAKTI_POOL_STRATEGI` = `fill_first` (bawaan) / `round_robin` / `least_used` / `random`.
State hanya menyimpan fingerprint sha256, tidak pernah nilai kunci.

### 6.4 Checkpoint (undo)

Edit/tulis/hapus otomatis membuat checkpoint. Daftar & pulihkan lewat alat
`khazanah` (aksi `checkpoint` / `kembalikan <id>`). Berkas petunjuk proyek
(`AGENTS.md`, `SAKTI.md`, `CLAUDE.md`, `SKILL.md`) milik manusia — agen ditolak
mengedit kecuali `SAKTI_DIRI_PENGAMAN=1`.

---

## 7. Environment variables penting

| env | gunanya |
|---|---|
| `SAKTI_MODEL_URL` / `SAKTI_MODEL_KEY` / `SAKTI_MODEL` | timpa endpoint/kunci/model |
| `SAKTI_MODEL_FALLBACKS` | cadangan `url\|model\|kunci` (koma) |
| `SAKTI_MODEL_COBA` | percobaan per endpoint (bawaan 6) |
| `SAKTI_CLI_STATE` | state terpisah per profil |
| `SAKTI_WORKER` / `SAKTI_WORKER_SUBAGEN` | batas paralel rekan/subagen (1-12) |
| `SAKTI_ALAT` | subset alat yang aktif |
| `SAKTI_BATAS_TOKEN` / `SAKTI_MAKS_LANGKAH` | hemat token / batas putaran agen |
| `SAKTI_ENV_PASSTHRU` | env rahasia yang diizinkan ke proses anak |
| `SAKTI_WA_IZIN` / `SAKTI_WA_TERBUKA` / `SAKTI_WA_IZIN_PENUH` | izin WhatsApp |
| `SAKTI_WARNA` / `SAKTI_TRUECOLOR` / `SAKTI_INDIKATOR` | tampilan TUI |
| `SAKTI_DEBUG` | log verbose |

Daftar lengkap: `grep -rhoE "SAKTI_[A-Z0-9_]+" sakti.js lib/ | sort -u`

---

## 8. TUI

`sakti` tanpa argumen = workspace layar penuh.

| tombol/perintah | fungsi |
|---|---|
| `Enter` | kirim |
| `Tab` | lengkapi |
| `Ctrl+O` | panel |
| `Ctrl+T` | rinci/ringkas (alat/skill/ingatan/tugas/chatroom) |
| `/bot` | menu bot: daftar, masuk/lepas room, hapus, set (tanpa argumen = menu interaktif) |
| `/room` | mode room: solo/otomatis/tim |
| `/nalar` | tampil/sembunyi penalaran model |
| `/pengaturan` | 10 setelan interaktif: model, effort, token, rute, izin, worker, alat, indikator, room, warna |
| `/biaya` | pemakaian token |
| `/alat` | subset alat |
| `/indikator` | gaya indikator kerja unicode/ascii/emoji |
| `/sesi <id>` | pindah sesi/room |
| `/ringkas` | simpan ingatan dari percakapan |
| `/warna` | tema warna |

---

## 9. MCP (Model Context Protocol)

```sh
sakti mcp daftar                  # server terdaftar
sakti mcp tambah nama=nrea command=npx args="-y @contoh/server"
sakti mcp tes nama                # uji koneksi + daftar alat aktif
```

`~/.sakti-cli/mcp.json` mendukung daftar putih `alat` supaya hemat konteks
(bawaan 7 alat inti untuk REA; `--semua` untuk semua).

---

## 10. Keahlian (skill)

Format `SKILL.md` gaya Hermes. Folder yang dibaca: `~/.hermes/skills`,
`~/.sakti-cli/skills`, `/root/sakti/skills` (atur: `SAKTI_SKILL_DIRS`).
Keahlian cocok tugas → agen membaca & mengikuti isinya otomatis.

```
~/.sakti-cli/skills/
  nama-skill/
    SKILL.md      # frontmatter + isi instruksi
```

---

## 11. Struktur proyek

```
sakti.js            CLI: mode TUI/-p/wa/serve/bot/setup/doctor/dll.
lib/
  agent.js          loop agen: giliran alat, evict konteks, filter shadow
  alat.js           registri alat + gerbang kanal + redaksi + envTool
  izin.js           izin alat, izin kanal, redaksiSecret
  model.js          pemanggilan model + credential pool + fallback
  lokal.js          shell, proses latar, folderProfil
  konteks.js        budget konteks + evict
  wa.js             jembatan WhatsApp (Baileys)
  serve.js          server HTTP chat
  tui.js            TUI layar penuh
  subagen.js        delegasi berperan
  kotak.js          pesan antar-bot
docs/
  adr/              keputusan arsitektur (ADR-001..005)
pasang.sh           pemasang
```

---

## 12. Pemecahan masalah

| gejala | cek |
|---|---|
| `sakti wa` terus putus (440) | pastikan cuma SATU proses `sakti wa` (pgrep -af "sakti wa") — dua proses satu folder auth saling tendang |
| balasan WA tidak muncul | `sakti doctor`; lihat log `~/.sakti-cli/log/wa-jembatan.log` |
| 401/429 endpoint | credential pool: sediakan `NAMA_API_KEY_2`; cek `sakti biaya lihat` |
| alat ditolak "tidak tersedia di kanal chat" | kanal serve/wa non-penuh memang dibatasi — pakai nomor `SAKTI_WA_IZIN_PENUH` |
| paste API key kacau di TUI | sudah diperbaiki (?2004l saat prompt); pastikan versi terkini |
| config rusak | `sakti doctor`; checkpoint `~/.sakti-cli/ckp/` |

