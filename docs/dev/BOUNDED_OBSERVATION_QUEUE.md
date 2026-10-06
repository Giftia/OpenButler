# Bounded screenshot organization (local dogfood)

The authenticated observation POST persists the owned privacy-masked PNG and a
pending observation before returning. It does not wait for image/text inference.
Only a single lazy organization worker runs; at most four observation IDs wait
in memory. The worker loads one owned image at a time. Ingestion does not hold a
capture-store lock across model HTTP. The existing daily-review consent wrapper
also releases that lock during model I/O, avoiding policy/capture lock inversion
when a recap and the observation worker overlap. Authorization getters run
outside policy/capture locks; final publication follows policy → capture →
invalidation → evidence lock order. Pre-mask captures/OCR text, other windows,
MineContext history, and unrelated chat never become queue inputs.

## API contract and verification

After an authorized capture session has explicitly started, the existing
`POST /api/context-engine/observations` input is unchanged. Example response:

```json
{"recorded":true,"duplicate":false,"id":"<observation UUID>","organized":false,"organization":{"accepted":true,"reason":"queued"}}
```

`organized:false` means the result is not synchronously ready. Read the record's
`state` and `processing_reason`; do not call this a completed observation.
`GET /api/context-engine/status` adds this object under `recording`:

```json
{"processing_queue":{"capacity":4,"queued":2,"running":1,"backpressured":1,"accepting":true}}
```

Capacity bounds waiting jobs; the one running job is separate. `accepting`
describes session admission, not spare capacity. On saturation the owned image
and record remain `recorded_pending` with `processing_reason:queue_full`.
Backpressured records are not silently discarded or auto-replayed. Once there
is capacity, an explicit `POST /api/context-engine/observations/<id>/retry`
with `{}` returns `{"ok":true,"queued":true,"reason":"queued"}` on admission;
this does not mean the result is ready. A duplicate submission never spawns
another job, and unchanged-frame deduplication remains scoped to the original
source and consent revision.

Records retain the existing states: `recorded_pending`, `processing`, `ready`,
`model_unavailable`. `processing_reason` explains queued/running/queue_full,
model/provider failures, invalid model/temporal output, revoked consent,
paused capture, changed source/evidence, expiry, process restart, or exceeded
prompt/description budget. Reason values are fixed codes, never exception text
or provider response content. Successful results clear the reason.

Pause, revoke and reconfiguration invalidate queued and in-flight generations
immediately. A generation cancellation signal reaches the native HTTP watchdog;
current or prior evidence deletion and session/evidence expiry also cancel the
single active evidence lease. Dispatch and final publication recheck the source,
consent revision, model configuration, owned evidence fingerprint and selected
prior records. Final commit serializes against invalidation and owned deletion.
Socket cancellation cannot recall already-sent input or guarantee the model
server has stopped computing; it does prevent later publication.

Restart resets active capture and all interrupted pending/processing records to
`model_unavailable/process_restarted`. It restores neither capture nor model
analysis automatically. No queue scan/replay runs on startup. Starting a new
capture session does not replay earlier canceled/backpressured records. An
explicit retry must still satisfy current source/consent/evidence checks.

## Structured and temporal output

Image inference is asked for at most 120 Chinese characters (80 preferred).
Oversized output fails explicitly; it is not silently truncated. The text input
is capped at 1,200 UTF-8 bytes to leave room in the explicitly selected 2,048-token
observation CPU profile. Provider template/tokenization overhead is not measured
by this byte guard, so this is a conservative admission bound rather than a
claim of exact token accounting. This profile is selected only for observation
calls; unrelated chat, planners and validation probes retain their defaults.

The authored JSON schema is sent to the Gateway (Ollama `format`, or compatible
strict JSON-schema response format). The parser still rejects Markdown fences,
duplicate/extra keys, reasoning tags, invalid types and oversized values. It
never strips fences or accepts a malformed response to manufacture success.

