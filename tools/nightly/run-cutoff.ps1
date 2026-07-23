$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

Push-Location $repoRoot
try {
  & node (Join-Path $PSScriptRoot "set-cutoff.mjs")
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
