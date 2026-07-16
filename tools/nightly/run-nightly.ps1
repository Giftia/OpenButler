param(
  [ValidateSet("dry-run", "execute")]
  [string]$Mode = "dry-run"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logRoot = Join-Path $repoRoot "data\nightly\scheduler"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logRoot "nightly-$stamp.log"

Push-Location $repoRoot
try {
  & node (Join-Path $PSScriptRoot "nightly-controller.mjs") "--mode=$Mode" *>&1 |
    Tee-Object -FilePath $logPath
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
