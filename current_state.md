# OpenButler Current State

Updated: 2026-05-30

## Repository Baseline

- Git has been initialized for `C:\Users\admin\Desktop\git\OpenButler`.
- Baseline commit: `b6fffb4 chore: establish OpenButler repository baseline`.
- Architecture alignment branch: `chore/architecture-reality-alignment`.
- Repository-local Git identity is configured as `OpenButler Local <openbutler-local@example.local>`.

## Real Structure

```text
backend/           FastAPI backend
frontend/          React + Vite + TypeScript frontend
api/               Vercel adapter for the backend app
backend/app/plugins/*.json
                   current runtime plugin manifests
plugins/           reserved placeholder, not runtime-loaded today
openclaw-skill/    OpenClaw declaration files
openclaw/          base skill markdown
docs/              product, architecture, privacy, dev docs
.openbutler/       goals, task queue, Definition of Done
```

There is no `apps/api` or `apps/web` structure. Future prompts must use `backend/`, `frontend/`, and `api/`.

## Implemented Capabilities Found In Code

### MineContext / godview

- Adapter: `backend/app/integrations/minecontext/adapter.py`.
- PowerShell script client: `backend/app/integrations/minecontext/godview_client.py`.
- Config: `backend/app/integrations/minecontext/config.py`.
- Normalizer and redaction: `backend/app/integrations/minecontext/normalizer.py`.
- API surface: `/api/pc-activity/minecontext/status`, query, search, import.
- Default settings are strict, read-only, path-only for screenshots, no external model.

Real local MineContext 7-day dry-run has not been run in this round because it reads user activity metadata and requires explicit confirmation.

### PC Activity Context

- Module: `backend/app/modules/pc_activity_context/`.
- Model: `PCActivityEventModel`.
- Supports event storage, idempotent creation, import, summaries, app/domain usage, focus blocks, workflow candidates, context recovery pack.
- Tests exist and pass.

### Proactive Butler Core

- Module: `backend/app/modules/butler_core/`.
- Models: `UnifiedTimelineEventModel`, `ButlerMetricSnapshotModel`, `InsightCardModel`.
- Supports unified timeline rebuild, metrics, rule insights, Butler Inbox feedback, noise evaluation, briefings, goals, context recovery, dry-run PC import preview, export/delete boundaries.
- Tests exist and pass.

Current insight evidence contract:

- `GET /api/butler/insights` returns inline `evidence_refs` and `evidence_boundary`.
- `GET /api/butler/insights/{insight_id}/evidence` does not exist.

### Frontend

- Framework: React + Vite + TypeScript.
- Main app: `frontend/src/App.tsx`.
- API client: `frontend/src/lib/api.ts`.
- Pages include `/butler`, `/butler/inbox`, `/metrics`, `/timeline`, `/goals`, `/pc-activity-context`, `/vision`, and `/`.
- Frontend build passes.

### OpenClaw

- Declaration files exist in `openclaw-skill/`.
- Base skill markdown exists in `openclaw/`.
- Runtime OpenClaw invocation has not been verified.

### Plugin Runtime

- Runtime manifests are `backend/app/plugins/*.json`.
- `/api/plugins` loads those JSON files and evaluates strict-mode availability.
- Top-level `plugins/` is now documented as a future placeholder.
- Plugins are metadata manifests today, not executable pipeline units.

## Tests Run Most Recently

```text
python -m unittest discover -s backend\app\modules\pc_activity_context\tests
Ran 8 tests - OK

python -m unittest discover -s backend\app\modules\butler_core\tests
Ran 51 tests - OK

python -m unittest discover -s backend\app\modules\workstation_vision\tests
Ran 7 tests - OK

cd frontend
npm run build
OK
```

## Not Run In This Governance Round

- Real MineContext 7-day dry-run preview.
- Browser click smoke for Butler Inbox evidence detail.
- `npm run verify:productization` because it may write/update local artifacts under `data/`.
- OpenClaw runtime execution.

## Current P0

1. Keep Git baseline clean and use commits as work boundaries.
2. Keep docs and task queue aligned to real `backend/` / `frontend/` / `api/` structure.
3. Validate real MineContext 7-day dry-run only after explicit user confirmation.
4. Run Butler Inbox evidence browser smoke as a separate validation task.
5. Audit Chinese mojibake risk separately; do not mix it with architecture alignment.

## Do Not Do Now

- Do not migrate directories to `apps/api` or `apps/web`.
- Do not add new hardware integrations.
- Do not rewrite MineContext/godview or Butler Core.
- Do not run real MineContext import without confirmation.
- Do not copy screenshots.
- Do not call external models.
- Do not add `/api/butler/insights/{id}/evidence` during governance cleanup unless a separate task is approved.
