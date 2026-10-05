Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenButlerForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@

$windowHandle = [OpenButlerForeground]::GetForegroundWindow()
if ($windowHandle -eq [IntPtr]::Zero) { exit 1 }
$processIdValue = [uint32]0
[void][OpenButlerForeground]::GetWindowThreadProcessId($windowHandle, [ref]$processIdValue)
if ($processIdValue -eq 0) { exit 1 }
$processInfo = Get-Process -Id $processIdValue -ErrorAction Stop
[Console]::WriteLine($processInfo.ProcessName)
