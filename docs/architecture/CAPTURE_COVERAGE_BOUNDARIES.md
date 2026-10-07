# Capture coverage boundaries

Owned screen observations are discrete samples, not a continuous activity log.
`sampling_sequence` and `sampling_gap_ms` remain local to the selected-window
consent session. A new session's `1` / `0` does **not** erase the pause before it.

## Durable control facts

The additive `context_capture_coverage` SQLite table stores metadata-only
`started`, `paused`, `revoked`, `reconfigured`, `stopped`, and `process_restarted`
events. These are control facts, not activity observations, model output, or
evidence images. They do not add to observation counts or feed model extraction.
Only opaque consent/session IDs, source kind, times and bounded stop reasons are
stored; native errors, window titles and image/OCR content are not copied here.

- `started` means an authorized sampling attempt started. `first_sample_at`
  remains null until a subsequent accepted sample, including an unchanged-image
  duplicate, has a chronologically consistent capture timestamp.
- Pause, revoke, source reconfiguration and acknowledged graceful backend stop
  have a known control boundary (`gap_start_known=true`). Repeated stop/start
  requests in the same state do not append duplicates.
- `gap_end_at` is the captured timestamp of the first later accepted sample.
  Starting a session or completing a model request does not close a gap.
  The endpoint means sampling was observed again, not continuous coverage.
  A failed attempt to restart leaves the earlier gap open; separate failed
  attempts can therefore have overlapping missing-coverage intervals.
- On startup, a persisted active flag produces `process_restarted` before it is
  reset to inactive. The actual shutdown time is unknown. `occurred_at` is the
  time recovery detected the interruption. `gap_started_at` is only the last
  accepted sample (including deduplicated samples), or the prior start if no
  sample was accepted. `gap_start_known=false` must remain visible. With no
  legacy anchor it is null. No crash time or exact shutdown-gap duration is
  invented. Orderly app Quit and service restart stop local capture immediately
  and wait up to one second for durable acknowledgment before termination.
  Crashes, timeout/failure and immediate security-revocation kills correctly
  recover as unknown interruptions when no stop was persisted. Pending model
  validation revocation is never delayed to obtain coverage metadata.
  A previously dispatched start request can outlive the bounded shutdown wait;
  cancellation prevents local acquisition, and any accepted late start remains
  a separate durable boundary followed by unknown restart recovery. An earlier
  stop acknowledgment is not promoted into an exact final shutdown in that case.
- A restart while already paused preserves the known pause rather than creating
  a spurious unknown shutdown. Capture never automatically resumes.
- Durable sequence orders control transitions even if the wall clock moves
  backward. An inconsistent earlier capture timestamp cannot close a gap. UI
  sorting by displayed time is not evidence of chronological continuity.

Boundary metadata is retained locally, like timeline metadata. It is not part of
the seven-day image retention deletion and contains no screenshot payload.
Older observation rows are not backfilled with inferred stops or changed. An
empty event list for legacy data means historical coverage boundaries are unknown.

## API

`GET /api/context-engine/observations?limit=100` still returns `count` and `items`.
It now also returns independently bounded `coverage_events`, newest durable
transition first. These are private local-session data under the existing
authentication middleware. A limit is not a completeness claim for all history.

Example response excerpt (no new observation is created by pausing):

```json
{
  "count": 0,
  "items": [],
  "coverage_events": [{
    "id": "opaque-event-id",
    "kind": "paused",
    "occurred_at": "2026-10-03T00:00:20+00:00",
    "source_kind": "public_window",
    "consent_revision": "opaque-consent-id",
    "session_id": "opaque-session-id",
    "last_sample_at": null,
    "first_sample_at": null,
    "gap_started_at": "2026-10-03T00:00:20+00:00",
    "gap_start_known": true,
    "gap_end_at": null,
    "gap_end_known": false,
    "reason": "user_paused"
  }]
}
```

`POST /api/context-engine/capture/pause` retains no-body / `{}` compatibility.
An optional `reason` is one of `user_paused`, `session_expired`,
`source_unavailable`, `capture_error`, `configuration_changed`, or `shutdown`. Unknown keys/reasons are
rejected. Desktop controllers map native failures to these bounded categories;
they still immediately stop acquisition, erase preview/session state and require
a fresh selected-window preview before restarting.

## Verification

```sh
PYTHONPATH=backend python -m unittest app.modules.context_engine.tests.test_coverage app.modules.context_engine.tests.test_local_http
node --test desktop/scripts/check-public-window.cjs desktop/scripts/check-capture-controller.cjs desktop/scripts/check-local-session-main.cjs
cd frontend && npm run test:capture-coverage && npm run build
```

Synthetic fixtures cover a 58.669-second pause and fresh consent session, two
session-local `sequence=1` observations, repeated starts/stops, unchanged-image
samples, failed image persistence, failed restart attempts, backward clocks,
late frames, restart recovery, graceful stops and legacy migration. They do not
prove native capture or model quality; no real screenshots or models are used.
