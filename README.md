# sakti — CLI agen terminal
mulai cepat (Node >= 20; inti tanpa dependensi, WhatsApp native butuh `npm install`):

```sh
bash pasang.sh             # salin + npm install (Baileys) + langsung `sakti setup`
bash pasang.sh --rea       # sekaligus pasang REA + daftarkan MCP
# atau tanpa pemasangan permanen:
node sakti.js setup        # endpoint + API key + model + model cadangan + profil alat + gateway
node sakti.js              # TUI
node sakti.js -p "halo"    # sekali jalan, cetak jawaban
node sakti.js doctor       # periksa endpoint, izin config, gateway, hook
```


Satu perintah `sakti` yang menggabungkan tiga hal yang dulu terpisah, tanpa
memanggil biner mana pun (tidak `pi`, tidak `hermes`):

| diambil dari | jadi apa di sini |
|---|---|
| **Sakti Bot** | alat: `terminal`, `daftar`, `baca`, `tulis`, `edit`, `folder`, `pindah`, `salin`, `hapus`, `cari`, `jalankan`, `uji`, `py`/`python`, `node`, `ffmpeg`, `chromium`, `web`, `pdf`, `zip`, `ingatan`, `mind`, `tugas`, `status`, `skill` · operasi: `git`, `http`, `db`, `layanan`, `paket`, `lint`, `env`, `json`, `csv` — plus aturan "bukti bukan klaim" |
| **pi** | agen koding berulang: putaran alat otomatis, sesi yang bisa dilanjutkan, mode cetak untuk skrip, folder kerja = cwd, server MCP |
| **Hermes** | keahlian `SKILL.md` (dibaca dari `~/.hermes/skills`, `~/.sakti-cli/skills`, `/root/sakti/skills`), ingatan awet + ingatan inti (`USER.md`), pencarian riwayat sesi, petunjuk proyek `AGENTS.md`, rencana kerja lintas giliran, terus terang soal batas |

Sejak 3.33.4 (beberapa nomor di satu gateway WA):

| kebutuhan | cara |
|---|---|
| satu akun WA bot melayani banyak nomor pengirim | tidak perlu proses tambahan; tiap JID punya sesi `wa-<nomor>` sendiri |
| batasi nomor yang boleh chat | `sakti wa --izin=628111...,628222...`; tanpa `--izin` semua nomor bisa memakai model |
| grup | `--grup`; satu sesi per grup, semua anggota berbagi konteks grup |
| beberapa akun/nomor bot sekaligus | jalankan beberapa proses dengan `--auth` berbeda dan `--sesi-prefix` berbeda |
| nomor lokal `08xx` | otomatis jadi `628xx` untuk pairing |

## Aturan proyek & perintah kustom

```sh
sakti init [nama proyek]        # buat kerangka AGENTS.md (tidak menimpa)
sakti perintah                  # daftar perintah kustom
sakti perintah tulis tinjau "Tinjau diff. Fokus: \$ARGUMEN" --keterangan "sebelum commit"
sakti perintah tulis migrasi "Jalankan migrasi \$1" --proyek    # hanya repo ini
sakti perintah lihat tinjau auth.js
sakti perintah hapus tinjau
```

Di TUI: `/perintah` (daftar) dan `/nama [argumen]` untuk memanggilnya. Penanda:
`$ARGUMEN` (semua) dan `$1`..`$9` (per kata); tanpa penanda, argumen ditempel di
akhir. Lapisan: `.sakti/perintah/` di folder kerja menang atas
`~/.sakti-cli/perintah/`.

## Hook alat

`~/.sakti-cli/hook.json` — perintah shell sebelum/sesudah satu alat:

```json
{
  "pra":  { "tulis": "npm run lint", "*": "echo mulai $SAKTI_ALAT" },
  "pasca": { "terminal": "echo selesai" },
  "wajib": { "pra": ["tulis"] }
}
```

