param(
  [ValidateSet("dry-run", "execute")]
  [string]$Mode = "dry-run"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nightScript = Join-Path $PSScriptRoot "run-nightly.ps1"
$morningScript = Join-Path $PSScriptRoot "run-morning.ps1"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew

$nightAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$nightScript`" -Mode $Mode" -WorkingDirectory $repoRoot
$nightTrigger = New-ScheduledTaskTrigger -Daily -At "19:00"
Register-ScheduledTask -TaskName "OpenButler-Nightly-Delivery" -Action $nightAction -Trigger $nightTrigger -Principal $principal -Settings $settings -Description "OpenButler nightly delivery controller ($Mode)" -Force | Out-Null

$morningAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$morningScript`"" -WorkingDirectory $repoRoot
$morningTrigger = New-ScheduledTaskTrigger -Daily -At "08:00"
Register-ScheduledTask -TaskName "OpenButler-Morning-Acceptance" -Action $morningAction -Trigger $morningTrigger -Principal $principal -Settings $settings -Description "Prepare and open the OpenButler morning acceptance pack" -Force | Out-Null

Get-ScheduledTask -TaskName "OpenButler-Nightly-Delivery", "OpenButler-Morning-Acceptance" |
  Select-Object TaskName, State, Description
