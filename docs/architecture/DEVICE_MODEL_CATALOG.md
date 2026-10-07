# Device model catalog v1 (2026-10-02)

## Scope and evidence boundary

This is a finite, Electron-only catalog, explicit inspection, and Ollama download flow. It does not install or start Ollama, run a model, activate model routes, take a screenshot, change capture settings, store credentials, or configure a cloud provider. Successful download only means the selected runtime reported the expected installed manifest and (for image entries) vision capability metadata. It does **not** establish image quality, speed, available RAM/VRAM, successful inference, or capture permission. The existing manually validated image/text model-route flow is still required.

Opening Settings, listing the catalog, and reading a job perform no endpoint or hardware discovery. Only the explicit inspection action queries the chosen literal-loopback native Ollama endpoint. Download requires a successful unexpired inspection token, a fixed catalog entry ID and `downloadConsent: true`. The UI must disclose that the chosen Ollama service will obtain public model artifacts from its registry over the network; a download is separate from private inference. This explicit download does not enable external model calls or send prompts, images, screenshot paths or activity data.

### Device scope

`device` describes the Electron process's resource namespace. Linux reports the most restrictive readable inherited cgroup memory limit and remaining allowance, bounded by physical memory; unreadable or ambiguous namespaces remain unknown. `cpuCount` is an available-parallelism hint reduced by readable cgroup v2 CPU quotas, not a throughput benchmark. GPU, VRAM and the model data directory's disk capacity remain unknown. A real cgroup-v2 hierarchy root lacks `memory.max`/`memory.current`; the probe preserves valid child limits only when an ENOENT at that root is corroborated by the kernel-documented root-only `cpuset.cpus.isolated` file and the memory controller. Missing child files, permission errors and ambiguous virtual roots still yield unknown. Older kernels without that root marker remain conservatively unknown. See the [kernel cgroup-v2 interface and namespace contract](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Ollama can be reached through loopback forwarding, containers, WSL or a tunnel. Native Ollama metadata cannot attest its physical host. Therefore `runtime.hostRelation` is always `unknown`, `hardwareVerified` is always `false`, and every entry's `fit`, memory evidence and speed evidence are unknown. Never use desktop process memory to assert that a model fits the chosen runtime, and never substitute the build/test container's hardware for the user's device.

## Pinned catalog

Source: `desktop/src/model-catalog.v1.json`, version `2026-10-02.v1`. Each entry fixes backend, exact named tag, full SHA-256 manifest digest, all model/projector/config/template/license/parameter assets, exact aggregate asset bytes, quantization, role metadata and license/source links. Small upstream manifest snapshots are under `docs/architecture/model-catalog-manifests/`; tests hash their raw bytes and compare every asset. No weights or private benchmark data are included.

- Ministral 3 3B: `ministral-3:3b-instruct-2512-q4_K_M`, 2,953,840,808 asset bytes, SHA-256 `f04aa1c738f64e13c625b82ae92504fc0260fa6723b509ed1ece0fa188179b1d`, image + text, Q4_K_M
- Gemma 4 E2B: `gemma4:e2b-it-qat`, 4,336,358,185 asset bytes including the BF16 image projector, SHA-256 `07ea59a474013479c8b6b802bef095c40e964a1d776ba02f264c0e30e1aede0c`, image + text, QAT Q4_0
- Qwen3 4B Instruct 2507: `qwen3:4b-instruct-2507-q4_K_M`, 2,497,293,803 asset bytes, SHA-256 `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`, text only, Q4_K_M

All three exact official library pages show Apache-2.0. Asset size is neither required RAM nor a prediction of bytes transferred: Ollama can reuse cached assets. No model has a tested/recommended/speed/fit badge in this catalog.

### Upstream protocol limits

Ollama's documented pull interface accepts a model name/tag, rather than promising a content-addressed immutable pull ref. This implementation sends the exact allowlisted tag, rejects unknown/mismatched progress asset digests/sizes, then compares the installed full manifest digest. Upstream tag drift therefore fails closed; it is not silently accepted, activated or deleted. There is a possible registry tag race before the runtime reports a mismatched asset. OpenButler cannot guarantee zero bytes of a changed tag were downloaded before detection. The catalog pins are acceptance criteria, not a claim that Ollama's tag lookup is immutable.

Official references checked on 2026-10-02:

- [Ollama pull API](https://docs.ollama.com/api/pull)
- [Ollama protocol documentation, pull/resume/show/tags](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Ministral exact library entry](https://ollama.com/library/ministral-3:3b-instruct-2512-q4_K_M)
- [Ministral license](https://ollama.com/library/ministral-3:3b-instruct-2512-q4_K_M/blobs/43070e2d4e53)
- [Gemma exact library entry](https://ollama.com/library/gemma4:e2b-it-qat)
- [Gemma license](https://ollama.com/library/gemma4:e2b-it-qat/blobs/0d542e0c8804)
- [Qwen exact library entry](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M)
- [Qwen license](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M/blobs/d18a5cc71b84)
- Metadata source form: `https://registry.ollama.ai/v2/library/{family}/manifests/{exact-tag}`

## Desktop IPC contract

All six methods use the existing strict main-frame/file-origin guard. Preload only forwards listed properties. No arbitrary command, URL path, file path, model name, headers, key, registry, or native IPC object is exposed. Except inspection's endpoint (validated by the existing literal loopback parser), authority resides in the main process. `localhost` is pinned to 127.0.0.1 without DNS. No redirects, proxy agents, cookie jar, credential forwarding or alternate registry are used by the local HTTP transport.

### `getBuiltinModelCatalog()`

Returns `{ok: true, catalogVersion, entries}` from packaged data only. An entry contains:

```
{id, name, family, backend: 'ollama', model, manifestDigest, downloadBytes,
 roles: ('image'|'text')[], quantization, license: {name, url}, sourceUrl,
 notes: string[], assets: {digest, size, mediaType}[], downloadSupported,
 memoryEvidence: 'unknown', speedEvidence: 'unknown'}
```

### `openBuiltinModelCatalogLink({catalogId, kind: 'source'|'license'})`

The main process resolves the chosen URL from the packaged catalog, validates exact HTTPS origin `https://ollama.com` with no credentials/query/fragment, then opens the system browser using `shell.openExternal`. Returns `{ok, error_code?}`. The renderer cannot provide a URL. Existing general navigation/pop-up restrictions remain unchanged. This is an explicit link click only.

### `inspectBuiltinModelHost({endpoint, protocol: 'ollama_native'})`

Calls only `/api/version`, `/api/tags`, and `/api/show` for already-installed matching image catalog entries. No inference. Returns:

```
{ok, endpoint, inspectionId?,
 runtime?: {available, version: string|null, hostRelation: 'unknown', hardwareVerified: false},
 device?: {platform, arch, memoryBytes: number|null, availableMemoryBytes: number|null,
   memorySource: 'cgroup_v2'|'cgroup_v1'|'physical'|'unknown', cpuCount: number|null,
   gpu: 'unknown', scope: 'desktop_process'},
 entries?: {id, installed, digestMatches, imageMetadataVerified, fit: 'unknown'}[],
 error_code?}
```

A successful inspection returns a random 32-hex token valid for ten minutes. A newer inspection replaces it. Results are discarded if the requesting main frame/URL changes. At most one inspection runs, with at least one second between starts. There is no scanning or periodic hardware probing.

### `startBuiltinModelDownload({inspectionId, catalogId, downloadConsent: true})`

Returns `{ok, job?, error_code?}` quickly. A durable intent journal is committed before request dispatch. The operation rechecks `/api/tags` to avoid overwriting an entry installed after inspection, then posts exactly `{model: packagedEntry.model, stream: true}` to `/api/pull`. There is only one job slot. A concurrent or unknown-server-state job blocks every further pull, including equivalent loopback aliases and other catalog entries/endpoints. A journal failure blocks mutation.

The response stream is metadata only; Ollama owns asset storage. OpenButler does not download blobs itself. After a clean `success` and stream end, `/api/tags` must contain the exact named model and expected full digest; image entries also require `/api/show` capabilities containing both `completion` and `vision`. Then the job becomes `succeeded`. No route activation follows.

### `getBuiltinModelDownload({jobId?})`

Returns `{ok, job: Job|null, error_code?}` from memory/local journal only. Omit ID to read the latest job, including recovery after app restart. Polling does not generate endpoint requests. The UI polls only while a job is active, no more frequently than once per second, and stops when it leaves the view. The main process does not push unsolicited events.

### `cancelBuiltinModelDownload({jobId})`

Returns `{ok, job?, error_code?}`. Disconnects this app's HTTP stream. **There is no separate Ollama server-cancel acknowledgment.** Once a pull has been sent, disconnected/time-out/malformed/incomplete streams become `interrupted`, with `serverState: 'unknown'` and `canRetry: false`. Do not label this paused, cancelled on the server, or fully stopped. Before pull dispatch, cancellation can be terminal because this operation has not sent the mutation. During post-success metadata verification, disconnection fails verification but retains the known terminal pull state.

### Job shape and transitions

```
{id, catalogId, endpoint, model, manifestDigest,
 state: 'starting'|'downloading'|'verifying'|'succeeded'|'failed'|'interrupted',
 phase, completedBytes, totalBytes, error_code?,
 serverState: 'active'|'terminal'|'unknown', canRetry, updatedAt}
```

- `starting` -> fixed read-only preflight -> `downloading` -> clean terminal success -> `verifying` -> verified `succeeded`
- An explicit server error record **and clean stream end** yields terminal `failed`, `canRetry: true`
- A definite preflight failure before mutation yields terminal `failed`, normally retryable
- Digest/vision verification failure is terminal `failed`, not a successful install and not automatically retried. A later explicit inspection that observes the tag absent permits a new attempt; a still-present drifted tag is never overwritten
- Lost HTTP connection after dispatch yields `interrupted`/unknown and locks further pulls
- App quit or renderer crash closes an active stream with the same truthful semantics
- A recovered nonterminal durable journal becomes unknown; there is no auto-resume or background probe

Ollama documents that repeated pulls can reuse partial/cached layers. Explicit retry after a known terminal error reissues the same fixed tag; OpenButler does not claim its own byte-range resume, estimate remaining time, delete partial files, or modify runtime storage. A read-only inspection may show an installed pinned model after disconnect, but installed metadata cannot prove that the previous pull stopped. It does **not** clear the unknown lock. V1 intentionally has no force-unlock or service-kill action. Existing manual model assignment remains available; recovering downloads after unknown state needs a future verified runtime-stop mechanism. This limitation is visible rather than silently permitting overlapping pulls.

The one-slot journal contains only catalog/job IDs, selected local endpoint, pinned model/digest, safe state/counts, and timestamp. Atomic write with fsync precedes mutation. Its fixed app-data path is never accepted from or returned to the renderer. Corrupt, oversized or unwritable journal fails closed. A stale temporary journal may require support repair; the app does not delete it automatically.

## Bounds and safe errors

- Three packaged entries (hard maximum eight), at most 32 assets each, maximum aggregate 32 GiB
- 128 installed model IDs, 200 characters per ID
- JSON: 512 KiB, five-second total request deadline; each explicit inspection has at most four such requests
- NDJSON: 8 KiB per record, 100,000 records, 32 MiB total metadata, 60-second idle deadline, two-hour total deadline
- Headers: 8 KiB; plain UTF-8 JSON/NDJSON only, no compressed responses
- Random opaque inspection/job IDs: exactly 32 lowercase hex characters
- Provider error/status bodies, prompts, paths and arbitrary exception text are never forwarded or logged
- Progress uses only allowlisted asset digests, exact asset sizes, bounded monotonic integers; phases are fixed codes

UI error-code mappings:

| Code | User meaning |
| --- | --- |
| `catalog_invalid_request`, `catalog_invalid_endpoint` | Use an explicit native Ollama literal-loopback address |
| `catalog_inspection_busy` | A device/service check is running or just ran |
| `catalog_inspection_stale` | Inspect the chosen service again |
| `catalog_download_consent_required` | Confirm downloading the fixed catalog model |
| `catalog_entry_unavailable` | This catalog entry cannot be downloaded |
| `catalog_already_installed` | Model already exists; inspect and use manual validation |
| `catalog_existing_digest_mismatch` | Existing tag differs from pinned version; do not overwrite silently |
| `catalog_server_state_unknown` | Connection stopped, but server download state is unknown; overlapping pulls blocked |
| `catalog_server_error` | Runtime reported terminal error; an explicit retry may reuse partial assets |
| `catalog_request_timeout`, `catalog_unavailable`, `catalog_http_error` | Service timed out/unavailable; read the job's serverState before offering retry |
| `catalog_invalid_response`, `catalog_response_too_large`, `catalog_incomplete_stream` | Invalid/bounded response; never imply server cancellation |
| `catalog_asset_mismatch`, `catalog_digest_mismatch` | Runtime artifact differs from pinned catalog |
| `catalog_vision_unverified` | Required image capability metadata was not established |
| `catalog_reinspection_required` | Download failed verification; inspect again and resolve pinned metadata |
| `catalog_cancelled_before_download` | This operation stopped before sending pull |
| `catalog_verification_interrupted` | Pull finished, but installed metadata verification did not finish |
| `catalog_request_interrupted` | Connection was interrupted; consult serverState |
| `catalog_journal_unavailable` | Safe recovery record cannot be read/written; downloads blocked |
| `catalog_invalid_link`, `catalog_link_unavailable` | The selected official source/license link could not be opened |
| `catalog_invalid_job`, `catalog_job_not_found` | Job identity is invalid or no longer present |

## Verification

No real downloads or runtime installs are part of these tests. Run from repository root:

```
node --test desktop/scripts/check-model-catalog.cjs desktop/scripts/check-local-model-discovery.cjs desktop/scripts/check-local-session-main.cjs
node desktop/scripts/check-desktop-contract.mjs
```

Catalog tests use mocked byte streams or controlled localhost fixtures, public metadata snapshots, and isolated temporary journal files. They cover allowlist and consent enforcement, origin/frame guard, no automatic discovery, version/ID/byte/record/time bounds, redirects, wrong digest/vision metadata, repeated clicks, stream disconnect/recovery, fixed-tag retry, cgroup limits and unchanged keyless session-only flow. Real hardware compatibility, public registry download, actual Ollama cancellation, model quality and packaged installer validation remain outside the fixture evidence.
