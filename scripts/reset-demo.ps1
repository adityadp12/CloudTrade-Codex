$ErrorActionPreference = 'Stop'
$tenantRoot = [IO.Path]::GetFullPath('D:\SaaS\tenants').TrimEnd('\') + '\'
$targets = @(Get-ChildItem -LiteralPath 'D:\SaaS\tenants' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^ct-[a-f0-9-]{36}$' } |
  ForEach-Object { [IO.Path]::GetFullPath($_.FullName) })
foreach ($target in $targets) {
  if (-not $target.StartsWith($tenantRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe tenant target' }
}

Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($tenantRoot, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

$yaml = Get-Content 'D:\Project\AI-Landing-Page-Studio\apps\api\src\main\resources\application.yml' -Raw
function Resolve-SpringValue([string]$value) {
  $value = $value.Trim().Trim('"').Trim("'")
  $placeholder = [regex]::Match($value, '^\$\{[^:}]+:(.*)\}$')
  if ($placeholder.Success) { return $placeholder.Groups[1].Value }
  return $value
}
$dbUser = Resolve-SpringValue ([regex]::Match($yaml, '(?m)^\s*username:\s*([^\r\n#]+)').Groups[1].Value)
$dbPassword = Resolve-SpringValue ([regex]::Match($yaml, '(?m)^\s*password:\s*([^\r\n#]+)').Groups[1].Value)
$env:PGPASSWORD = $dbPassword
& 'D:\tools\pgsql\bin\psql.exe' -h 127.0.0.1 -p 5435 -U $dbUser -d cloudtrade -v ON_ERROR_STOP=1 -c "DELETE FROM terminals WHERE user_id=(SELECT id FROM users WHERE email='demo@cloudtrade.local')" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Database reset failed' }

foreach ($target in $targets) {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
[pscustomobject]@{ deletedTenantFolders=$targets.Count } | ConvertTo-Json -Compress
