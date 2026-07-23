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
$cutoffFlag = Join-Path $repoRoot "data\nightly\control\stop-new-issues.flag"
Remove-Item -LiteralPath $cutoffFlag -Force -ErrorAction SilentlyContinue
if ($Mode -eq "execute") {
  $env:OPENBUTLER_ENABLE_REAL_DATA_NIGHTLY = "1"
}

Push-Location $repoRoot
try {
  & node (Join-Path $PSScriptRoot "nightly-controller.mjs") "--mode=$Mode" *>&1 |
    Tee-Object -FilePath $logPath
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
