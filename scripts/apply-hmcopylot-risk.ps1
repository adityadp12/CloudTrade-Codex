param(
  [Parameter(Mandatory=$true)][string]$TerminalKey,
  [Parameter(Mandatory=$true)][string]$TenantRoot,
  [Parameter(Mandatory=$true)][string]$PythonExe,
  [Parameter(Mandatory=$true)][double]$MaxLossUsd,
  [Parameter(Mandatory=$true)][ValidateRange(0.01,100)][double]$LotSize,
  [Parameter(Mandatory=$true)][int]$TrailingDistancePoints
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $TenantRoot $TerminalKey))
$allowedRoot = [IO.Path]::GetFullPath($TenantRoot).TrimEnd('\') + '\'
if (-not $root.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Terminal path escaped tenant root' }
$terminalExe = Join-Path $root 'terminal64.exe'
$chart = Join-Path $root 'MQL5\Profiles\Charts\Default\chart02.chr'
if (-not (Test-Path -LiteralPath $terminalExe) -or -not (Test-Path -LiteralPath $chart)) { throw 'HMCopyLot terminal configuration is unavailable' }
$processes = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminalExe }
$processes | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($p) { $null=$p.CloseMainWindow(); if (-not $p.WaitForExit(12000)) { Stop-Process -Id $_.ProcessId -Force } }
}
Start-Sleep -Seconds 2
$unicode = [Text.Encoding]::Unicode
$text = [IO.File]::ReadAllText($chart, $unicode)
if ($text -notmatch '(?m)^name=HMCopyLot\r?$') { throw 'HMCopyLot chart was not found' }
$loss = $MaxLossUsd.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
$lot = $LotSize.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
$text = if ($text -match '(?m)^InpMaxLoss=.*\r?$') { [regex]::Replace($text,'(?m)^InpMaxLoss=.*\r?$',"InpMaxLoss=$loss`r") } else { $text -replace '(?m)^<inputs>\r?$',"<inputs>`r`nInpMaxLoss=$loss" }
$text = if ($text -match '(?m)^InpLot=.*\r?$') { [regex]::Replace($text,'(?m)^InpLot=.*\r?$',"InpLot=$lot`r") } else { $text -replace '(?m)^<inputs>\r?$',"<inputs>`r`nInpLot=$lot" }
$text = if ($text -match '(?m)^InpTrailDist=.*\r?$') { [regex]::Replace($text,'(?m)^InpTrailDist=.*\r?$',"InpTrailDist=$TrailingDistancePoints`r") } else { $text -replace '(?m)^<inputs>\r?$',"<inputs>`r`nInpTrailDist=$TrailingDistancePoints" }
[IO.File]::WriteAllText($chart, $text, $unicode)
$env:CT_TERMINAL_EXE=$terminalExe
$lines=@(& $PythonExe (Join-Path $PSScriptRoot 'login-terminal.py'))
$exit=$LASTEXITCODE
$last=$lines|Select-Object -Last 1
try{$verification=$last|ConvertFrom-Json}catch{throw 'MT5 risk restart returned invalid response'}
if($exit -ne 0 -or -not $verification.account_matches -or -not $verification.server_matches -or -not $verification.terminal_connected){throw 'MT5 risk restart verification failed'}
$process=Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'"|Where-Object ExecutablePath -eq $terminalExe|Select-Object -First 1
[pscustomobject]@{success=$true;installPath=$root;processId=$process.ProcessId;maxLossUsd=$MaxLossUsd;lotSize=$LotSize;trailingDistancePoints=$TrailingDistancePoints}|ConvertTo-Json -Compress
