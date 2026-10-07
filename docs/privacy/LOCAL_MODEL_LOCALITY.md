# Local-model provider boundary

Loopback HTTP is a transport boundary, not evidence of where inference runs.
Signed-in stock Ollama can forward cloud models and remote-backed aliases while
listening on localhost. A route configured as `local` therefore needs fresh,
prompt-free supported-provider metadata before every inference. This applies
in both strict and basic mode, even if external consent was previously granted.
It never silently converts a local route into external processing.

## Enforcement and supported declarations

`HttpTransport.post` is the common production dispatch boundary for synthetic
validation, image/text activation, observations, OCR processing, recap, planner
and conversation calls. It checks locality on every call, including after a
previous successful validation. UI discovery is advisory and cannot authorize
dispatch. Caller consent/cancellation is checked again after metadata I/O,
before a prompt or image is sent. There is no cached locality allow decision.

Only the following provider declarations are currently supported:

1. Native Ollama at a literal loopback HTTP origin, or its OpenAI-compatible
   endpoint at exactly `/v1`
   - Read `GET /api/tags`, with no body, prompt or model selector
   - Require exactly one matching `name` row (the requested ID, or its explicit
     `:latest` spelling when the request omits a tag) and identical `model`
   - Require a lowercase 64-hex `digest`, positive integer `size`, and
     `details.format` equal to `gguf` or `safetensors`
   - `remote_model` / `remote_host`, when present, must be strings. Any nonempty
     value denies the call. Their absence is expected for local Ollama models
     because the provider omits empty fields; absence alone is insufficient
   - Explicit provider `:cloud` and `:<tag>-cloud` selectors are also denied,
     case-insensitively. This is an additional denial, not a tag-name locality
     heuristic. An innocent-looking alias with remote metadata is denied too
   - `:local` selectors, multiple runner rows, absent aliases, incomplete
     metadata and unknown formats fail closed in this bounded implementation

Standalone llama.cpp is deliberately unsupported as a strict/local-only route.
Stock llama.cpp can use `--rpc` / `LLAMA_ARG_RPC` to offload computation to other
hosts while its normal `/props` and `/v1/models` responses still describe a
loaded GGUF model and local model path. Those fields do not establish that
inference stays on this computer. An earlier candidate's automatic llama.cpp
metadata fallback was removed after independent review identified this gap.
A 404/405 from `/api/tags` now returns `local_provider_unsupported`; no `/props`,
`/v1/models`, model loading, or inference request follows. There is no operator
attestation or consent-based bypass of this boundary.

The metadata request reuses literal-loopback pinning, redirect rejection and
cancellable bounded transport. Metadata is limited to 256 KiB of plain JSON;
duplicate JSON keys, invalid UTF-8, encoded responses and malformed shapes
fail closed. The whole metadata phase has a three-second ceiling inside the
existing total inference-call budget. It cannot extend that budget. No model
loading, model download, settings change, inference probe or `/api/show` call
is used for locality discovery. `/api/show` itself can forward cloud selectors.

Desktop discovery keeps a bounded `modelMetadata` array with `name`, `locality`
(`local`, `remote`, `unknown`) and safe `remote_model` / `remote_host` strings
when supplied. Its existing `models` string list offers only declared-local
candidates. Arbitrary provider metadata, credentials in remote URLs, query
strings and fragments are not reflected. The backend independently checks its
own live response before every inference.

## Errors and compatibility migration

- `local_model_remote`: select installed local weights instead of the
  cloud-backed model or remote-backed alias
- `local_model_unverified`: locality could not be established from the required
  metadata. Check that the intended supported local provider is running and
  reports its installed model; no inference was sent
- `local_provider_unsupported`: use a trusted native Ollama endpoint or its
  compatible `/v1` endpoint with fresh native `/api/tags` local-weight evidence.
  Standalone llama.cpp, generic proxies, routers and arbitrary URL prefixes are
  not admitted as local

Previously tested Windows standalone llama.cpp/Ollama-embedded C++ runner
routes, including genuinely single-machine runners, are now blocked in this
new candidate's local-only mode because the available metadata cannot rule out
stock RPC offload. The installed application is unchanged by this source patch.
Generic OpenAI-compatible localhost endpoints are also unavailable unless their
native Ollama metadata meets the supported contract. Unknown providers,
unavailable/old metadata contracts, multiple matching Ollama runner rows,
noncanonical alias spelling and `:local` selectors also fail closed. The
existing stored route and evidence are not deleted or rewritten. Initial
validation readiness is not a perpetual guarantee: an alias that later changes
to remote remains configured but its next dispatch is denied. No error enables
external consent, changes privacy mode or falls back to an external service.

## Trust and residual race boundary

These are provider declarations, not cryptographic attestation or a network
sandbox. They address the documented stock-provider cloud/alias behavior and
recheck changes between validation and subsequent use. An arbitrary malicious
localhost proxy can forge metadata or forward requests. A mutable provider can
also change between the final metadata read and inference dispatch; the
provider APIs do not atomically bind the inspected metadata to this request.
This implementation does not prove that arbitrary localhost services are
offline and does not claim to close that lookup-to-dispatch race. Only use
trusted local providers; stronger guarantees require a separately defined
provider trust or network-isolation boundary.

## Primary provider references

Provider sources were checked on 2026-10-06. The bounded parser is deliberately
conservative when contracts change.

- [Ollama API introduction](https://docs.ollama.com/api/introduction)
- [Ollama remote fields and list model shape](https://github.com/ollama/ollama/blob/8a971df3bacec93944ec894f2939fd2567afc5dd/api/types.go)
- [Ollama list rows use manifest remote configuration](https://github.com/ollama/ollama/blob/8a971df3bacec93944ec894f2939fd2567afc5dd/server/model_list.go)
- [Ollama source selector parsing](https://github.com/ollama/ollama/blob/8a971df3bacec93944ec894f2939fd2567afc5dd/internal/modelref/modelref.go)
- [Ollama chat and show forwarding](https://github.com/ollama/ollama/blob/8a971df3bacec93944ec894f2939fd2567afc5dd/server/routes.go)
- [llama.cpp b11232 --rpc / LLAMA_ARG_RPC and provider metadata contracts](https://github.com/ggml-org/llama.cpp/blob/b11232/tools/server/README.md)
- [llama.cpp b11232 remote compute through RPC](https://github.com/ggml-org/llama.cpp/blob/b11232/tools/rpc/README.md)

## Synthetic verification

```sh
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/model_gateway/tests
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/agent_runtime/tests
node --test desktop/scripts/check-local-model-discovery.cjs
```

The new locality tests fully mock the HTTP connection and assert zero inference
requests for remote aliases, cloud selectors, missing/ambiguous metadata,
changed aliases, unsupported providers and revoked consent. Honest standalone
Windows and RPC-capable llama.cpp metadata fixtures both fail closed, without
querying `/props` or invoking autoload. Existing wire tests use synthetic
loopback servers with prompt-free Ollama metadata. No real model
compliance, native acquisition, model-weight access or offline guarantee is
established by these tests.
