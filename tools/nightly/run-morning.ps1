$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logRoot = Join-Path $repoRoot "data\nightly\scheduler"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logRoot "morning-$stamp.log"

Push-Location $repoRoot
try {
  & node (Join-Path $PSScriptRoot "morning-report.mjs") *>&1 | Tee-Object -FilePath $logPath
  $reportExitCode = $LASTEXITCODE
  if ($reportExitCode -ne 0) {
    exit $reportExitCode
  }
  $preview = Join-Path $env:LOCALAPPDATA "Programs\OpenButler Preview\OpenButler Preview.exe"
  if (Test-Path $preview) {
    Start-Process -FilePath $preview -WindowStyle Hidden
  }
  exit 0
}
finally {
  Pop-Location
}
