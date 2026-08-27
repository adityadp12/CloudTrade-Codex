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

`QUEUED -> CLONING -> AUTHENTICATING -> SYMBOL_DISCOVERY -> CONFIGURING_BRIDGE -> CONFIGURING_XAUUSD -> WEBREQUEST_ALLOWLIST -> TELEMETRY_VERIFY -> RUNNING`

Setiap terminal mempunyai portable directory, credential terenkripsi, telemetry token, `InpTerminalId`, proses, chart, dan data tenant sendiri.

## Kontrol risiko HMCopyLot

TradeCloud tidak mengubah atau melakukan decompile terhadap `HMCopyLot.ex5`. Sistem hanya mengatur input resmi `InpMaxLoss` dan `InpTrailDist`, lalu me-reload terminal tenant menggunakan credential user yang terenkripsi.

```text
TrailingDistance = max(2 * spreadPoints, ceil(spreadPoints * 200 / riskPercent))
```

Risk percentage default adalah 10%. Dengan spread 10 point, risiko 10% menghasilkan 200 point dan risiko 20% menghasilkan 100 point.

## Keamanan

- Password broker tidak dikembalikan oleh API.
- Secret dienkripsi AES-256-GCM sebelum masuk PostgreSQL.
- Token telemetry disimpan sebagai hash dan ciphertext terpisah.
- Browser API dibatasi oleh session user dan ownership terminal.
- Session menggunakan cookie HttpOnly dan SameSite=Lax.
- Gunakan HTTPS, `COOKIE_SECURE=true`, dan secret manager pada production.

File berikut sengaja tidak masuk Git: `.env`, `login.txt`, golden image/runtime MT5, folder tenant, data PostgreSQL, runtime log, dan `node_modules`.
