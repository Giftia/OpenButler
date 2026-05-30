# OpenButler Current State

Updated: 2026-05-30

## Repository Baseline

- Git has been initialized for `C:\Users\admin\Desktop\git\OpenButler`.
- Baseline commit: `b6fffb4 chore: establish OpenButler repository baseline`.
- Architecture alignment branch: `chore/architecture-reality-alignment`.
- Repository-local Git identity is configured as `Giftina Chen <admin@giftia.moe>`.

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

Real local MineContext 7-day dry-run was explicitly authorized and completed on 2026-05-30. Only aggregate counts were recorded:

- dry-run only: true.
- source events estimated: 157.
- estimated new events: 95.
- estimated duplicate events: 62.
- OpenButler DB table counts unchanged.
- MineContext source DB file metadata unchanged.
- screenshots copied: false.
- external model used: false.
- external webhook used: false.
- MineContext source mutated: false.

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

Product-friendly UI V1 was implemented on 2026-05-30:

- `/butler` now opens a user-friendly Today page instead of a technical control console.
- Primary navigation is reduced to `今日`, `时间线`, `管家`, and `我的`.
- Technical and power-user pages remain available under `高级与实验室`.
- The homepage uses a hero, today status cards, 1-3 prioritized butler suggestions, scene signal cards, and timeline preview.
- New-user and insufficient-data states explain the next step instead of showing empty technical panels.
- `/timeline` now renders unified timeline events as life-record moments grouped by date, with progressive evidence expansion.
- Butler Inbox cards default to title/summary/actions and expand inline `evidence_refs` only when the user asks to view evidence.

Mobile UX Polish V2 was implemented on 2026-05-30:

- The mobile primary navigation is compact, so the first screen is not consumed by navigation cards.
- `/butler` now prioritizes the value statement, today's summary, and one main action before secondary cards.
- Demo-mode copy is user-facing Chinese and marked as demo data without exposing internal fields such as mock seeds or raw source names.
- `/timeline` demo entries read as life-record moments instead of development logs.
- Butler chat demo answers hide internal source fields and use user-facing evidence labels.
- `/me` now shows privacy/data, data sources, and preference settings first; advanced architecture details are folded under `高级与实验室`.
- No backend API contract was changed.

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

## Browser Smoke Verification

Butler Inbox evidence browser smoke was completed on 2026-05-30 using a temporary backend data directory and synthetic demo data:

- backend API: `http://127.0.0.1:8011`.
- frontend build: `npm run build` OK.
- browser smoke: `npm run smoke:butler-browser` OK.
- verified `/butler/inbox` opened.
- verified an insight card could expand evidence refs.
- verified `evidence_boundary` was visible.
- privacy counters: `external_model_used=false`, `minecontext_source_deleted=0`, `copied_screenshots=0`.
- no real MineContext activity was read for this smoke; MineContext paths were pointed at nonexistent temporary locations.

## Chinese Mojibake Audit

Chinese mojibake risk audit was completed on 2026-05-30.

- Audit report: `docs/dev/CHINESE_MOJIBAKE_AUDIT_2026-05-30.md`.
- Scoped mojibake pattern scan found no matching repository text files.
- Chinese source text is intentionally present in UI labels, docs, tests, plugins, and goal files.
- Frontend runtime verification passed through `npm run smoke:butler-browser`.
- No source file encoding conversion was performed.
- Current likely risk source is terminal or PowerShell output rendering when UTF-8 is not explicit, not persistent source corruption.

## PrivacyGuard Design

Unified PrivacyGuard design was completed on 2026-05-30 without behavior changes.

- Design doc: `docs/architecture/PRIVACY_GUARD_DESIGN.md`.
- ADR: `docs/architecture/decisions/0009-design-privacyguard-before-implementation.md`.
- Current reality remains distributed privacy checks in `backend/app/main.py`, PC Activity Context, Butler Core, and Workstation Vision.
- No central `PrivacyGuard` implementation exists yet.
- Future implementation should be incremental and must preserve existing strict-mode tests and response fields.

## Not Run In This Governance Round

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
