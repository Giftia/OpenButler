# Local durable goal runtime (next Preview milestone)

This new module is isolated from frozen Phase 1 and uses a dedicated
`agent_runtime.sqlite3`. Importing/constructing it performs no capture, model
call, source collection, external message, scheduler registration, or startup
execution. The parent application owns its optional stoppable supervisor.
Runtime enablement is durable and defaults to **off**, independently of capture.
Only `synthetic` fixtures and explicitly entered `user_statement` sources are
admitted in this milestone.

## Public service contract

```python
from app.modules.agent_runtime import RuntimeService
service = RuntimeService(path, clock=optional_aware_datetime_clock,
                         planner=optional_Planner, fault_hook=None)
```

- `grant_source(source_id, scope='goal_tracking', expires_at=None)` explicitly
  grants source metadata consent; it does not turn on a collector. `revoke_source`
  invalidates consent, derived facts, approvals, wakes and queued actions.
  `delete_source` additionally tombstones source/derived content; it does not
  access or delete any external source system.
- `add_evidence(source_id, source_event_id, target_id, event_type, value,
  observed_at, expires_at=None, provenance=None)` requires current consent and
  immutable event IDs. Incoming provenance is untrusted, never authority.
- Typed `commitment_open` values have exactly `title`, `completion_event_type`,
  `completion_value`, and optional `deadline_at`. They atomically create a
  deduplicated **candidate**, never an active goal. All other free text remains
  evidence. `discover_candidates()` is an idempotent recovery/discovery pass.
- `create_goal(title, target_id, success_event_type, success_value,
  evidence_ids=None, source_ids=None, deadline_at=None, candidate_key=None)`
  creates a manual candidate. It requires an exact target and either valid
  evidence references or explicitly selected consented sources.
- `activate_goal(goal_id, expected_version)` is explicit local approval of the
  exact goal/plan/source versions and only the local action allowlist. Candidate
  version 1 becomes active version 2, with an approval recording version 2.
- `update_goal(..., expected_version, ...)` returns the goal to candidate,
  invalidates approvals and creates a new plan version. Target changes require a
  new goal so evidence cannot be silently reassigned. `control_goal(id,
  'pause'|'resume'|'cancel', expected_version)` never selects an arbitrary latest
  goal. Resume is a new exact-version activation, with a new freshness boundary.
- `set_enabled(bool)` pauses/resumes the entire runtime without affecting
  capture. Disable invalidates active execution leases immediately; queued
  authorized work is retained for explicit enablement. Approval itself is not
  enlarged by enablement.
- `configure(quiet_until=..., daily_notice_budget=..., cooldown_seconds=...,
  max_actions_per_run=...)` changes local delivery policy. Omitted values remain
  unchanged. Daily budget uses UTC days; quiet time is an explicit UTC deadline,
  not a recurring quiet-hours schedule.
- `enqueue_wake(goal_id, kind, dedupe_key, due_at=None)` accepts event/time/user/
  recovery wakes for active or waiting goals. `run_once(max_wakes=10)` processes
  a bounded number of wakes and local actions, with leases and retry backoff.
- `get_goal`, `get_goal_by_candidate_key`, `list_goals`, `list_evidence`,
  `list_assertions`, `list_inbox`, `list_runs`, `list_actions`, `list_receipts`
  expose durable state. Read lists used by the API support bounded `limit=100`.
  `mark_notice_read` only records read feedback; it never completes a goal.
- `append_message(conversation_id, role, content, client_message_id)` and
  `list_messages(conversation_id, limit=100)` persist plain chat; they never
  dispatch a text command. Reused IDs with changed contents are conflicts.

`status()` includes `enabled`, `next_wake_at`, `counts`, `blocked_reason`,
`settings`, planner identity and the local-only boundary. Goal detail includes
versioned plan/tasks, approval, exact wait target, checkpoint, deadline, per-goal
next wake and `verification_status` (`unverified`, `verified`, `withdrawn`).
Plan/task/approval IDs are explicit. All times normalize to aware UTC ISO.

## Evidence-backed lifecycle and local effect semantics

```
authorized typed observation -> candidate -> explicit activation -> active
 -> durable waiting_external -> fresh exact authorized evidence -> completed
```

The replaceable `Planner` protocol returns only decisions. The engine separately
checks current enablement epoch, lease, goal/plan versions, approval, current
source generation, consent scope/expiry, evidence expiry, exact target and event,
canonical type-sensitive JSON equality, and observation/ingestion freshness.
Completion requires observation strictly after activation and an already durable
wait checkpoint. Notifications, planner failures, elapsed deadlines and model
outages do not complete goals. A deadline produces at most one local question
per approved plan and leaves the goal waiting.

