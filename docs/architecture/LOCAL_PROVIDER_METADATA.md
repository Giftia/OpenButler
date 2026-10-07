# Local provider timing metadata

Strict text responses on a `local` / `openai_compatible` route may include one
optional top-level `timings` object. This supports the non-speculative
llama.cpp chat-completion envelope used by the official Ollama v0.35.1 embedded
server. It does not enable a service, perform a probe, or change model settings.

The object must contain exactly these nine keys:

- Integer token counts: `cache_n`, `prompt_n`, `predicted_n`
- Integer or floating-point measurements: `prompt_ms`, `prompt_per_token_ms`,
  `prompt_per_second`, `predicted_ms`, `predicted_per_token_ms`,
  `predicted_per_second`

Every value must be finite, nonnegative and at most `2**63 - 1`. Booleans,
strings, nulls, nested values, missing keys and unknown keys are rejected with
the content-free `invalid_provider_response` error. The numeric ceiling is an
OpenButler validation bound, not a performance claim or a provider limit.
The existing one-MiB transport response bound remains in force.

Timing metadata is validated and ignored. It cannot alter authorization,
timeouts, resource caps, visible content, source grounding or persistence.
The envelope still requires exactly one choice, a normal `stop` finish, and
only the admitted assistant text channel. Unknown envelope/choice fields and
reasoning, tool and refusal message fields remain rejected. No output is
repaired or stripped. `custom` OpenAI-compatible and Ollama-native strict
responses retain their existing field allowlists; non-strict parsing is
unchanged.

This compatibility allowance intentionally excludes speculative-decoding
timing extensions (`draft_n`, `draft_n_accepted`) and other unreviewed variants.
Such responses fail closed rather than expanding the trusted shape.

## Provider references

- [Ollama v0.35.1 llama.cpp version pin](https://github.com/ollama/ollama/blob/v0.35.1/LLAMA_CPP_VERSION)
  selects `b11232`
- [llama.cpp b11232 chat-completion contract](https://github.com/ggml-org/llama.cpp/blob/b11232/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api)
  documents the nine timing fields
- [llama.cpp b11232 timing serializer](https://github.com/ggml-org/llama.cpp/blob/b11232/tools/server/server-common.cpp)
  defines `server_slot_stats::to_json`; the
  [chat-completion serializer](https://github.com/ggml-org/llama.cpp/blob/b11232/tools/server/server-task.cpp)
  attaches it when statistics are available

## Verification

From the repository root:

```sh
PYTHONPATH=backend python -m unittest app.modules.model_gateway.tests.test_llama_timings
PYTHONPATH=backend python -m unittest app.modules.model_gateway.tests.test_local_budget_schema
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/model_gateway/tests
```

These regressions use synthetic envelopes and a synthetic loopback HTTP server.
They cover strict parsing, a real Gateway text probe and schema call, numeric
edge cases, provider scoping and continued rejection of extra output channels.
They do not establish live-model compliance or semantic accuracy.
