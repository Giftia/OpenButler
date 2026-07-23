# OpenButler Loop Contract

## Purpose

The development loop keeps repository facts, GitHub work, tests, and privacy constraints aligned. It is separate from the future OpenButler ambient runtime loop.

## Active Loop

| Pattern | Cadence | Level | Authority |
|---|---|---|---|
| Local repository governance drift audit | On demand | L1 | Report only |
| Local nightly delivery rehearsal | Daily 19:00 Asia/Shanghai | L1 dry-run | Queue/readiness report only until L2 is approved |
| ChatGPT Web GitHub preflight | Daily 17:30 Asia/Shanghai | Independent reviewer | Read-only issue specification and PR review drafts |
| ChatGPT Web morning product report | Daily 08:00 Asia/Shanghai | Independent reviewer | Public GitHub evidence summary only |

Command:

```powershell
Push-Location tools/loop
npm run audit:governance -- --github
Pop-Location
```

## Inputs

- `AGENTS.md`
- `.openbutler/goals.yaml`
- `.openbutler/task_queue.yaml`
- `STATE.md`
- `loop-budget.md`
- `loop-constraints.md`
- current Git branch, remote refs, CI definitions, issues, labels, and pull requests

GitHub Issues are the executable work queue. `.openbutler/task_queue.yaml` stores goal-level synchronization and evidence, not a second independent backlog.

The L1 loop must not inspect MineContext source data, OpenButler runtime databases, screenshots, raw activity output, microphone data, or camera data.

The local Codex heartbeat `OpenButler Night Loop & Morning Report` remains paused because its first scheduled run produced no accepted runtime evidence. The durable local scheduler is Windows Task Scheduler, installed by `tools/nightly/install-scheduled-tasks.ps1`. It starts in `dry-run` mode and writes only ignored artifacts under `data/nightly/`. ChatGPT Web owns two public-GitHub reviewer workflows: a 17:30 preflight and an 08:00 morning report. Registration alone never counts as a useful run.

The independent web reviewer produces issue body patches, suggested triage-label changes, and pull-request review drafts. Its current GitHub connection cannot write; local Codex verifies and applies approved GitHub changes. The reviewer must not write code, create implementation pull requests, merge or close work, change the active goal, or remove a promotion gate. This reviewer workflow is not an L2 maker and does not advance the repository's Loop level by itself. Only local Codex implements one `ready-for-agent` issue at a time and supplies approved redacted local evidence when needed.

The morning report summarizes public GitHub facts. Local tests, Electron behavior, deployments, and real-data checks remain `本机未验证` unless the user provides a redacted report. User authorization for local real-data testing, production deployment, and desktop installation is necessary but not sufficient: the current level, tests, verifier, privacy rules, and rollback gates still apply.

After L2 promotion, production delivery remains in a supervised trial until two consecutive delivery cycles complete without a privacy violation, unresolved serious regression, failed production or desktop smoke, or rollback. This post-promotion release trial is separate from the single L1 dry-run promotion gate.

## Outputs

- `data/loop-runs/<run-id>/report.json`
- `data/loop-runs/<run-id>/report.md`
- concise human summary
- exit `0` for clean, `2` for drift, `3` for partial evidence

`data/` is ignored by Git. L1 does not edit tracked files, including `STATE.md` and `loop-run-log.md`; a human or an approved higher-level loop records accepted state changes.

## Checks

1. Canonical `main` is an ancestor of the current branch.
2. Exactly one product objective is active.
3. Active tasks reference declared goals and blocked tasks reference valid prerequisites.
4. Evidence claimed by completed tasks exists.
5. `current_state.md` names the current active goal.
6. Required CI and loop files exist.
7. GitHub repository visibility, labels, issues, workflows, and branch protection can be observed.

## Circuit Breakers

Stop and return partial evidence when:

- canonical branch has no common ancestry with the current branch;
- goal or task YAML cannot be parsed;
- more than one objective is active;
- GitHub evidence is unavailable after two retries for transient failures;
- three consecutive infrastructure failures are recorded by the operator.

## Promotion

### L0 to L1

- canonical main and archive branch verified;
- CI green and main protected;
- loop audit score at least 70;
- one manual governance audit completed without side effects.

### L1 to L2

- one supervised nightly dry-run with accepted runtime readback;
- false-positive rate below 20 percent;
- no budget violation;
- no unresolved active-goal drift.

After the dry-run passes, L2 still requires the exact human approval `批准进入 L2`. A governance pull request records the promotion; the scheduler may not change its own authority.

L2 fixes use one worktree per item, one maker, and an independent verifier. They open a PR and never merge automatically.

## Nightly Delivery Contract

- GitHub Issues are eligible only when both `ready-for-agent` and `nightly-approved` are present.
- High-risk issues require `nightly-approved` from GitHub user `Giftia` after the latest issue specification change.
- Work is serial, one issue and worktree at a time, from 19:00 until 06:15.
- The nightly hard cap is 750,000 tokens; at 80 percent no new issue is started.
- Successful issue branches remain separate pull requests. A local-only integration worktree may combine conflict-free commits for `OpenButler Preview` acceptance testing.
- Nightly execution never merges. The morning acceptance pack records exact PR head SHAs. Human approval is valid only while those SHAs and green checks remain unchanged.

### L2 to L3

- ten successful worktree fixes;
- verifier, rollback, and circuit breaker have been exercised;
- no privacy incident;
- CI and branch protection remain stable.

L3 auto-merge is restricted to the allowlist in `loop-constraints.md`.

## Human Gates

Human review is always required for privacy, identity, consent, sensors, MineContext, Electron lifecycle, dependencies, schemas, migrations, GitHub governance, external writes, or changes spanning more than five files.

## Connectors

The local L1 audit uses `gh` read-only. ChatGPT Web currently reads public GitHub facts and emits change drafts under `docs/agents/chatgpt-web-reviewer.md`; it has no verified GitHub write connection. Local Codex is the only GitHub write proxy. L2 or L3 implementation connector scopes must be documented and approved separately.

## Kill Switch

Set `loop-pause-all: true` in `STATE.md`. A loop that observes this flag exits without further reads or actions.
