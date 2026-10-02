# Dedicated public-window capture

This is a separate, explicitly selected source scope (`dedicated_public_window`),
implemented by the OpenButler desktop product. Linux uses X11; the Windows
development provider uses `CreateForWindow(HWND)` with `hwnd:` identities and
`windows_wgc_hwnd` provenance. Neither provider falls back to screen capture.
The generic provider contract and whole-desktop privacy gates are unchanged.
Linux lock state remains **unknown**, with lock protection unsupported.

### Windows development validation

Build the native helper from the installed Microsoft C++/WinRT SDK using
`powershell.exe -NoProfile -File desktop/scripts/build-windows-public-window.ps1`.
The build does not install software or alter OS permissions. The Preview build
compiles and unpacks this helper alongside the desktop shell. A missing helper,
unsupported WGC device, unavailable event guard or unknown/locked input desktop
disables capture. Selected windows are bound to HWND, PID, process creation
FILETIME, executable basename, exact class/title and DWM physical frame bounds.
Metadata enumeration takes no thumbnails. Unknown, cloaked, minimized, layered,
transparent, negative-position or oversized windows are not offered; the current
raw pipe limit supports at most two million window pixels.

WGC reads only that window's surface. Frame dimensions must match the bound
window, and only `ContentSize` is copied from the surface; transparent corner RGB
is cleared. A per-monitor V2 DPI context avoids logical/physical coordinate
mixups. Frame QPC timestamps must be nonfuture and at most eight seconds old.
Window destroy/hide/name/location events permanently revoke the binding,
including a title change followed by restoration. Required WTS session events,
power suspend and fail-closed input-desktop polling revoke capture. The helper
and controller recheck identity before/after acquisition, after local OCR and
before submission. No automatic rebind or resume exists.

Run `node --test desktop/scripts/check-windows-public-window.cjs`,
`node desktop/scripts/check-windows-native-revocation.cjs` and
`node desktop/scripts/check-windows-native-public-window.cjs` for synthetic
contract tests and real self-created public-window capture/masking/offline OCR.
Then run `PYTHONPATH=backend python desktop/scripts/check-windows-timeline.py`.
Only the timeline validation model is mocked; no endpoint/model is downloaded
or called. Native title, movement, resize, transient-title and closing tests are
separate from injected PID-reuse/lock/timeout cases. Actual OS lock/unlock and
real PID/HWND reuse are not claimed as accepted. This isolated development trial
is not a production Windows security or model-understanding acceptance.

For an independent Windows Trial installer, set
`OPENBUTLER_PREVIEW_ISOLATED_TRIAL=1` when building the Preview. Its app identity,
backend executable, default user-data directory and shortcuts are separate from
the ordinary Preview and stable channels. Installation is limited to the
current user's `Programs/OpenButlerWindowsTrial` directory. The NSIS startup
guard rejects a conflicting destination or cached Trial uninstall target before
the installation section can uninstall or extract files. This path guard is
not an uninstall-lifecycle acceptance.

The installed-component checks accept `OPENBUTLER_TRIAL_INSTALL_DIR`, defaulting
to the current user's Trial installation. They create fresh workspace-owned
profiles, use public generated fixtures and explicitly label local HTTP mock
model output. The component test opens evidence over the authenticated API;
the UI test validates rendered startup and app-owned exit separately. These
checks do not prove a user-clicked end-to-end flow or real model quality. The
existing backend summary boundary still conservatively reports unsupported
lock protection; native Windows capabilities and provenance report the actual
guard contract separately.

## User flow

1. Open a dedicated window containing only material approved for public use.
2. Select that window in OpenButler, confirm the public-only restriction, and
   inspect its locally masked preview.
3. Explicitly start a bounded session (30–3600 seconds, 10/30/60-second samples).
4. Stop from OpenButler. Source loss, title/document change, geometry change,
   observed excluded/unknown foreground, privacy-processing failure, a received lock or
   suspend event, or expiry stops the session and consumes the preview.

There is no automatic start or restart. An app/service restart never restores a
session. Opening another document or toggling the dirty marker changes the exact
title and requires a new preview. This implementation does not claim exhaustive
activity recording, perfect PII detection, or desktop-wide exclusion protection.

## Acquisition and evidence boundary

`desktop/src/x11-public-window.py` keeps one X11 connection alive. Selection is
bound to XID, PID, process start time, process executable name, WM_CLASS, exact
window title, and client content bounds. Metadata is checked before and after
capture, again after local OCR, and immediately before submission. X11 events
invalidate destroyed/unmapped/reparented/resized sources and identity-property
changes, preventing a recycled XID or transient title change from being reused.

The only image read is `XGetImage` from a pinned
`XCompositeNameWindowPixmap` for the selected opaque, visible 24-bit client.
There is no root drawable read, screen cropping, desktop thumbnail, alternate
window lookup, global compositor setting, or screen-image fallback. An explicit
preview prepares only that client with `XCompositeRedirectWindow(Automatic)`.
Before any pixel read, it initializes the whole named pixmap to black with an
unclipped, full-plane `GXcopy`, verifies `XSync`, and sends only that client's
Expose repaint request. It does not use `XClearArea` or read the initial backing:
X.Org can initialize a new backing from the parent drawable. This may briefly
blacken the approved public window; it does not edit the document or its file.

The same cleared pixmap handle remains pinned throughout the bounded preview and
session. Frames never acquire a replacement backing after remapping/resizing.
The helper releases its own handle and Automatic redirect on stop, failure or
exit; closing its X connection also removes its per-client resources. A preview
has a five-minute cleanup deadline from request start, including OCR time. Black
or textless frames fail closed; nonempty OCR is not proof of complete repaint,
so the initial masked preview remains a deliberate user review step.

