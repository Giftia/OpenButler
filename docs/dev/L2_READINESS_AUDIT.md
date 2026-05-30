# Proactive Butler Core L2 Readiness Audit

Generated: 2026-05-30

## 1. Current Structure Summary

The repository currently uses the following active structure:

- `backend/app/modules/butler_core/`: proactive Butler APIs, unified timeline, metrics, insights, feedback, Productization Harness, and L2 import preview.
- `backend/app/modules/pc_activity_context/`: MineContext-backed PC Activity APIs, import service, summaries, app/domain usage, focus blocks, workflow candidates, and evidence APIs.
- `backend/app/integrations/minecontext/`: MineContext adapter, godview client, read-only database/export helpers, schemas, and normalizer.
- `frontend/src/App.tsx`: current React prototype routes including `/butler`, `/butler/inbox`, `/metrics`, `/timeline`, `/goals`, `/pc-activity-context`, and supporting panels.
- `frontend/scripts/`: static and smoke checks for Butler UI, Inbox evidence, metrics trend, demo pack, and Productization Harness.
- `.openbutler/`: product goals, task queue, and Definition of Done.
- `docs/`: product, architecture, privacy, development, and Productization Harness documentation.

## 2. L1 Artifact Check

Existing L1 artifacts are present:

- `AGENTS.md`
- `.openbutler/goals.yaml`
- `.openbutler/task_queue.yaml`
- `.openbutler/definition_of_done.md`
- `current_state.md`
- `docs/product/NORTH_STAR.md`
- `docs/product/MVP_SCOPE.md`
- `docs/product/ROADMAP.md`
- `docs/privacy/PRIVACY_BOUNDARIES.md`
- `docs/dev/CODEX_WORKFLOW.md`
- Butler Core backend module and routes
- Butler Home, Inbox, Metrics, Timeline, and Goals UI routes
- MineContext / godview integration module and PC Activity APIs
- OpenClaw skill files

L2 note: the requested task ids `OB-TASK-040` through `OB-TASK-042` were already used by L1. The L2 queue therefore uses `OB-L2-TASK-*` ids while preserving `requested_id` fields for traceability.

## 3. Butler Core Current Capability

Confirmed current Butler Core capabilities:

- `GET /api/butler/home`
- `GET /api/butler/timeline`
- `POST /api/butler/timeline/rebuild`
- `GET /api/butler/metrics/today`
- `GET /api/butler/metrics`
- `GET /api/butler/insights`
- `POST /api/butler/insights/generate`
- `POST /api/butler/insights/{insight_id}/feedback`
- `POST /api/butler/insights/{insight_id}/dismiss`
- `POST /api/butler/insights/{insight_id}/snooze`
- `GET /api/butler/briefings/today`
- `POST /api/butler/briefings/generate`
- `GET /api/butler/context-recovery`
- `GET /api/butler/productization/objectives/status`
- `GET /api/butler/productization/l1-audit`
- `GET /api/butler/productization/demo-pack`
- `POST /api/butler/import/pc-activity/preview`

The L2 dry-run preview endpoint was added in this pass. It is read-only, defaults to no screenshot copying, and rejects non-dry-run requests from this endpoint.

## 4. MineContext / Godview Current Capability

Confirmed current MineContext / PC Activity capability:

- MineContext health status API exists.
- Godview query-at-time API exists.
- Godview keyword search API exists.
- PC Activity import API exists.
- Event, summary, focus-block, app-usage, domain-usage, workflow-candidate, evidence, settings, delete, and context-recovery APIs exist.
- The adapter reads MineContext through configured local access and uses a read-only SQLite URI for database fallback.
- The import path has `source_activity_id` duplicate protection.

This audit did not read, modify, delete, copy, or migrate real MineContext source data.

## 5. Web Page Current Capability

Confirmed active UI routes:

- `/butler`: proactive Butler home and Productization Harness surface.
- `/butler/inbox`: insight inbox with evidence details and feedback actions.
- `/metrics`: current metrics and 7-day trend panels.
- `/timeline`: unified timeline surface.
- `/goals`: goal and preference configuration surface.
- `/pc-activity-context`: PC Activity / MineContext context surface.

Inbox evidence details already exist from L1. A full browser click smoke for the evidence detail chain is still a L2 hardening task.

## 6. API Current Capability

Key L2-relevant API findings:

