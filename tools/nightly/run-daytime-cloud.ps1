param(
  [ValidateSet("dry-run", "execute")]
  [string]$Mode = "dry-run"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logRoot = Join-Path $repoRoot "data\daytime-cloud\scheduler"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logRoot "daytime-cloud-$stamp.log"

Push-Location $repoRoot
try {
  & node (Join-Path $PSScriptRoot "daytime-cloud-controller.mjs") "--mode=$Mode" *>&1 |
    Tee-Object -FilePath $logPath -Encoding UTF8
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
