# Preview phase 1: explicit review, model setup, and visual masks

Baseline: `db3aa40a7bb678657e5f69f27bba16b01ead9361`.

This phase changes three user-facing flows. It does not add background chat,
reminders, automatic recording, new personal-data sources, native platform
capture adapters, publishing, or installer production.

## Daily review

`POST /api/context-engine/daily-review` is authenticated by the existing local
session boundary and admitted as one explicit POST by the desktop API bridge.

Example request body:

```json
{"day":"2026-10-02","timezone":"Asia/Shanghai","confirmed":true}
```

The UI calls this only after the user clicks Generate. It does not run on page
mount, polling, navigation, or model configuration. Changing date, timezone,
record metadata, or authorization invalidates the displayed ephemeral result.

The response contains:

- `status`: `ready`, `empty`, or `unavailable`, with a content-free reason
- `counts`: total, ready, pending, failed, expired/missing evidence, invalid
  rows, eligible, included, and omitted records
- `coverage`: requested local-day UTC boundaries, evaluated-until time, first
  and last observation timestamps, observation count, and snapshot gaps
- `conclusions`: text with backend-resolved observation/evidence IDs and times
- `truncated` and a fixed evidence-boundary explanation

Counts describe the selected owned-record snapshot. Evidence/invalid counts
can overlap state counts. Pending includes both waiting and processing. Coverage
uses valid nonfuture observation timestamps; conclusions use only ready rows
with unexpired, present, owned evidence. A gap of at least 15 minutes is an
interval without observation points, not proof of inactivity. First/last times
never imply continuous activity or hours worked.

Only existing title/summary/boundary text enters the configured text gateway.
No image bytes, raw paths, old MineContext data, or unrelated sources enter the
review request. A maximum 10,000-character prompt selects a disclosed spread
of eligible records across the day. Omitted records are counted. Empty/unusable
days do not call the model. Output is strict bounded JSON; unknown, unsent,
duplicate, malformed, or reasoning-tagged references/results are rejected.

Evidence metadata and authorization are checked before dispatch and publication.
Expiry, deletion, changed evidence, revoked consent, changed privacy mode, or
superseded model routes cause the result to be discarded. The response is not
stored in a new table. Reopening an evidence panel fetches it again; missing or
expired evidence is shown explicitly.

## Privacy and model configuration

The model-settings section is always visible and focusable. It distinguishes
unconfigured, saved but needing validation, ready, and unavailable. Restoration
is read-only. Validating saved settings is explicit and reuses the existing
encrypted desktop key store; keys never return to the renderer. Editing a
recipient or protocol clears consent and typed credentials.

A main-process single-flight gate prevents simultaneous saves across renderer
remounts. A session-only uncertainty flag survives remounts when transport or
encrypted persistence fails after dispatch. It clears only after validation and
encrypted write/rename succeed. The UI does not claim that old active settings
were preserved when the result is uncertain. The on-disk format is unchanged.

Active model dispatch and committed privacy-mode changes share a reentrant
lock. Runtime calls recheck the current mode under that lock; stale basic-mode
authorization cannot bypass a newly committed strict mode. Daily reviews also
check the expected route revision inside dispatch, before selecting a recipient.
Model-setting transactions serialize synthetic probes, publication, and their
explicit privacy-mode change. Synthetic endpoint probes preserve their existing
explicit-consent behavior.

A mode change may wait for an already-dispatched request to finish or time out.
Already-sent requests cannot be recalled. The transport's 10-second socket I/O
timeout is not represented as a guaranteed end-to-end deadline. Nothing using
the old policy may start after the new policy commits.

## Visual masks

The editor draws, resizes, deletes, and numerically adjusts rectangles in the
natural pixel coordinates of an already-masked PNG. It supports keyboard
movement/deletion and clamps bounds. It never displays a raw capture.

Starting a gesture or editing any scope invalidates approval immediately. A
same-display old masked image may remain as a clearly labeled editing-only
canvas; deleting/shrinking a rectangle does not reveal pixels beneath it. A
fresh, successfully loaded privacy preview and explicit checkbox are required
before recording. Changing displays clears the canvas. Revision/session guards
reject late preview/start results, repeated starts, and results after dismissal.

## Verification commands

Install the pinned backend requirements (including timezone data for Windows),
then from the repository root:

```sh
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/context_engine/tests
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/model_gateway/tests
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/butler_core/tests
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/pc_activity_context/tests
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/workstation_vision/tests
```

From `frontend`, run `npm ci`, then `npm run build`, `npm run test:local-proxy`,
`npm run test:phase1-ui`, `npm run test:preview-model-settings`,
`npm run test:mask-editor`, and `npm run test:mask-editor-dom`. JSDOM checks are
functional component tests, not rendered browser or native-app acceptance.

From `desktop`, install lockfile dependencies with `npm ci --ignore-scripts`
for mocked tests, then run `check-local-session.cjs`,
`check-local-session-main.cjs`, `check-model-routes-persistence.cjs`, and
`check-capture-controller.cjs` under `scripts/` with Node.

## Platform acceptance boundary

Windows is the existing desktop packaging path. The cloud Linux run verifies
backend, frontend build, synthetic OCR, component behavior, and local HTTP
protocols. It does not establish native Windows/macOS/Linux screen, permission,
lock/sleep, secret-store, installer, or uninstaller acceptance.

First native targets remain Windows, macOS arm64, and Debian/Ubuntu X11. Wayland
and Mac Intel need separate later acceptance. Non-Windows foreground/visible-app
adapters are still absent and capture must keep refusing unknown scope. Linux
secret storage must reject `basic_text` before native support is advertised.

The current cloud browser rejects localhost navigation. No browser bypass,
alternate network exposure, rendered-UI success claim, or screenshot substitute
is part of this phase's verification. Native rendered UI remains an open
acceptance item.
