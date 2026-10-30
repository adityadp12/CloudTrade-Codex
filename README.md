# TradeCloud

TradeCloud adalah control plane multi-tenant untuk provisioning dan pengelolaan terminal MetaTrader 5 portable. Backend menyimpan user, paket, secret terenkripsi, token telemetry, histori trading, kontrol risiko, dan provisioning job di PostgreSQL. Seluruh migration berada di repository.

## Komponen

- `src/server.js`: API auth, terminal, telemetry, trade event, supervisor, dan kontrol risiko.
- `src/worker.js`: worker queue Windows dengan row locking PostgreSQL.
- `scripts/provision-terminal.ps1`: clone, login, konfigurasi chart/EA, WebRequest, dan verifikasi telemetry.
- `scripts/apply-hmcopylot-risk.ps1`: penerapan input resmi HMCopyLot tanpa memodifikasi binary EA.
- `scripts/login-terminal.py`: login dan verifikasi account/server/symbol tanpa mencetak secret.
- `migrations/`: schema PostgreSQL versioned.
- `public/`: landing, auth, dashboard, provisioning log, dan MT5 supervisor.
- `core_system_prompt.txt`: workflow core yang menjadi acuan provisioning/repair.

## Menjalankan lokal

1. Salin `.env.example` menjadi `.env`.
2. Isi PostgreSQL, `JWT_SECRET`, dan `CREDENTIALS_MASTER_KEY` (64 karakter hex).
3. Jalankan PostgreSQL dengan `docker compose up -d`, atau arahkan `DATABASE_URL` ke PostgreSQL yang tersedia.
4. Jalankan:

   ```powershell
   npm.cmd run migrate
   npm.cmd start
   npm.cmd run worker
   ```

5. Buka `http://localhost:8090`.

Route frontend: `/`, `/login`, `/register`, `/dashboard`, `/terminals`, `/activity`, `/plans`, dan `/terminal/:id`.

`PROVISIONING_ENABLED=false` adalah mode simulasi. Aktifkan hanya pada Windows worker yang memiliki golden image MT5, Python MetaTrader5, dan izin menjalankan terminal.

## Lifecycle

Worker harus berjalan terpisah dari API: `npm.cmd run worker`. Tanpa worker, job baru tetap berada di antrean. Pada Windows, jalankan `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-worker-autostart.ps1` untuk memasang task per-user yang menyalakan worker saat logon dan memeriksa prosesnya setiap menit. Starter tidak menggandakan worker yang sudah berjalan. Kegagalan membaca antrean saat database belum siap akan dicoba kembali dengan jeda bertahap, bukan mematikan worker.

Provisioning mempertahankan executable tenant yang lebih baru daripada golden image. Jika koneksi Python belum siap setelah restart, worker mengirim login melalui dialog MT5 yang sebenarnya dan memverifikasi identitas akun, server, serta koneksi melalui SDK sebelum melanjutkan. Judul jendela tidak dipakai sebagai bukti autentikasi. Penemuan broker memilih perusahaan yang menyediakan server yang diminta, bukan sekadar nama merek yang mirip.

Login awal memakai profile kosong agar chart bawaan tidak menahan inisialisasi pada akun dengan suffix simbol. Setelah discovery, Bridge dan HMCopyLot dimuat memakai nama simbol broker yang sebenarnya (misalnya `EURUSDc` dan `XAUUSDc`).

`QUEUED -> CLONING -> AUTHENTICATING -> SYMBOL_DISCOVERY -> CONFIGURING_BRIDGE -> CONFIGURING_XAUUSD -> WEBREQUEST_ALLOWLIST -> TELEMETRY_VERIFY -> RUNNING`

Setiap terminal mempunyai portable directory, credential terenkripsi, telemetry token, `InpTerminalId`, proses, chart, dan data tenant sendiri.

## Kontrol risiko HMCopyLot

TradeCloud tidak mengubah atau melakukan decompile terhadap `HMCopyLot.ex5`. Sistem hanya mengatur input resmi `InpMaxLoss` dan `InpTrailDist`, lalu me-reload terminal tenant menggunakan credential user yang terenkripsi.

```text
TrailingDistance = max(2 * spreadPoints, ceil(spreadPoints * 200 / riskPercent))
```

Risk percentage default adalah 10%. Dengan spread 10 point, risiko 10% menghasilkan 200 point dan risiko 20% menghasilkan 100 point.

