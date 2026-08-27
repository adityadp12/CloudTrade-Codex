$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'caddy.exe' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
