# Three-platform feasibility and acceptance gates

This is a read-only feasibility outcome, not a support claim or adapter
implementation. Initial targets: Windows, macOS arm64 (M1 Max first), and named
Debian/Ubuntu X11 environments. Wayland and Mac Intel are separate later gates.

## Current reality

- Shared backend, web build, offline OCR and synthetic privacy contracts run on
  Linux. Native capture has not been accepted by those tests.
- `desktop/src/main.cjs` uses PowerShell for foreground/visible applications.
  Non-Windows returns unknown and `capture-controller.cjs` refuses capture.
- Distribution is Windows-only: `.exe` resources, `cmd.exe`, and NSIS. The
  development `python3` fallback is not packaged Linux/macOS support.
- Electron lock-screen events cover Windows/macOS; Linux requires an explicit
  session-lock provider. Suspend alone does not prove the session is unlocked.

## Security blockers before real native acceptance

1. `captureSelectedDisplay` requests nonzero thumbnails for all screen sources
   before selecting one. Acquisition must be bound to the selected source;
   do not claim that only the selected screen was acquired today.
2. Application exclusion is checked before acquisition. A window may change
   between those operations. Missing geometry/PID entries, overlays and partial
   window enumeration must not count as proof that exclusion is complete.
3. Linux credential reads/writes must require an approved secret-store backend
   and reject `basic_text`/unknown. `isEncryptionAvailable()` alone is not an
   adequate platform-support gate.
4. Permission loss, lock/sleep, display change, process identity changes and
   incomplete visibility must invalidate preview/in-flight work and pause
   capture without automatically resuming it.

## Minimal interfaces for a later native phase

- Platform capabilities: OS, architecture, session, permission, exclusion
  completeness, lock observability, supported/blocked reason
- Capture context: selected-source identity, canonical app/window identities,
  freshness, display geometry and pixel-coordinate transform
- Capture adapter: source-bound acquisition with an exclusion policy/filter;
  no frame if safety evidence is stale or incomplete
- Session guard: initial lock/sleep state and change subscription; never infer
  unlocked from a missing signal
- Credential store: protected read/write and explicit unavailable status
- Backend runtime: platform/architecture-specific bundled executable and owned
  process lifecycle, with no production dependence on development Python

## Native matrix

| Target | Required acceptance |
| --- | --- |
| Windows | Source isolation; app exclusion including hosted/packaged apps and transient overlays; mixed DPI/negative monitor coordinates; lock/suspend; DPAPI failures; clean install/upgrade/uninstall with stable/preview isolation |
| macOS arm64 | Native arm64 binaries; screen permission grant/deny/revoke; canonical bundle/PID identities and source filters; Retina/external displays; lock/sleep; unavailable/locked Keychain |
| Debian/Ubuntu X11 | Named distro/desktop versions; real X11 detection; complete visibility contract; explicit session-lock provider; suspend; Secret Service success and basic_text rejection |
| Wayland | Deferred; clear disabled capability, no silent X11/full-screen fallback |
| Mac Intel | Deferred; distinct architecture artifact and native validation, not an arm64/Rosetta inference |

All initial targets additionally need offline English/Chinese and small-text
OCR fixtures, missing-asset failure, mask geometry, absence of raw-frame
persistence/network output, and explicit fresh preview after interruption.

## Primary references

- Electron 31.7.7 [safeStorage](https://raw.githubusercontent.com/electron/electron/v31.7.7/docs/api/safe-storage.md) and [desktopCapturer](https://raw.githubusercontent.com/electron/electron/v31.7.7/docs/api/desktop-capturer.md)
- [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) and [systemPreferences permissions](https://www.electronjs.org/docs/latest/api/system-preferences)
- Microsoft [EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows) and [GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)
- Apple [NSWorkspace foreground application](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication) and [ScreenCaptureKit application filters](https://developer.apple.com/videos/play/wwdc2022/10156/?time=341)
- [EWMH window-manager properties](https://specifications.freedesktop.org/wm/latest/ar01s03.html)
- [PyInstaller per-OS support](https://pyinstaller.org/en/stable/usage.html#supporting-multiple-operating-systems) and [macOS architectures](https://pyinstaller.org/en/stable/feature-notes.html#macos-multi-arch-support)

Latest documentation can describe APIs newer than the checkout's Electron 31
and electron-builder 24. Freeze and validate the chosen toolchain before native
implementation; no platform package was built or published during phase 1.
