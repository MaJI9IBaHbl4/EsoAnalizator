# Registers (or re-registers) the Windows scheduled task that collects the ESO
# snapshot every 15 minutes. Run it once, from an ordinary PowerShell window:
#
#   powershell -ExecutionPolicy Bypass -File collector\install-task.ps1
#
# Remove it again with:
#
#   powershell -ExecutionPolicy Bypass -File collector\install-task.ps1 -Uninstall

[CmdletBinding()]
param(
    [string]$TaskName = 'ESO analizatorius - collect',
    # The source recomputes its counters every five minutes; see README.
    [int]$IntervalMinutes = 5,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Задача «$TaskName» удалена."
    return
}

$launcher = Join-Path $PSScriptRoot 'run_hidden.vbs'
if (-not (Test-Path $launcher)) { throw "не найден $launcher" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $launcher)

# -Once plus a repetition interval is how you get a sub-hourly schedule that
# also survives a reboot. RepetitionDuration is left unset on purpose: an empty
# duration means "repeat indefinitely", while [TimeSpan]::MaxValue serialises
# to P99999999DT23H59M59S, which the task scheduler rejects as out of range.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2)

# Interactive logon on purpose: the push reuses the Git credentials stored in
# this user's profile, which a service account would not be able to read.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'Снимает статистику отключений ESO и коммитит её в репозиторий EsoAnalizator.' | Out-Null

Write-Host "Задача «$TaskName» зарегистрирована: каждые $IntervalMinutes мин."
Write-Host "Первый запуск — через минуту. Лог: $(Join-Path $PSScriptRoot 'run.log')"
Write-Host "Запустить прямо сейчас:  Start-ScheduledTask -TaskName '$TaskName'"
