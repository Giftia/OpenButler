# API Contracts

This document lists the currently implemented FastAPI routes extracted from `app.routes`. Do not add routes here from plans or prompts unless they exist in code.

## Core

| Method | Path | Reality |
|---|---|---|
| `GET` | `/health` | implemented |
| `GET` | `/api/events` | implemented |
| `POST` | `/api/events/simulate` | implemented |
| `GET` | `/api/plugins` | implemented |
| `GET` | `/api/privacy-mode` | implemented |
| `POST` | `/api/privacy-mode` | implemented |
| `POST` | `/api/chat` | implemented |
| `GET` | `/api/openclaw/skill` | implemented |
| `GET` | `/docs` | FastAPI docs |
| `GET` | `/openapi.json` | FastAPI OpenAPI |
| `GET` | `/redoc` | FastAPI Redoc |

## PC Activity Context

Prefix: `/api/pc-activity`

| Method | Path | Reality |
|---|---|---|
| `GET` | `/api/pc-activity/minecontext/status` | implemented |
| `POST` | `/api/pc-activity/minecontext/query-at-time` | implemented |
| `POST` | `/api/pc-activity/minecontext/search` | implemented |
| `POST` | `/api/pc-activity/minecontext/import` | implemented; writes OpenButler PC events |
| `GET` | `/api/pc-activity/events` | implemented |
| `DELETE` | `/api/pc-activity/events` | implemented; deletes OpenButler PC Activity events, not MineContext source data |
| `GET` | `/api/pc-activity/summary/today` | implemented |
| `GET` | `/api/pc-activity/summary` | implemented |
| `GET` | `/api/pc-activity/focus-blocks` | implemented |
| `GET` | `/api/pc-activity/app-usage` | implemented |
| `GET` | `/api/pc-activity/domain-usage` | implemented |
| `GET` | `/api/pc-activity/workflow-candidates` | implemented |
| `GET` | `/api/pc-activity/evidence/{event_id}` | implemented |
| `GET` | `/api/pc-activity/settings` | implemented |
| `POST` | `/api/pc-activity/settings` | implemented |
| `GET` | `/api/pc-activity/context-recovery-pack` | implemented |

## Proactive Butler Core

Prefix: `/api/butler`

| Method | Path | Reality |
|---|---|---|
| `GET` | `/api/butler/home` | implemented |
| `GET` | `/api/butler/readiness` | implemented |
| `GET` | `/api/butler/mvp-report` | implemented |
| `GET` | `/api/butler/demo/data-insufficient-drill` | implemented |
| `GET` | `/api/butler/harness/runs/latest` | implemented |
| `GET` | `/api/butler/productization/objectives/status` | implemented |
| `GET` | `/api/butler/productization/l1-audit` | implemented |
| `GET` | `/api/butler/productization/demo-pack` | implemented |
| `POST` | `/api/butler/demo/run` | implemented |
| `POST` | `/api/butler/demo/reset` | implemented |
| `POST` | `/api/butler/import/pc-activity/preview` | implemented; dry-run preview by default |
| `GET` | `/api/butler/timeline` | implemented |
| `POST` | `/api/butler/timeline/rebuild` | implemented |
| `GET` | `/api/butler/metrics/today` | implemented |
| `GET` | `/api/butler/metrics` | implemented; supports `days` |
| `GET` | `/api/butler/insights` | implemented |
| `GET` | `/api/butler/insights/noise-evaluation` | implemented |
| `POST` | `/api/butler/insights/generate` | implemented |
| `POST` | `/api/butler/insights/{insight_id}/feedback` | implemented |
| `POST` | `/api/butler/insights/{insight_id}/dismiss` | implemented |
| `POST` | `/api/butler/insights/{insight_id}/snooze` | implemented |
| `GET` | `/api/butler/briefings/today` | implemented |
| `POST` | `/api/butler/briefings/generate` | implemented |
| `GET` | `/api/butler/goals` | implemented |
| `POST` | `/api/butler/goals` | implemented |
| `PATCH` | `/api/butler/goals/{goal_id}` | implemented |
| `DELETE` | `/api/butler/goals/{goal_id}` | implemented |
| `GET` | `/api/butler/context-recovery` | implemented |
| `GET` | `/api/butler/settings` | implemented |
| `POST` | `/api/butler/settings` | implemented |
| `GET` | `/api/butler/export` | implemented |
| `DELETE` | `/api/butler/data` | implemented; deletes Butler-derived data only |

## Vision

Two prefixes currently point to the same module:

- `/api/vision`
- `/api/workstation-vision`

Implemented routes under both prefixes:

| Method | Suffix | Reality |
|---|---|---|
| `GET` | `/cameras` | implemented |
| `POST` | `/session/start` | implemented |
| `POST` | `/session/stop` | implemented |
| `GET` | `/status` | implemented |
| `GET` | `/events` | implemented |
| `GET` | `/summary/today` | implemented |
| `GET` | `/summary` | implemented |
| `GET` | `/attention-heatmap` | implemented |
| `GET` | `/posture` | implemented |
| `GET` | `/fatigue` | implemented |
| `GET` | `/settings` | implemented |
| `POST` | `/settings` | implemented |
| `DELETE` | `/data/today` | implemented |
| `DELETE` | `/data` | implemented |
| `GET` | `/export` | implemented |

## Explicitly Not Implemented

These paths were mentioned in prior prompts or plans but are not present in the extracted route table:

- `GET /api/butler/insights/{insight_id}/evidence`
- `/api/devices/*`
- `/api/acoustic/*`

## Current Insight Evidence Contract

Current contract: `GET /api/butler/insights` returns each insight card with inline `evidence_refs`, `evidence_boundary`, `confidence`, `metrics`, status, and suggested actions. The frontend Butler Inbox expands those fields in-place.

There is no dedicated insight evidence endpoint today.

### Future Option A: Keep Inline Evidence

Keep using inline `evidence_refs` in insight cards.

Best when:

- evidence payloads stay small,
- Butler Inbox and OpenClaw can fetch insight cards once,
- no lazy loading is needed.

### Future Option B: Add Dedicated Evidence Endpoint

Add `GET /api/butler/insights/{id}/evidence`.

Best when:

- evidence detail becomes large,
- OpenClaw needs a single-purpose evidence tool,
- evidence requires lazy loading or extra redaction rules.

Do not implement this endpoint as part of architecture alignment unless a separate task is opened.
