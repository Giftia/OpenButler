# OpenButler Current State

Updated: 2026-07-15

## Current Stage

The only active product objective is `OB-GOAL-027: Loop-Driven Ambient OpenButler`.

OpenButler is moving from prompt-driven development to a controlled loop-engineering workflow. This stage does not add sensors or smart-home actions. It establishes a read-only L1 governance loop, CI gates, durable state, explicit budgets, circuit breakers, and a safe promotion path toward L2 and L3.

## Repository Baseline

- Canonical repository: `Giftia/OpenButler`.
- Canonical branch: `main`.
- Previous unrelated remote main: `archive/original-main-2026-07-15` at `5e67d7e`.
- Product history baseline: `79485f5` before the OB-GOAL-027 branch.
- Repository visibility: public after a redacted full-history scan found no tracked secrets, databases, screenshots, logs, or MineContext user data.
- Active implementation branch: `codex/loop-driven-ambient-openbutler`.
- Governance PR: `#16`; all six required checks pass and human review/merge is pending.
- `main` protection requires a pull request and strict Butler Core, PC Activity, Workstation Vision, Frontend Build, Desktop Contract, and Loop Governance checks.

## Product Reality

Already implemented and tested:

- MineContext/godview read-only adapter and PC Activity Context.
- Unified timeline, metrics, insights, Inbox feedback, briefings, goals, and context recovery.
- React/Vite ordinary-user product shell and Windows Electron shell.
- Local-mode activation flow with redacted preview boundaries.

Important gaps before ambient operation:

- No unified local API authentication or central PrivacyGuard.
- No continuous sensor scheduler, checkpoint recovery, or power policy.
- No real household identity and consent model.
- Quiet hours and intervention budgets are not yet the global decision gate.
- No approved external action execution state machine.

## Two Different Loops

1. **Development loop**: triage repository drift, keep state, isolate changes, verify, and escalate.
2. **Ambient product loop**: observe, normalize, identify, apply consent, decide whether to stay silent, deliver a suggestion, and learn from feedback.

The L1 development loop is report-only. It must not read real MineContext activity, change product code, mutate GitHub, deploy, or call external models.

## Source Of Truth

1. `.openbutler/goals.yaml` - active and planned product objectives.
2. GitHub Issues - executable work queue.
3. `STATE.md` - current loop snapshot and human inbox.
4. `LOOP.md` - loop operating contract.
5. `loop-run-log.md` - append-only run evidence.
6. `current_state.md` - concise historical and architectural orientation only.

## Next Promotion Gate

CI and branch protection are ready. OB-GOAL-027 completes only after PR #16 receives human review and merge, the first GitHub-connected manual L1 audit is clean or has explicitly accepted findings, and the weekday report-only automation is configured. Product work then proceeds to `OB-GOAL-028: Secure Local Control Plane & PrivacyGuard`.

## Privacy Boundary

- No real MineContext activity was read in this stage.
- No screenshots were copied.
- No microphone or camera data was captured.
- No external model or webhook was called.
- No smart-home or remote-system action was executed.
