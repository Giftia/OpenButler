param([ValidateSet('Install', 'Uninstall')][string]$Lifecycle = 'Install',
      [ValidateSet('Trial', 'RC')][string]$Product = 'Trial')
$ErrorActionPreference = 'Stop'
try {
  $trialRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ("Programs\OpenButlerWindows" + $Product)))
  # Never dispatch an existing uninstaller whose lifecycle has not been verified.
  if ($Lifecycle -eq 'Install' -and (Test-Path -LiteralPath (Join-Path $trialRoot ("Uninstall OpenButler Preview Windows " + $Product + '.exe')))) { exit 22 }
  $images = @("OpenButler Preview Windows $Product.exe", "openbutler-backend-windows-$($Product.ToLowerInvariant()).exe")
  $processes = @(Get-CimInstance Win32_Process -Filter ("Name='" + $images[0] + "' OR Name='" + $images[1] + "'"))
  foreach ($process in $processes) {
    if ($images -notcontains $process.Name -or -not $process.ExecutablePath) { exit 21 }
    $executable = [IO.Path]::GetFullPath($process.ExecutablePath)
    if ($executable.StartsWith($trialRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { exit 20 }
    if ($Product -eq 'RC') { exit 21 } # A portable/custom RC may share the RC data directory.
  }
  exit 0
} catch {
  exit 21
}
