# Native tasks and activity, first slice

## Product and parity boundary

The authenticated native Preview now has a **Tasks** workspace independent of the
private RC goal executor. It provides manual task creation/editing, user priority
and deadline, manual completion, reversible archive, evidence-linked discoveries,
activity correction, reversible task merge, references, logged time and a saved
next step. No Obsidian installation is required.

MineContext was inspected at `171c7a9ea8091e326ddcf0f10718aa1b58c83c65`:

- [native Todo CRUD](https://github.com/volcengine/MineContext/blob/171c7a9ea8091e326ddcf0f10718aa1b58c83c65/frontend/src/main/services/ToDoService.ts)
- [SmartTodo extraction](https://github.com/volcengine/MineContext/blob/171c7a9ea8091e326ddcf0f10718aa1b58c83c65/opencontext/context_consumption/generation/smart_todo_manager.py)
- [Activity aggregation and resources](https://github.com/volcengine/MineContext/blob/171c7a9ea8091e326ddcf0f10718aa1b58c83c65/opencontext/context_consumption/generation/realtime_activity_monitor.py)
- [Apache-2.0 license](https://github.com/volcengine/MineContext/blob/171c7a9ea8091e326ddcf0f10718aa1b58c83c65/LICENSE)

This implementation is independently written; it reuses product concepts, not
upstream source code. It does not claim full MineContext parity. In particular,
vector retrieval/deduplication, multi-source aggregation, document ingestion,
archived reports, and model-quality evaluation remain separate work.

## Ownership and storage

`backend/app/modules/task_activity/` owns additive `work_*` SQLite tables in the
existing application database. `work_tasks` is the authoritative user-work record;
`agent_runtime.tasks` is an executable plan-step record and is not a user task.
An optional validated `runtime_goal_id` reference is a bridge only. It grants no
execution approval, creates no runtime goal, and never copies runtime completion
into user completion. Existing `PrivateRcRuntimeService` restrictions stay intact.

Activity records are either explicitly entered user time intervals or references
to native `context_observations`. Source title/summary is projected from the source,
not duplicated in the activity. Many-to-many links carry relation, confidence,
origin, decision and primary time allocation. User corrections dominate automatic
links, including after merges. Merge stores a reversible parent reference, so
source records, resources and links remain recoverable without destructive moves.
Archive is the reversible task deletion mechanism in this slice.

All mutations use serialized SQLite transactions and version preconditions.
Manual task/activity/resource creation uses a UUID command key plus exact request
hash: retries cannot duplicate a successful command, and changed-payload reuse
fails. A lost reply is not proof that a mutation failed.

## Discovery and production wiring

Task discovery is off by default and requires an explicit setting confirmation.
Manual tasks work with no observation permission or model configuration.
Enabling discovery does not start capture, configure a model, read MineContext,
open files/URLs, add a source, or grant runtime execution.

The production observation queue calls task processing after an existing authorized
observation finishes. Explicit bounded sync recovers unprocessed retained records;
it consumes at most 200 records in rules mode, or one model extraction per request,
and reports whether more may remain. Automatic task processing inherits the
capture job cancellation; task shutdown also cancels in-flight extraction. Only
current-consent public-window records captured since discovery was enabled
are eligible. Successful organized observations use their existing exact grounding.
A model-unavailable observation can instead use its original, verified post-mask
Tesseract OCR when the image digest, source verification and bounded text all match
and the reason is an explicitly allowed organization/model failure, including a
rejected optional temporal comparison. The rejected comparison/title/summary is
never promoted; only independently verified original OCR is used. Privacy, capture,
authorization and malformed OCR failures are not converted into evidence. The
original organization state is preserved; the activity is labeled unorganized OCR
and quotes exact lines, with no invented model summary. Rules therefore work without
a configured organization model, and local task extraction can also use these
verified excerpts without requiring upstream model success. Old history is not
silently imported, and no scanner starts on launch.

Two providers are available:

1. `evidence_rules_v1` is the default, deterministic and network-free. It recognizes
   `TODO(me): ...` / `我的待办：...` (including OCR whitespace such as
   `TODO (me) : ...`) as explicit unfinished self-assigned task clues.
   `TODO: ...`, `待办：...`, `可能需要：...`, and Markdown unchecked items produce
   pending discoveries. These are still unverified document statements.
2. `local_model_v1` must be explicitly selected and confirmed. It uses an already
   configured/validated local text Gateway, with no API key/custom route, and a
   fixed engine-authored JSON schema. Input is one complete independently verified
   original post-mask OCR record, preserving source order, line breaks, attribution,
   negation and completion context. Its descriptor carries observation/evidence
   identifiers, image/text digests and the exact Unicode span from zero through
   the full text length. Optional organization summaries or selected quotations
   are not substituted for that original record. A replaceable provider proposes
   task text, exact quote, assignment/completion uncertainty and confidence.
   Validation checks quote ancestry, shape, length, finite confidence, current source evidence,
   settings and Gateway revisions at dispatch and commit. A sealed extraction receipt
   is checked under the model-settings lock and Gateway policy lock before the
   final SQLite transaction; those locks remain held through commit. Output is data,
   not instructions. No prior tasks, raw screenshots or extra observations enter
   this call. Invalid output has no fallback or partial proposal commit.

### Complete-input budget decision

The earlier three-line/200-character model input could select window chrome and
omit an ordinary action, or omit the qualifier needed to interpret it. A heuristic
ranking/grouping candidate was rejected after real OCR collapsed paragraph gaps
and independent tests exposed dropped attribution or wrapped negation. Passing
synthetic selection tests did not establish a safe or useful input contract.

The local task-model path therefore sends a complete record or abstains. The
rendered engine prompt plus serialized descriptor is limited to 2,560 UTF-8 bytes,
with Unicode serialized directly rather than expanded into ASCII escapes. Its
separate task-only Ollama-native profile requests a 4,096-token context and retains
the 768-token output cap. The supported local OpenAI-compatible protocol uses the
same complete-input byte cap and output cap; context size remains provider-configured,
and no unsupported context parameter is invented. The observation profile and
transport deadlines stay unchanged. This budget leaves explicit context headroom but is not a proof of
provider-specific tokenizer behavior or model quality. Original capture storage
limits (2,000 characters and 6,000 UTF-8 bytes) and all consent/evidence eligibility
checks remain unchanged.

If a complete verified record cannot satisfy the task input checks/budget, the
valid Activity remains, extraction records `task_context_incomplete`, and no model
call or automatic fallback occurs. That state is distinct from a successful empty
proposal result. No sentence or qualification is silently cropped to fit. Full
input means this one authorized OCR record; it does not establish comprehensive
knowledge of the user's work or prove that first-person document text belongs to
the user. Examples, simulated work, third-party assignments and unclear ownership
remain unverified context under the model's existing classification contract.

The prompt requires reading the entire record before classifying: document-wide
disclaimers take precedence over first-person wording, completed/cancelled actions
are excluded, and a quote must include the action and relevant subject/conditions.
The title is copied case-sensitively from that same quote; candidates requiring
more than the existing 200-character quote bound are omitted rather than cropped.
These instructions do not prove compliance. JSON Schema cannot enforce ancestry
or authorship; the unchanged engine validator rejects any title outside its quote
or quote outside the supplied source. Semantic ownership still requires separate
model evaluation; the current quality gate requires confirmation of every model proposal.

The deterministic rule provider retains its earlier explicit-marker scope and
bounded excerpt selection. It is not general natural-language task recognition;
its excerpt view is incomplete. Do not treat its absence of a task as evidence
that the source contains no work, or use its selected excerpts as proof of local
model extraction quality.

An eligible, source-validated Activity is committed before optional task-model
extraction. It can therefore remain visible while that extraction is slow or
fails. This record is a zero-duration source reference, never a fabricated model
summary or a claim that extraction succeeded. Proposal publication retains its
source/settings/Gateway revision and authorization fences. A separate durable
extraction receipt distinguishes completion (including a valid empty result) from
failure; an Activity alone is not a completion receipt. Failed extraction does not
automatically retry or change providers. Explicit bounded sync can retry it after
rechecking current consent and evidence. Legacy indexed activities remain treated
as completed so upgrade does not redispatch historical work. Failed or abandoned
attempts remain retryable after restart, but opening the service never dispatches
them. Extraction is serialized per database across service instances in one
backend process; multiple OS processes sharing the same database are unsupported.
An attempt fence still rejects stale proposal publication. Completed extraction
can reconcile a later exact-source `same_topic` link in deterministic-rule mode
without calling the provider again, and explicit user link corrections still
take precedence. Experimental local-model mode does not auto-accept these links.

### Content-free extraction diagnostics

Failed extraction exposes a fixed code, never raw provider output, exception
text, endpoints or source text. The native bridge forwards these codes only for
the exact Sync POST and a bounded single-field error response. The UI reports
them separately from a genuine optimistic `version_conflict`:

- `task_context_incomplete`: complete source/input budget checks failed.
- `invalid_discovery_result`: JSON, schema, scalar bounds or duplicate checks failed.
- `discovery_source_mismatch`: an otherwise valid title/quote failed exact ancestry.
- `discovery_authorization_changed`: source, consent, settings, route or cancellation fences changed.
- `local_model_unavailable`: the configured local route is missing, unsupported or unverified.
- `local_provider_failed`: the local provider request failed.
- `local_provider_timeout`: a trusted transport timeout was identified.
- `invalid_provider_response`: the provider envelope or completion protocol was rejected.
- `local_discovery_failed`: an unknown/internal failure; no guessed diagnosis.

The existing version-qualified settings `last_error` stores the latest failure
category, not per-Activity history. Extraction receipts retain state and attempt;
no raw response or diagnostic payload is added. Exact grounding and all-or-nothing
proposal rejection remain unchanged, and source withdrawal still invalidates
Activity even when an error would otherwise preserve it. These diagnostics do not
turn a failed extraction into an empty successful result or trigger retries.

High-confidence self-assigned unfinished deterministic-rule proposals can create
reversible tasks within the existing explicit-marker scope. Local-model extraction
is experimental and confirmation-only: every new model proposal remains pending,
even at high confidence or when its title exactly matches an existing task. It
does not automatically create tasks or accept associations. Explicit user acceptance
can create/reuse a task and its source link; dismissals and prior corrections remain
authoritative. Existing user-confirmed records are not rewritten by this gate.

This gate follows a fixed five-case synthetic evaluation on the existing local
model: one passed and four failed. The positive, simulated and third-party controls
produced headings/disclaimers instead of actions; the completed control returned
empty correctly; the ambiguous control violated exact title-in-quote grounding.
No resampling, validator relaxation or additional prompt tuning was used. These
results do not support automatic model task creation. Restoring that capability
requires separate credible quality evidence and an explicit product decision.

Tasks retain their persisted provider: rule discovery or local-model extraction.
Manual tasks remain labeled manual; older records without provider metadata remain
unknown. They are never retroactively described as model output. Quotes establish traceability,
not semantic correctness or the identity of the writer. AI tasks have no inferred
deadline and are never auto-completed. Exact normalized task titles may deduplicate
or link; semantic similarity never silently merges distinct work. Dismissed
suggestions and archived tasks suppress repeated automatic creation. If the sole
matching AI record lost its unadopted source text, fresh evidence becomes a new
pending discovery; confirmation creates a recoverable record without silently
restoring the old invalidated source. Pending discoveries are ordered before
accepted history, with a total/remainder count; resolving the displayed batch
reveals the next pending records.

Existing exact-source `same_topic` observation relations add **possible** task
links. A relationship is not proof of productive work or actual progress. Users
can accept, reject or change its type and primary allocation.

## Evidence, references, time and resumption

Observation media is checked by owned opaque ID and file metadata, never opened by
this module. Optional organization retries do not invalidate previously verified OCR evidence;
its task/activity projection remains readable while new discovery stays blocked
during queued/processing or interrupted organization. Capture stop does not grant
new discovery, and actual source revocation, expiry, deletion or missing media still
invalidates it. Invalid persisted OCR records receive an ID/state/reason-only
rejection receipt, never an Activity, so bounded sync can advance; a changed
organization state/reason can be reconsidered.

Source deletion/revocation/reconfiguration synchronously invalidates
derived activities and clears copied discovery text and unowned AI task text via
SQLite triggers. Reads also reconcile expiry/missing evidence. User-edited or
explicitly adopted task text remains user-owned, while unavailable evidence stays
visibly unavailable. User resources and next steps remain explicit user content.

Resource references are inert labels/IDs or text entered by the user. They grant
no read/open permission; URLs and file paths are not navigated or dereferenced.

Native observations are zero-duration sample points. The first-to-last observed
span is presented separately and never counted as work. There is no new foreground,
idle, lock, background-app or all-window monitor. Therefore automatic active-time
estimates are not currently produced. The schema supports estimates for future
independently authorized sources, but this is not a claim of an implemented sensor.

User-entered intervals count only when explicitly assigned a primary task.
Half-open interval partitioning prevents duplicate time across overlapping
activities, sources and merged tasks. Manual intervals outrank estimates; otherwise
the earlier-entered interval wins. This is an auditable allocation convention,
not a judgment of productivity. A primary owner can be corrected. No time interval
is filled from sampling gaps, idle, lock, sleep, background windows or restart.

An explicit user next step wins over automatic context. Without one, a valid recent
linked activity supplies only a task/activity-level return point. No window is
switched and no editor line, cursor or chapter is invented. Active reminders and
attention scoring are out of scope.

## Refresh and unfinished edits

The visible task workspace rereads on focus/visibility changes and at a bounded
30-second cadence, skipping background reads while a draft or mutation is active.
A same-task refresh retains the detail panel, expanded evidence, focus and action
nodes while it is in flight and across ordinary version updates. New navigation,
a failed read, authorization loss, or newly withdrawn evidence still hides stale
content. A mutation aborts older reads before reconciling its result.

Task, checkpoint, resource, activity-association and merge drafts keep the version
at which editing began; merge also keeps the chosen target version. An unrelated
successful action cannot silently rebase these versions. A conflict preserves the
draft without replaying it and asks the user to cancel and reopen the current
record. A newly withdrawn task/activity/resource/checkpoint projection overrides
unfinished editors, including on user-owned or confirmed tasks; already-redacted
content does not repeatedly remount on later refreshes. Successful saves reset
their own editor, while unrelated drafts remain fenced.

### Explicit asynchronous Sync

Manual Sync returns a durable operation receipt rather than holding the native
request open for extraction. The shared native IPC deadline remains 15 seconds;
no global or Gateway deadline/scheduling change is made. Admission and Stop share
a one-second deadline across their coordinator/publication lock and SQLite waits.
This is not a hard bound on HTTP scheduling or arbitrary runtime stalls: an
unanswered start/Stop remains an uncertain result. Only these exact mounted
native Sync routes skip redundant request-time demo database initialization;
normal startup initialization and outer session authentication remain required.

One managed runner per canonical database shares the existing extraction lane.
A model operation selects at most one source; a rule operation selects at most
200, under the frozen discovery settings version. Different request UUIDs arriving
while a user operation owns the lane alias that operation without queuing another
batch. Automatic processing already owning the lane produces a durable no-dispatch
receipt instead. Replaying either kind of request cannot become a later retry.
Request hashes include the exact normalized settings version, unlike ordinary
task CRUD command hashes.

`work_sync_operations` stores identities, state, revisions and counters without
raw source/model text. `pending`/`stopping` are unsettled; `complete`, `error` and
`interrupted` are terminal. Selected/attempted/processed/new-Activity/invalid-skip
counts describe committed events, not model calls, new tasks or model quality.
Activity/attempt counters and completed extraction counts commit with their
underlying records. `has_more=null` means selection has not yet established a
backlog. A successful empty extraction remains different from failed/withdrawn
evidence or an interrupted request.

Stop sets cancellation and fences publication without acquiring model settings
or Gateway locks. Already committed work is retained. The operation publication
gate covers individual transactions only; publication order remains model
settings, Gateway, operation gate, then SQLite. A provider that ignores physical
cancellation keeps an unsettled stopping operation until it unwinds; no new worker
is admitted in the meantime. Late Stop cannot rewrite an established terminal
outcome. Worker joins occur outside all these locks. Shutdown bounds its entire
cancellation/finalization/join attempt and reports failure when the worker cannot
settle. If final bookkeeping meets temporary storage contention, the same owned
runner retries bookkeeping only; it never repeats extraction or provider dispatch.
The lane remains owned until durable settlement and release. A true restart
interrupts orphaned operations without redispatch; constructing another live
service never adopts or interrupts an existing same-process worker. Sharing one
database between multiple OS processes remains unsupported.

The UI keeps Sync separate from task-edit busy state, so navigation, independent
Activity reads and draft/version/privacy protections remain available. Visible
status polling uses GET only. Session storage retains only a bounded request UUID
and settings version across navigation/renderer reload, never task/source/model
text. Authorization failure from any workspace request clears cached task and
operation projections and fences stale replies; the opaque request identity may
remain for later authorized reconciliation. A lost POST or Stop response does not trigger an automatic retry or claim
cancellation. Exact-ID GET 404 proves absence only at that lookup: a delayed
original POST could still arrive. Its identity remains uncertain; an explicitly
resubmitted admission uses the identical UUID/version. A genuinely new retry is
permitted only after the prior request is known to be settled or not dispatched.

JSDOM checks assert node identity, focus, expanded evidence, draft/version fences,
privacy transitions and stale-response rejection. They do not measure browser
scroll geometry; native UI acceptance must verify actual scrolling and Undo.

## API examples

All routes require the existing native local session middleware; they are not
mounted in hosted/demo or tokenless composition. Desktop IPC admits only listed
verbs and paths. Responses are `private, no-store`.

```json
POST /api/tasks
{"command_id":"11111111-1111-4111-8111-111111111111","title":"Review public fixture","priority":"high","due_at":null}
```

```json
PATCH /api/tasks/task_<id>
{"expected_version":1,"status":"doing","due_at":"2026-10-15T09:00:00+08:00"}
```

```json
PUT /api/task-activity/settings
{"expected_version":1,"auto_discovery":true,"provider":"evidence_rules_v1","confirmed":true}
```

```json
POST /api/task-activity/sync
{"command_id":"22222222-2222-4222-8222-222222222222","expected_version":1}
```

Start returns `{operation, reason}` with HTTP 202 while unsettled, otherwise 200.
`GET /api/task-activity/sync` reads the latest operation; `GET .../sync/{command_id}`
reconciles that exact request (including aliases). `POST .../sync/{command_id}/stop`
with `{}` stops that operation, or returns its existing terminal result. GET and
Stop never start extraction. Reusing a request UUID with another settings version
returns `command_conflict`; a fresh stale-settings start returns `version_conflict`.
An exact lookup's fixed `task_sync_not_found` is absence-at-lookup evidence only.

`GET /api/tasks/{id}` returns task, activity timeline, references, time summary,
checkpoint and reversible merged children. `PUT .../activities/{activity_id}`
corrects a link. `POST .../merge` includes source and target versions;
`POST .../unmerge` restores the source. `409 version_conflict` requires refresh.
Model failures return only bounded error codes; arbitrary provider output is never
logged or returned. `GET /api/task-activity/settings` exposes provider capability
and latest failure separately from the enabled setting.

## Migration, rollback and verification

Schema creation is additive and idempotent; existing capture/source tables are
not migrated. Rolling back the application code leaves the inert `work_*` tables
and user records intact. Never drop these tables as part of app rollback. Source
cleanup triggers remain compatible with the older capture deletion paths.
Test rollback on an isolated synthetic copy by running the old capture initializer
and capture CRUD against a database containing the task tables, then reopen with
the new service. No real database migration/test is authorized by this change.

```sh
PYTHONPATH=backend python -m unittest discover -s backend/app/modules/task_activity/tests
cd frontend && npm run test:task-activity && npm run build
```

Synthetic service/HTTP/DOM and mocked Gateway tests establish contract behavior.
They do not establish real model extraction quality, Windows native UI acceptance,
or unrestricted capture support. Those stages require separate explicit evidence.
