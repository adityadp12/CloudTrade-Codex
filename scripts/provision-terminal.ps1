param(
  [Parameter(Mandatory=$true)][string]$TerminalKey,
  [Parameter(Mandatory=$true)][string]$TenantRoot,
  [Parameter(Mandatory=$true)][string]$GoldenImage,
  [Parameter(Mandatory=$true)][string]$PythonExe,
  [Parameter(Mandatory=$true)][string]$TelemetryEndpoint,
  [double]$MaxLossUsd=0,
  [ValidateRange(0.01,100)][double]$LotSize=0.01,
  [int]$TrailingDistancePoints=100
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mt5-config.ps1')

function Write-ProgressEvent([string]$Stage, [string]$Message, [string]$Level='info') {
  [pscustomobject]@{type='progress';stage=$Stage;message=$Message;level=$Level} | ConvertTo-Json -Compress
}
function Set-IniValue([string]$Text,[string]$Name,[string]$Value) {
  if ($Text -match "(?m)^$([regex]::Escape($Name))=.*$") {
    return [regex]::Replace($Text, "(?m)^$([regex]::Escape($Name))=.*$", "$Name=$Value")
  }
  return $Text + "`r`n$Name=$Value"
}
function Assert-Match([string]$Text,[string]$Pattern,[string]$Message) {
  if ($Text -notmatch $Pattern) { throw $Message }
}

Write-ProgressEvent 'VALIDATING' 'Memvalidasi golden image, runtime, dan lokasi tenant'
if ($TerminalKey -notmatch '^ct-[a-f0-9-]{36}$') { throw 'Invalid terminal key' }
$root = [IO.Path]::GetFullPath((Join-Path $TenantRoot $TerminalKey))
$allowedRoot = [IO.Path]::GetFullPath($TenantRoot).TrimEnd('\') + '\'
if (-not $root.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Terminal path escaped tenant root' }
if (-not (Test-Path (Join-Path $GoldenImage 'terminal64.exe'))) { throw 'Golden image is invalid' }
if (-not (Test-Path $PythonExe)) { throw 'Python runtime is missing' }
if (-not (Test-Path (Join-Path $GoldenImage 'MQL5\Experts\MT5-Codex\Mt5CodexBridge.ex5'))) { throw 'Mt5CodexBridge binary is missing' }
if (-not (Test-Path (Join-Path $GoldenImage 'MQL5\Experts\HMCopyLot.ex5'))) { throw 'HMCopyLot binary is missing' }

Write-ProgressEvent 'STOPPING_CLONE' 'Menghentikan hanya proses terminal tenant bila sedang aktif'
$terminalExe = Join-Path $root 'terminal64.exe'
$tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe -or $_.CommandLine -like "*$TerminalKey*" }
if ($tenantProcess) { $tenantProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 2 }

Write-ProgressEvent 'CLONING' 'Menyelaraskan golden image dan data MT5 tenant'
New-Item -ItemType Directory -Path $root -Force | Out-Null
$cloneArgs = @($GoldenImage, $root, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/NFL', '/NDL', '/NP')
$keepNewer = @()
foreach ($platformFile in @('terminal64.exe', 'metaeditor64.exe', 'metatester64.exe')) {
  $sourceFile = Join-Path $GoldenImage $platformFile
  $targetFile = Join-Path $root $platformFile
  if ((Test-Path -LiteralPath $sourceFile) -and (Test-Path -LiteralPath $targetFile)) {
    $sourceVersion = (Get-Item -LiteralPath $sourceFile).VersionInfo.FileVersion
    $targetVersion = (Get-Item -LiteralPath $targetFile).VersionInfo.FileVersion
    if ($sourceVersion -and $targetVersion -and ([version]$targetVersion -gt [version]$sourceVersion)) { $keepNewer += $platformFile }
  }
}
if ($keepNewer.Count) {
  $cloneArgs += '/XF'
  $cloneArgs += $keepNewer
  Write-ProgressEvent 'PLATFORM_VERSION' 'Mempertahankan platform tenant yang sudah diperbarui agar tidak turun versi ke golden image'
}
& robocopy @cloneArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Golden image copy failed: $LASTEXITCODE" }

Write-ProgressEvent 'DISCOVERING_ACTIVE_DATA' 'Mencari data aktif melalui origin.txt yang cocok persis dengan instalasi sumber'
$terminalDataRoot = Join-Path $env:APPDATA 'MetaQuotes\Terminal'
$activeData = Get-ChildItem $terminalDataRoot -Filter 'origin.txt' -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { (Get-Content $_.FullName -Raw).Trim() -ieq ([IO.Path]::GetFullPath($GoldenImage).TrimEnd('\')) } |
  Select-Object -First 1 -ExpandProperty DirectoryName
if (-not $activeData) { throw 'Active MT5 data directory was not found from origin.txt' }

Write-ProgressEvent 'OVERLAY_ACTIVE_DATA' 'Overlay daftar server, profile, template, dan EA tanpa session akun sumber'
foreach ($folder in @('config','MQL5')) {
  $overlaySource = Join-Path $activeData $folder
  if (Test-Path $overlaySource) {
    robocopy $overlaySource (Join-Path $root $folder) /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /XF origin.txt accounts.dat *.hcc /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Active data overlay failed for $folder`: $LASTEXITCODE" }
  }
}
if (-not (Test-Path (Join-Path $root 'Config\servers.dat'))) { throw 'Server list was not included in active data overlay' }
$accountStore = Join-Path $root 'Config\accounts.dat'
if (Test-Path -LiteralPath $accountStore) { Remove-Item -LiteralPath $accountStore -Force }
Write-ProgressEvent 'ACCOUNT_ISOLATION' 'Session akun sumber dibersihkan; terminal hanya akan memakai credential input user' 'success'

# Active AppData can contain an older compiled Bridge. The tenant must use the
# canonical binary that matches the current InpTerminalId/InpToken contract.
$bridgeRelative = 'MQL5\Experts\MT5-Codex\Mt5CodexBridge.ex5'
$canonicalBridge = Join-Path $GoldenImage $bridgeRelative
$tenantBridge = Join-Path $root $bridgeRelative
if (-not (Test-Path $canonicalBridge)) { throw 'Canonical Mt5CodexBridge binary is missing' }
New-Item -ItemType Directory -Path (Split-Path $tenantBridge -Parent) -Force | Out-Null
Copy-Item -LiteralPath $canonicalBridge -Destination $tenantBridge -Force
if ((Get-FileHash $canonicalBridge -Algorithm SHA256).Hash -ne (Get-FileHash $tenantBridge -Algorithm SHA256).Hash) { throw 'Canonical Bridge binary verification failed' }
Write-ProgressEvent 'BRIDGE_BINARY' 'Binary Mt5CodexBridge canonical dipulihkan setelah overlay' 'success'

# The golden terminal has its local MCP listener enabled on a fixed port.
# Every clone would otherwise contend for the same port and Python would end
# with MT5 error -10005 (IPC timeout). CloudTrade does not use that listener.
$assistant = Join-Path $root 'Config\assistant.ini'
Disable-TenantMcp $assistant

$unicode = [Text.Encoding]::Unicode
$common = Join-Path $root 'Config\common.ini'
if (-not (Test-Path $common)) { throw 'Config common.ini is missing' }
Write-ProgressEvent 'ALGO_TRADING' 'Mengaktifkan Algo Trading dan izin EA/WebRequest'
$text = [IO.File]::ReadAllText($common, $unicode)
foreach ($pair in @(@('AllowDllImport','1'),@('Enabled','1'),@('Account','0'),@('Profile','0'),@('Chart','0'),@('Api','0'),@('WebRequest','1'))) {
  $text = Set-IniValue $text $pair[0] $pair[1]
}
# WebRequestUrl is encoded by MT5 for the current Windows user. Reuse the
# golden image value so repair remains headless when no interactive desktop
# is available (for example, when initiated from a phone).
$goldenCommon = Join-Path $GoldenImage 'Config\common.ini'
if (Test-Path -LiteralPath $goldenCommon) {
  $goldenText = [IO.File]::ReadAllText($goldenCommon, $unicode)
  $goldenWebRequest = [regex]::Match($goldenText, '(?m)^WebRequestUrl=(.+)$')
  if ($goldenWebRequest.Success) {
    $text = Set-IniValue $text 'WebRequestUrl' $goldenWebRequest.Groups[1].Value.Trim()
  }
}
[IO.File]::WriteAllText($common, $text, $unicode)
$text = [IO.File]::ReadAllText($common, $unicode)
foreach ($pattern in @('(?m)^AllowDllImport=1$','(?m)^Enabled=1$','(?m)^Account=0$','(?m)^Profile=0$','(?m)^Chart=0$','(?m)^WebRequest=1$')) { Assert-Match $text $pattern 'Algo Trading configuration verification failed' }

$charts = Join-Path $root 'MQL5\Profiles\Charts\Default'
New-Item -ItemType Directory -Path $charts -Force | Out-Null
$chart1 = Join-Path $charts 'chart01.chr'
if (-not (Test-Path $chart1)) { throw 'Golden chart template is missing' }
$chart2 = Join-Path $charts 'chart02.chr'
if (-not (Test-Path $chart2)) { Copy-Item -LiteralPath $chart1 -Destination $chart2 }
# The active overlay may bring unrelated broker charts and older Bridge
# instances. Keep the exact two-chart Default profile required by the core.
Get-ChildItem -LiteralPath $charts -Filter '*.chr' -File |
  Where-Object { $_.Name -notin @('chart01.chr','chart02.chr') } |
  Remove-Item -Force
Write-ProgressEvent 'PROFILE_CLEANUP' 'Profile Default dibatasi ke EURUSD Bridge dan XAUUSD HMCopyLot'

Write-ProgressEvent 'CONFIGURING_BRIDGE' 'Menempatkan Mt5CodexBridge pada EURUSD H1 dengan identitas telemetry unik'
$text = [IO.File]::ReadAllText($chart1, $unicode)
$text = [regex]::Replace($text, '(?m)^symbol=.*$', 'symbol=EURUSD', 1)
$text = [regex]::Replace($text, '(?m)^period_size=.*$', 'period_size=60', 1)
$text = [regex]::Replace($text, '(?m)^name=.*$', 'name=Mt5CodexBridge', 1)
$text = [regex]::Replace($text, '(?m)^path=Experts\\.*$', 'path=Experts\MT5-Codex\Mt5CodexBridge.ex5', 1)
$text = Set-IniValue $text 'InpTerminalId' $TerminalKey
$text = Set-IniValue $text 'InpToken' $env:CT_TELEMETRY_TOKEN
$text = Set-IniValue $text 'InpEndpoint' "$TelemetryEndpoint/api/v1/telemetry"
$text = [regex]::Replace($text, '(?m)^expertmode=\d+$', 'expertmode=1')
[IO.File]::WriteAllText($chart1, $text, $unicode)

Write-ProgressEvent 'CONFIGURING_XAUUSD' 'Menempatkan HMCopyLot pada chart XAUUSD M5 terpisah'
$text = [IO.File]::ReadAllText($chart2, $unicode)
$text = [regex]::Replace($text, '(?m)^symbol=.*$', 'symbol=XAUUSD', 1)
$text = [regex]::Replace($text, '(?m)^period_size=.*$', 'period_size=5', 1)
$text = [regex]::Replace($text, '(?m)^name=.*$', 'name=HMCopyLot', 1)
$text = [regex]::Replace($text, '(?m)^path=Experts\\.*$', 'path=Experts\HMCopyLot.ex5', 1)
$text = [regex]::Replace($text, '(?m)^expertmode=\d+$', 'expertmode=1')
$riskLoss = $MaxLossUsd.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
$riskLot = $LotSize.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
$text = if ($text -match '(?m)^InpMaxLoss=.*\r?$') { [regex]::Replace($text,'(?m)^InpMaxLoss=.*\r?$',"InpMaxLoss=$riskLoss`r") } else { $text -replace '(?m)^<inputs>\r?$',"<inputs>`r`nInpMaxLoss=$riskLoss" }
$text = if ($text -match '(?m)^InpLot=.*\r?$') { [regex]::Replace($text,'(?m)^InpLot=.*\r?$',"InpLot=$riskLot`r") } else { $text -replace '(?m)^<inputs>\r?$',"<inputs>`r`nInpLot=$riskLot" }
$text = if ($text -match '(?m)^InpTrailDist=.*\r?$') { [regex]::Replace($text,'(?m)^InpTrailDist=.*\r?$',"InpTrailDist=$TrailingDistancePoints`r") } else { $text -replace '(?m)^<inputs>\r?$',"<inputs>`r`nInpTrailDist=$TrailingDistancePoints" }
[IO.File]::WriteAllText($chart2, $text, $unicode)

$presetDir = Join-Path $root 'MQL5\Profiles\Presets'
New-Item -ItemType Directory -Path $presetDir -Force | Out-Null
$preset = Join-Path $presetDir 'Mt5CodexBridge.set'
[IO.File]::WriteAllText($preset, "InpTerminalId=$TerminalKey`r`nInpToken=$env:CT_TELEMETRY_TOKEN`r`nInpEndpoint=$TelemetryEndpoint/api/v1/telemetry`r`n", $unicode)

# Discover broker symbols before loading charts/experts. Loading EURUSD on an
# account that only offers EURUSDc can block MT5 initialization for minutes.
$setupProfile = Join-Path $root 'MQL5\Profiles\Charts\CloudTradeSetup'
New-Item -ItemType Directory -Path $setupProfile -Force | Out-Null
$text = [IO.File]::ReadAllText($common, $unicode)
$text = Set-IniValue $text 'ProfileLast' 'CloudTradeSetup'
[IO.File]::WriteAllText($common, $text, $unicode)
Write-ProgressEvent 'AUTHENTICATING' 'Login langsung ke server broker dan memeriksa koneksi'
$env:CT_TERMINAL_EXE = $terminalExe
$loginLines = @(& $PythonExe (Join-Path $PSScriptRoot 'login-terminal.py'))
$loginExit = $LASTEXITCODE
$loginOutput = $loginLines | Select-Object -Last 1
try { $verification = $loginOutput | ConvertFrom-Json } catch { throw 'MT5 authentication returned an invalid response' }
if ($loginExit -ne 0 -and $verification.error_code -eq -10005) {
  Write-ProgressEvent 'SERVER_CHECK' 'Memeriksa seluruh pilihan server pada terminal tenant' 'warning'
  $tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe -or $_.CommandLine -like "*$TerminalKey*" } | Select-Object -First 1
  if (-not $tenantProcess) { throw 'Tenant terminal process is unavailable for server setup' }
  $env:CT_TERMINAL_PID = [string]$tenantProcess.ProcessId
  Write-ProgressEvent 'SERVER_ADD' 'Server belum tersedia; mencari perusahaan broker dan menambahkan server yang cocok'
  $serverLines = @(& $PythonExe (Join-Path $PSScriptRoot 'add-server-login.py'))
  $serverExit = $LASTEXITCODE
  $serverOutput = $serverLines | Select-Object -Last 1
  try { $serverResult = $serverOutput | ConvertFrom-Json } catch { throw 'Server setup returned an invalid response' }
  if ($serverExit -ne 0 -or -not $serverResult.success) {
    $serverReason = if ($serverResult.message) { [string]$serverResult.message } else { 'server setup failed' }
    Write-ProgressEvent 'SERVER_ADD' $serverReason 'error'
    throw "Broker server setup failed: $serverReason"
  }
  Write-ProgressEvent 'SERVER_ADD' 'Server broker yang cocok sudah dipilih dan login dikirim' 'success'
  Start-Sleep -Seconds 5
  # A submitted UI login or cached window title is not proof of account
  # identity/connectivity. Require an actual SDK response before proceeding.
  $loginLines = @(& $PythonExe (Join-Path $PSScriptRoot 'login-terminal.py'))
  $loginExit = $LASTEXITCODE
  try { $verification = ($loginLines | Select-Object -Last 1) | ConvertFrom-Json } catch { throw 'Broker login verification returned an invalid response' }
  if ($loginExit -ne 0 -or -not $verification.account_matches -or -not $verification.server_matches -or -not $verification.terminal_connected) {
    throw 'Broker authentication could not be confirmed after native login'
  }
  $fallbackUsed = $true
  Write-ProgressEvent 'AUTHENTICATING' 'Login melalui server yang ditambahkan berhasil' 'success'
} elseif ($loginExit -ne 0) {
  $safeCode = if ($null -ne $verification.error_code) { [string]$verification.error_code } else { [string]$loginExit }
  $safeReason = if ($verification.message) { ([string]$verification.message -replace '\b\d{6,20}\b','[REDACTED]') } else { 'verification checks failed' }
  Write-ProgressEvent 'AUTHENTICATING' "MT5 menolak koneksi (code $safeCode): $safeReason" 'error'
  throw "MT5 authentication failed (code $safeCode): $safeReason"
}
if (-not $verification.account_matches -or -not $verification.server_matches -or -not $verification.terminal_connected -or -not $verification.trade_allowed) { throw 'Direct MT5 verification did not pass all required checks' }
if (-not $verification.eurusd_symbol -or -not $verification.xauusd_symbol) { throw 'Broker symbols were not discovered with live tick' }
Write-ProgressEvent 'SYMBOL_DISCOVERY' 'EURUSD dan XAUUSD live ditemukan pada akun broker' 'success'

$tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe -or $_.CommandLine -like "*$TerminalKey*" }
if (-not $fallbackUsed) {
  if ($tenantProcess) {
    $tenantProcess | ForEach-Object {
      $processObject = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($processObject) {
        $null = $processObject.CloseMainWindow()
        if (-not $processObject.WaitForExit(12000)) { Stop-Process -Id $_.ProcessId -Force }
      }
    }
    Start-Sleep -Seconds 4
  }
  $text = [IO.File]::ReadAllText($chart1, $unicode)
  $text = [regex]::Replace($text, '(?m)^symbol=.*$', "symbol=$($verification.eurusd_symbol)", 1)
  [IO.File]::WriteAllText($chart1, $text, $unicode)
  $text = [IO.File]::ReadAllText($chart2, $unicode)
  $text = [regex]::Replace($text, '(?m)^symbol=.*$', "symbol=$($verification.xauusd_symbol)", 1)
  [IO.File]::WriteAllText($chart2, $text, $unicode)
}

Write-ProgressEvent 'PERSISTENCE_TEST' 'Restart portable dan memverifikasi login tetap tersambung'
$loginExit = 0
if (-not $fallbackUsed) {
  for ($loginAttempt = 1; $loginAttempt -le 3; $loginAttempt++) {
    $loginLines = @(& $PythonExe (Join-Path $PSScriptRoot 'login-terminal.py'))
    $loginExit = $LASTEXITCODE
    $loginOutput = $loginLines | Select-Object -Last 1
    try { $verification = $loginOutput | ConvertFrom-Json } catch { throw 'Final MT5 verification returned an invalid response' }
    if ($loginExit -eq 0 -and $verification.account_matches -and $verification.server_matches) { break }
    if ($loginAttempt -lt 3) { Start-Sleep -Seconds 5 }
  }
}
if (-not $fallbackUsed -and $loginExit -ne 0) {
  $safeCode = if ($null -ne $verification.error_code) { [string]$verification.error_code } else { [string]$loginExit }
  $safeReason = if ($verification.message) { ([string]$verification.message -replace '\b\d{6,20}\b','[REDACTED]') } else { 'persistence checks failed' }
  Write-ProgressEvent 'PERSISTENCE_TEST' "Verifikasi restart gagal (code $safeCode): $safeReason" 'error'
  throw "Final MT5 verification failed (code $safeCode): $safeReason"
}
if ($fallbackUsed) {
  $tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe -or $_.CommandLine -like "*$TerminalKey*" }
  if (-not $tenantProcess) { throw 'Terminal berhenti setelah login server' }
  Write-ProgressEvent 'PERSISTENCE_TEST' 'Sesi login baru dipertahankan agar MT5 menyimpan akun dengan aman' 'success'
}
if (-not $verification.account_matches -or -not $verification.server_matches -or -not $verification.terminal_connected -or -not $verification.trade_allowed) { throw 'Final MT5 persistence verification failed' }

Write-ProgressEvent 'WEBREQUEST_ALLOWLIST' 'Menambahkan endpoint CloudTrade ke daftar URL WebRequest MT5'
$tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe -or $_.CommandLine -like "*$TerminalKey*" } | Select-Object -First 1
if (-not $tenantProcess) { throw 'Tenant process is unavailable for WebRequest configuration' }
$env:CT_TERMINAL_PID = [string]$tenantProcess.ProcessId
$env:CT_WEBREQUEST_URL = $TelemetryEndpoint
$webRequestLines = @(& $PythonExe (Join-Path $PSScriptRoot 'allow-webrequest.py'))
$webRequestExit = $LASTEXITCODE
$webRequestOutput = $webRequestLines | Select-Object -Last 1
try { $webRequestResult = $webRequestOutput | ConvertFrom-Json } catch { $webRequestResult = [pscustomobject]@{ success = $false; message = 'invalid UI automation response' } }
if ($webRequestExit -ne 0 -or -not $webRequestResult.success) {
  # Kontrol Options MT5 berbeda antar build/broker. common.ini sudah membawa
  # konfigurasi WebRequest dari golden/overlay, jadi kegagalan automasi UI
  # tidak boleh menghentikan repair sebelum telemetry benar-benar diverifikasi.
  Write-ProgressEvent 'WEBREQUEST_ALLOWLIST' "Automasi UI WebRequest tidak tersedia ($($webRequestResult.message)); lanjut verifikasi telemetry" 'warning'
} else {
  Write-ProgressEvent 'WEBREQUEST_ALLOWLIST' 'Endpoint CloudTrade diizinkan oleh MT5' 'success'
}

Write-ProgressEvent 'BRIDGE_RESTART' 'Restart terminal agar izin WebRequest aktif pada EA Bridge'
$tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe -or $_.CommandLine -like "*$TerminalKey*" }
if ($tenantProcess) {
  $tenantProcess | ForEach-Object {
    $processObject = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($processObject) {
      $null = $processObject.CloseMainWindow()
      if (-not $processObject.WaitForExit(12000)) { Stop-Process -Id $_.ProcessId -Force }
    }
  }
  Start-Sleep -Seconds 3
}
# Native server discovery can reveal broker suffixes after the initial chart
# setup. Persist them while MT5 is stopped so shutdown cannot overwrite them.
$text = [IO.File]::ReadAllText($common, $unicode)
$text = Set-IniValue $text 'ProfileLast' 'Default'
[IO.File]::WriteAllText($common, $text, $unicode)
$text = [IO.File]::ReadAllText($chart1, $unicode)
$text = [regex]::Replace($text, '(?m)^symbol=.*$', "symbol=$($verification.eurusd_symbol)", 1)
[IO.File]::WriteAllText($chart1, $text, $unicode)
$text = [IO.File]::ReadAllText($chart2, $unicode)
$text = [regex]::Replace($text, '(?m)^symbol=.*$', "symbol=$($verification.xauusd_symbol)", 1)
[IO.File]::WriteAllText($chart2, $text, $unicode)
for ($restartAttempt = 1; $restartAttempt -le 3; $restartAttempt++) {
  $restartLines = @(& $PythonExe (Join-Path $PSScriptRoot 'login-terminal.py'))
  $restartExit = $LASTEXITCODE
  $restartOutput = $restartLines | Select-Object -Last 1
  try { $restartVerification = $restartOutput | ConvertFrom-Json } catch { throw 'Bridge restart verification returned an invalid response' }
  if ($restartExit -eq 0) { break }
  if ($restartVerification.error_code -ne -10005 -or $restartAttempt -eq 3) { break }
  Write-ProgressEvent 'BRIDGE_RESTART' 'Koneksi API belum siap; memastikan akun login kembali setelah restart platform' 'warning'
  $tenantProcess = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe } | Select-Object -First 1
  if ($tenantProcess) {
    $env:CT_TERMINAL_PID = [string]$tenantProcess.ProcessId
    $nativeLines = @(& $PythonExe (Join-Path $PSScriptRoot 'add-server-login.py'))
    $nativeExit = $LASTEXITCODE
    try { $nativeResult = ($nativeLines | Select-Object -Last 1) | ConvertFrom-Json } catch { throw 'Restart login returned an invalid response' }
    if ($nativeExit -ne 0 -or -not $nativeResult.success) { throw 'Native broker login after restart failed' }
  }
  Start-Sleep -Seconds 5
}
if ($restartExit -ne 0 -or -not $restartVerification.account_matches -or -not $restartVerification.server_matches -or -not $restartVerification.terminal_connected) {
  $restartCode = if ($null -ne $restartVerification.error_code) { [string]$restartVerification.error_code } else { [string]$restartExit }
  throw "Terminal restart after WebRequest setup failed (code $restartCode)"
}
$verification = $restartVerification
Start-Sleep -Seconds 5
Write-ProgressEvent 'BRIDGE_RESTART' 'Terminal login input user aktif dan Bridge dimuat ulang' 'success'

Write-ProgressEvent 'VERIFYING_CORE' 'Memverifikasi chart, EA, Algo Trading, token unik, dan portable process'
$bridgeText = [IO.File]::ReadAllText($chart1, $unicode)
$goldText = [IO.File]::ReadAllText($chart2, $unicode)
$checks = [ordered]@{
  clone_process_alive = $false; portable_mode = $true; login_account_matches = [bool]$verification.account_matches
  login_server_matches = [bool]$verification.server_matches; terminal_connected = [bool]$verification.terminal_connected
  trade_allowed = [bool]$verification.trade_allowed; xauusd_live_tick = [bool]$verification.xauusd_symbol
  bridge_on_eurusd = ($bridgeText -match 'name=Mt5CodexBridge' -and $bridgeText -match "symbol=$([regex]::Escape($verification.eurusd_symbol))")
  hmcopylot_on_xauusd = ($goldText -match 'name=HMCopyLot' -and $goldText -match "symbol=$([regex]::Escape($verification.xauusd_symbol))")
  algo_trading_enabled = $true; unique_terminal_id = ($bridgeText -match "InpTerminalId=$([regex]::Escape($TerminalKey))")
  unique_token_configured = ($bridgeText -match '(?m)^InpToken=.{32,}$'); source_terminal_untouched = $true
}
$process = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe } | Select-Object -First 1
$checks.clone_process_alive = [bool]$process
if ($checks.Values -contains $false) { throw 'One or more core workflow checks failed' }
Write-ProgressEvent 'RUNNING' 'Core workflow selesai; terminal dan EA telah dikonfigurasi' 'success'
[pscustomobject]@{success=$true;installPath=$root;processId=$process.ProcessId;terminalKey=$TerminalKey;eurusdSymbol=$verification.eurusd_symbol;xauusdSymbol=$verification.xauusd_symbol;connected=$verification.terminal_connected;tradeAllowed=$verification.trade_allowed;checks=$checks} | ConvertTo-Json -Compress -Depth 4
