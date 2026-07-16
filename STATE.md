# OpenButler Loop State

Last accepted run: 2026-07-15T20:06:11+08:00
Current level: L1 active
Canonical branch: `main`
Active objective: `OB-GOAL-027`
loop-pause-all: false

## High Priority

- Verify the first 19:00 and 08:00 ChatGPT Web scheduled runs; registration alone is not runtime evidence.
- Use ChatGPT Web to refine one GitHub implementation issue at a time, while local Codex remains the sole implementation and local-validation worker.
- Keep `OB-GOAL-028` blocked until the L1-to-L2 promotion evidence is accepted.
- Use the 08:00 report to surface attention points, verification paths, and decisions for the user.

## Human Inbox

- The first canonical L1 report was accepted after a clean GitHub-connected run with zero mutations.
- The local Codex heartbeat `OpenButler Night Loop & Morning Report` is paused after producing no accepted scheduled-run evidence.
- ChatGPT Web schedules `OpenButler Nightly GitHub Orchestrator` at 19:00 and `OpenButler Morning Product Report` at 08:00 Asia/Shanghai are registered; their first scheduled runs still need readback.
- Issue #10 is waiting for the user's first trust-policy decision before it can be split into implementation-ready child issues.
- Review any future proposal that touches privacy, identity, sensors, MineContext, Electron lifecycle, dependencies, API schemas, or external actions.

## Watch List

- Existing GitHub issues 1-8 were created for older product-shell work and must not be treated as the current ambient roadmap.
- The Productization Harness writes local audit data and is not the read-only governance loop.
- OpenClaw declarations exist, but runtime invocation remains unverified.
- ChatGPT Web cannot verify local tests, Electron, deployments, or real data without a user-provided redacted report.

## Recent Noise

- Historical objective sections in previous `current_state.md` revisions are not current authority.

## Promotion Evidence

| Gate | State | Evidence |
|---|---|---|
| Sensitive history scan | passed | no tracked secrets, databases, screenshots, logs, or MineContext data found |
| Canonical main replacement | passed | old main archived; product history is canonical main |
| Repository visibility | passed | public |
| CI | passed | all six required checks passed on PR #16 |
| Branch protection | passed | PR required; strict checks; force-push and deletion disabled |
| Manual L1 run | passed | canonical main; clean; zero product/GitHub mutations; ignored report `2026-07-15T12-06-11-179Z` |
