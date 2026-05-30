# OpenButler Current State

Last scanned: 2026-05-29.

## 1. Current Directory Structure

```text
OpenButler/
  backend/
    app/
      main.py
      integrations/
        local_eyes_adapter.py
        minecontext/
      modules/
        butler_core/
        pc_activity_context/
        workstation_vision/
      plugins/
    data/
    Dockerfile
    requirements.txt
  frontend/
    src/
      App.tsx
      lib/api.ts
      styles.css
    Dockerfile
    package.json
  docs/
    minecontext_integration.md
    proactive_butler_core.md
    openclaw_integration.md
    productization/
      DEMO_RECORD.md
    privacy/
  CHANGELOG.md
  openclaw/
  openclaw-skill/
  docker-compose.yml
  README.md
```

The repository uses `backend/` and `frontend/`, not `apps/api` and `apps/web`.

## 2. Completed Capabilities

- FastAPI backend with SQLite local data storage.
- React + Vite + TypeScript web prototype.
- Plugin manifest loading from `backend/app/plugins/*.json`.
- Privacy mode with `basic` and `strict`.
- MineContext / godview integration through local scripts and read-only source handling.
- PC Activity Context APIs for status, query-at-time, keyword search, import, summary, focus blocks, app usage, domain usage, workflow candidates, evidence, settings, and deletion of OpenButler-derived events.
- Proactive Butler Core for unified timeline rebuild, today metrics, insights, Butler Inbox feedback, briefings, goals, settings, and context recovery.
- Butler Inbox evidence details for insight cards, including evidence refs, evidence boundary, confidence/source metadata, and screenshot path-only handling.
- Recent 7-day metrics trend for PC active minutes, focus minutes, and context switching, with a data-insufficient empty state.
- Productization Harness MVP report for checking the proactive Butler chain, strict privacy fields, evidence boundaries, and safe demo reset behavior.
- MVP report acceptance checks now include local next actions for data-insufficient or attention-needed states.
- `/butler` can execute whitelisted local next actions from MVP report suggestions.
- Read-only data-insufficient drill API for validating empty-state recovery guidance without changing real PC Activity or MineContext source data.
- `/butler` exposes the read-only data-insufficient drill as a Productization Harness UI action.
- Productization Harness run summaries are persisted locally and shown on `/butler` after refresh.
- Productization Harness summaries are included in Butler structured export and deleted by Butler derived-data deletion.
- Active objective status is available from a local Productization Harness evidence-map API and shown on `/butler`.
- L1 active objective audit is available from `GET /api/butler/productization/l1-audit` and distinguishes `proven`, `needs_attention`, `missing_evidence`, and `out_of_scope`.
- Vision sensing module backed by the local camera-eye adapter, with mock fallback.
- OpenClaw skill declarations for vision, PC activity, and proactive butler tools.
- Productization Harness changelog and demo record with local acceptance commands, artifact path, privacy counters, and known limits.

## 3. Runnable Commands

Docker:

```bash
docker compose up --build
```

Backend:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010
```

Frontend:

```powershell
cd frontend
$env:VITE_API_BASE_URL="http://127.0.0.1:8010"
npm run dev -- --host 0.0.0.0 --port 5175
```

## 4. Existing APIs

Base:

- `GET /health`
- `GET /api/events`
- `POST /api/events/simulate`
- `GET /api/plugins`
- `GET /api/privacy-mode`
- `POST /api/privacy-mode`
- `POST /api/chat`
- `GET /openclaw/skill`

PC Activity:

- `GET /api/pc-activity/minecontext/status`
- `POST /api/pc-activity/minecontext/query-at-time`
- `POST /api/pc-activity/minecontext/search`
- `POST /api/pc-activity/minecontext/import`
- `GET /api/pc-activity/events`
- `GET /api/pc-activity/summary/today`
- `GET /api/pc-activity/summary`
- `GET /api/pc-activity/focus-blocks`
- `GET /api/pc-activity/app-usage`
- `GET /api/pc-activity/domain-usage`
- `GET /api/pc-activity/workflow-candidates`
- `GET /api/pc-activity/evidence/{event_id}`
- `GET /api/pc-activity/settings`
- `POST /api/pc-activity/settings`
- `DELETE /api/pc-activity/events`
- `GET /api/pc-activity/context-recovery-pack`

Proactive Butler:

- `GET /api/butler/home`
- `GET /api/butler/readiness`
- `GET /api/butler/mvp-report`
- `GET /api/butler/demo/data-insufficient-drill`
- `GET /api/butler/harness/runs/latest`
- `GET /api/butler/productization/objectives/status`
- `GET /api/butler/productization/l1-audit`
- `GET /api/butler/productization/demo-pack`
- `POST /api/butler/demo/run`
- `POST /api/butler/demo/reset`
- `GET /api/butler/timeline`
- `POST /api/butler/timeline/rebuild`
- `GET /api/butler/metrics/today`
- `GET /api/butler/metrics`
- `GET /api/butler/metrics?days=7`
- `GET /api/butler/insights`
- `POST /api/butler/insights/generate`
- `POST /api/butler/insights/{insight_id}/feedback`
- `POST /api/butler/insights/{insight_id}/dismiss`
- `POST /api/butler/insights/{insight_id}/snooze`
- `GET /api/butler/briefings/today`
- `POST /api/butler/briefings/generate`
- `GET /api/butler/goals`
- `POST /api/butler/goals`
- `PATCH /api/butler/goals/{goal_id}`
- `DELETE /api/butler/goals/{goal_id}`
- `GET /api/butler/context-recovery`
- `GET /api/butler/settings`
- `POST /api/butler/settings`
- `GET /api/butler/export`
- `DELETE /api/butler/data`

Vision:

- `GET /api/vision/cameras`
- `POST /api/vision/session/start`
- `POST /api/vision/session/stop`
- `GET /api/vision/status`
- `GET /api/vision/events`
- `GET /api/vision/summary/today`
- `GET /api/vision/summary`
- `GET /api/vision/attention-heatmap`
- `GET /api/vision/posture`
- `GET /api/vision/fatigue`
- `GET /api/vision/settings`
- `POST /api/vision/settings`
- `DELETE /api/vision/data/today`
- `DELETE /api/vision/data`
- `GET /api/vision/export`

## 5. Existing Pages

- `/`: Web dashboard.
- `/capture`: data intake.
- `/vision`: vision sensing.
- `/pc-activity-context`: PC activity context.
- `/plugins`: plugin pipeline.
- `/timeline`: unified timeline.
- `/chat`: butler chat.
- `/privacy`: privacy and deployment.
- `/butler`: proactive butler home.
- `/butler`: includes the Productization Harness panel backed by `GET /api/butler/mvp-report`.
- `/butler`: shows Productization Harness next actions when MVP checks need attention.
- `/butler`: includes `演练空数据路径`, a read-only Productization Harness drill for empty-state recovery guidance.
- `/butler`: shows `最近 Harness 结果`, sourced from persisted local Harness summaries.
- `/butler`: shows `目标完成度自检`, sourced from local active-objective evidence mapping loaded from `.openbutler/goals.yaml`.
- `/butler`: shows `一页演示包`, sourced from local Productization demo pack aggregation.
- `/butler`: next-action buttons are limited to local API calls and page navigation.
- `/butler/inbox`: Butler Inbox with expandable evidence details.
- `/metrics`: metrics and recent 7-day trend.
- `/goals`: goals and reminders.

## 6. Existing Tests

- `backend/app/modules/workstation_vision/tests/`
- `backend/app/modules/pc_activity_context/tests/`
- `backend/app/modules/butler_core/tests/`

Common command:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest discover -s backend\app\modules
```

