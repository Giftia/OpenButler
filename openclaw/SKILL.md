---
name: openbutler
description: Query a local-first OpenButler personal or family event lake through HTTP tools.
---

# OpenButler Skill

Use this skill when a user asks OpenClaw to retrieve personal context, find household objects, summarize achievements, check home context, inspect local visual sensing, or recover PC activity context from a self-hosted OpenButler instance.

## HTTP Tools

- `GET /health`: verify the local OpenButler API is reachable.
- `GET /api/events?q=<keyword>`: search the event lake. Results include evidence chains.
- `POST /api/chat`: ask the butler a natural-language question.
- `GET /api/plugins`: inspect registered plugins and privacy availability.
- `GET /api/vision/status`: get current local visual sensing state.
- `GET /api/vision/summary/today`: get actual present time and safe local summaries.
- `GET /api/vision/fatigue`: get non-medical fatigue suggestions from observable local events.
- `GET /api/vision/posture`: get posture events and suggestions.
- `GET /api/pc-activity/minecontext/status`: inspect MineContext/godview connectivity.
- `POST /api/pc-activity/minecontext/query-at-time`: query what the user was doing at a time, with evidence boundaries.
- `POST /api/pc-activity/minecontext/search`: search PC activity by keyword without treating generic browser terms as confirmation.
- `GET /api/pc-activity/summary/today`: get imported PC activity summary.
- `GET /api/pc-activity/context-recovery-pack`: get a local context recovery pack for Codex/OpenClaw.
- `GET /api/butler/home`: get today's proactive butler overview.
- `GET /api/butler/insights`: get active insight cards.
- `POST /api/butler/briefings/generate`: generate a morning, evening, or context recovery briefing.
- `POST /api/butler/insights/{insight_id}/feedback`: submit feedback for an insight.

## Privacy Contract

OpenClaw must read `/api/privacy-mode` before invoking tools. In `strict` mode, do not call cloud model providers, external webhooks, or network data sources.

MineContext-derived PC activity is local observation evidence, not final truth for remote systems. For deploys, commits, CI, Yunxiao, or API health, use MineContext only as a clue and verify the source system live.

For proactive butler questions about today, next actions, repeated workflows, or context recovery, call `/api/butler/*` tools and preserve the evidence boundary.
