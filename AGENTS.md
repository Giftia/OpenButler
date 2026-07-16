# OpenButler Agent Map

OpenButler is a local-first proactive AI butler prototype that turns authorized personal context into evidence-backed timelines, metrics, insights, briefings, and feedback loops.

## Current Priority

`OB-GOAL-027` is the only active objective. Establish the report-only loop-engineering control plane before adding ambient sensors or actions. Read `LOOP.md`, `STATE.md`, `loop-budget.md`, and `loop-constraints.md` before any loop-driven work.

## Real Directory Layout

- `backend/`: FastAPI backend.
  - Entry: `backend/app/main.py`.
  - MineContext integration: `backend/app/integrations/minecontext/`.
  - PC Activity Context: `backend/app/modules/pc_activity_context/`.
  - Proactive Butler Core: `backend/app/modules/butler_core/`.
  - Vision module: `backend/app/modules/workstation_vision/`.
  - Runtime plugin manifests: `backend/app/plugins/*.json`.
- `frontend/`: React + Vite + TypeScript web app.
  - Entry: `frontend/src/App.tsx`.
  - API client: `frontend/src/lib/api.ts`.
- `api/`: Vercel Python adapter that exposes the backend FastAPI app.
- `openclaw-skill/`: OpenClaw skill declaration files. Runtime invocation has not been independently validated.
- `openclaw/`: secondary OpenClaw skill markdown served by `/api/openclaw/skill`.
- `docs/`: product, architecture, privacy, development, and audit documents.
- `.openbutler/`: goals, task queue, and Definition of Done.
- `plugins/`: reserved placeholder for a future external plugin package layout. It is not the current runtime plugin source.

There is no `apps/api` or `apps/web` structure. Future prompts and edits must use `backend/`, `frontend/`, and `api/`.

## Run Locally

Backend:

```powershell
$env:PYTHONPATH = "C:\Users\admin\Desktop\git\OpenButler\backend"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5175
```

Docker Compose exists, but the frontend service defaults to port 5173 unless `OPENBUTLER_FRONTEND_PORT` is set.

## Test Commands

```powershell
$env:PYTHONPATH = "C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest discover -s backend\app\modules\pc_activity_context\tests
python -m unittest discover -s backend\app\modules\butler_core\tests
python -m unittest discover -s backend\app\modules\workstation_vision\tests

cd frontend
npm run build
```

Use `npm run verify:productization` only when it is acceptable to run the local Productization Harness and write/update local artifacts under `data/`.

## Loop Engineering

The L1 governance loop is read-only and separate from the future ambient product runtime:

```powershell
Push-Location tools/loop
npm ci --registry=https://registry.npmjs.org
npm run audit:governance -- --github
Pop-Location
```

- `.openbutler/goals.yaml` is the active product-objective source.
- GitHub Issues are the executable work queue.
- `STATE.md` is the current loop snapshot.
- `LOOP.md` is the operating contract.
- L1 may write only ignored reports under `data/loop-runs/`; it must not edit tracked files or GitHub state.
- L2/L3 are disabled until the promotion gates in `LOOP.md` are satisfied.

## Current Capabilities

- MineContext/godview adapter exists and supports PowerShell query/search wrappers plus read-only SQLite activity import. Real 7-day dry-run against user data requires explicit confirmation.
- PC Activity Context exists with event storage, summaries, app/domain usage, focus blocks, workflow candidates, idempotent event creation, and tests.
- Proactive Butler Core exists with unified timeline, metrics, insights, Inbox feedback, briefings, goals, context recovery, dry-run PC import preview, and tests.
- Butler insight evidence is currently inline: `GET /api/butler/insights` returns `evidence_refs` and `evidence_boundary`. There is no dedicated `GET /api/butler/insights/{id}/evidence` endpoint.
- Plugin manifests are loaded from `backend/app/plugins/*.json` by `/api/plugins`. They are metadata manifests, not executable plugin pipeline units.

## Privacy Red Lines

- Do not delete or mutate MineContext source data.
- Do not run real MineContext 7-day dry-run/import without explicit user confirmation.
- Do not copy screenshots or upload screenshot contents.
- Do not call external models or external webhooks in strict mode.
- Do not read secrets, tokens, cookies, passwords, or private raw outputs.
- Do not present MineContext summaries as final truth for remote systems.
- Do not add employee monitoring, medical, psychological, personality, or moral-judgment features.

## PR / Task Completion Standard

Follow `.openbutler/definition_of_done.md`. Each change should preserve evidence boundaries, update docs when contracts change, run focused tests, and state residual risks. Never treat docs or task queue status as proof without code or command evidence.

## Agent skills

### Issue tracker

Issues and external pull requests are tracked in GitHub for `Giftia/OpenButler`; external PRs are a triage request surface. See `docs/agents/issue-tracker.md`.

### Independent web reviewer

ChatGPT Web may refine issues and review high-risk pull requests, but it does not implement code, merge or close work, or change the active goal. Local runtime evidence may be shared only through a redacted morning report. See `docs/agents/chatgpt-web-reviewer.md`.

### Triage labels

Use the default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo. Engineering skills should read `AGENTS.md`, the architecture docs, and ADRs under `docs/architecture/decisions/`. See `docs/agents/domain.md`.

## Fact Sources

- Current architecture: `docs/architecture/CURRENT_ARCHITECTURE.md`
- Repository structure: `docs/architecture/REPO_STRUCTURE.md`
- API contracts: `docs/architecture/API_CONTRACTS.md`
- Plugin runtime: `docs/architecture/PLUGIN_RUNTIME.md`
- Privacy boundaries: `docs/privacy/PRIVACY_BOUNDARIES.md`
- Reality audit: `docs/dev/OPENBUTLER_REALITY_AUDIT_2026-05-30.md`
- Loop operations: `docs/dev/LOOP_OPERATIONS.md`
- Ambient architecture: `docs/architecture/LOOP_DRIVEN_AMBIENT_ARCHITECTURE.md`
