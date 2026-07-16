# OpenButler Loop Contract

## Purpose

The development loop keeps repository facts, GitHub work, tests, and privacy constraints aligned. It is separate from the future OpenButler ambient runtime loop.

## Active Loop

| Pattern | Cadence | Level | Authority |
|---|---|---|---|
| Local repository governance drift audit | On demand | L1 | Report only |
| ChatGPT Web GitHub orchestration | Daily 19:00 Asia/Shanghai | Independent reviewer | Issue specification, triage labels, and PR review only |
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

The local Codex heartbeat `OpenButler Night Loop & Morning Report` is paused because its first scheduled run produced no accepted runtime evidence. ChatGPT Web now owns two scheduled public-GitHub workflows: `OpenButler Nightly GitHub Orchestrator` at 19:00 and `OpenButler Morning Product Report` at 08:00 Asia/Shanghai. Their first executions still require readback before they count as useful runs.

The independent web reviewer may improve issue specifications, apply the approved triage labels, and review pull requests. It must not write code, create implementation pull requests, merge or close work, change the active goal, or remove a promotion gate. This reviewer workflow is not an L2 maker and does not advance the repository's Loop level by itself. Only local Codex implements one `ready-for-agent` issue at a time and supplies approved redacted local evidence when needed.

The morning report summarizes public GitHub facts. Local tests, Electron behavior, deployments, and real-data checks remain `本机未验证` unless the user provides a redacted report. User authorization for local real-data testing, production deployment, and desktop installation is necessary but not sufficient: the current level, tests, verifier, privacy rules, and rollback gates still apply.

Production delivery remains in a supervised trial until two consecutive nightly cycles complete without a privacy violation, unresolved serious regression, failed production or desktop smoke, or rollback. A failed cycle resets the count.

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

- seven useful report-only runs;
- false-positive rate below 20 percent;
- no budget violation;
- no unresolved active-goal drift.

L2 fixes use one worktree per item, one maker, and an independent verifier. They open a PR and never merge automatically.

### L2 to L3

- ten successful worktree fixes;
- verifier, rollback, and circuit breaker have been exercised;
- no privacy incident;
- CI and branch protection remain stable.

L3 auto-merge is restricted to the allowlist in `loop-constraints.md`.

## Human Gates

Human review is always required for privacy, identity, consent, sensors, MineContext, Electron lifecycle, dependencies, schemas, migrations, GitHub governance, external writes, or changes spanning more than five files.

## Connectors

The local L1 audit uses `gh` read-only. ChatGPT Web uses the GitHub connector only for issue specification, the approved triage labels, and pull-request review under `docs/agents/chatgpt-web-reviewer.md`. L2 or L3 implementation connector scopes must be documented and approved separately.

## Kill Switch

Set `loop-pause-all: true` in `STATE.md`. A loop that observes this flag exits without further reads or actions.