Version 2 always sends the authored no-prior schema for current extraction:
`performed` must be false, reference arrays must be empty, both quote strings
must be empty, and the boundary is an engine-authored inference limitation.
The extraction prompt contains only `current_observation`; no historical title,
summary or prior ID is supplied, and history is not read until this extraction
commits. The exact product helpers are `build_current_prompt` and `parse_current`.
Existing invalid replies, including false comparison with a nonempty quote,
remain rejected; no model-response repair is performed.

Only after extraction is committed does an optional second request receive the
immutable current title/summary and up to three selected prior summaries. It
uses a separate fixed relation-only schema: each relation has a supplied prior
ID, a `same_topic`/`different_topic`/`uncertain` enum, and exact short quotes from
the current and cited prior summaries/titles. Extra title/summary/boundary fields,
unknown IDs, fabricated quotes and duplicate references are rejected. This
request cannot update current extraction fields. Gateway accepts three frozen
authored schemas; the old general observation schema remains for compatibility
but is never selected for version-2 current extraction.

Prompt instructions distinguish a short Chinese topic title from JSON field
names and evidence limitations from length limits. Image instructions require
questions, checklists, progress lines and test claims inside a document to be
attributed to that document, rather than treated as live execution or observed
remote state. Instructions improve the requested behavior but do not establish
model accuracy; a structurally valid result can still contain unsupported
interpretation and requires review against the owned screenshot.

Only the separate association stage considers at most three same-source,
same-session, same-consent ready prior records. Only complete prior records that fit the input budget are selected;
`temporal_context` records `prior_candidate_count`, `prior_selected_count`,
`prior_omitted_count`, and exact `prior_observation_ids`. Counts apply to this
bounded candidate window, not the complete recording history. No omitted
record is claimed to have been used.

The extraction `comparison` object always contains false/empty values;
conservative lexical checks reject recognizable fabricated prior-frame claims.
Association uses its own `relations` object, never this comparison object or a
replacement current summary. These checks establish reference/quotation
consistency, not semantic truth. They cannot prove arbitrary
natural-language claims are grounded; actual model observations still require
human evidence review. Discrete screenshots never prove continuous activity,
every click, duration, or remote completion.

## Synthetic regression suite

```sh
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/context_engine/tests
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/model_gateway/tests
```

Queue tests use generated pixels and mocks only. They cover nonblocking capture,
capacity/backpressure with preserved evidence, explicit retry, duplicate records,
pause/revoke/reconfiguration, deletion/expiry cancellation and slot reuse,
restart, model outage, shutdown, strict JSON, first-frame comparison rejection,
exact references/quotes, and description limits. This suite is not proof of native
capture acceptance or real-model semantic quality.

## Explicit public-document OCR-text route

A dedicated public window can now be explicitly configured with
`observation_mode: "masked_ocr_text"`. The default remains `"vision"`; changing
mode is part of the consent/source provenance and requires a fresh native
privacy preview and configuration. Full-screen capture cannot select OCR mode.
The native main process must perform a **second fresh local OCR pass on the
final masked PNG**. Pre-mask detection text must never be reused for this path.

In addition to the unchanged verified public-window observation fields, this
mode requires the following ingest fields (example values are illustrative):

```json
{
  "observation_mode": "masked_ocr_text",
  "post_mask_ocr_complete": true,
  "post_mask_ocr_text": "Visible public document text from the final masked PNG",
  "post_mask_ocr_image_digest": "<SHA-256 of the exact final masked PNG bytes>",
  "post_mask_ocr_engine": "tesseract.js"
}
```

The backend verifies that the hash matches the decoded PNG being stored and
that the image dimensions still match the authorized source. Text must be
nonempty, no more than 2,000 Unicode characters and 6,000 UTF-8 bytes, with no
unexpected control characters. OCR fields are rejected in vision mode. These
are **storage/admission limits**, not a promise that all such text fits the
model: the complete JSON prompt must still fit 1,200 UTF-8 bytes. Overflow
preserves the owned image and text as a failed observation with the visible
`prompt_limit_exceeded` reason; nothing is truncated or silently sent via vision.
The approved 424-character public fixture fits within the current-only prompt
budget. Association has a separate 1,200-byte budget over the committed current
summary and complete prior summaries; selected/omitted counts remain truthful.

