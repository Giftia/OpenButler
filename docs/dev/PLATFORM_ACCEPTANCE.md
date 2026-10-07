# Three-platform feasibility and acceptance gates

This is a read-only feasibility outcome, not a support claim or adapter
implementation. Initial targets: Windows, macOS arm64 (M1 Max first), and named
Debian/Ubuntu X11 environments. Wayland and Mac Intel are separate later gates.

## Current reality

- Shared backend, web build, offline OCR and synthetic privacy contracts run on
  Linux. Native capture has not been accepted by those tests.
- Full-desktop capture is unavailable on **all** platforms, including Windows.
  The UI and Electron capability report `full_desktop_unavailable`; screen
  enumeration, preview, start and acquisition are blocked. The backend rejects
  full-screen configure/start/ingest independently, including saved consent and
  direct requests. No flag or platform value enables this path.
- The separately authorized `dedicated_public_window` path remains available
  only through its existing provider/identity/preview/consent checks. There is no
  fallback between source scopes. Historical records and consent are preserved;
  an old full-screen consent cannot start or resume recording or authorize new
  observation processing/retry. Historical read-only review remains available.
- Distribution is Windows-only: `.exe` resources, `cmd.exe`, and NSIS. The
  development `python3` fallback is not packaged Linux/macOS support.
- Electron lock-screen events cover Windows/macOS; Linux requires an explicit
  session-lock provider. Suspend alone does not prove the session is unlocked.

## Security blockers before real native acceptance

1. The disabled legacy screen implementation requested nonzero thumbnails for
   all screen sources before selecting one. Any future implementation must bind
   acquisition to the selected source before pixels are read.
2. The disabled full-screen exclusion check ran before acquisition. A window may
   change between those operations. Missing geometry/PID entries, overlays and
   partial enumeration must not count as proof that exclusion is complete.
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

## Full-desktop fail-closed regression boundary

Synthetic checks (no real screen capture or model requests):

    node --test desktop/scripts/check-capture-controller.cjs desktop/scripts/check-local-session-main.cjs desktop/scripts/check-public-window.cjs desktop/scripts/check-windows-public-window.cjs
    PYTHONPATH=backend python -m unittest discover -s backend/app/modules/context_engine/tests
    npm --prefix frontend run test:mask-editor-dom
    node frontend/scripts/check-public-window-dom.cjs
    node frontend/scripts/check-capture-coverage-dom.cjs

The controller/main-process checks use forbidden dependency spies and stale
capability/preview/session inputs. API checks use synthetic temporary stores.
They establish that the disabled path is unreachable, not that full-desktop
acquisition or native exclusion safety has been fixed. Restoring support needs
a separate implementation, explicit review and the native acceptance matrix
above. The gate does not reprocess, migrate or erase existing evidence.

Backend contract: `POST /api/context-engine/capture/configure` with a
`full_screen` scope, `POST /api/context-engine/capture/start` against persisted
full-screen consent, and `POST /api/context-engine/observations` with full-screen
provenance return HTTP 403 with `detail: "full_desktop_unavailable"`. These checks
run before consent writes, image decoding or model dispatch. Retrying a legacy
full-screen observation returns `{ok: false, queued: false, reason:
"full_desktop_unavailable"}` without marking, reading or dispatching it. Active
processing requires both dedicated-window consent and dedicated-window source
provenance; historical read-only review is unchanged. The status endpoint adds `full_desktop_available: false`, `full_desktop_reason:
"full_desktop_unavailable"` and
`supported_capture_scopes: ["dedicated_public_window"]`. The last field describes
the backend's accepted source contract, not a claim that the current machine has
a working native provider; the desktop's separate public-window capability and
all existing source validation are still required.

The older manual `smoke:preview-builtin-capture` browser harness still assumes an
enabled full-screen UI and is not an acceptance command for this disabled
contract. It is not part of PR/development CI and has not been run for this gate.
Use the synthetic gate/public-window suites above; a future browser/native
acceptance pass must first update that historical harness to the supported scope.
