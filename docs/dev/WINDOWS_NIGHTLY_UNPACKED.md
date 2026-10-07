# Supervised Windows Nightly program replacement

This is one unpacked-only Windows x64 variant for a supervised, reversible
program-directory replacement. It is not an installer, registered upgrade,
Stable release, or public GA claim. Existing Stable, Preview, Trial and RC
entry points retain their behavior. Do not run their installers, uninstallers,
image-name cleanup scripts, or the Nightly controller for this route.

## Fixed identity and fresh history

- Product/executable: `OpenButler Nightly Windows` / `OpenButler Nightly Windows.exe`
- App id: `moe.giftia.openbutler.nightly.windows`
- Metadata: `openbutlerVariant=windows-nightly-unpacked-v1`, `openbutlerChannel=preview`
- Profile: `%APPDATA%\OpenButler Nightly Windows Fresh`
- Backend data: that profile's `data` directory
- Backend image: `resources\backend\openbutler-backend-windows-nightly.exe`

Main validates the full identity, source commit/tree metadata, packaged state
and Windows x64 platform, then selects the profile before the single-instance
lock and application data I/O. An incomplete/conflicting Nightly identity,
any launch argument, or inherited `OPENBUTLER_*`/`MINECONTEXT_*` setting fails
closed. The sole allowed setting is `OPENBUTLER_STARTUP_DIAGNOSTICS=1`, which
emits existing fixed lifecycle codes. No custom profile, smoke-file, CDP flag,
channel switch, import, migration, or old-history fallback is supported for
this variant. Existing controlled test overrides remain available only in
the older variants. Nightly tests mock Electron's appData root instead.

Before first use, the supervising Windows operator must verify that the fixed
profile does not exist and its parent has no reparse/path ambiguity. Stop if
it exists; do not empty, reuse, or rename personal data to make the test pass.
The app does not inspect or discover old profiles. Every old profile remains
untouched, and its history is not displayed in this fresh Nightly profile.
Subsequent launches reuse only this new profile.

Nightly retains Preview built-in composition and the current RC capability
cuts. Fresh startup is strict, with no seed events, configured model, selected
source, automatic capture, or import. Full desktop, natural chat, conversation
goal adoption and goal automation remain unavailable. Missing own packaged
backend is a startup failure, with no Python/development fallback. Existing
owned-child shutdown semantics remain in effect.

## Close and minimize

For this Nightly only, title-bar Close or Alt+F4 stops local recording and uses
the existing quit flow to stop its owned backend before exiting. Repeated Close
requests keep the window visible while the same shutdown is pending. If the
owned process-tree stop fails or its child exit is unconfirmed, the window stays
open with an error, and the existing stop guard blocks normal exit and backend
replacement. A timed-out capture-pause acknowledgment still follows the existing
bounded shutdown path; successful process exit alone does not prove a persisted
pause. Minimize still hides to the tray and does not stop recording. Stable,
Preview, Trial and RC retain their existing close-to-hide behavior.

## Build after review

Use a reviewed clean checkout and its locked dependencies on Windows x64,
with existing x64 Python/PyInstaller and Visual Studio C++ tooling. This entry
installs no toolchain and never updates package versions or lockfiles. The
output parent must already exist, be a plain directory, and be outside the
source checkout. The output itself must not exist. For example, from `desktop`:

```powershell
npm run pack:nightly -- --output=C:\OpenButlerBuilds\nightly-20261007-1 --version=0.2.0-nightly.20261007.1
```

It builds fresh frontend assets with desktop/Preview flags, a fresh x64 WGC
helper, a backend using `PyInstaller --clean` into its own dist/work paths,
and both installed offline OCR languages. It verifies x64 PE headers before
packaging and in the resulting Electron/backend/helper payloads. The standalone
builder config sets `extends:null`, contains no NSIS configuration, and runs
only `electron-builder --win --dir --x64 --publish never`. The helper is copied as a separate resource after ASAR creation to
`app.asar.unpacked/src/windows-public-window.exe`, the provider's existing
physical path; no external file-set is inserted into the ASAR. The existing
`asarUnpack` patterns remain, and the packaged helper SHA256 must match the
fresh compiled helper. The backend resource uses the Nightly image name. A source change during the build fails
the result instead of publishing successful provenance.

Output contains `packaged\win-unpacked`, isolated `inputs`/`work`, the exact
builder config, and `build-provenance.json` (version, source commit/tree and
architecture). Failed attempts retain their output for inspection; retry with
a new directory. Do not copy a stale backend or frontend into a failed build.

## Validation and Windows gates

Synthetic checks, also included in the existing Desktop Contract CI job:

```text
node desktop/scripts/check-local-session-main.cjs
node --test desktop/scripts/check-nightly-unpacked.test.mjs
```

The VM tests prove profile-before-lock/I/O ordering, owned backend data path,
strict/built-in settings, no implicit capture/model call, rejected overrides,
missing-backend failure, close/repeated-close shutdown and failed-stop window
preservation, unchanged minimize behavior, and old-variant compatibility.
Builder mocks test fresh inputs, x64-only output, failure propagation and
changed-source rejection; they do not prove Windows compiler or Electron
packaging execution.

Before any program swap, independently verify the built ASAR metadata, all
resource identities/hashes, offline OCR and helper placement, and the ordinary
no-argument startup path. On Windows verify visible UI readiness, owned backend
health, strict mode, zero configured models/sources/history, paused capability
state, and confirmed owned shutdown. Do not use legacy smoke scripts, start
capture, call models, or read old data for these checks. Preserve the complete
old program directory and existing profiles, perform the parent-supervised
program-only swap/rollback, and retain the synthetic new profile separately.
A restored old program must not be launched against old data as a rollback
smoke. This source change supplies no swap, migration or installer tooling.
