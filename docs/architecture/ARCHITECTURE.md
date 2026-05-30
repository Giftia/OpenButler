# Architecture

OpenButler is built around local evidence-preserving context rather than raw AI summaries.

Reality note: the current repository uses `backend/`, `frontend/`, and `api/`. It does not use `apps/api` or `apps/web`. See `docs/architecture/CURRENT_ARCHITECTURE.md` and `docs/architecture/REPO_STRUCTURE.md` for the current path map.

## Flow

```text
Data Sources
  -> Adapters
  -> Event Lake
  -> Unified Timeline
  -> Metrics Engine
  -> Insight Engine
  -> Butler Inbox
  -> Briefing Generator
  -> Web UI / Chat Tools / OpenClaw Skill
```

## Data Sources

Current sources:

- MineContext local PC activity and godview script outputs.
- Local camera-eye / vision sensing module.
- Mock dashboard events.

Future sources must be opt-in and adapter-based.

## Adapters

Adapters translate source-specific data into OpenButler structures while preserving evidence references and privacy boundaries.

- `backend/app/integrations/minecontext/`: local MineContext/godview access.
- `backend/app/integrations/local_eyes_adapter.py`: local camera-eye access.

## Event Lake

SQLite is the current MVP data layer. It stores derived OpenButler events, metrics, insights, briefings, Productization Harness summaries, settings, and audit records. MineContext source data remains owned by MineContext.

## Unified Timeline

The unified timeline normalizes PC activity and future sources into one queryable event stream. It must keep:

- source,
- source event id,
- time range,
- title and summary,
- entities,
- metrics,
- confidence,
- evidence refs,
- evidence boundary,
- privacy level.

## Metrics Engine

The metrics engine converts timeline events into quantitative snapshots such as PC active minutes, focus minutes, context switches, top apps, top domains, top projects, and low-confidence counts.

## Insight Engine

The insight engine generates proactive cards from metrics and timeline events. MVP rules are deterministic and local; LLM summaries are disabled by default and external models are forbidden in strict mode.

## Butler Inbox

The Inbox stores insight cards and user feedback. Feedback changes status and can reduce future priority for dismissed or inaccurate insight types.

## Briefing Generator

Briefings produce morning, midday, evening, context recovery, and weekly-review views from metrics, insights, and timeline evidence.

## Chat Tools

The chat endpoint routes butler questions to PC Activity and Butler Core services. It must not answer recent-activity questions from chat memory alone.

## OpenClaw Skill

OpenClaw tools expose local context and proactive butler APIs. Tool results must include evidence boundaries and data-insufficiency messages when relevant.

## Privacy Guard

Privacy behavior is enforced through settings, plugin availability, strict-mode checks, and documentation. Strict mode forbids external model calls, external APIs, and external webhooks.

## Plugin Runtime

Plugin manifests live under `backend/app/plugins/*.json`. Each plugin must declare id, name, stage, schemas, privacy level, model requirements, permissions, prompt template, and version.