Frontend Productization Harness smoke commands:

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run smoke:butler-demo
npm run smoke:butler-ui-flow
npm run smoke:butler-mvp-report
npm run smoke:butler-demo-pack
npm run smoke:butler-browser
npm run smoke:butler-l1-audit
npm run artifact:butler-demo-pack
npm run test:demo-pack-artifact-file
npm run test:productization-records
npm run test:metrics-trend-panel
npm run test:inbox-evidence-panel
npm run verify:productization
npm run smoke:butler-data-insufficient-drill
```

## 7. Known Gaps

- Documentation was spread across README and integration notes; this harness now makes product, architecture, privacy, and development facts explicit.
- Frontend has no dedicated automated browser regression suite yet.
- `smoke:butler-mvp-report` is an API-level productization check, not a full browser-click test.
- `smoke:butler-demo-pack` is a focused API-level one-page Productization Harness check.
- `smoke:butler-browser` is a headless Edge/Chrome `/butler` page runtime check for Productization Harness, objective status, one-page demo pack, evidence boundaries, strict privacy text, and data-insufficient drill UI.
- `smoke:butler-l1-audit` verifies the success-criterion-level L1 audit report, result classes, evidence refs, evidence boundaries, and strict privacy counters.
- `artifact:butler-demo-pack` writes `data/productization/productization-demo-pack.json` with local Productization Harness evidence and privacy counters.
- `test:demo-pack-artifact-file` validates the Productization Harness artifact offline without a running backend.
- `test:productization-records` validates `CHANGELOG.md` and `docs/productization/DEMO_RECORD.md` for acceptance commands, artifact path, privacy counters, evidence boundaries, and absence of MineContext source records or screenshot content.
- `test:metrics-trend-panel` validates the `/metrics` recent 7-day trend UI, `GET /api/butler/metrics?days=7` wrapper, data-insufficient empty state, strict privacy counters, and evidence-boundary copy.
- `test:inbox-evidence-panel` validates the `/butler/inbox` evidence detail UI, including `evidence_refs`, evidence boundary, confidence/source metadata, screenshot path-only handling, and missing-evidence copy.
- `verify:productization` is the one-command local Productization Harness gate when the backend is running. It checks `/health`, static scripts, runtime demo pack smoke, artifact generation, and offline artifact validation.
- `smoke:butler-data-insufficient-drill` is a synthetic empty-state drill; it proves next actions and privacy boundaries, not the real current workspace state.
- `GET /api/butler/productization/demo-pack` is a local one-page Productization Harness snapshot; it does not verify remote systems.
- Productization objective status now reads declared active objectives from `.openbutler/goals.yaml`; unknown future objectives need an evidence mapper before they can be proven.
- `/butler` now displays `缺少 evidence mapper` for declared future active objectives that do not yet have a Productization Harness evidence mapper.
- `docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md` defines the mapper template for future active objectives, and `/api/butler/productization/objectives/status` returns the same contract in `evidence_mapper_template`.
- `/butler` Productization Harness panel is covered by source-level checks and runtime API smoke, but not by full browser automation.
- API contract tests are mostly service-level unit tests and smoke checks.
- Proactive Butler insights are rule-based MVP and do not yet tune thresholds deeply from feedback.
- Focus block detection can return zero if MineContext imports do not contain long enough stable project/app spans.
- Export flows for all Butler structured data need a richer product UI.
- `apps/api` and `apps/web` do not exist; future prompts should use the actual `backend/` and `frontend/` layout.

## 8. Next Shortest Product Loop

1. Import today's MineContext PC activities.
2. Rebuild the unified timeline.
3. Generate today's metrics.
4. Generate proactive insights.
5. Show them in `/butler` and `/butler/inbox`.
6. Let the user mark insights useful, dismissed, snoozed, or inaccurate.
7. Use feedback to reduce repeated low-value insights.
