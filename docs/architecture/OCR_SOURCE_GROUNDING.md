# OCR source excerpts and unverified proposals

## Why this contract exists

Current-only extraction prevents historical summaries from contaminating the
current input, but does not prove a model understood that input. A captured
public text-editor note containing `guitar notes` and `standard tuning e a d g b e`
produced a model summary claiming physical strings with note markings. JSON
validation accepted that prose, and later temporal relations could quote it as
if the generated summary were the original source.

The OCR route now separates exact source excerpts from free-form model proposals.
It does **not** add a semantic correctness detector or claim that the real model's
understanding is fixed.

## Current extraction

`masked_ocr_text` uses the fixed, allowlisted `OCR_OBSERVATION_JSON_SCHEMA`, which
adds required `source_quotes` to the existing current-only contract. The model
must copy one to three contiguous, nonempty original OCR spans: at most 120
Unicode code points each and 200 total, without changing whitespace or case.
The server validates exact membership and rejects duplicate or invalid quotes.
There is no repair, truncation, historical fallback, or vision fallback.

The accepted canonical title is `文档 OCR 摘录`; the canonical summary is an
attributed verbatim excerpt such as:

> 屏幕文档 OCR 文字：“guitar notes”；“standard tuning e a d g b e”。

The model's free-form `title` and `summary` are retained only as
`current_facts.source_grounding.model_proposal`, marked
`verification: unverified_inference`. They are not the canonical observation,
not the default displayed summary, not temporal citation evidence, and not
forwarded to the daily-review model. A proposal paired with a legitimate quote
can still be wrong; this contract deliberately does not pretend otherwise.

`current_facts.source_grounding` is additive; existing extraction version 2 is
retained. It contains:

- `version: 1`, `source_kind: post_mask_ocr_text`
- Server-bound observation ID, evidence ID and masked-image SHA-256
- SHA-256 of the exact UTF-8 original OCR text, without normalization
- `offset_unit: unicode_codepoints` and `excerpts: [{quote, start, end}]`
- `verification: exact_source_spans_only`, `semantic_verified: false`
- The separately marked `model_proposal`

Offsets are zero-based, start-inclusive and end-exclusive. Repeated identical
text resolves to its first occurrence. This identifies an OCR-string range,
not visual placement, layout, a particular physical object, or proof of an
action. Full OCR stays in the owned local record; list/review APIs still omit it
and expose only bounded selected excerpts. Existing expiry/deletion rules are
unchanged. Retained IDs and excerpts do not imply screenshot availability.

## Independent historical association

For a new OCR extraction, association receives current/prior `source_quotes`,
never model titles or summaries. Prior excerpts must still match the owned OCR
text, its digest, image digest and IDs, and canonical aliases. Records with no
valid source-grounding contract are omitted without legacy-summary fallback;
`no_source_grounded_prior` explains when no suitable prior remains. The usual
candidate/selected/omitted counts and 1200-byte prompt bound remain in force.

Relations still use `same_topic`, `different_topic`, or `uncertain`, and still
represent unverified model inference. Exact quotes must occur inside the
selected OCR excerpts. The server attaches `current_source_span` and
`prior_source_span` with the original code-point range and source IDs/digests.
`temporal_context.citation_basis` is `post_mask_ocr_spans` for these records.
The association cannot modify committed current content. Cancellation, source
mutation, consent changes and deletion retain the existing fail-closed behavior.

The vision path is unchanged and remains unverified model interpretation. Its
citation basis is explicitly `unverified_model_summaries`. Legacy version-1 and
version-2 rows are not migrated, replayed, or relabeled as source-validated.

## UI and daily review

The observation view labels new records as OCR excerpts with unverified meaning,
shows quote ranges and original source identifiers, and keeps free-form proposals
inside a collapsed, explicitly unverified explanation. Invalid advertised
grounding is not replaced by legacy model prose. Old version-2 OCR output gets an
explicit no-source-span-validation label. Expired evidence is described as
unavailable; a retained source digest is not an availability claim.

Daily review receives canonical attributed excerpts with input scope
`attributed_ocr_excerpt_not_action_fact`. Its synthesis remains unverified and
cannot treat document text as completed actions or fill gaps between samples.

## Verification and remaining acceptance gap

Run focused checks from the repository root:

```sh
PYTHONPATH=backend python -m unittest app.modules.context_engine.tests.test_source_grounding
PYTHONPATH=backend python -m unittest app.modules.context_engine.tests.test_current_isolation
PYTHONPATH=backend python -m unittest app.modules.model_gateway.tests.test_ocr_grounding_schema
node frontend/scripts/check-observation-analysis-dom.cjs
```

`tests/fixtures/reconstructed-guitar-negative.json` preserves the exact OCR and
unsupported summary supplied in an earlier verified report. The original raw
response file is absent after the execution-environment reset. This fixture is
explicitly a reconstruction, not a raw captured-response replay or a fresh model
run. Its historical hashes identify earlier artifacts and are not claimed to be
reverified by this test. Additional valid-citation/false-proposal cases are
synthetic adversarial tests.

The tests establish parsing, provenance, containment, isolation, cancellation,
UI labeling and provider-schema contracts. They do not establish OCR accuracy,
model-selected excerpt completeness, useful proposal quality, or topic-relation
accuracy. The 2048-context/768-output-token local profile and prompt limits are
unchanged, but real model compliance with the expanded schema is unmeasured.
A fresh authorized real-model run on the same public note is still required for
semantic acceptance. No new capture, model service, credentials or model-weight
download was used for this source-only change.