Pixmap dimensions must exactly equal the bound client dimensions. Known nonexcluded foreground windows
may differ from the source; their pixels are never acquired.

Raw PNG bytes travel in a private child-process pipe to local offline Tesseract
OCR and the existing masking function. No raw file or raw network upload is
created. Only the masked frame and, in the explicitly selected OCR-text mode,
fresh post-mask OCR text reach the authenticated loopback observations API.
Pre-mask OCR text is never submitted. Buffer clearing is best effort within managed
runtime/PIL/Tesseract copies, not a guarantee against OS swap, crash dumps, or
runtime memory inspection. No claim of perfect secret recognition is made.

The backend checks a per-session server-generated consent revision, source
revision, complete source identity, source scope, acquisition timestamp, expiry,
sampling sequence/gap and native capture method. Masked evidence retains the
existing seven-day retention policy. Samples are not continuous video.

## Explicit public text-document observation mode

The public-window setup defaults to `observation_mode: "vision"`. Users may
explicitly choose `masked_ocr_text` for a dedicated public text-document window.
The mode is part of the preview fingerprint, configured consent and every
observation. Changing mode or source clears the preview and approval, cancels its
native preview lease, and serializes that cancellation before another preview.
A failed cancellation receipt blocks replacement capture. There is no automatic
fallback between routes and no OCR-text option for full-screen capture.

For OCR-text mode, each frame runs first-pass local OCR for privacy masking,
applies automatic and fixed masks, then runs local Tesseract again on the final
masked PNG. Only the second pass is used as text evidence. The PNG SHA-256 is
checked before and after the second pass and binds that text to the exact stored
image. The ingest payload repeats `observation_mode: "masked_ocr_text"` and adds
`post_mask_ocr_complete: true`, `post_mask_ocr_engine: "tesseract.js"`,
`post_mask_ocr_text` (complete second-pass text), and
`post_mask_ocr_image_digest` (64-character SHA-256). Vision omits all four OCR
fields. Source identity, lock-state limitations and frame verification remain
unchanged. Cancellation is checked after every asynchronous processing step;
late OCR cannot respawn a helper, produce a preview or post an observation.

Empty text, OCR errors, control characters, more than 2000 Unicode code points,
more than 6000 UTF-8 bytes, or changed image bytes fail closed with an explicit
message. Text is never silently truncated. The backend applies a stricter final
prompt bound and may retain the observation as `prompt_limit_exceeded` without
calling a model. The UI labels this route as post-mask OCR into the text model,
shows second-pass text during preview, and states that it provides no visual or
layout understanding. Screenshot evidence remains a real masked capture;
model titles and summaries remain inferences from imperfect OCR.

Synthetic regression commands (no real capture or model calls):

    node desktop/scripts/check-public-window.cjs
    node frontend/scripts/check-public-window-dom.cjs
    npm --prefix frontend run build

## Runtime and verification

From the actual native desktop terminal:

    sh desktop/scripts/launch-public-window-preview.sh

The launcher requires the inherited desktop session, the local project Python
environment and a workspace-owned official Electron 31.7.7 binary. It never sets
DISPLAY, disables the Chromium sandbox or installs a service. Electron 31.7.7 is
the repository's pinned preview dependency and is end-of-support; this isolated
local trial is not a production-security release.

Official archive SHA256:
`00a2e8e5f52fe39c37cfc9d7bd7629e560017d28ee94c51495bf7e39c84b2d47`.

Focused tests:

    node --test desktop/scripts/check-public-window.cjs desktop/scripts/check-capture-controller.cjs desktop/scripts/check-local-session-main.cjs

These tests prove fail-closed control flow and mock/native call restrictions.
They do not replace real native-window isolation, OCR, source-loss and final
timeline verification. Those must be reported separately from unit tests.

Protocol reference: the X.Org Composite `NameWindowPixmap` request associates a
pixmap with a selected window's off-screen storage. Remapping/resizing allocates
a different backing, while the old named handle remains valid until freed. The
implementation deliberately rejects loss and never silently replaces its cleared
handle with a newly initialized source.

https://sources.debian.org/src/xorgproto/2018.4-4/compositeproto.txt

Initialization implementation reviewed:
https://sources.debian.org/data/main/x/xorg-server/2%3A21.1.7-3%2Bdeb12u12/composite/compalloc.c

## Current-frame observation and separate temporal association

The timeline recognizes the version-2 extraction contract through
`extraction_version: 2` and `current_facts`. It displays title and summary from
that immutable current-frame object, retaining its original observation and
owned evidence IDs. A version-2 row with no current extraction never falls back
to an old compatibility summary. `ready` is displayed as processing completed,
unverified; document statements and model summaries are not verified actions.

`temporal_context.association_state` is presented independently as skipped,
pending, running, ready or failed. Failed association does not replace the
current observation or display rejected relation output. Accepted relations
show their selected prior IDs, current/prior quoted summary substrings and
same-topic/different-topic/uncertain inference labels. Quote matching is not
proof of semantic truth. Selected/omitted counts remain visible. Unknown
failure codes use a bounded generic message rather than raw provider errors.

Missing or version-1 extraction markers retain an explicit legacy label: those
summaries may mix history and are not retroactively described as corrected or
current-only. No automatic reprocessing or capture behavior is added by this UI.

Synthetic presentation check and native build commands:

    node frontend/scripts/check-observation-analysis-dom.cjs
    node frontend/scripts/check-public-window-dom.cjs
    node frontend/scripts/check-phase1-ui.cjs
    node desktop/scripts/build-frontend-for-desktop.mjs
    node desktop/scripts/check-desktop-frontend-assets.mjs

Use the desktop build script for native trials: a generic Vite build may emit
absolute `/assets` paths that do not load under Electron `loadFile`.