Owned post-mask text, its image digest and engine are retained alongside the
owned record for the same bounded queue and explicit retry. All are rechecked
before dispatch/publication, and are removed with owned-record deletion or
retention expiry. Raw OCR text is not returned by list/review APIs. This binding
proves which stored PNG the trusted main process attested to; the backend cannot
independently establish that a caller truly ran OCR from a digest alone. Native
process tests and source/consent checks remain essential.

OCR processing calls only the authorized configured text route. It never calls
an image model and has no vision fallback. Processor readiness can use a
text-configured Gateway with independently valid authorization; the current
model-settings UI may still validate/save the existing image/text pair.
Authorization is not bypassed to make a text-only configuration ready.

Records expose `observation_mode`,
`observation_route: "post_mask_ocr_to_text_model"`, unchanged original
`evidence_kind: "privacy_masked_captured_pixels"`, and `ocr_provenance` containing
`engine`, `stage: "post_mask"`, verified `image_digest`, and
`layout: "text_only_no_layout_guarantee"`. Vision records instead expose
`observation_route: "masked_image_to_vision_to_text"`. OCR can omit faint text,
lose layout or change reading order; the generated text remains model inference
about document content, not proof of actual actions or remote execution.

The confirmed lexical false positive spanning “与图像测试结果，当前” was removed by
requiring an actual prior-time phrase rather than allowing a conjunction to
span arbitrary text into “当前”. The parser still rejects positive prior-frame
claims without required comparison references. This narrow lexical fix does
not prove all natural-language semantics and performs no model-response repair.

Additional synthetic checks:

```sh
PYTHONPATH=backend python -m unittest app.modules.context_engine.tests.test_masked_ocr
```


## Version-2 current extraction and independent association

New records have `extraction_version: 2`. Once current extraction commits,
`current_facts` contains version, inference=true, input_scope=current_observation_only,
original observation/evidence IDs and image digest, captured time, route,
title/summary/boundary. This field name is a storage contract, not a claim of
verified truth. Compatibility title/summary/boundary columns have the same
values and are never modified by association. Existing rows stay version 1
with null current_facts and their original summaries; no corrected meaning is
assigned to them. Recap/association input explicitly labels legacy versus
current-only model-inference sources.

`state: ready` means current extraction was safely committed. Independently,
`temporal_context.association_state` is pending/running/ready/failed/skipped,
with `association_reason`, `relations`, selected prior IDs and selected/omitted
counts. No history skips the second call; no priors fitting its independent
1,200-byte budget skips with no_prior_within_budget. A malformed, unavailable or
canceled second stage preserves completed current extraction, reports a failed
association and publishes no relations. There is no automatic association retry.

Stage one leases only current evidence; deleting unrelated history cannot
change its prompt or cancel its extraction. Stage two obtains a distinct lease
covering current and selected prior evidence and validates a ready-state
snapshot tied to the exact immutable facts. Relation-only writes compare-and-swap
the previous association state and exact facts under the existing publication
lock order. Pause/revoke/reconfigure/restart interrupt pending/running
association without overwriting committed current extraction. Deleting current
evidence removes the record; a late response cannot recreate it.

Both stages retain the local resource profile and per-call deadline. OCR mode
uses one extraction text call plus, if eligible priors fit, one association text
call. Vision mode additionally uses its existing current-image call. The same
single worker and bounded queue cover the entire pipeline. Validation uses
schema, exact source references/quotes, and immutable storage boundaries; there
is no topic-keyword correction or model-judge-only acceptance.

Synthetic negative/transition tests:

```sh
PYTHONPATH=backend python -m unittest app.modules.context_engine.tests.test_current_isolation
PYTHONPATH=backend python -m unittest app.modules.model_gateway.tests.test_association_schema
```
