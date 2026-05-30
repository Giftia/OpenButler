# OpenButler Agent Guide

OpenButler is a local-first proactive full-context AI butler for helping users make daily life clearer, more efficient, and more measurable.

## Current Priority

Build the Productization Harness and keep Proactive Butler Core moving toward a reliable MVP. Do not add new hardware integrations in this stage.

## Repository Map

- `backend/`: FastAPI app, SQLite data layer, integrations, modules, plugin manifests.
- `backend/app/integrations/minecontext/`: MineContext / godview adapter. Reuse it; do not rewrite it.
- `backend/app/modules/pc_activity_context/`: PC activity ingestion, query, search, summary, tools, tests.
- `backend/app/modules/butler_core/`: unified timeline, metrics, insights, Butler Inbox, briefings, goals.
- `backend/app/modules/workstation_vision/`: existing vision sensing module; do not expand hardware scope now.
- `frontend/`: React + Vite + TypeScript web prototype.
- `openclaw/` and `openclaw-skill/`: OpenClaw skill declarations.
- `docs/`: product, architecture, privacy, development, and integration facts.
- `.openbutler/`: durable product goals, task queue, and Definition of Done.

## Local Run

Docker:

```bash
docker compose up --build
```

Manual backend:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010
```

Manual frontend:

```powershell
cd frontend
$env:VITE_API_BASE_URL="http://127.0.0.1:8010"
npm run dev -- --host 0.0.0.0 --port 5175
```

## Tests

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest discover -s backend\app\modules
python -m compileall -q backend\app
cd frontend
npm run build
```

With the backend running, `cd frontend; npm run verify:productization` runs the local Productization Harness gate: static script checks, frontend build, one-page demo pack smoke, artifact generation, offline artifact validation, and headless `/butler` browser smoke. `npm run smoke:butler-demo-pack` checks only the one-page evidence pack. `npm run smoke:butler-browser` renders `/butler` in local headless Edge/Chrome through the built app and verifies visible Productization Harness sections, evidence boundaries, strict privacy fields, and the data-insufficient drill UI. `npm run artifact:butler-demo-pack` writes the same local evidence to `data/productization/productization-demo-pack.json`. `npm run test:demo-pack-artifact-file` validates that artifact offline. `npm run smoke:butler-reset` resets only OpenButler-derived Butler demo data.

## Web Verification

- Home dashboard: `/`
- Proactive Butler: `/butler`
- Butler Inbox: `/butler/inbox`
- Metrics: `/metrics`
- Unified Timeline: `/timeline`
- Goals: `/goals`
- PC Activity Context: `/pc-activity-context`
- Vision: `/vision`

## API Verification

- `GET /health`
- `GET /api/pc-activity/minecontext/status`
- `POST /api/pc-activity/minecontext/import`
- `POST /api/butler/demo/run`
- `POST /api/butler/demo/reset`
- `POST /api/butler/timeline/rebuild`
- `GET /api/butler/home`
- `GET /api/butler/metrics/today`
- `POST /api/butler/insights/generate`
- `POST /api/butler/briefings/generate`
- `GET /api/butler/mvp-report`
- `GET /api/butler/productization/demo-pack`

## Privacy Red Lines

- Strict mode forbids external models, external APIs, and external webhooks.
- MineContext access is local and read-only by default.
- Do not copy screenshots by default; store paths only.
- Do not delete, move, or mutate MineContext source data.
- Do not make medical, psychological, personality, employee-monitoring, or moral judgments.
- Every insight must preserve an evidence boundary.

## Do Not Do

- Do not add new hardware, acoustic imagers, thermal cameras, or more USB peripherals in this stage.
- Do not rewrite MineContext / godview or PC Activity modules.
- Do not turn OpenButler into a generic TODO app, generic RAG app, or generic chatbot.
- Do not auto-deploy, auto-merge, or perform external writes without explicit user confirmation.

## PR Done Standard

Follow `.openbutler/definition_of_done.md`. A change must include focused implementation, tests or a clear test-gap note, updated docs when behavior changes, strict-mode review, and a concise risk summary.

## Document Fact Sources

- Product principles: `docs/product/PRODUCT_PRINCIPLES.md`
- North Star: `docs/product/NORTH_STAR.md`
- MVP scope: `docs/product/MVP_SCOPE.md`
- Roadmap: `docs/product/ROADMAP.md`
- Architecture: `docs/architecture/ARCHITECTURE.md`
- Privacy boundaries: `docs/privacy/PRIVACY_BOUNDARIES.md`
- Development workflow: `docs/dev/CODEX_WORKFLOW.md`
- Current state: `current_state.md`

## Current Stage

`Proactive Butler Core preparation`: keep the MineContext -> unified timeline -> metrics -> insights -> briefing -> feedback loop reliable before expanding to more devices.
