$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logRoot = Join-Path $repoRoot "data\nightly\scheduler"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logRoot "finalize-$stamp.log"

Push-Location $repoRoot
try {
  & node (Join-Path $PSScriptRoot "set-cutoff.mjs") *>&1 | Tee-Object -FilePath $logPath
  & node (Join-Path $PSScriptRoot "auto-merge-controller.mjs") *>&1 | Tee-Object -FilePath $logPath -Append
  & node (Join-Path $PSScriptRoot "cleanup-nightly.mjs") *>&1 | Tee-Object -FilePath $logPath -Append
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