Env yang disisipkan: `SAKTI_ALAT`, `SAKTI_ARGS` (JSON), `SAKTI_HASIL` (pasca).
Bawaannya **tidak memblokir**: hook gagal cuma dilaporkan. Tambahkan `"wajib"` bila
hook harus jadi gerbang — kalau hook pra wajib gagal, alat tidak dijalankan.
Hook pasca yang gagal tidak membatalkan kerja yang sudah terjadi (berkas sudah
ditulis), hanya memberi peringatan keras.

Tombol mati: `SAKTI_HOOK_MATI=1` melewati semua hook. Pakai ini kalau hook wajib
sendiri yang rusak dan mengunci semua alat.

`sakti doctor` melaporkan hook dan perintah kustom yang terpasang.

## Room multi-bot: urutan kerja & paralel

Bot punya peran `tugas` (produk/backend/frontend/qa) dan prioritas `urutan`
(angka, kecil bicara lebih dulu). Urutan kerja **bukan alfabet**:

1. `urutan` eksplisit (angka) menang.
2. Tanpa `urutan`: urutan bot **masuk room** (`state.chatroom`), bukan `tugas`
   dan bukan `nama`.
3. `@sebutan` di pesan menentukan urutan untuk pesan itu, sesuai posisi sebutan
   (`@andi @eny` = andi lalu eny), bukan urutan room/abjad.
4. `@semua` memakai urutan room.

`sakti bot urut` menampilkan urutan hasil aturan ini; `tugas` tetap dipakai
sebagai deskripsi peran, bukan pengurut.

```sh
sakti bot baru andi prompt="kamu QA" tugas=qa urutan=40
sakti bot set andi tugas=qa urutan=40
sakti bot urut          # urutan bicara di room ini (urutan eksplisit -> urutan masuk)
sakti bot               # daftar bot + tugas/urutan
```

### Mode room: tim (bawaan), solo, serial, atau paralel

Mode disimpan di state dan berlaku untuk CLI, TUI, dan `serve`:

| perintah | arti |
|---|---|
| `sakti room` / `/room` | lihat mode sekarang |
| `sakti room tim` / `/room tim` | **bawaan**: satu koordinator membagi tugas ke rekan lewat `panggil`; rekan hanya mengerjakan bagian sesuai prompt/perannya. `otomatis` adalah alias tim |
| `sakti room solo` / `/room solo` | satu bot per pesan; rekan tetap bisa dipanggil dari dalam giliran |
| `sakti room otomatis` / `/room otomatis` | alias `tim` (bukan semua bot mengulang pesan yang sama) |

Di mode tim, `panggil` berjalan **sinkron**: koordinator menunggu hasil rekan
sebelum menyusun jawaban. Di mode lain, panggilan saat room sibuk diantrekan.
Kata kunci di pesan (`@nama`, `paralel`, `berurutan`, …) menang atas mode
tersimpan:

| pesanmu mengandung | yang bekerja | cara |
|---|---|---|
| `@nama` satu | hanya bot itu | solo; ia boleh `panggil` rekan lain |
| `@nama` dua+ tanpa kata serial/paralel | sesuai mode | tim memilih sebutan pertama sebagai koordinator; solo = paralel biasa |
| `paralel`, `bersamaan`, `semua bot`, `kalian semua` | SEMUA bot di room | paralel, worker = jumlah peserta (maks 12) |
| `tim`, `bagi tugas`, `koordinator`, `kerja sama`, `kolaborasi`, `satu tim` | satu koordinator | memanggil rekan dengan tugas berbeda |
| `berurutan`, `serial`, `bergantian`, `tunggu`, `menanggapi`, `saling koreksi` | SEMUA bot di room | serial; bot berikut melihat jawaban sebelumnya |
| selain itu | tergantung `sakti room`: `tim`/`otomatis` = koordinator; `solo` = satu bot pertama | satu worker |

Kata serial/paralel eksplisit menang atas mode bawaan (`tim` + `paralel` =
semua paralel; `tim` + `berurutan` = semua serial). Saat lebih dari satu bot
bekerja:

