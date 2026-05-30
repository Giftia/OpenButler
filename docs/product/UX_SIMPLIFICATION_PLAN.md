# UX Simplification Plan

Date: 2026-05-30

## Why

OpenButler has working local context, timeline, metrics, insight, briefing, feedback, and privacy capabilities. The current UI exposes too much of that machinery at once. A new user can see that the system is powerful, but not what to do first.

The product UI V1 goal is to make the first screen answer:

- what OpenButler is,
- what it knows today,
- what is worth attention,
- what to do next,
- where to inspect the supporting basis.

## Current Information Architecture Audit

Current frontend structure:

| Route | Current component | Primary API data | User-facing issue |
|---|---|---|---|
| `/` | `Dashboard` | `/api/events`, `/api/plugins`, `/api/privacy-mode` | Prototype dashboard, not the proactive butler value entry. |
| `/butler` | `ButlerHome` | `/api/butler/home`, readiness, MVP report, harness APIs | Mixes user value with Productization Harness and developer checks. |
| `/butler/inbox` | `ButlerInbox` | `/api/butler/insights` | Uses internal English labels such as Inbox and evidence refs. |
| `/metrics` | `MetricsPage` | `/api/butler/metrics/today`, `/api/butler/metrics` | Useful, but reads like an analytics panel. |
| `/timeline` | `UnifiedTimeline` | `/api/butler/timeline` | Shows technical event source/type rather than remembered life/work moments. |
| `/goals` | `GoalsPage` | `/api/butler/goals`, settings, metrics range | Useful for power users; too detailed for first-run users. |
| `/pc-activity-context` | `PCActivityContext` | `/api/pc-activity/*` | Important integration page; too technical for primary navigation. |
| `/vision` | `WorkstationVision` | `/api/vision/*` | Hardware/sensor detail; should live under advanced/lab. |
| `/plugins` | `Plugins` | `/api/plugins` | Developer/runtime metadata; should live under advanced/lab. |
| `/privacy` | `Privacy` | `/api/privacy-mode`, plugin metadata | Should be reachable as "我的 / 设置"; detailed diagnostics should be advanced. |
| `/chat` | `Chat` | `/api/chat` | Should become the simple "管家" entry. |

Current main blockers for ordinary users:

- Too many first-level navigation items.
- Internal terms appear in primary UI: MineContext, PC Activity, Productization Harness, Metrics, evidence refs, readiness.
- The first screen emphasizes demo controls and acceptance checks instead of the daily butler value.
- Empty or data-insufficient states look like an engineering setup problem rather than a guided start.
- Evidence is present, but competes with the message instead of being progressively disclosed.

## New Primary Navigation

Ordinary user navigation should be four entries:

1. **今日**: `/` or `/butler`; daily status, top reminders, next best action, timeline preview.
2. **时间线**: `/timeline`; remembered events grouped by time.
3. **管家**: `/chat`; conversational query and advice.
4. **我的**: `/privacy` for V1; privacy, goals, data sources, and advanced/lab links.

Advanced/lab links remain available but are not first-level ordinary navigation:

- `/dashboard`
- `/pc-activity-context`
- `/vision`
- `/plugins`
- `/metrics`
- `/goals`
- `/butler/inbox`

## Product UI V1 Direction

The new homepage should use a layered model:

1. First screen: value proposition, current status, privacy mode, one primary action.
2. Second section: top 1-3 butler reminders.
3. Third section: scene cards for work rhythm, life record, automation candidates, data source status.
4. Fourth section: timeline preview.
5. Folded section: advanced and lab entries.

## Progressive Triggering

UI state should be derived in the frontend from existing APIs:

- `new_user`: no source events, no insights, data quality notice present.
- `connected_no_insights`: source events or timeline exist, but no active insights.
- `active`: insights exist and metrics have source event count.

The frontend may use fallback content when data is missing, but fallback must be labeled as guidance, not fabricated history.

## Constraints

- Do not add `/api/butler/insights/{id}/evidence`.
- Use inline `evidence_refs` from `GET /api/butler/insights`.
- Do not read real MineContext data in this UI task.
- Do not call external models or webhooks.
- Keep existing technical pages available through advanced/lab links.
