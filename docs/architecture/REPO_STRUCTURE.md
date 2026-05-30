# Repository Structure

This is the current, verified repository structure.

## `backend/`

Purpose: FastAPI backend, SQLite persistence, local integrations, APIs, and backend tests.

Key entry:

- `backend/app/main.py`

Main modules:

- `backend/app/integrations/minecontext/`: MineContext/godview integration.
- `backend/app/integrations/local_eyes_adapter.py`: local camera-eye adapter.
- `backend/app/modules/pc_activity_context/`: PC Activity Context.
- `backend/app/modules/butler_core/`: Proactive Butler Core.
- `backend/app/modules/workstation_vision/`: current local vision prototype.
- `backend/app/plugins/*.json`: current runtime plugin manifest source.

Tests:

- `backend/app/modules/pc_activity_context/tests/`
- `backend/app/modules/butler_core/tests/`
- `backend/app/modules/workstation_vision/tests/`

## `frontend/`

Purpose: React + Vite + TypeScript web prototype.

Key entry:

- `frontend/src/App.tsx`

API client:

- `frontend/src/lib/api.ts`

Build command:

```powershell
cd frontend
npm run build
```

Notable scripts:

- `frontend/scripts/smoke-routes.mjs`
- `frontend/scripts/smoke-butler-browser.mjs`
- `frontend/scripts/verify-productization.mjs`

## `api/`

Purpose: Vercel serverless adapter for the FastAPI backend.

Confirmed:

- `api/index.py` adds `backend/` to `sys.path` and imports `app.main:app`.

Not a separate product API implementation.

## `plugins/`

Current state: placeholder directory for a future external plugin/package layout.

Important: this directory is not the current runtime plugin source.

Do not add current runtime plugin manifests here unless the loader is changed and tested.

## `backend/app/plugins/`

Current state: actual runtime plugin manifest directory.

Purpose: JSON manifests returned by `/api/plugins`.

Runtime loading: yes, loaded by `backend/app/main.py` using `PLUGIN_DIR = BASE_DIR / "plugins"`.

Validation: current runtime checks strict-mode availability from `privacy_level`, `model_requirements.provider`, and permissions such as `external_network`, `cloud_api`, and `external_webhook`. It does not execute plugin logic or enforce a full schema validator.

## `openclaw-skill/`

Current state: OpenClaw skill declaration.

Files:

- `openclaw-skill/SKILL.md`
- `openclaw-skill/tools.yaml`

Verified:

- File presence.
- Backend tests check selected docs/tool declaration expectations.

Not verified:

- Real OpenClaw runtime invocation.

## `openclaw/`

Purpose: base OpenClaw skill markdown served by `/api/openclaw/skill`.

## `docs/`

Purpose: product, architecture, privacy, development, integration, and audit facts.

## `.openbutler/`

Purpose: local productization governance.

Files:

- `.openbutler/goals.yaml`
- `.openbutler/task_queue.yaml`
- `.openbutler/definition_of_done.md`

Task queue status is planning metadata. It is not proof of implementation unless backed by code paths and test/command evidence.