- hasil selalu sejajar urutan peserta (bukan urutan selesai, bukan abjad);
- satu bot gagal **tidak** menghentikan bot lain — kegagalannya dilaporkan
  per bot (`rusak: GAGAL - …`), sisanya tetap menjawab;
- jumlah worker paralel mengikuti jumlah peserta, dibatasi 12.

`panggil` di tengah giliran room **diantrekan**: permintaan diterima, bot target
menjawab setelah giliran selesai, jadi riwayat sesi tidak saling menimpa.
Alat `kirim` menaruh pesan koordinasi di ingatan inti yang terbaca bot lain.

Room **bawaan**: `sakti bot masuk <nama>` tanpa `--sesi` mengisi room bawaan
yang diwarisi setiap `sakti chat` baru, jadi bot benar-benar dipanggil. Untuk
mengatur room satu sesi saja: `sakti bot masuk <nama> --sesi <id>`.

Atur jumlah worker: `/worker <1-12>` di TUI, atau `sakti --worker=3`.
Worker ini dipakai saat mode paralel (jumlah peserta jadi batas atas) dan oleh
subagen di dalam giliran. `--worker=1` = berurutan penuh: tiap bot melihat
jawaban bot sebelumnya. Mode paralel sengaja tidak menunggu sesama bot (itu
arti paralel); pakai `--worker=1` atau kata `berurutan` bila bot harus saling
menanggapi.

Worker yang sama dipakai subagen di dalam giliran bot. Mau beda per bot?
`sakti bot set riset worker=3` (tersimpan di JSON bot, ikut ke setiap giliran).

## Subagen berperan & worker (`lib/subagen.js`)

Subagen = agen kedua dengan riwayat bersih: kamu memberi tugas mandiri, ia
bekerja dengan alat sesuai perannya, lalu mengembalikan jawabannya saja.

| peran | kapan dipakai | alat |
|---|---|---|
| `peneliti` | fakta, dokumentasi pustaka, versi terbaru | baca + cariweb/web |
| `penelusur` | lacak alur & pemanggil di kode | baca + diff |
| `arsitek` | rancang pendekatan / pecah pekerjaan | baca |
| `koder` | implementasi & perbaikan berkas | baca + tulis/edit/tambal/jalankan/uji |
| `penguji` | jalankan uji/build/lint, buktikan hasil | uji/jalankan/terminal |
| `peninjau` | review diff, keamanan, konsistensi | baca + diff |
| `perangkum` | saring log/keluaran panjang (model murah) | baca |
| `umum` | tugas mandiri lain (cadangan) | baca |

```sh
sakti subagen                                  # roster + alat + worker efektif
sakti subagen pilih "perbaiki bug login"       # peran mana yang dipilih otomatis
sakti delegasi peran=peneliti tugas="cari API resmi X"
sakti delegasi banyak='[{"peran":"peneliti","tugas":"cari spesifikasi Y"},{"peran":"penguji","tugas":"jalankan uji unit"}]'
```

Aturan yang dijaga kode, bukan cuma prompt:

- `peran=auto` **tidak** pernah memilih peran yang bisa menulis; `koder`/`penguji`
  hanya terpakai kalau peran disebut eksplisit atau `penuh=true`;
- `peran` yang salah ketik ditolak dengan daftar pilihan, bukan ditebak;
- batas delegasi bersarang 3 (subagen `penuh` memegang alat `delegasi` juga);
- alat yang mengubah disk tetap berurutan; hanya agen + pembacaan yang
  dijalankan bersamaan, sebanyak worker;
- `panggil` memakai pool yang sama (bukan `Promise.all` tanpa batas), dan bot
  target mewarisi folder kerja + worker-nya (`konteksBot`).

Terukur dengan model tiruan lokal (`uji-subagen.mjs` + probe): tiga `delegasi`
dalam satu balasan = 1391 ms saat `worker=1`, 470 ms saat `worker=3`, hasil
tetap sejajar urutan panggilan.

## Alat langsung, tanpa model

