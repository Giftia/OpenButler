# Current Architecture

This document describes the current repository reality. It overrides older prompt assumptions that used `apps/api` and `apps/web`.

## Repository Shape

```text
OpenButler/
  backend/
  frontend/
  api/
  backend/app/plugins/
  plugins/
  openclaw/
  openclaw-skill/
  docs/
  .openbutler/
```

There is no current `apps/api` or `apps/web` layout. Future prompts, tasks, and code references must use `backend/`, `frontend/`, and `api/`. This project should not be migrated into a monorepo-style `apps/` layout during ordinary feature work. If a migration is needed later, open a dedicated migration RFC and treat it as a separate risk-managed task.

## Backend

The backend is a FastAPI application rooted at `backend/`.

- Entry point: `backend/app/main.py`
- Vercel adapter: `api/index.py`
- Core SQLite data path: controlled by `OPENBUTLER_DATA_DIR`
- OpenAPI docs: `/docs` when the backend is running

Main backend modules:

- `backend/app/integrations/minecontext/`: MineContext/godview adapter, script client, normalizer, settings, errors, schemas.
- `backend/app/modules/pc_activity_context/`: PC Activity events, import, summaries, usage stats, workflow candidates, context recovery pack, tests.
- `backend/app/modules/butler_core/`: unified timeline, metrics, rule insights, Butler Inbox feedback, briefings, goals, Productization Harness, tests.
- `backend/app/modules/workstation_vision/`: local vision session and detector prototype. This exists but is not the current productization priority.
- `backend/app/plugins/*.json`: current runtime plugin manifest source.

## Frontend

The frontend is a React + Vite + TypeScript app rooted at `frontend/`.

- App entry: `frontend/src/App.tsx`
- API client: `frontend/src/lib/api.ts`
- Build command: `cd frontend; npm run build`
- Dev command: `cd frontend; npm run dev -- --host 0.0.0.0 --port 5175`

Current route handling is state/path-sniffing inside `App.tsx`, not a separate router package.

Current pages include:

- `/butler`
- `/butler/inbox`
- `/metrics`
- `/timeline`
- `/goals`
- `/pc-activity-context`
- `/vision`
- `/`

## API Directory

`api/` currently contains the Vercel Python function adapter:

- `api/index.py` imports `backend/app/main.py` and exposes `app`.
- It sets Vercel-oriented defaults such as `OPENBUTLER_DATA_DIR=/tmp/openbutler`.

It is not a second backend implementation.

## OpenClaw

- `openclaw/SKILL.md`: base skill markdown served by `/api/openclaw/skill`.
- `openclaw-skill/SKILL.md` and `openclaw-skill/tools.yaml`: tool declarations for OpenClaw/Codex integrations.

Runtime OpenClaw invocation has not been independently verified in this repository. Treat these files as declarations until an execution smoke test proves the bridge.

## Plugin Runtime

Current runtime plugin manifests are JSON files under `backend/app/plugins/*.json`, loaded by `backend/app/main.py` through `/api/plugins`.

The top-level `plugins/` directory is reserved for a future external plugin package layout. It is not currently loaded by the backend.

## Data Flow

```text
MineContext / local sensors / seed events
  -> backend adapters and module services
  -> SQLite derived tables
  -> PC Activity events
  -> Unified Timeline
  -> Metrics Engine
  -> Insight Engine
  -> Butler Inbox and Briefings
  -> Web UI / Chat / OpenClaw declarations
```

MineContext remains an observation layer, not final truth. Remote repository, CI, deployment, Yunxiao, or online service state must be verified from the source system.

## Privacy Architecture Reality

There is no single central `PrivacyGuard` class. Current privacy enforcement is distributed:

- plugin strict-mode availability in `backend/app/main.py`
- PC Activity settings and import preview protections in `backend/app/modules/pc_activity_context/service.py`
- Butler Core strict settings, privacy counters, and delete boundaries in `backend/app/modules/butler_core/service.py`
- Vision raw-frame strict handling in `backend/app/modules/workstation_vision/service.py`

This is sufficient for the current tested prototype paths, but a unified Privacy Guard may be a future architecture task.

Design note: `docs/architecture/PRIVACY_GUARD_DESIGN.md` maps the current distributed checks and proposes a future central guard interface. It is design-only; no central PrivacyGuard implementation exists yet.
