$ErrorActionPreference = 'Stop'
$caddy = 'D:\tools\caddy\caddy.exe'
$config = Join-Path (Split-Path $PSScriptRoot -Parent) 'deploy\Caddyfile'
$logDirectory = 'D:\logs'

if (-not (Test-Path -LiteralPath $caddy)) { throw "Caddy is unavailable at $caddy" }
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

& $caddy validate --config $config --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration is invalid' }

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'caddy.exe' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath $caddy `
  -ArgumentList @('run', '--config', $config, '--adapter', 'caddyfile') `
  -WorkingDirectory (Split-Path $config -Parent) `
  -RedirectStandardOutput (Join-Path $logDirectory 'caddy.log') `
  -RedirectStandardError (Join-Path $logDirectory 'caddy-error.log') `
  -WindowStyle Hidden