```sh
sakti terminal "npm install && npm test"   # bash -lc apa adanya
sakti uji uji/hitung.test.js              # node --test / pytest / bash, pilih dari nama berkas
sakti ls src                               # pohon folder
sakti baca src/a.js
sakti tulis src/a.js "export const a = 1;"
sakti cari "TODO" --berkas=*.js
sakti hapus src/lama.js                   # menolak / dan .
sakti py "print(2+2)"
sakti web https://example.com --tautan
sakti pdf teks dokumen.pdf --halaman=2
sakti zip buat src --ke=src.zip
sakti ingatan tambah "proyek ini memakai node 24"
sakti mind tambah "jangan sentuh port 8080"
sakti tugas simpan build "npm run build && npm test"
sakti tugas jalankan build
sakti status
sakti env
sakti alat                                 # daftar alat + skema JSON
```

Alias: `ls`→`daftar`, `cat`→`baca`, `sh`/`bash`→`terminal`, `test`→`uji`, `ingat`→`ingatan`.

## Smart route token (ringan = minimal, sulit = ultra)

Tingkat anggaran dipilih sendiri dari kesulitan tugas. Penilai `skorKesulitan()`
(`lib/rute.js`) deterministik: tanpa panggilan model, tanpa acak, tanpa jam. Sinyalnya
panjang pesan, sebutan berkas, blok kode, kata kerja berat (audit / race condition /
IDOR / rollback), kata uji, kata kerja, jumlah langkah, panjang riwayat, dan rencana
yang masih berjalan.

| tingkat | `effort` | `max_tokens` | riwayat | batas konteks |
|---|---|---|---|---|
| minimal | minimal | 1.024 | 6 pesan | 12.000 |
| low | low | 2.048 | 12 | 16.000 |
| medium | medium | 4.096 | 24 | 24.000 |
| high | high | 8.192 | 40 | 32.000 |
| ultra | ultra | 16.384 | 120 | 64.000 |

Eskalasi sendiri: begitu model memanggil alat dalam suatu giliran, putaran berikutnya
dipaksa minimal `high`; putaran ke-4 `ultra`. Tugas alat yang panjang tidak pernah
tertahan di anggaran ringan hanya karena pertanyaan pembukanya pendek.

Yang tidak pernah digeser rute: knob yang diset tangan - `--effort`, `--max-tokens`,
`--batas-riwayat`, `--batas-token`, env `SAKTI_*`, dan `/effort`, `/token` di TUI.
Rute hanya mengisi yang kosong; `konfigModel().eksplisit` mencatat mana yang diset
tangan. Batas konteks rute berlanai 12.000: biaya tetap satu giliran terukur ±18,5k
token (prompt 5,3k + skema alat 13,2k), jadi kasur di bawahnya hanya memotong badan
pesan tanpa menghemat apa pun.

```sh
sakti rute                      # keadaan sekarang + tabel tingkat
sakti rute on|off|auto          # hidup/matikan (bawaan on; auto melepas patokan)
sakti rute ultra                # patok satu tingkat, skor tidak dipakai
sakti chat --rute=off           # dari baris perintah
sakti chat --rute-tingkat=high
/rute                           # di TUI; satu baris tingkat yang dibayar ikut tercetak
```

Env: `SAKTI_RUTE=off`, `SAKTI_RUTE_TINGKAT=high`. Config: `{"rute":true,"ruteTingkat":""}`.

Terukur pada tiruan endpoint (muatan nyata yang dikirim `giliran()`): chat ringan
berriwayat 24 turun **5.623 -> 3.752 token (-33%)** - riwayat 24 -> 6 baris,
`max_tokens` 1.024. Tugas audit tetap `ultra` dengan 24 baris utuh + ruang 16.384.
`uji-rute.mjs` mengunci angka itu dari payload yang benar-benar terkirim, bukan dari
panggilan fungsi murni.

## Model

```sh
sakti model                                   # model aktif + katalog endpoint ini
sakti model <id>                              # pilih model aktif
sakti model katalog                           # tarik ulang GET /models sekarang
sakti model reasoning                         # uji effort/max_tokens yang didukung, simpan
sakti model set --model=<id> --model-url=<url> --model-key=<kunci>
sakti model tes                               # uji endpoint + simpan katalognya
```

