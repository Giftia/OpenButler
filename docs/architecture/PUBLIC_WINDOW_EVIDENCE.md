# Dedicated public-window evidence

This is the bounded X11 public-window slice. It does not make full-desktop capture safe when lock state is unknown, and it does not establish complete click or activity coverage. The legacy full-screen capture gate is unchanged.

## Source and consent contract

The desktop acquires only the selected XComposite named-window pixmap, verifies the process/window identity before and after acquisition, and runs local OCR/redaction. Vision mode sends only the privacy-masked PNG. The explicitly selected `masked_ocr_text` mode also sends a fresh second-pass OCR result from that final masked PNG, bound to its exact SHA-256. Pre-mask screenshots and pre-mask OCR text have no backend storage or processing API here. The submitted image must retain the selected window's full dimensions.

Existing endpoints are reused. `POST /api/context-engine/capture/configure` accepts the legacy `display_id`, `excluded_apps`, `masks`, and explicit `confirmed`, plus this public-window binding:

```json
{
  "display_id": "x11:100",
  "excluded_apps": ["password-manager"],
  "masks": [],
  "confirmed": true,
  "source_kind": "public_window",
  "capture_scope": "dedicated_public_window",
  "session_id": "00000000-0000-4000-8000-000000000001",
  "source_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "source_identity": {
    "window_id": "x11:100",
    "owner_pid": 123,
    "owner_process_start": "999",
    "owner_process_name": "mousepad",
    "wm_class": "Mousepad",
    "window_title": "Public test",
    "content_bounds": {"x": 0, "y": 0, "width": 800, "height": 500}
  },
  "session_expires_at": "2026-10-02T11:00:00+00:00",
  "lock_state": "unknown",
  "lock_protection_supported": false,
  "capture_method": "xcomposite_named_window_pixmap",
  "sampling_interval_ms": 60000
}
```

Use a real session UUID, revision of the selected identity, and expiry in the next hour. The response includes a new server-generated `consent_revision` UUID. Every configure operation cancels in-flight work and issues a different revision, including configuring the same window again. Configure never starts capture. The desktop must show its masked preview and obtain the explicit start action before calling the existing start endpoint.

`POST /api/context-engine/observations` echoes the exact source binding, including the `consent_revision`, and supplies `captured_at`, `masked_png_base64`, `local_ocr_complete: true`, `masks_applied: true`, `source_verified_before: true`, `source_verified_after: true`, `sampling_sequence` (positive integer), and `sampling_gap_ms` (nonnegative integer). It does not send configure-only fields (`confirmed`, `excluded_apps`, `masks`). `captured_at` is acquisition time before OCR; backend `recorded_at` is acceptance time. The backend rejects expired sessions, mismatching identities/revisions/dimensions, late/reordered sequence or capture time, and missing strict verification booleans. The high-water mark advances even for a deduplicated identical image.

The stored provenance attests the permitted acquisition route and source ownership. It is not cryptographic proof of pixel semantics, successful redaction, or model correctness. This local authenticated API trusts the reviewed desktop capture implementation's verification attestations.

## Processing and temporal context

In vision mode, the existing image Gateway receives exactly the supplied full-resolution masked PNG and provides a bounded current-image description. The explicitly selected `masked_ocr_text` mode instead uses fresh post-mask OCR text and never calls an image model or falls back to vision. Version-2 current extraction receives only this current input; it receives no history or prior summaries. Current extraction is committed before history is read. A separate optional association request receives that immutable result and up to three selected prior ready summaries from the same source, session and consent revision. Its relation-only response cannot replace the current title, summary or boundary. A failed association does not convert an accepted current extraction into a fabricated combined summary.

Each complete text prompt is capped at 1,200 UTF-8 bytes; whole prior records that do not fit association are omitted with explicit selected/omitted counts. Post-mask OCR text is retained with owned evidence for bounded processing and explicit retry, and removed on owned-record deletion or retention expiry. List/review APIs do not return raw OCR text. See `docs/dev/BOUNDED_OBSERVATION_QUEUE.md` for queue cancellation, separate-stage states, legacy records and mode-specific contracts.

Capture consent/source revision, session expiry, active state, gateway configuration/authorization, current image digest and file fingerprint, and selected prior-record content/file fingerprints are checked before/after model calls and before publication. Pause, revoke and reconfigure announce cancellation before waiting for an in-flight operation; stale model output is discarded. Final publication and frame persistence serialize against cancellation intent. Old records remain reviewable evidence, but a previous consent revision cannot be reused for automatic processing or new temporal context. Pause retains consent so completed stopped-session records can still enter an explicitly requested daily recap. The trusted desktop always reconfigures before a new start. A direct authenticated API pause/start with unchanged consent can permit a later explicitly requested retry of pending evidence; it cannot revive already canceled in-flight output.

Model output is untrusted. JSON shape, duplicate keys, lengths and reasoning tags are rejected. Both title and summary remain model inferences. Public-window records have a server-owned boundary stating that evidence is privacy-masked captured pixels, discrete samples omit intervening clicks, remote completion cannot be concluded, and lock protection is unsupported. Source provenance cannot prove a generated statement is true.

## Read models

Observation items retain existing fields and add:

- `source_kind`, `source_label`, `recorded_at`, `consent_revision`
- `provenance`: the exact source/session/identity/capture-method binding, plus pre/post verification and sampling interval/sequence/gap
- `evidence_kind: "privacy_masked_captured_pixels"`
- `temporal_context`: `prior_observation_ids`, `inference: true`, `coverage: "discrete_samples_only"`, and a fixed explanatory note

Original evidence means the captured pixels **after privacy masking**. It must not be called an unredacted original. The backend does not resize or redraw stored evidence.

The existing explicit daily recap consumes these records. Its public-window conclusions retain typed source provenance in evidence references, and coverage includes source sessions and sampling gaps. A dedicated-window consent does not send legacy/private source text or earlier public-window consent revisions to recap models. No parallel timeline or recap subsystem was introduced.

## Verification

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend python -m unittest discover -s backend/app/modules/context_engine/tests -v
```

The public-window suite uses synthetic PNGs only and covers source identity/revision mismatch, malformed identity, unknown lock support, forbidden pre-mask OCR and vision-mode OCR fields, full-resolution dimensions, temporal context bounds, late frames including deduplication, expiry, malformed model output, stop/revoke/reconfigure during image/text calls, replaced current evidence, changed/deleted prior context, and cancellation during PNG validation.

Real selected-window acquisition, OCR quality and actual local model inference require separate runtime verification. These unit tests do not claim that any real desktop session or vision model succeeded.
