# PrivacyGuard Design

Date: 2026-05-30

This is a design-only document. It maps the current distributed privacy checks and proposes a future central `PrivacyGuard` interface. It does not describe code that exists today.

## Current Reality

OpenButler does not currently have a single `PrivacyGuard` class. Privacy enforcement is distributed across modules:

| Area | Current file | Current protection |
|---|---|---|
| Global privacy mode | `backend/app/main.py` | Stores `basic` or `strict` in settings and returns it from `/api/privacy-mode`. |
| Plugin availability | `backend/app/main.py` | In strict mode, blocks plugin manifests outside `strict` or `strict_local`, cloud providers, and `external_network`, `cloud_api`, or `external_webhook` permissions. |
| MineContext settings | `backend/app/modules/pc_activity_context/service.py` | Strict mode forces `external_model_allowed=false` and `copy_screenshot_evidence=false`. |
| MineContext import preview | `backend/app/modules/pc_activity_context/service.py` | Dry-run preview is read-only, does not write OpenButler PC Activity events, does not mutate MineContext, does not copy screenshots, and reports external model/webhook usage as false. |
| PC Activity deletion | `backend/app/modules/pc_activity_context/service.py` | Deletes OpenButler PC Activity events only; no MineContext source deletion logic exists in this path. |
| Butler settings | `backend/app/modules/butler_core/service.py` | Strict mode forces `external_model_allowed=false` and `system_notification_enabled=false`. |
| Butler insights and briefings | `backend/app/modules/butler_core/service.py` and `backend/app/modules/butler_core/insight_engine.py` | Rule-based generation reports `external_model_used=false` and preserves evidence boundaries. |
| Butler data deletion | `backend/app/modules/butler_core/service.py` | Deletes only Butler-derived timeline, metrics, insights, briefings, and harness summaries; preserves PC Activity and MineContext source data. |
| Vision raw-frame handling | `backend/app/modules/workstation_vision/service.py` | Strict mode rejects raw-frame saving and reports strict-local derived events. |

This distributed model is currently covered by focused tests in PC Activity, Butler Core, and Workstation Vision.

## Proposed Interface

A future central guard should be explicit and boring. It should evaluate intent before a module performs privacy-sensitive work.

```python
class PrivacyDecision:
    allowed: bool
    reason_codes: list[str]
    effective_mode: str
    audit_fields: dict[str, object]


class PrivacyGuard:
    def evaluate_model_call(self, provider: str, mode: str) -> PrivacyDecision:
        ...

    def evaluate_webhook_call(self, target: str, mode: str) -> PrivacyDecision:
        ...

    def evaluate_screenshot_copy(self, source: str, mode: str, explicit_user_approval: bool) -> PrivacyDecision:
        ...

    def evaluate_minecontext_access(self, operation: str, dry_run: bool, mode: str) -> PrivacyDecision:
        ...

    def evaluate_delete_scope(self, scope: str, mode: str) -> PrivacyDecision:
        ...

    def evaluate_plugin_manifest(self, manifest: dict, mode: str) -> PrivacyDecision:
        ...
```

The guard should return structured decisions rather than raising ad hoc exceptions. Callers can then render explainable API errors, UI messages, and audit logs.

## Policy Matrix

| Action | Basic mode | Strict mode |
|---|---|---|
| Local rule insight generation | allow | allow |
| Local MineContext read-only query | allow after user enables integration | allow after user enables integration |
| MineContext source mutation | deny | deny |
| OpenButler dry-run import preview | allow | allow |
| OpenButler real import | allow only after explicit user action and idempotency guard | allow only after explicit user action and idempotency guard |
| Screenshot path reference | allow if configured | allow if configured |
| Screenshot file copy | allow only with explicit user approval | deny |
| External model call | allow only if configured and user-approved | deny |
| External webhook | allow only if configured and user-approved | deny |
| System notification | allow only if configured | off by default; future strict behavior should require explicit opt-in |
| Delete Butler-derived data | allow with confirmation | allow with confirmation |
| Delete MineContext source data | deny | deny |

## Migration Plan

1. Add `backend/app/privacy/guard.py` with pure functions and no behavior change.
2. Add tests that assert the guard reproduces the current distributed decisions.
3. Wire `/api/plugins` manifest checks through the guard first, because the behavior is simple and well contained.
4. Wire PC Activity import preview through the guard while preserving current response fields.
5. Wire Butler Core settings and delete scope checks through the guard.
6. Wire Workstation Vision raw-frame decisions through the guard.
7. Add a contract test that compares old expected privacy counters with guard-produced audit fields.

Each step should be a separate small change. Do not replace all distributed checks in one patch.

## Risks

- A central guard can become a false sense of security if network calls, file copies, or delete paths bypass it.
- Premature wiring could break tested strict-mode behavior.
- A global network blocker is not currently implemented; a future task should decide whether to add one.
- Existing API response fields are already used by frontend smoke tests and productization checks. Keep them stable during migration.
- Do not treat `basic` mode as permission to upload private data by default. It still requires explicit user configuration.

## Non-Goals

- No behavior change in this design task.
- No new external model integration.
- No new webhook implementation.
- No real MineContext import.
- No screenshot copying.
- No directory migration.

## Acceptance For Future Implementation

A future PrivacyGuard implementation should pass existing PC Activity, Butler Core, and Vision privacy tests, plus new unit tests for every method in the proposed interface. It should also keep these invariants:

- strict mode does not call external models,
- strict mode does not call external webhooks,
- screenshots are not copied by default,
- MineContext source data is never deleted or mutated,
- Butler data deletion stays scoped to OpenButler-derived Butler records,
- evidence boundaries remain present in insight and briefing outputs.
