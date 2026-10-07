# Local goal-loop milestone

This is a durable local goal-loop prototype with a default deterministic planner
and a separately selected local synthetic text-model planner. A new explicitly
consented synthetic conversation surface can answer or propose a local goal for
review and adoption. It is not a general personal-data assistant or a live collector. It uses the
`agent_runtime` product module, never the engineering `tools/nightly` scheduler.

## What actually runs

- A separate `agent_runtime.sqlite3` file under the configured local data
  directory stores sources/consent, typed evidence/assertions, goals, versioned
  plans/tasks/approvals, actions/receipts, wakes/runs/checkpoints, conversations,
  and API command receipts.
- The app mounts `/api/agent-runtime` only for local Preview mode with a valid
  session token. Public/demo and stable legacy chat paths do not gain this
  runtime. Existing Host/Origin/loopback/session checks remain in force.
- The runtime defaults to disabled. Explicit enablement persists across
  restarts independently of screen capture. Restart does not authorize or
  resume capture.
- A stoppable in-process supervisor waits for a local event kick or persisted
  deadline/lease/expiry. It does not install an OS task or poll a model. Quiet
  deadlines do not postpone privacy-expiry maintenance.
- Only local plan preparation, local inbox notices, and local questions exist.
  There is no external executor, calendar write, message sender, OS notification
  integration or live source connector. Optional model planning uses a dedicated
  text-only Gateway restricted to separately approved synthetic loopback data.

## User-facing control plane

Preview's `/assistant` page shows persisted conversation notes, explicit target
and success-predicate goal creation, candidate activation, exact-ID/version
pause/resume/cancel, wait/checkpoint/evidence information, and local inbox read
controls. Reading a notice never completes a goal. The first-run guide offers
local chat without enabling sensors. Legacy stable Chat is preserved.

Legacy `/chat` free text remains a note; it is not interpreted as tool authority
or a command. New `/conversations` text is processed only after separate
per-conversation synthetic-only consent, and remains untrusted data. Structured evidence ingestion is API/test-fixture-only for now. The
page exposes an explicit rule/model planner choice and clearly labels the model
mode's synthetic-only boundary. Legacy notes and `user_statement` are never submitted to the model. Only the
new separately consented synthetic conversation surface dispatches user-entered
synthetic dialogue; the prototype is not general personal-data model chat. It reads state every 30 seconds only while
visible, skipping in-flight writes/reads and cleaning observers on unmount.
Those UI reads are distinct from backend planner/model activity.

The UI supports a one-off UTC quiet-until time, UTC daily local-notice budget,
and global notice cooldown. These are not a recurring local-time quiet-hours
calendar. Lists are capped at 100 entries in this Preview surface.

Source revoke/forget optimistically hides dependent local content in the UI while
preserving an explicit unconfirmed state until a receipt/fresh read verifies the
outcome. Committed withdrawal also scrubs stored model proposals. A scope change
can wait for an already-dispatched bounded local model call; it cannot retract
bytes already sent.
Mixed source generations and withdrawn completion proof cannot show stale
content as verified. Source forgetting affects that source and its derived
content; conversation notes, other sources and minimal effect receipts are
separate. SQLite forgetting is logical, not forensic erasure of WAL/backups.

## Main route contract

Reads: `/status`, `/sources`, `/evidence`, `/goals`, `/goals/{id}`, `/inbox`,
`/runs`, `/chat`, `/planner`, `/commands/{command_id}`, and the separate
`/conversations` read/reconciliation routes under `/api/agent-runtime`.

Explicit writes: `/enabled`, `/settings`, source `/grant|revoke|delete`,
`/evidence`, `/goals`, goal `/activate|control`, inbox `/{id}/read`, `/chat`,
`/planner/configure`, `/planner/select`, and the separate conversation consent,
revoke, turn-send and proposal-adopt endpoints described below.
Goal PATCH changes require an expected version. The desktop bridge narrowly
admits these routes; no generic run/execute/force-complete endpoint is exposed.

Only fixed `synthetic` and `user_statement` source identities are accepted.
Source grants require `confirmed: true`. Ingested provenance is assigned by the
server and explicitly untrusted; it cannot claim verified remote-system facts.
Mutations bind a command ID to the full canonical validated intent, including
omitted versus explicit-null fields. Reused IDs with changed payloads conflict.
Completed exact replays return receipt metadata and do not repeat effects.
Reservation, service mutation and command receipt share one transaction; a
pre-commit crash can safely retry the same intent.

## Local synthetic text-model contract

Configuration and selection are explicit, separate operations. Configuring a
loopback OpenAI-compatible or Ollama-native text route requires confirmation of
synthetic-only processing and sends a manual fixed `READY` probe. No API keys,
external endpoints, thinking mode, new sources or image routes are admitted.
Successful nonsecret validation and planner selection persist; restart restores
the exact record without an automatic startup probe. A later provider outage
backs off safely, with no silent deterministic fallback.