Only `prepare_plan`, `inbox_notice`, and `ask_user` exist. Fixed engine-authored
messages and exact plan keys prevent planner text from becoming tool authority.
The local outbox effect, immutable receipt and task checkpoint share one SQLite
transaction; action acknowledgment happens afterward. Recovery reconciles the
receipt before retrying unknown work. This proves **exactly-once local outbox
insertion**, not external delivery. Cancellation/revocation and action commit
serialize with `BEGIN IMMEDIATE`, and effects already committed keep truthful
receipts. No external executor exists.

Source changes never silently resume goals. Revoked/expired evidence and derived
assertions are excluded from public reads; derived goal content is redacted.
Deletion tombstones evidence, assertions, goals and affected run checkpoints;
minimal receipt IDs and generic engine-authored effect history remain. Historical
completed goals become `verification_status='withdrawn'` when proof is withdrawn.
This is logical local forgetting, **not forensic erasure or encryption** of SQLite
pages, WAL files, filesystem snapshots or backups.

Store transactions are reentrant per thread, with nested SAVEPOINTs and a shared
outer connection. The authenticated API command journal can therefore commit a
command receipt and service mutation atomically without storing response bodies.

## Synthetic verification

```bash
PYTHONPATH=backend ../.venv/bin/python -m unittest discover \
  -s backend/app/modules/agent_runtime/tests -v
```

Kernel tests cover separate-process restart, multi-worker contention, both sides
of an effect crash, unknown receipt reconciliation, exact typed evidence,
source/goal/approval changes, deletion/withdrawal, cancellation and disable races,
quiet/budget/cooldown, bounded work, time deadlines and planner backoff. Kernel fixtures never read real context or start native capture. The separate
model-planner suite uses actual Gateway HTTP transport only against generated
loopback mock providers; it never calls a real model or sends personal data.

## Deliberate limits

- Default deterministic planner; opt-in local text-model planning is limited to
  explicitly approved synthetic sources. Separate explicit synthetic-only model
  conversation is available; no live source adapter or personal-data chat
- Actual provider quality and rendered browser/native behavior are unverified
- Local SQLite outbox only; no OS scheduler, external messaging or native sensing
- User must explicitly grant sources, activate exact goals and enable execution
- Legacy conversation notes never dispatch a model or command; separate synthetic
  natural conversation can propose one new goal for explicit adoption
- Completion verifies the admitted local evidence predicate, not an external
  system's truth; source input remains visibly untrusted
- Processing wakes/actions and public reads is bounded; invalidation maintenance
  scans affected local state and is designed for this small Preview database,
  not yet a high-volume archival store


## Opt-in local text-model planner

`PlannerControl` is a stable replaceable planner facade. Its selected mode and
validated nonsecret configuration live in the runtime's existing settings table;
there is no schema migration or credential store. Default selection remains
`deterministic`. `local_model` requires a separately confirmed synthetic-only
local text configuration, followed by explicit selection. Existing image/text
settings and their consent are neither changed nor inherited.

```python
from app.modules.agent_runtime.model_planner import ModelPlanner
from app.modules.model_gateway import Gateway, ModelRoute
from app.security.privacy_guard import PrivacyGuard

planner = ModelPlanner(Gateway(PrivacyGuard()),
                       allowed_sources=frozenset({"synthetic"}))
# Explicit manual operation, using a synthetic loopback mock in verification:
planner.configure(ModelRoute("openai_compatible", "local",
                             "http://127.0.0.1:PORT/v1", "synthetic-fixture"),
                  consent=True)
```

The manual configure operation sends only a fixed synthetic `READY` probe.
Only HTTP loopback routes without API keys or thinking mode are accepted.
`Gateway.configure_text` proves independent text readiness and returns its exact
committed revision. Existing paired image/text readiness semantics are unchanged.
The control API persists the exact exported validation record after success.
Internal restart restore validates that record's exact schema, route and source
scope without probing or sending anything. Restored readiness means prior
validation, not proof that a provider is currently running. Failed due calls use
backoff; model mode never silently falls back to deterministic mode.

`ModelPlanner.decide` deliberately fails closed. The engine uses
`decide_guarded(..., dispatch_precondition=...)`, binding the planner object,
configuration revision, enablement epoch, exact lease/goal/plan/approval/source
versions and all included evidence. The engine repeats those checks immediately
before transport and after the response, including the final apply transaction.
Only current selected synthetic sources may be transmitted; prior
`goal_tracking` consent does not authorize transmitting `user_statement`, chat,
capture, history, provenance or another source to a model.

Prompts are canonical JSON of at most 10,000 characters, with at most eight
projected evidence records. Exact success values are never truncated. Goal titles
and evidence values are explicitly untrusted data, not authority. Output is at
most 4,096 characters and has exactly:

```json
{
  "schema_version": 1,
  "disposition": "wait",
  "evidence_ids": [],
  "actions": [{"kind": "prepare_plan", "key": "prepare"}],
  "plan": {
    "summary": "A bounded synthetic tracking proposal",
    "steps": ["Wait for the exact authorized completion evidence."],
    "evidence_ids": []
  }
}
```

