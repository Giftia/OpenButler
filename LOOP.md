# OpenButler Loop Contract

## Purpose

The development loop keeps repository facts, GitHub work, tests, and privacy constraints aligned. It is separate from the future OpenButler ambient runtime loop.

## Active Loop

| Pattern | Cadence | Level | Authority |
|---|---|---|---|
| Repository governance drift audit | Daily 19:00 Asia/Shanghai | L1 | Report only |
| Operator morning report | Daily 08:00 Asia/Shanghai | L1 | Evidence summary only |

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

The Codex heartbeat `OpenButler Night Loop & Morning Report` owns both scheduled wakes. The evening wake follows the current promotion level and processes GitHub work strictly one issue at a time. At L1 it runs only the report-only governance audit. The morning wake summarizes completed work, tests, deployment evidence, privacy checks, attention points, manual experience paths, and decisions requiring the user. User authorization for local real-data testing, production deployment, and desktop installation is necessary but not sufficient: the current level, tests, verifier, privacy rules, and rollback gates still apply.

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

L1 uses the local `gh` CLI with read-only GitHub Actions permissions. No MCP connector is required. L2 or L3 connector scopes must be documented and approved before use.

## Kill Switch

Set `loop-pause-all: true` in `STATE.md`. A loop that observes this flag exits without further reads or actions.
