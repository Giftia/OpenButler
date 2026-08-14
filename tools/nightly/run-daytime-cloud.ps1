param(
  [ValidateSet("dry-run", "execute")]
  [string]$Mode = "dry-run",
  [string]$Now = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logRoot = Join-Path $repoRoot "data\daytime-cloud\scheduler"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logRoot "daytime-cloud-$stamp.log"

Push-Location $repoRoot
try {
  $arguments = @((Join-Path $PSScriptRoot "daytime-cloud-controller.mjs"), "--mode=$Mode")
  if ($Mode -eq "dry-run" -and $Now) { $arguments += "--now=$Now" }
  & node @arguments *>&1 | ForEach-Object {
    $_ | Out-File -FilePath $logPath -Append -Encoding utf8
    Write-Output $_
  }
  $exitCode = $LASTEXITCODE
  exit $exitCode
}
finally {
  Pop-Location
}
