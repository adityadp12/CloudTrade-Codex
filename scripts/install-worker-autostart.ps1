$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'start-worker.ps1'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'TradeCloud Provisioning Worker' -Action $action -Trigger @($logon, $watch) -Principal $principal -Settings $settings `
    -Description 'Starts the TradeCloud queue consumer at logon and checks every minute. Does not restart a running worker.' -Force | Out-Null
Start-ScheduledTask -TaskName 'TradeCloud Provisioning Worker'
Get-ScheduledTask -TaskName 'TradeCloud Provisioning Worker' | Select-Object TaskName, State