A due, approved synthetic goal may receive a model-authored draft summary and
one to four short plan steps. The UI labels these `proposed_unverified`; they
are nonexecutable display text, not commands or authority. Only fixed local
prepare/notice/question action keys can execute. Exact fresh authorized evidence
remains necessary for completion independently of anything the model claims.
Prompts are bounded to 10,000 characters and eight evidence records, and strict
JSON responses to 4,096 characters. Hidden reasoning, unknown references/tool
fields, malformed output and truncated provider envelopes fail safely.

Automatic model use has a conservative 20-attempt UTC daily limit, separate from
the local-notice budget. Attempt reservations commit before HTTP dispatch so
restarts, crashes and failed or abandoned attempts cannot refund usage. Exhausted
work waits until the next UTC reset; it cannot complete or hot-loop. Explicit
manual validation probes are separate. There are zero automatic calls when
idle/disabled or for paused, cancelled, withdrawn or expired scopes.

The engine serializes scope validation and transport with SQLite write locking.
The local HTTP exchange has a hard total 10-second deadline, including slow
headers and bodies. Scope changes may wait for an already-dispatched exchange;
once committed, withdrawn data cannot be newly sent. Old output is rejected if
planner identity/revision, policy, consent, goal/plan, lease or evidence changes
before application. Draft text is scrubbed when any of its authorized inputs
expire or are withdrawn, even if the model did not cite that input.

## Explicit synthetic conversation and goal adoption

`ConversationService` uses separate `natural_*` tables and never reads legacy
notes. A named conversation is created only by explicit consent, bound to the
current validated local text-route revision/identity and active `synthetic`
source generation. Planner/model consent alone never authorizes conversations.
The goal planner may remain deterministic; runtime enablement is independent.
No conversation constructor, read, restore, idle path or retry timer calls HTTP.

Under `/api/agent-runtime/conversations`:
- `GET /` lists up to 100 summaries; `GET /{id}` returns up to 100 durable turns
- `POST /{id}/consent` takes a standard `command_id`, `confirmed: true`, exact
  `expected_route_revision`, `expected_source_version`, and `expected_version`
  (`null` only for a new named conversation)
- `POST /{id}/revoke` takes `command_id` and exact `expected_version`
- `POST /{id}/turns` takes a durable `request_id`, synthetic `content` (up to
  2,000 characters), exact conversation `expected_version`, optional paired
  `goal_id`/`expected_goal_version`, up to eight explicit `evidence_ids`, and
  optional `retry_of`. There is no latest-goal default
- `GET /{id}/turns/{request_id}` reconciles a lost reply without sending again
- `POST /{id}/proposals/{proposal_id}/adopt` takes a durable `adoption_id`, exact
  proposal `expected_version`, and `confirmed: true`
- `GET /{id}/adoptions/{adoption_id}` reconciles an atomic adoption receipt

A fresh dedicated strict Gateway uses only the already-validated text route.
Prompts are bounded to 10,000 characters, four prior completed turns and eight
explicit evidence records. All included prior-turn, exact-goal and evidence
inputs remain dependencies, even when output does not cite them. Responses are
strict JSON limited to 4,096 characters and only `answer`, `question`, or
`proposal` dispositions. Ambiguity asks a question with no adoptable proposal.
A server-side gate additionally requires the proposed exact target and typed
scalar success predicate to be anchored in current user text or explicitly
selected structured evidence/goal context. Old dialogue never selects a latest
goal. Unanchored suggestions become a fixed local question (`reply_kind:
clarification`); actual model replies use `reply_kind: model`. This conservative
synthetic boundary does not claim to prove language understanding or correctness.
Free-form target/predicate inference remains constrained and unverified; users
may need to provide exact synthetic identifiers/event names/JSON scalar values.
Unknown fields, tool/hidden-reasoning envelopes, unknown references, unsupported
predicates and malformed output fail closed. Answer/proposal text and the
bounded plan summary/steps are untrusted and unverified display text, never
executable actions or evidence of completion.

Send commits an `outcome_unknown` request reservation before HTTP. It must not
run inside the generic command transaction. Exact duplicate IDs return persisted
state, while changed payloads conflict; there is no automatic resend after a
crash or response loss. Only a new explicit request with `retry_of` can retry an
unknown/failed attempt after its 15-second dispatch window. Live pending requests
fence overlapping sends. The bounded transport and fresh dependency guard run
under a serialized transaction; stale or superseded dispatches cannot send.
Explicit manual conversation sends do not consume the autonomous planner's
20-attempt UTC daily budget. They have separate durable one-request dispatch
reservations and no automatic retries.

Adoption revalidates consent and every input, then atomically creates and
activates one new local goal together with its immutable receipt. It never
auto-enables the runtime or changes/cancels an existing context goal. Existing
exact-ID/version pause/cancel controls remain the only controls. Already-adopted
goals retain all underlying data dependencies, including uncited/cross-target
context; data withdrawal pauses and tombstones the derived goal. A later model
route change alone does not cancel an independently adopted goal.

