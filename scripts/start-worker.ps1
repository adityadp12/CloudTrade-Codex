$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$workerEntry = Join-Path $projectRoot 'src\worker.js'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$lockName = 'Local\TradeCloudWorkerStart-' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($projectRoot)).Replace('/', '_').Replace('\', '_')
$mutex = New-Object Threading.Mutex($false, $lockName)
$locked = $false
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { exit 0 }
    $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($workerEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    if ($existing) { Write-Output 'TradeCloud worker is already running.'; exit 0 }
    $logDirectory = Join-Path $projectRoot '.runtime'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Start-Process -FilePath $node -ArgumentList ('"{0}"' -f $workerEntry) -WorkingDirectory $projectRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'worker-autostart.stdout.log') `
        -RedirectStandardError (Join-Path $logDirectory 'worker-autostart.stderr.log') | Out-Null
    Write-Output 'TradeCloud worker started.'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
