param(
  [ValidateSet("dry-run", "execute")]
  [string]$Mode = "dry-run"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nightScript = Join-Path $PSScriptRoot "run-nightly.ps1"
$cutoffScript = Join-Path $PSScriptRoot "run-cutoff.ps1"
$finalizeScript = Join-Path $PSScriptRoot "run-finalize.ps1"
$morningScript = Join-Path $PSScriptRoot "run-morning.ps1"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12 -Minutes 15) -MultipleInstances IgnoreNew

$nightAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$nightScript`" -Mode $Mode" -WorkingDirectory $repoRoot
$nightTrigger = New-ScheduledTaskTrigger -Daily -At "20:00"
Register-ScheduledTask -TaskName "OpenButler-Nightly-Delivery" -Action $nightAction -Trigger $nightTrigger -Principal $principal -Settings $settings -Description "OpenButler nightly delivery controller ($Mode)" -Force | Out-Null

$cutoffAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$cutoffScript`"" -WorkingDirectory $repoRoot
$cutoffTrigger = New-ScheduledTaskTrigger -Daily -At "07:15"
Register-ScheduledTask -TaskName "OpenButler-Nightly-Cutoff" -Action $cutoffAction -Trigger $cutoffTrigger -Principal $principal -Settings $settings -Description "Stop claiming new OpenButler Issues" -Force | Out-Null

$finalizeAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$finalizeScript`"" -WorkingDirectory $repoRoot
$finalizeTrigger = New-ScheduledTaskTrigger -Daily -At "08:20"
Register-ScheduledTask -TaskName "OpenButler-Nightly-Finalize" -Action $finalizeAction -Trigger $finalizeTrigger -Principal $principal -Settings $settings -Description "Finalize Nightly evidence, merge eligible PRs, and clean processes" -Force | Out-Null

$morningAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$morningScript`"" -WorkingDirectory $repoRoot
$morningTrigger = New-ScheduledTaskTrigger -Daily -At "08:30"
Register-ScheduledTask -TaskName "OpenButler-Morning-Report" -Action $morningAction -Trigger $morningTrigger -Principal $principal -Settings $settings -Description "Prepare the redacted OpenButler morning report" -Force | Out-Null

Unregister-ScheduledTask -TaskName "OpenButler-Morning-Acceptance" -Confirm:$false -ErrorAction SilentlyContinue

Get-ScheduledTask -TaskName "OpenButler-Nightly-Delivery", "OpenButler-Nightly-Cutoff", "OpenButler-Nightly-Finalize", "OpenButler-Morning-Report" |
  Select-Object TaskName, State, Description