Readable dialogue persists only within its consent epoch. Route changes,
conversation consent renewal/revocation, and source withdrawal irreversibly scrub
both synthetic user dialogue and derived output/proposals from these tables.
Reconsent cannot restore prior text. Individual evidence/goal invalidation also
scrubs dependent turns and their history-derived descendants. Minimal IDs and
truthful receipts remain; legacy notes stay separate. This remains logical
SQLite forgetting, not forensic WAL/backups erasure.

## Completion and recovery proof

```text
authorized typed open commitment
  -> candidate
  -> explicit version-scoped activation
  -> plan and durable wait checkpoint
  -> process killed and restarted
  -> fresh, exact, authorized matching evidence
  -> verified local predicate completion, once
```

Completion verifies admitted local evidence against the exact target, event and
typed JSON value. It does not independently verify the outside world's truth.
Boolean `true` cannot be satisfied by numeric `1`. Source generation, expiry,
goal/plan/approval versions, enablement epoch and lease are checked independently
of the replaceable planner. Model/planner failure, budget exhaustion, silence,
deadline passage and notice delivery never stand in for success evidence.

Local outbox insertion, action receipt and checkpoint commit together. After
response loss or process death, the engine checks the receipt before retrying.
Cancellation and revocation prevent new effects while preserving truthful
receipts for already committed effects. This is exactly-once local insertion,
not a claim of exactly-once external delivery.

## Verification and limits

```sh
PYTHONPATH=backend python -W error::ResourceWarning -m unittest discover -s backend/app/modules/agent_runtime/tests
cd frontend
npm ci
npm run build
npm run test:agent-loop
npm run test:planner-model-settings
npm run test:natural-chat
```

Natural conversation tests additionally cover both real local HTTP protocols,
restart/reply/adopt, ambiguity, malformed output, exact references, request-ID
conflicts, dispatch/process death, response-loss reconciliation, atomic adoption,
uncited/history dependency expiry, cancellation and no automatic enablement.

Runtime tests include separate processes, concurrent workers, both sides of an
effect crash, atomic API commands, pause/cancel/revoke/delete, wrong/stale/expired
evidence, type-sensitive matching, long-history/source-prefix selection,
quiet/budget/cooldown, backoff, consent expiry, stopped/idle supervision, and chat
deduplication. Synthetic HTTP mock tests exercise both provider protocols,
text-only readiness, strict output parsing, model-authored plan/wait/completion
through process restart, durable quotas, slow-response deadlines and race-safe
proposal redaction. No real provider or real data is used. The local test driver
also kills and restarts the actual FastAPI
process and verifies that old session tokens stop working.

Rendered browser/native UI acceptance remains unverified: the available cloud
browser rejects localhost navigation. Component tests and requested UI
illustrations must not be described as actual app screenshots. Platform capture,
permissions, secure storage, installers and real-model behavior remain separate
release gates. The first runtime is designed for a small Preview store; some
invalidation work scans affected local state and is not an archival-scale engine.


### Rejected conversation receipt recovery

A rejected consent/revoke request is retired only after its exact command GET
returns the bounded `runtime_command_not_found` 404 and a fresh scope/list (and,
for an existing selection, conversation) read succeeds. Desktop forwards that
fixed code only for the exact read-only command route; HTML, arbitrary error
text, malformed JSON, unrelated 404s and transport failures remain opaque.
The identifier-only recovery journal additionally retains definite rejection
status and whether consent attempted a new conversation. A rejected new create
must not repeatedly read its nonexistent conversation, and clears only its own
failed selection after the fresh read. Later explicit reconciliation can use the
same retained rejection after a failed refresh or remount. Receipt absence alone
never authorizes automatic retry, replay, model dispatch or inferred success.

### Mixed runtime snapshot evidence boundary

Goal/evidence/source lists are independent bounded reads, not an atomic view.
The client therefore requires current `goal_tracking` consent, exact source
versions, readable evidence and exact target IDs for goal basis and model plan
content. A positive completion label additionally requires every referenced
completion proof to match the exact event, typed value and post-activation
observation time. Missing proof, including a valid record omitted by the
100-item evidence page cap, projects `unverified`; it does not assert withdrawal
or rewrite the stored `completed` lifecycle. Basis content is hidden when its
IDs cannot be established. Safe explicit controls and unrelated durable goals
retain their state. Local expiry timers also remove unsupported presentation
without dispatching commands or model work.

Public goal details now include `plan.proposal_dependencies`: the existing
engine-authored list of all evidence IDs supplied to the proposal, including
uncited inputs, or `null` when there is no proposal/known dependency projection.
Only IDs are exposed; no prompt, raw model output or new execution authority is
added. Both these dependencies and the proposal's citations must be current in
the same readable client snapshot. Older/malformed dependency projections fail
closed for draft text. This is a display boundary, not a new planner, proof of
external truth, or an authoritative rollback of saved tasks or action receipts.

Unreadable target/predicate/source basis also blocks activating a candidate or resuming a paused goal, both in the controls and immediately before dispatch. Pause, cancel, and source revoke remain available. Optional non-executable proposal withdrawal alone does not block those controls when the goal terms remain readable.
