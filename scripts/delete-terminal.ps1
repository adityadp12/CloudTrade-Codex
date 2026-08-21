param(
  [Parameter(Mandatory = $true)][string]$TerminalKey,
  [Parameter(Mandatory = $true)][string]$TenantRoot
)
$ErrorActionPreference = 'Stop'
$allowedRoot = [IO.Path]::GetFullPath($TenantRoot).TrimEnd('\') + '\'
$target = [IO.Path]::GetFullPath((Join-Path $TenantRoot $TerminalKey))
if (-not $target.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Unsafe terminal deletion target'
}
if ([IO.Path]::GetFileName($target) -ne $TerminalKey) {
  throw 'Terminal deletion target mismatch'
}
$terminalExe = Join-Path $target 'terminal64.exe'
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'terminal64.exe' -and $_.ExecutablePath -eq $terminalExe) -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*provision-terminal.ps1*' -and $_.CommandLine -like "*$TerminalKey*")
}
$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
[pscustomobject]@{ deleted = $true; path = $target; stoppedProcesses = @($processes).Count } | ConvertTo-Json -Compress
