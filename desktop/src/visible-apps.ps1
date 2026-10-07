param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$Width,
  [Parameter(Mandatory=$true)][int]$Height
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OpenButlerVisibleApps {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    public static uint[] ProcessIds(int x, int y, int width, int height) {
        var ids = new HashSet<uint>();
        bool ok = EnumWindows((handle, state) => {
            if (!IsWindowVisible(handle) || IsIconic(handle)) return true;
            Rect rect;
            if (!GetWindowRect(handle, out rect)) return true;
            if (rect.Right <= x || rect.Left >= x + width || rect.Bottom <= y || rect.Top >= y + height) return true;
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            if (pid != 0) ids.Add(pid);
            return true;
        }, IntPtr.Zero);
        if (!ok) throw new InvalidOperationException("window_enumeration_failed");
        var result = new uint[ids.Count];
        ids.CopyTo(result);
        return result;
    }
}
'@

foreach ($id in [OpenButlerVisibleApps]::ProcessIds($X, $Y, $Width, $Height)) {
  $process = Get-Process -Id $id -ErrorAction Stop
  [Console]::WriteLine($process.ProcessName)
}
