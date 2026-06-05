# Roadmap

## Phase G: Git Baseline And Architecture Reality Alignment

- Goal: make the repository safe for sustained Codex development by establishing Git history and aligning docs with the real `backend/`, `frontend/`, and `api/` layout.
- Deliverables: Git baseline, current architecture docs, repo structure docs, API contracts, plugin runtime docs, ADRs 0006-0008, aligned AGENTS/current_state/task queue.
- Acceptance: baseline and architecture commits exist, tests still pass, no runtime/private data is tracked, task queue has clear ready/needs-human next tasks.
- Risks: stale prompts may still assume `apps/api`, `apps/web`, top-level runtime plugins, or a dedicated insight evidence endpoint.

## Phase 0: Prototype

- Goal: prove a local-first web prototype can show events, plugins, privacy mode, and chat.
- Deliverables: React/Vite UI, FastAPI API, SQLite, plugin manifest loading, Docker Compose.
- Acceptance: one-command local run, six core pages, basic chat, strict/basic privacy switch.
- Risks: prototype data shape can drift without documentation.

## Phase 1: MineContext PC Activity

- Goal: connect the user's local PC observation layer.
- Deliverables: MineContext adapter, godview query/search, PCActivityEvent, keyword match grading, summary, OpenClaw tools.
- Acceptance: query a time, search a keyword, import today, preserve evidence boundary, do not copy screenshots by default.
- Risks: MineContext schema or script output changes; generated summaries may be over-trusted.

## Phase 2: Proactive Butler Core

- Goal: move from passive query to proactive daily butler.
- Deliverables: unified timeline, metrics engine, insight engine, Butler Inbox, briefings, goals, feedback loop.
- Acceptance: `/butler` explains today, `/butler/inbox` accepts feedback, strict mode uses no external model.
- Risks: noisy insights, weak thresholds, insufficient data quality signals.

### Phase 2 L2: Real History, Evidence Review, Feedback Noise Reduction

- Goal: make the proactive Butler useful against real recent history while preserving evidence and privacy boundaries.
- Deliverables: 7-day PC Activity / MineContext dry-run import preview, duplicate-risk reporting, Inbox evidence detail hardening, feedback-driven insight noise evaluation, 7-day review briefing, and Goals trend linkage.
- Acceptance: dry-run previews recent history without database writes, screenshot copying, external model calls, or MineContext mutation; repeated imports are protected by source id or stable hash; 7-day metrics can be rebuilt from unified timeline; Inbox evidence detail click smoke passes; dismiss/inaccurate/too-frequent feedback can reduce future insight priority; weekly review briefing and Goals trend use the same local 7-day metrics.
- Risks: MineContext schema drift, duplicate records without stable source ids, over-suppressing important privacy or data-quality notices.

### Phase 2 L3: Demo / Local Boundary And Trust Layer

- Goal: make the public demo honest and understandable while preserving the path to real local use.
- Deliverables: Demo/local mode boundary, local real mode activation path, consistent evidence trust layer, archived completed goals, and one clear active productization objective.
- Acceptance: Vercel clearly says it is a sample experience; local mode explains local run plus active authorization; ordinary CTAs use user task language; reminders, timeline events, and assistant answers keep evidence boundaries; no real MineContext data is read without explicit approval.
- Risks: public users may still expect web-only real data access; local activation may remain too technical until a guided installer exists.

## Phase 3: Workstation Vision

- Goal: add local visual presence/work-state signals where user explicitly opts in.
- Deliverables: local eyes adapter, session control, presence/posture/attention/fatigue signals, strict local processing.
- Acceptance: no raw frame persistence by default, clear running state, confidence on all results.
- Risks: camera privacy, false precision, multi-person ambiguity.

## Phase 4: Mobile Capture

- Goal: allow optional mobile-origin notes, photos, and lightweight context capture.
- Deliverables: mobile-friendly web capture or small companion app, upload/import queue, local-first retention rules.
- Acceptance: capture data becomes evidence-preserving events.
- Risks: scope creep into all-in-one mobile product.

## Phase 5: Home Context

- Goal: add household-level context such as calendar, smart-home summaries, and family-safe notes.
- Deliverables: adapters, household permissions, multi-user boundaries.
- Acceptance: per-user authorization and clear household data ownership.
- Risks: shared-device privacy and consent ambiguity.

## Phase 6: Custom Devices

- Goal: support special sensors only after the core butler loop is stable.
- Deliverables: adapter contracts, permission manifests, local processing requirements.
- Acceptance: devices enter through the same event/evidence/privacy pipeline.
- Risks: hardware work can overwhelm product quality.

## Phase 7: Marketplace / Skills

- Goal: make repeated workflows and butler capabilities reusable.
- Deliverables: plugin registry, skill drafts, OpenClaw/OpenButler tool templates.
- Acceptance: user can approve skill generation from evidence-backed workflow candidates.
- Risks: unsafe automation or unclear user consent.
