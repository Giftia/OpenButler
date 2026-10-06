$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Installed Visual Studio C++ toolchain required; no automatic installation.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Installed Visual Studio C++ toolchain required; no automatic installation.' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
New-Item -ItemType Directory -Path (Join-Path $desktopRoot '.tmp') -Force | Out-Null
Push-Location -LiteralPath $desktopRoot
try {
  # C++20 selects standard WinRT coroutines; VS2026 rejects the legacy experimental path.
  & cmd.exe /d /s /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++20 /EHsc /MT /DUNICODE /D_UNICODE src\windows-public-window.cpp /Fe:src\windows-public-window.exe /Fo:.tmp\windows-public-window.obj /link d3d11.lib windowsapp.lib user32.lib gdi32.lib dwmapi.lib wtsapi32.lib')
  if ($LASTEXITCODE -ne 0) { throw "Native helper compilation failed ($LASTEXITCODE)" }
} finally { Pop-Location }