An active goal requires a draft plan and a prepare action. The summary is at most
500 characters, with one to four steps of at most 160 characters. Later waiting
or completion decisions use `plan: null`. Completion must cite known included
evidence and remains subject to the kernel's exact fresh typed predicate and
durable-wait requirement. Unknown fields/references/actions, duplicate JSON
keys, hidden reasoning/tool/refusal channels, nonterminal envelopes and malformed
or oversized output fail safely without completing the goal.

The proposal is stored only in `prepare_plan` action payload and surfaced as
`goal.plan.proposal` with `status='proposed_unverified'`, `authored_by='planner'`
and `executable=false`. Generated steps never become tools, SQL, arguments or
outbox text. Engine-authored fixed messages and local action keys remain the
only effects. All supplied input IDs are tracked as conservative dependencies,
even when the model does not cite them. Withdrawal, forgetting, configuration
changes and evidence expiry scrub proposals while retaining truthful fixed
receipts. Expiry between response and application prevents insertion altogether.

### Transport, quota and cancellation boundaries

- HTTP transport has a hard total 10-second connect/request/response budget,
  including slow headers and HTTP/1.0 slow-drip bodies. A joined watchdog only
  shuts down sockets; no background thread sends data after scope is released
- Lock order is SQLite `BEGIN IMMEDIATE` then Gateway. Scope mutations may wait
  for an already-dispatched bounded local call. Withdrawal is effective when its
  transaction commits; bytes already sent cannot be retracted
- Queued work never sends withdrawn data after that commit. In-flight responses
  are discarded if the scope/configuration changes before application
- Automatic local-model attempts have a conservative limit of 20 per UTC day.
  A durable reservation commits before dispatch, so timeout, malformed output,
  abandoned attempts and process death cannot refund an already reserved call
- Exhaustion leaves goals uncompleted and defers wakes to the next UTC reset
  with `model_daily_budget`. Manual synthetic validation probes are separate
- Idle, disabled, paused, cancelled, revoked and expired work makes no automatic
  model calls; a due wake and all current authorization checks are required

The HTTP mock tests verify both supported provider protocols, real wire payloads,
model-generated plan/wait/evidence-linked completion through separate-process
restart, input/output bounds, failure/backoff, budget/restart handling,
configuration/consent races and proposal redaction. They do not establish real
model quality, real personal-data authorization, desktop UI acceptance or a
production-ready autonomous assistant.


## Separate synthetic natural conversation

`ConversationService(service, planner_control)` adds a bounded natural text
surface without changing `append_message`/`list_messages` or legacy `/chat`.
Its separate tables are created lazily when the Preview app wires the service.
It starts no work or probes. See `docs/dev/LOCAL_GOAL_LOOP.md` for REST shapes.

Service methods are `list_conversations`, `get_conversation`, `consent`, `revoke`,
`send`, `get_turn`, `adopt`, and `get_adoption`. Consent explicitly creates a
named conversation and binds current route revision/identity and synthetic
source generation. It does not inherit goal-model consent. `send` requires an
exact conversation version, optional paired exact goal ID/version, bounded
explicit evidence IDs, and a durable request ID. Only that explicit invocation
can call the hardened Gateway, under a fresh privacy/dependency guard.

Each send commits its reservation before HTTP; **do not wrap `send` in an outer
transaction**. A crash leaves durable `outcome_unknown`, never a request to
replay automatically. Same-ID duplicates only read; changed payloads conflict.
Explicit `retry_of` with a new ID is possible after the 15-second dispatch window
and binds the original content/context. Public turns separate output citations,
all-input dependency IDs, and original `request_evidence_ids` for exact retry.
Full input goal projections support stale/mixed-snapshot frontend masking.

Strict model output is answer, ambiguity question, or one proposed new goal with
a bounded nonexecutable plan. Exact target/predicate anchoring is additionally
checked against current user text or explicitly selected structured inputs. An
unanchored model suggestion becomes a local clarification question, marked
`reply_kind=clarification`; actual model replies use `reply_kind=model`. Free-form
target/predicate inference remains constrained and unverified. Adoption names exact proposal/version and its own
idempotency ID, revalidates all inputs and atomically creates/activates at most
one goal plus an adoption receipt. It never turns execution on, invokes model
tools, or mutates an existing context goal. Existing goal controls apply after
adoption. Local completion still requires independent exact fresh evidence.

All included inputs, including uncited history and goal context, remain durable
dependencies after adoption. Source/evidence/goal withdrawal hides and scrubs
related text and invalidates derived goal authority. Model route changes and
conversation consent replacement/revocation scrub synthetic user dialogue too,
but do not cancel an already independently adopted goal while its underlying
data remains valid. Text is retained only within its consent epoch; legacy notes
and minimal effect/adoption receipts are separate. No forensic-erasure claim.

Focused checks: `PYTHONPATH=backend python -W error::ResourceWarning -m unittest
backend.app.modules.agent_runtime.tests.test_natural_conversation`. Fixtures use
only generated synthetic data and real literal-loopback HTTP mock providers.