## Analisis pasar dan kalender di web

Halaman `/terminal/:id` memiliki tab **Harga & volume**, **Kalender ekonomi**, dan **Kalender PNL**, dalam bahasa Indonesia/Inggris serta layout desktop/mobile.

Detail terminal memakai kartu metrik ringkas, tinggi tabel yang dibatasi, dan panel risiko, ringkasan trading, kontrol akun, serta grafik yang dapat dibuka saat dibutuhkan. Kontrol akun tetap memerlukan tindakan eksplisit pengguna. Tabel lebar digulir di dalam panel agar halaman mobile tidak melebar.

- Harga/volume dibaca dari terminal MT5 tenant yang sudah berjalan, melalui `scripts/market-snapshot.py` dan `PYTHON_EXE`. Reader tidak login ulang, mengirim order, menyalakan terminal, atau mengubah EA. PID dan path executable harus sesuai tenant. Jika terminal offline atau data lama/tidak lengkap, web menjelaskan status tersebut dan tidak mengarang sinyal.
- Arah indikator BUY/SELL/WAIT menggunakan candle tertutup M15/H1, konfirmasi H4, rata-rata harga 10/30 candle, dan volume relatif terhadap 20 candle sebelumnya. Tick volume dibedakan dari real volume; DOM hanya ditampilkan bila broker menyediakannya. Data broker bukan volume seluruh pasar global. Ini konteks analisis, bukan prediksi probabilitas profit.
- **Minta analisis AI** menjalankan `CODEX_COMMAND` dengan login CLI yang tersedia pada user server, sandbox read-only, direktori sementara kosong, output JSON terstruktur, dan batas waktu 90 detik. Hanya data pasar dan kalender yang dikirim, tanpa credential, identitas akun atau histori PNL. Hasil diberi waktu snapshot dan menjadi kedaluwarsa setelah 3 menit. AI dapat menurunkan sinyal ke WAIT, tetapi tidak membalik arah atau melewati pemeriksaan data. Kegagalan AI tidak menghilangkan analisis indikator. Pada Windows gunakan native `codex.exe` atau shim npm standar `codex.cmd`.
- Kalender ekonomi mengambil jadwal minggu ini dari `https://nfs.faireconomy.media/ff_calendar_thisweek.json`, cache 15 menit, dengan filter mata uang/dampak dan waktu WIB. Nilai actual yang tidak disediakan tetap kosong. Feed gagal/lama ditandai; jangan menganggapnya berarti tidak ada berita. Kalender ini bukan feed actual real-time yang dijamin.
- PNL bulanan memakai seluruh deal tercatat pada bulan/zona waktu pilihan, bukan 1.000 baris terakhir tabel histori. Net mencakup profit, komisi, swap, dan fee termasuk biaya entry. Deposit/penarikan dan floating PNL tidak dihitung. Jumlah penutupan dan win rate dihitung per closing deal, bukan per posisi. Klik tanggal untuk rincian. Kalender hanya mencakup deal yang sudah diterima TradeCloud; belum ada backfill histori broker otomatis.

API memerlukan session login dan memeriksa kepemilikan terminal: `GET /api/terminals/:id/market`, `GET /api/economic-calendar`, `GET /api/terminals/:id/pnl-calendar?month=2026-10&timeZone=Asia/Jakarta`, serta `POST`/`GET /api/terminals/:id/market-ai`. Tidak ada migration baru dan tidak ada perubahan eksekusi trading.

Validasi: `npm test` untuk analisis/API, `npm run test:web` untuk browser Chrome desktop/mobile (Chrome lokal harus terpasang). Test browser memakai fixture terisolasi dan tidak menjalankan terminal atau order nyata.

## Keamanan

- Password broker tidak dikembalikan oleh API.
- Secret dienkripsi AES-256-GCM sebelum masuk PostgreSQL.
- Token telemetry disimpan sebagai hash dan ciphertext terpisah.
- Browser API dibatasi oleh session user dan ownership terminal.
- Session menggunakan cookie HttpOnly dan SameSite=Lax.
- Gunakan HTTPS, `COOKIE_SECURE=true`, dan secret manager pada production.

File berikut sengaja tidak masuk Git: `.env`, `login.txt`, golden image/runtime MT5, folder tenant, data PostgreSQL, runtime log, dan `node_modules`.