Katalog model disimpan per endpoint di `katalog[<baseUrl>]` pada
`~/.sakti-cli/config.json` (0600), dengan cermin `models`/`modelsUrl`/`modelsWaktu`.
Ganti endpoint = katalog ikut berganti; katalog endpoint lama tetap tersimpan
untuk dipakai lagi. Disegarkan sendiri bila kosong atau umurnya lewat 6 jam;
`SAKTI_KATALOG_TTL` (detik) mengubah umur itu, `0`/`off` mematikan penyegaran
otomatis (manual lewat `sakti model katalog` atau baris "muat ulang" di TUI).

Konfigurasi di `~/.sakti-cli/config.json` (0600). Urutan: env `SAKTI_MODEL_URL`
/ `SAKTI_MODEL` / `SAKTI_MODEL_KEY` → berkas itu → `~/.pi/agent/models.json`
(dibaca sekali untuk menebak bawaan; setelah config ada, pi tidak disentuh lagi).
Endpoint apa pun yang bicara OpenAI chat-completions bisa dipakai.

## Yang tersimpan di mana

- konfigurasi model: `~/.sakti-cli/config.json`
- ingatan, ingatan inti, tugas: `~/.sakti-cli/state.json`
- transkrip sesi: `~/.sakti-cli/sesi/<id>.jsonl` + meta `.json`
- profil: `~/.sakti-cli/USER.md`
- berkas: di cakram apa adanya — tidak ada ruang kerja tersembunyi

- perintah kustom: `~/.sakti-cli/perintah/*.md`, atau `.sakti/perintah/` per proyek
- hook alat: `~/.sakti-cli/hook.json`

Env override: `SAKTI_CLI_CONFIG`, `SAKTI_CLI_STATE`, `SAKTI_CLI_SESI`,
`SAKTI_CLI_USER`, `SAKTI_SKILL_DIRS`, `SAKTI_HERMES_SKILLS`, `SAKTI_MODEL*`,
`SAKTI_CLI_PERINTAH`, `SAKTI_CLI_HOOK`, `SAKTI_HOOK_MATI`, `SAKTI_BATAS_RIWAYAT`,
`SAKTI_BATAS_TOKEN`, `SAKTI_MAKS_LANGKAH`, `SAKTI_WORKER`, `SAKTI_WORKER_SUBAGEN`,
`SAKTI_CLI_REA` (folder pemasangan REA), `SAKTI_CLI_REACH` (biner Agent Reach).

## Integrasi Agent Reach (internet platform)

Agent Reach dipasang resmi lewat uv, bukan PyPI. Instalasi saat ini:

```sh
sakti reach status        # versi + launcher + status skill
sakti reach pasang        # uv tool install dari rilis resmi GitHub
sakti reach setup         # pasang kanal default + skill untuk agen
sakti reach channels      # daftar kanal, aksi, parameter
sakti reach github search "sakti-cli" --limit 1
sakti reach web read https://example.com
```

`agent-reach` terpasang di `~/.local/bin/agent-reach`; skill-nya di
`~/.hermes/skills/agent-reach` sehingga agen sakti membacanya otomatis.
Kanal default: GitHub, YouTube, Bilibili, V2EX, web. Kanal opsional:
X/Twitter, Reddit, Facebook, Instagram, Xiaohongshu, LinkedIn, BOSS, Xueqiu,
Xiaoyuzhou. Login dilakukan pengguna sendiri lewat `sakti reach login <kanal>`;
sakti tidak meminta atau menyimpan kata sandi.

`SAKTI_CLI_REACH` menunjuk biner lain. `bash pasang.sh --reach` memasang
Agent Reach + skill sekaligus. `sakti doctor` melaporkan versi dan skill.

## Pasang di device lain

Syaratnya cuma **Node.js >= 20**. Tidak ada `npm install`, tidak ada dependensi
(hanya `node:fs`, `node:path`, `node:child_process`, dan `fetch` bawaan Node),
tidak ada langkah build