- Butler Core can generate home, timeline, metrics, insights, feedback, briefings, context recovery, and Productization Harness responses.
- PC Activity can query/search/import MineContext-derived activities and expose evidence.
- New preview endpoint:

```http
POST /api/butler/import/pc-activity/preview
```

The preview endpoint returns estimated source event count, new event count, duplicate event count, screenshot path count, privacy mode, warnings, and evidence boundary. It does not write OpenButler event rows and does not mutate MineContext.

## 7. Test Commands And Results

Commands run during this audit:

```powershell
$env:PYTHONPATH='C:\Users\admin\Desktop\git\OpenButler\backend'; python -m unittest backend.app.modules.butler_core.tests.test_butler_api_contract
```

Result: `Ran 25 tests ... OK`

```powershell
$env:PYTHONPATH='C:\Users\admin\Desktop\git\OpenButler\backend'; python -m unittest discover -s backend\app\modules\butler_core\tests
```

Result: `Ran 44 tests ... OK`

```powershell
$env:PYTHONPATH='C:\Users\admin\Desktop\git\OpenButler\backend'; python -m unittest discover -s backend\app\modules\pc_activity_context\tests
```

Result: `Ran 6 tests ... OK`

```powershell
cd frontend
npm run build
```

Result: `built in 2.26s`

```powershell
cd frontend
npm run test:inbox-evidence-panel
npm run test:metrics-trend-panel
```

Result: both returned `ok: true`.

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL='http://127.0.0.1:8011'
npm run verify:productization
```

Result: passed against a temporary backend on port `8011`. The Productization demo pack correctly reported `data_insufficient` for the current runtime data, `objective_status: needs_attention` for open L2/data-quality work, and privacy counters `external_model_used: false`, `copied_screenshots: 0`, and `minecontext_source_deleted: 0`.

## 8. Failed Tests

Initial Butler API contract run failed 3 Productization Harness assertions after adding `OB-GOAL-004`, because the old tests assumed every active objective was fully proven. The Harness and tests were updated to represent the correct L2 state:

- L1 objectives remain proven.
- `OB-GOAL-004` is active and partially proven.
- incomplete L2 hardening tasks keep the overall objective status at `needs_attention`.
- the demo pack returns `attention_needed` instead of `data_insufficient` when L2 objectives are intentionally incomplete.

After the update, the relevant tests passed. The first sandboxed `verify:productization` run also hit a Windows `esbuild` child-process `spawn EPERM`; the same command passed when rerun with approval for the required Vite/esbuild and browser child processes.

## 9. Strict Privacy Protection Points

Current strict privacy protections confirmed by code and tests:

- no external model calls in Butler Core or dry-run preview,
- no external webhook calls in dry-run preview,
- no MineContext source deletion,
- no MineContext source mutation,
- no screenshot copying by default,
- screenshot evidence remains path/reference only,
- non-dry-run import through the L2 preview endpoint is rejected,
- dry-run preview does not write OpenButler PC Activity events,
- Productization Harness privacy counters preserve `external_model_used: false`, `copied_screenshots: 0`, and `minecontext_source_deleted: 0`.

## 10. Best Next P0 Task

The best task completed after this audit was:

- `OB-L2-TASK-041`: design and implement the real 7-day PC Activity / MineContext dry-run import strategy.

Reason: MineContext / PC Activity import and duplicate protection are stable enough to support a read-only preview, while Inbox evidence details and basic feedback penalties already exist from L1.

Next most suitable ready tasks:

- `OB-L2-TASK-042`: idempotent upsert and stable-hash duplicate protection for activities without `source_event_id`.
- `OB-L2-TASK-045`: runtime browser click smoke for Inbox evidence details.
- `OB-L2-TASK-047`: strict privacy regression test for L2 import, evidence, and feedback paths.

## 11. Risks And Blockers

- Full 7-day import is not enabled by the preview endpoint; it is intentionally dry-run only.
- Stable-hash duplicate protection for records without `source_event_id` remains a follow-up task.
- Inbox evidence details have source/static checks, but the L2 browser click smoke is still pending.
- Feedback-driven noise reduction now has an explicit policy document and evaluation endpoint, but the next L2 privacy regression should still verify the endpoint in the full strict-mode gate.
- Real MineContext schema and script output can drift. Runtime import should keep returning explainable errors instead of fabricating data.
- Productization Harness is now correctly in `attention_needed` / `needs_attention` while L2 remains incomplete.
