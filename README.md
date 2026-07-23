# OpenButler

OpenButler is a local-first proactive AI butler prototype. It turns authorized local context into evidence-backed timelines, reminders, briefings, and eventually quiet, context-aware assistance.

Development is now governed by a separate loop-engineering control plane. The engineering loop maintains repository truth and quality gates; the product's future ambient loop observes context, applies consent, decides whether to stay silent, and learns from feedback.

## Loop Engineering

Install the pinned tools and run the report-only governance audit:

```powershell
Push-Location tools/loop
npm ci --registry=https://registry.npmjs.org
npm run audit:governance -- --github
Pop-Location
```

The audit writes redacted reports only below ignored `data/loop-runs/`. It does not read real MineContext activity, modify product code, mutate GitHub, deploy, or call external models. It remains available as a governance check while delegated L2 delivery runs through a separate controller. See `LOOP.md`, `STATE.md`, and `docs/dev/LOOP_OPERATIONS.md`.

### Delegated Nightly delivery

The repository is in delegated L2. A dry-run remains available for governance verification:

```powershell
node tools\nightly\nightly-controller.mjs --mode=dry-run
node tools\nightly\morning-report.mjs
```

After the governance change is merged, install the four Windows tasks:

```powershell
powershell -ExecutionPolicy Bypass -File tools\nightly\install-scheduled-tasks.ps1 -Mode execute
```

The schedule starts delivery at 20:00, stops taking new work at 07:15, finalizes and cleans up at 08:20, and prepares the redacted morning report at 08:30. The executor refuses `execute` unless `STATE.md` records `L2 active`. Eligible pull requests may auto-merge only after exact-SHA CI, two independent verifier results, privacy gates, and Nightly evidence; the stable release channel remains manual. See `docs/dev/NIGHTLY_DELIVERY_LOOP.md`.

## Current Reality

This repository currently uses:

```text
backend/      FastAPI backend
frontend/     React + Vite + TypeScript frontend
api/          Vercel adapter for the backend app
```

It does not use `apps/api` or `apps/web`.

Current runtime plugin manifests live in:

```text
backend/app/plugins/*.json
```

The top-level `plugins/` directory is only a reserved placeholder for a future plugin package layout.

## Main Capabilities

- MineContext / godview adapter for local PC activity query, keyword search, and read-only activity import.
- PC Activity Context: imported PC activity events, app/domain usage, focus blocks, workflow candidates, summaries, evidence boundaries.
- Proactive Butler Core: unified timeline, metrics, rule insights, Butler Inbox feedback, briefings, goals, context recovery, 7-day dry-run preview.
- Vision prototype: local camera-eye adapter and `/api/vision` / `/api/workstation-vision` route aliases.
- Web UI pages for Butler Home, Inbox, Metrics, Timeline, Goals, PC Activity Context, Vision, Dashboard, Chat, Privacy, and Plugins.
- OpenClaw declaration files under `openclaw-skill/`.

## Important Contract Notes

- Insight evidence is currently inline: `GET /api/butler/insights` returns `evidence_refs` and `evidence_boundary`.
- `GET /api/butler/insights/{insight_id}/evidence` does not exist today.
- OpenClaw runtime invocation has not been independently verified.
- strict mode has module-level protections and tests, but there is no single central `PrivacyGuard` class.
- Real MineContext 7-day dry-run reads local user activity metadata and should only run after explicit confirmation.

## Local Backend

Install Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Run the backend:

```powershell
$env:PYTHONPATH = "C:\Users\admin\Desktop\git\OpenButler\backend"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API docs:

```text
http://127.0.0.1:8000/docs
```

## Local Frontend

Install dependencies and start Vite:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5175
```

Build:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\frontend
npm run build
```

## Docker Compose

`docker-compose.yml` exists. The frontend service defaults to port 5173 unless `OPENBUTLER_FRONTEND_PORT` is set.

Example:

```powershell
$env:OPENBUTLER_FRONTEND_PORT = "5175"
docker compose up --build
```

This has not replaced the direct local backend/frontend commands as the primary verified development loop.

## Tests

Run backend unit tests:

```powershell
$env:PYTHONPATH = "C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest discover -s backend\app\modules\pc_activity_context\tests
python -m unittest discover -s backend\app\modules\butler_core\tests
python -m unittest discover -s backend\app\modules\workstation_vision\tests
```

Run frontend build:

```powershell
cd frontend
npm run build
```

Most recent governance-run results:

```text
pc_activity_context: 10 tests OK
butler_core: 57 tests OK
workstation_vision: 7 tests OK
frontend npm run build: OK
```

## MineContext / godview

Current code includes:

- `backend/app/integrations/minecontext/adapter.py`
- `backend/app/integrations/minecontext/godview_client.py`
- `backend/app/integrations/minecontext/config.py`
- `backend/app/integrations/minecontext/normalizer.py`

Default paths are configured in `MineContextSettings` and can be overridden with:

```powershell
$env:OPENBUTLER_MINECONTEXT_WORKSPACE = "C:\path\to\minecontext-godview-workspace"
$env:OPENBUTLER_MINECONTEXT_HOME = "C:\path\to\MineContext"
```

Current MineContext API:

- `GET /api/pc-activity/minecontext/status`
- `POST /api/pc-activity/minecontext/query-at-time`
- `POST /api/pc-activity/minecontext/search`
- `POST /api/pc-activity/minecontext/import`

7-day dry-run preview exists at:

```text
POST /api/butler/import/pc-activity/preview
```

Do not run real 7-day dry-run or import without explicit user confirmation.

## Proactive Butler Core

Current Butler APIs include:

- `GET /api/butler/home`
- `POST /api/butler/timeline/rebuild`
- `GET /api/butler/metrics/today`
- `GET /api/butler/metrics?days=7`
- `GET /api/butler/insights`
- `GET /api/butler/insights/noise-evaluation`
- `POST /api/butler/insights/generate`
- `POST /api/butler/insights/{insight_id}/feedback`
- `POST /api/butler/briefings/generate`
- `GET /api/butler/context-recovery`
- `POST /api/butler/import/pc-activity/preview`

See `docs/architecture/API_CONTRACTS.md` for the full current route list.

## Privacy Mode

Use:

```text
GET /api/privacy-mode
POST /api/privacy-mode
```

strict mode expectations:

- no external model calls,
- no external webhooks,
- no screenshot copying by default,
- MineContext source data remains read-only,
- OpenButler deletion APIs must not delete MineContext source databases or screenshot files.

These protections are implemented in module-level code paths and covered by focused tests. There is no central `PrivacyGuard` class today.

## Not Supported Or Not Verified

- `apps/api` / `apps/web` layout.
- `GET /api/butler/insights/{insight_id}/evidence`.
- `/api/devices/*`.
- `/api/acoustic/*`.
- Real OpenClaw runtime invocation.
- Real 7-day MineContext dry-run in the current governance round.
- Full plugin runtime execution/sandboxing.
- Centralized outbound network blocking.
- Chinese mojibake remediation. This remains a separate audit/fix task.

## Architecture Docs

- Current architecture: `docs/architecture/CURRENT_ARCHITECTURE.md`
- Repository structure: `docs/architecture/REPO_STRUCTURE.md`
- API contracts: `docs/architecture/API_CONTRACTS.md`
- Plugin runtime: `docs/architecture/PLUGIN_RUNTIME.md`
- Reality audit: `docs/dev/OPENBUTLER_REALITY_AUDIT_2026-05-30.md`
