# Capture provider contract: native OS and external hardware

Status: **non-integrated framework, synthetic tests only**. Checked 2026-10-02 UTC.

## Scope and current reality

`desktop/src/capture-providers.cjs` is an additive contract seam. It is not imported by
`main.cjs` or `capture-controller.cjs`, does not replace their consent/preview gates,
and does not establish a new production acquisition path. This change does not
connect hardware, accept endpoints or credentials, enable MCP, read a real screen,
run a model, install software, or send input/control commands. No scheduler, network
transport, persistent store, or production adapter is included.

The immediate target device is **NanoKVM Go+** (the user's “Nano KVM GO Plus”),
not an assumed interchangeable NanoKVM Go, Cube, PCIe, USB, or Pro. Other capture
vendors can implement the same source contract after separate review.

Existing native capture and the dedicated-public-window experiment remain separate
runtime paths. This module makes no claim that Linux full-screen application identity
or lock protection has become available.

## Official facts and boundaries

Sources checked directly on 2026-10-02:

1. [Sipeed model introduction](https://wiki.sipeed.com/hardware/en/kvm/NanoKVM_Go/introduction.html)
   explicitly lists user-enabled MCP for both Go and Go+. Go+ additionally supports
   Memory Fabric and Screen Timelapse. Thus Go+ support is established by the model
   documentation, not inferred just from the Go-named MCP guide. Actual firmware,
   application version, video source compatibility, and device capabilities remain
   unverified until the purchased unit is available.
2. [MCP guide, Chinese](https://wiki.sipeed.com/hardware/zh/kvm/NanoKVM_Go/mcp.html)
   and [English](https://en.wiki.sipeed.com/hardware/en/kvm/NanoKVM_Go/mcp.html)
   describe a device-displayed endpoint and API key and both viewing and control
   functions. They do not establish a universal screenshot tool name/schema.
   This framework implements neither discovery nor invocation. The guide includes
   a TLS-verification-disabling example; **do not copy that workaround** into an
   adapter. Device certificate trust requires a separately reviewed secure setup.
3. [Go+ Memory Fabric guide](https://wiki.sipeed.com/hardware/zh/kvm/NanoKVM_Go/memory_weaving.html)
   specifically excludes non-plus Go. It describes approximately ten-second
   sampling of changed screens and OCR-derived records, not continuous recording
   or default screenshot history. Short-lived or graphical activity can be missed.
   Screen replay is a separate feature. Recognized content may go to the configured
   model service; its model key differs from the MCP key. Therefore device-produced
   OCR/memory must not be labeled locally redacted or assumed eligible for strict mode.
   Saving model settings is not evidence that a model call or capture/query succeeded.
4. [Sipeed FAQ](https://wiki.sipeed.com/hardware/zh/kvm/NanoKVM_Go/faq.html)
   warns that capture may show an extended display rather than the user's primary
   display. Setup must verify the selected source; mirroring or primary-display
   changes remain an explicit user choice. USB-C DP Alt Mode and a full-featured
   cable are required for video. The 4K50 EDID is Beta and must not be the assumed
   default. Removing auxiliary PD power can reboot the unit even when the data
   cable remains connected: record a gap, rotate generation, invalidate consent,
   and never reuse a cached frame as a new observation.

Vendor capability, implemented adapter capability, connected-device capability,
and per-source authorization are four separate facts. Documentation alone sets
none of the latter three to ready.

## Public module API

Run the focused contract checks from the repository root:

```sh
node --check desktop/src/capture-providers.cjs
node desktop/scripts/check-capture-providers.cjs
```

Exports:

- `canonicalSourceId(providerId, localId)` returns `providerId/localId` with a
  collision-safe restricted identifier format
- `CaptureProviderRegistry.register(provider)` validates/snapshots the provider;
  `descriptors()` lists immutable manifests; `resolve(selection)` requires an exact
  current enumerated source, with no default source or full-screen fallback
- `createPendingProvider(...)` supports future vendor manifests without capture
- `createNanoKvmGoPlusProvider()` is a truthful, inert pending placeholder;
  `listSources()` returns no fabricated device, and acquisition always rejects
- `schemaDigest(schema)` and `inspectMcpCaptureCapability(...)` compare already
  supplied tool schemas against an explicit independently reviewed binding; neither
  calls a tool nor enables transport
- `CapturePipeline.sample({selection, policy})` is an injected, non-integrated
  privacy/evidence seam. It has no timer and defaults to denying authorization

### Provider and source contract

Each provider supplies an immutable descriptor:

```js
{
  provider_id: 'os-native',
  label: 'OS-native adapter',
  kind: 'os-native', // or external-hardware
  status: 'pending', // ready only after implementation/runtime verification
  acquisition_locality: 'local', // or network
  source_kinds: ['raw-frame'],
  capabilities: {
    raw_frames: 'pending', app_identity: 'pending', visible_apps: 'pending',
    window_capture: 'pending', lock_state: 'pending',
    device_ocr: 'unsupported', device_memory: 'unsupported'
  }
}
```

Every capability uses `supported`, `pending`, or `unsupported`. NanoKVM's
app/window identity and lock-state capabilities are **unsupported** here. Hardware
video alone is not OS identity evidence. A later independently verified companion
could supply source-bound OS evidence; OCR-inferred names cannot do so.

`listSources()` returns zero or more explicit source records:

```js
{
  source_id: 'os-native/monitor-1', local_id: 'monitor-1',
  generation: 'session-1', source_kind: 'raw-frame',
  display_id: 'monitor-1', window_id: null
}
```

`source_id` is stable and provider-namespaced. `generation` changes when the device,
stream, window owner, coordinate geometry, or display mapping changes enough to
invalidate a prior privacy preview. `display_id` is provider-local; a hardware
input is not silently equated with an OS monitor. A non-null `window_id` selects
exactly that window. The caller's selection must match all five binding fields
(`source_id`, `generation`, `source_kind`, `display_id`, `window_id`). The registry
adds the validated `provider_id`; free-form input fields are discarded.

The three media kinds remain distinct:

- `raw-frame`: transient captured pixels, eligible only for reviewed local privacy
  processing and derived observation emission
- `device-ocr`: vendor-produced text from historical screen sampling, not a screenshot
- `device-memory`: vendor-organized memory, a derived interpretation rather than a
  directly observed full action trace

Only the raw-frame pipeline is implemented as a test seam. Device OCR/memory
ingestion remains pending and is rejected by that pipeline. A later record adapter
must retain vendor record ID, source/time range, upstream processing location,
sampling gaps, and derived-evidence status, and must not claim original-image replay
without a separately verified authorized image reference.

### Acquisition binding

A ready raw-frame adapter must provide:

- `inspectSource(source)`: current matching binding, `observed_at_ms`, explicit
  `locked: false`, OS-authoritative `foreground_app` and non-empty `visible_apps`
- `acquireFrame(source)`: matching binding, a transferred `buffer` owned by the
  pipeline, `mime_type`, dimensions, `frame_id`, monotonic `sequence`,
  `captured_at_ms`, `timestamp_authority`, and `clock_uncertainty_ms`

Adapters must select by the exact binding and verify identity before/after native
acquisition. They must never retry a failed window capture as a desktop capture.
They must rotate generation after reconnect/source changes and invalidate previous
consent. Device clocks need a verified host conversion plus bounded uncertainty;
simply stamping receipt time as capture time is not allowed.

The framework rejects missing/stale/future frames, unverified clocks, replays,
binding mismatches, unavailable safety capabilities, unknown/excluded apps, and
locked/unknown sessions. It rechecks inspection after acquisition before processing.
This cannot prove atomicity inside an unreviewed native adapter; that is an adapter
implementation/OS verification obligation, not an inference from passing unit tests.

## Common privacy → OCR/AI → context/timeline seam

The injected dependencies are trusted reviewed code, not a plugin sandbox:

1. Existing privacy authority `privacyGate(request)` returns a current grant bound
   to the exact source/generation/scope, policy fingerprint, policy revision, and
   expiry. The default implementation denies. No factory in this module issues
   grants or treats docs/tool availability as consent. Production integration must
   use existing explicit preview/consent/revocation checks
2. A local `redactor.redact(...)` applies masks and reusable rules to transient raw
   pixels. A local detector may support suggestions/corrections in a later reviewed
   implementation; this framework supplies no detector/model. Output carries
   `redaction_policy_revision`, `policy_fingerprint`, `detection_status`, and
   `uncertainty.review_required`. Changed source or rule content invalidates old
   approval. Unavailable/review-required detection blocks downstream analysis
3. The redactor transfers a separate masked buffer. Raw pixels are wiped before
   `analyzer.analyze(...)`; both buffers are wiped on success/failure before emission
4. A local OCR/AI analyzer receives only that masked buffer. The current seam refuses
   external analysis even outside strict mode. An approved external-summary route
   needs a separate reviewed disclosure/consent contract
5. A **local** `publish(event)` sink receives allowlisted text/summary plus evidence,
   or a content-free gap reason. It never receives pixel buffers, screenshot paths,
   tool payloads, error strings, endpoints, keys, or arbitrary analyzer fields

Policy application does **not** mean all personal information was detected. Evidence
explicitly sets `all_pii_detection_guaranteed: false`, `raw_retained: false`, and
`frame_replay_available: false`. JavaScript buffer wiping does not promise erasure
of copies made inside trusted OCR/native libraries; implementations must minimize
copies and remain separately reviewable.

Strict mode also denies network acquisition. Hardware being on the same LAN does
not automatically make it strict-mode-safe. Unknown upstream device-model processing
is not equivalent to local inference.

### Sampling, provenance, and temporal context

There is no background start behavior. Each explicit `sample()` invocation enforces
the declared interval and prevents overlapping same-source acquisition. Too-early
or overlapping calls do not fabricate gaps. Actual failures emit `capture_gap` with
the selected source binding, attempt time, a bounded reason code, and evidence boundary.

An accepted `capture_observation` records source/provider/generation/display/window,
frame ID, capture/receive/emit times, clock authority/uncertainty, age limit, interval,
sequence discontinuities, missed scheduled intervals, and preceding gap. Its stable
evidence ID is `source_id/generation/frame_id`; a future local sink should use this
for idempotency. Sink failure propagates and is never claimed as saved or retried
implicitly. History is process-local and must not be presented as durable scheduling.

Samples support nearby-context reasoning but never assert a continuous operation
trace, complete screen history, confirmed remote state, or proof that the user
performed a particular action. Inferred temporal links need to remain marked as
inference and retain gaps. No screenshot replay is promised by this evidence object.

## MCP and later hardware acceptance

`inspectMcpCaptureCapability` requires an exact tool name, reviewed read-only semantic
binding, source kind, and hashes of both advertised input and output schemas. A
changed/missing schema or duplicate/unknown tool fails closed. `readOnlyHint` is
not sufficient. Even a match returns `operational: false` and
`transport_not_implemented`. No generic `callTool`, keyboard, mouse, HID, power,
shell, configuration, memory-write, or arbitrary MCP executor is exposed.
The generic vendor documentation also does not prove capture-only credential
scope. A future adapter must enforce its own narrow reviewed read-only tool
allowlist rather than giving a model access to all tools associated with a key.

After the unit arrives, separately authorize and verify identity/firmware, source
selection, supported read-only tool shapes, certificate trust, privacy processing
location, consent preview, clock conversion, reconnect/sequence handling, missing
signal, and paused/locked/excluded conditions using an explicitly non-sensitive
test source. Do not enable device memory/model processing or save authentication
as a side effect of capture integration. A safe secure credential flow and explicit
permissions are prerequisites to any persistent connection.

## Integration notes / non-goals

- No current backend/frontend/API schema changes are made by this module
- The parallel public-window runtime uses `source_kind: public_window/full_screen`
  to describe **scope**. This module's `source_kind` describes **media kind**.
  Future integration must map the two explicitly, ideally rename media kind at the
  boundary, and retain public-window scope/identity/consent provenance
- The bounded dedicated-public-window experiment has an explicit unknown-lock
  limitation. It is not registered here and does not relax this generic pipeline's
  full-screen safety requirements. A dedicated-scope adapter requires its own
  reviewed policy contract and tests, not capability flags pretending lock is known
- Tests use synthetic byte buffers and injected functions only. They prove contract
  behavior, not real NanoKVM connectivity, OS capture, image redaction accuracy,
  firmware support, UI preview quality, hardware performance, or external model safety
- Existing runtime capture remains authoritative until a separately reviewed
  integration preserves its consent/preview, pause, retention, and evidence gates
