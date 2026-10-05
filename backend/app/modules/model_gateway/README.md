# Bounded local model transport

Gateway route probing and dispatch remain explicitly authorized, pinned and
non-streaming. Strict mode still prohibits external requests. No constructor,
status read or environment change downloads a model, creates credentials or
starts a service.

## Trusted local CPU budget

`HttpTransport(total_timeout=10, local_total_timeout=None)` preserves the existing
10-second default. `total_timeout` accepts only finite positive values up to 10;
when omitted, `local_total_timeout` inherits it. A distinct local budget accepts
finite positive values up to 120 seconds and applies only to validated loopback
HTTP routes. Custom routes always use the original at-most-10-second budget.
The total socket watchdog covers slow headers and slow-drip bodies and is joined
on every outcome; a slow response cannot refresh the budget.

The model-settings router reads the process-owned environment variable
`OPENBUTLER_LOCAL_MODEL_TOTAL_TIMEOUT_SECONDS`, default `10`. Invalid values fail
startup. There is no HTTP setting or model-authored field for changing this limit.
For an explicitly approved temporary CPU trial, the launcher may set:

```bash
OPENBUTLER_LOCAL_MODEL_TOTAL_TIMEOUT_SECONDS=90
```

`GET /api/model_settings/get` includes `local_total_timeout_seconds` and
`external_total_timeout_seconds`. Values describe the actual HTTP transport;
`null` means an injected transport does not declare a budget. Increasing the
budget is not a readiness, model-quality or completion claim. It is a per-request
budget: image and text inference are separate requests, so callers must use a
bounded asynchronous queue rather than wait in a capture request.

Only internal observation calls with `local_cpu_profile="observation"` send the
fixed resource options. Their local Ollama requests use: `num_ctx=2048`,
`num_predict=512` for image descriptions or `768` for text, at most six CPU
threads, and zero temperature. The same profile on local OpenAI-compatible requests sends the output cap and
temperature using that API's fields. Custom requests, probes and unrelated local
chat/planner calls retain their earlier payloads without these options. The processor must bound prompts and prior context, and reject
unsupported/truncated output. A context cap alone cannot prove that a provider
did not truncate input; real model verification remains required.

## Authored structured observation output

Internal `Gateway.call_text(..., json_schema=OBSERVATION_JSON_SCHEMA)` uses
Ollama's native `format` schema, or an OpenAI-compatible
`response_format={type: "json_schema", json_schema: {name, strict: true, schema}}`.
No user-facing endpoint accepts a schema. Only the five exact authored schemas (legacy observation, current-only
observation, legacy OCR quotation, current OCR selection and relation-only temporal
association) are admitted; a bounded primitive-tree check precedes canonical comparison.
References, enlarged fields, recursive data and arbitrary schemas fail before
network dispatch. Mutating the exported convenience object cannot change the
canonical allowlist. Version-2 current extraction uses `OBSERVATION_NO_PRIOR_JSON_SCHEMA` for vision
and `OCR_SELECTION_JSON_SCHEMA` for masked OCR:
comparison is fixed to false, prior IDs and quotes are empty, and boundary is
fixed to the engine-authored current-frame limitation. It receives no historical
summary. Optional later association uses `TEMPORAL_ASSOCIATION_JSON_SCHEMA`;
its relations cannot update current extraction fields. The generic observation
schema remains a compatibility allowlist entry, not the version-2 extraction path. Returned JSON
is still strictly validated, with no content repair.

Provider support is required; there is no fallback to a weaker format and no
Markdown-fence removal or output repair. Schema requests and the observation profile force the existing
strict envelope checks: a normal completed stop, one visible assistant message,
no refusal/reasoning/tool channel or unknown fields, and bounded visible content.
The observation processor still validates JSON shape, duplicate fields, length,
semantic boundaries and evidence relationships; schema-constrained generation
alone does not establish truthful content.

Official provider contracts:
- https://docs.ollama.com/capabilities/structured-outputs
- https://developers.openai.com/api/docs/guides/structured-outputs

## Cancellation and consent

`call_image` and `call_text` accept an optional `cancel_event` and
`strict_text_response`; text additionally accepts the fixed `json_schema`.
Cancellation is checked before dispatch, after the response, and by a joined
watcher that closes the active socket within its 50 ms polling interval.
The connecting socket is exposed before nonblocking connect; readiness waits
are bounded to 50 ms so cancellation does not wait for the 90-second budget.
TLS sockets are also exposed before the handshake. Its
signal does not acquire the Gateway policy lock. Cancellation reports only
`authorization_revoked`; closing the client socket requests cancellation but
cannot independently prove that a provider immediately released every resource.
Callers must invalidate the event independently of dispatch and keep their
source/consent postflight and final-publication checks. Gateway also reruns the
provided dispatch precondition after a response. Reconfiguration retains its
existing dispatch serialization and route-revision gates.

## Synthetic verification

These checks use generated loopback mocks, not a downloaded or running model:

```bash
PYTHONPATH=backend ../.venv/bin/python -m unittest discover \
  -s backend/app/modules/model_gateway/tests -v
PYTHONPATH=backend ../.venv/bin/python -m unittest \
  app.modules.agent_runtime.tests.test_model_planner -v
```

Coverage includes explicit local versus external deadlines, unchanged slow-drip
cleanup, native/OpenAI schema wire shapes, bounded resource options, schema
rejection, strict-channel/truncation rejection, physical in-flight cancellation,
postflight revocation and public status. Passing mocks are not evidence of model
quality or an actual accepted screenshot observation.


Current-frame masked OCR extraction uses the static `OCR_SELECTION_JSON_SCHEMA`:
models return 1–3 `source_ids` from immutable `[id,text]` candidates, never free
quotes. The engine resolves exact Unicode offsets in the complete source-bound
snapshot; unknown, duplicate, cross-source or over-budget choices fail as a whole.
Distinct occurrences have separate IDs; selecting duplicate text from distinct
occurrences is rejected for the existing v1 unique-quote contract. Candidate text
is never normalized. Limits remain 12 candidates, 120 characters per fragment,
200 selected characters and 1200 prompt bytes. IDs/byte offsets remain internal;
persisted excerpts retain only `quote/start/end`, version 1 and
`semantic_verified=false`. Legacy quote parsing is diagnostic only, with no live
fallback. Historical association and daily-review contracts remain unchanged.
