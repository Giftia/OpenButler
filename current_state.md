# OpenButler Current State

Updated: 2026-07-17

## Current Stage

The only active product objective is `OB-GOAL-027: Loop-Driven Ambient OpenButler`.

OpenButler is preparing a loop-driven Integrated Context Engine roadmap. The canonical main baseline and first GitHub-connected L1 audit are complete. The original local Codex heartbeat is paused. PR #18 aligns the public reviewer and governance facts; stacked PR #19 delivers the local night controller, Preview acceptance path, and Windows scheduler scripts. Neither PR is merged, the scheduler is not installed, and no supervised nightly dry-run has been accepted yet.

ChatGPT Web is a read-only public-GitHub reviewer at 17:30 and 08:00. Windows Task Scheduler will own the local 19:00 dry-run and 08:00 acceptance opening. Local Codex remains the only implementation and GitHub write worker.

## Repository Baseline

- Canonical repository: `Giftia/OpenButler`.
- Canonical branch: `main`.
- Previous unrelated remote main: `archive/original-main-2026-07-15` at `5e67d7e`.
- Product history baseline: `79485f5` before the OB-GOAL-027 branch.
- Repository visibility: public after a redacted full-history scan found no tracked secrets, databases, screenshots, logs, or MineContext user data.
- Governance PR: `#16`, merged as `5081011` after all required checks passed.
- `main` protection requires a pull request and strict Butler Core, PC Activity, Workstation Vision, Frontend Build, Desktop Contract, and Loop Governance checks.

## Product Reality

Already implemented and tested:

- MineContext/godview read-only adapter and PC Activity Context.
- Unified timeline, metrics, insights, Inbox feedback, briefings, goals, and context recovery.
- React/Vite ordinary-user product shell and Windows Electron shell.
- Local-mode activation flow with redacted preview boundaries.

Important gaps before the Integrated Context Engine can start:

- No unified local API authentication or central PrivacyGuard.
- No internal `context_engine` implementation yet; MineContext remains an external read-only compatibility source.
- No three-route image, text, and Embedding model gateway with protected secret storage.
- No verified migration preview and read-only copy path for existing MineContext data.
- No feature-parity implementation for capture, activities, reports, tasks, search, and memory.

## Two Different Loops

1. **Development loop**: triage repository drift, keep state, isolate changes, verify, and escalate.
2. **Context product loop**: capture authorized context, deduplicate, understand, store, generate results, explain evidence, and learn from feedback.

The L1 development loop is report-only. It must not read real MineContext activity, change product code, mutate GitHub, deploy, or call external models.

## Source Of Truth

1. `.openbutler/goals.yaml` - active and planned product objectives.
2. GitHub Issues - executable work queue.
3. `STATE.md` - current loop snapshot and human inbox.
4. `LOOP.md` - loop operating contract.
5. `loop-run-log.md` - append-only run evidence.
6. `current_state.md` - concise historical and architectural orientation only.

## Planned Product Route

`OB-GOAL-034` through `OB-GOAL-041` define the new sequence: secure internal context engine, three-route model gateway, MineContext feature parity, migration and product shell, OpenButler Cloud, NanoKVM screen recall, controlled KVM autonomy, then ambient expansion. Historical goals `OB-GOAL-028` through `OB-GOAL-033` are deferred or superseded and their existing Issues are not executable under the new route.

## Nightly Delivery Bootstrap

- GitHub Issues require both `ready-for-agent` and `nightly-approved` before the local runner may select them.
- L1 runs are forcibly read-only and write only ignored artifacts under `data/nightly/`.
- One supervised scheduled dry-run needs real runtime readback. Registration alone does not count.
- The exact approval `批准进入 L2` is required before the executor may create worktrees, branches, PRs or Preview builds.
- L2 never merges at night. It prepares independent PRs and a side-by-side `OpenButler Preview` acceptance center for the user.
- The nightly budget is 750,000 tokens; no new Issue starts after 600,000 tokens or 06:15.

## Next Promotion Gate

The repository remains at L1. PR #18 and PR #19 must be reviewed and merged first. Then one supervised dry-run must produce accepted runtime readback without product or GitHub mutation. Only the exact approval `批准进入 L2` may activate `OB-GOAL-034`; this governance repair does not itself enter L2.

## Privacy Boundary

- No real MineContext activity was read in this stage.
- No screenshots were copied.
- No microphone or camera data was captured.
- No external model or webhook was called.
- No smart-home or remote-system action was executed.
