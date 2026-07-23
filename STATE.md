# OpenButler Loop State

Last accepted run: 2026-07-23T23:15:37+08:00
Current level: L2 active
Canonical branch: `main`
Active objective: `OB-GOAL-034`
loop-pause-all: false

## High Priority

- Implement `OB-GOAL-034: Secure Integrated Context Engine` through decision-complete GitHub Issues.
- Keep Cloud execution disabled until a docs-only Codex Cloud smoke succeeds.
- Run local execution only from 20:00 to 07:15; finish cleanup by 08:20.
- Keep exactly one execution lease per Issue across Cloud and local workers.
- Install only the isolated OpenButler Nightly channel automatically.
- Publish the redacted delivery report at 08:30.

## Human Inbox

- The first canonical L1 report was accepted after a clean GitHub-connected run with zero mutations.
- PR #18 and #19 were squash-merged after fresh green CI.
- A supervised Windows Task Scheduler dry-run completed with `LastTaskResult=0`.
- The accepted run `2026-07-23T15-15-37-644Z` reported zero product/GitHub mutation,
  zero real-activity read, zero database write, zero screenshot copy and zero external-model call.
- The user pre-authorized `批准进入 L2，并启用完全自动代理`; this governance change records it.
- Windows Task Scheduler owns the 20:00, 07:15, 08:20 and 08:30 local phases.
- ChatGPT Web checkpoints are 08:30, 09:00, 13:30 and 19:30; they remain independent of local execution.
- ChatGPT Web has no verified GitHub write connection; every issue patch, label change, and PR review remains a draft until local Codex applies it.
- Issues #10 through #15 describe the superseded OB-GOAL-028 through OB-GOAL-033 route and must not be selected as Integrated Context Engine implementation work.
- OB-GOAL-034 needs new decision-complete implementation Issues before execution.
- Review any future proposal that touches privacy, identity, sensors, MineContext, Electron lifecycle, dependencies, API schemas, or external actions.

## Watch List

- Existing GitHub issues 1-15 are historical product-shell or ambient-roadmap work and must not be treated as the new Integrated Context Engine queue.
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
| Supervised nightly dry-run | passed | scheduled run `2026-07-23T15-15-37-644Z`; task result 0; redacted pack |
| L2 human approval | passed | user pre-authorization recorded by this governance change |
| L2 delegated policy | pending merge | `.openbutler/automation-policy.yaml` |
