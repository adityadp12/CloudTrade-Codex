$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$configPath = 'D:\Project\AI-Landing-Page-Studio\apps\api\src\main\resources\application.yml'
$yaml = Get-Content -LiteralPath $configPath -Raw
function Resolve-SpringValue([string]$value) {
  $value = $value.Trim().Trim('"').Trim("'")
  $placeholder = [regex]::Match($value, '^\$\{[^:}]+:(.*)\}$')
  if ($placeholder.Success) { return $placeholder.Groups[1].Value }
  return $value
}
$user = Resolve-SpringValue ([regex]::Match($yaml, '(?m)^\s*username:\s*([^\r\n#]+)').Groups[1].Value)
$password = Resolve-SpringValue ([regex]::Match($yaml, '(?m)^\s*password:\s*([^\r\n#]+)').Groups[1].Value)
if (-not $user -or -not $password) { throw 'Local database configuration is unavailable' }
$env:DATABASE_URL = "postgresql://${user}:$([uri]::EscapeDataString($password))@127.0.0.1:5435/cloudtrade"

Set-Location -LiteralPath $project
& 'C:\Program Files\nodejs\node.exe' 'src\migrate.js'
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed' }

$existing = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src\\(server|worker)\.js' }
$existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'src\server.js' -WorkingDirectory $project -RedirectStandardOutput 'D:\logs\cloudtrade-api.log' -RedirectStandardError 'D:\logs\cloudtrade-api-error.log' -WindowStyle Hidden
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'src\worker.js' -WorkingDirectory $project -RedirectStandardOutput 'D:\logs\cloudtrade-worker.log' -RedirectStandardError 'D:\logs\cloudtrade-worker-error.log' -WindowStyle Hidden
