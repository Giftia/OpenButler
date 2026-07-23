# OpenButler Loop Contract

## Purpose

The development loop keeps repository facts, GitHub work, tests, and privacy constraints aligned. It is separate from the future OpenButler ambient runtime loop.

## Active Loop

| Pattern | Cadence | Level | Authority |
|---|---|---|---|
| Local repository governance drift audit | On demand | L1 | Report only |
| Local nightly delivery | Daily 20:00 Asia/Shanghai | L2 | Serial implementation, verification and Nightly packaging |
| Local QA cutoff | Daily 07:15 Asia/Shanghai | L2 | Stop new work and finish the current safe unit |
| Local cleanup | Daily 08:20 Asia/Shanghai | L2 | Finish report and terminate Nightly test processes |
| Morning report | Daily 08:30 Asia/Shanghai | L2 | Redacted local and GitHub evidence |
| ChatGPT Web morning report | Daily 08:30 Asia/Shanghai | Independent reviewer | Public GitHub evidence summary only |
| ChatGPT Web issue preparation | Daily 09:00 Asia/Shanghai | Independent reviewer | Issue specification and acceptance drafts |
| ChatGPT Web review checkpoint | Daily 13:30 Asia/Shanghai | Independent reviewer | Product, privacy and architecture review |
| ChatGPT Web queue freeze | Daily 19:30 Asia/Shanghai | Independent reviewer | Final queue order and risk summary |

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

The local Codex heartbeat `OpenButler Night Loop & Morning Report` remains paused. Windows Task Scheduler is the durable local scheduler. ChatGPT Web is an advisory reviewer and report surface; it is never the hard trigger.

The independent web reviewer produces issue body patches, suggested triage-label changes, and pull-request review drafts. Its current GitHub connection cannot write; local Codex verifies and applies approved GitHub changes. The reviewer must not write code, create implementation pull requests, merge or close work, change the active goal, or remove a promotion gate. This reviewer workflow is not an L2 maker and does not advance the repository's Loop level by itself. Only local Codex implements one `ready-for-agent` issue at a time and supplies approved redacted local evidence when needed.

The morning report summarizes public GitHub facts. Local tests, Electron behavior, deployments, and real-data checks remain `本机未验证` unless the user provides a redacted report. User authorization for local real-data testing, production deployment, and desktop installation is necessary but not sufficient: the current level, tests, verifier, privacy rules, and rollback gates still apply.

Delegated L2 runs in the Nightly channel. Stable release remains manually approved until two consecutive delivery cycles complete without privacy, regression, lifecycle or rollback failures.

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

L2 fixes use one worktree per item, one maker, a code verifier, and a separate
product/privacy verifier. They always open a pull request. Delegated merge is
allowed only through the contract below; no worker may push directly to `main`.

## Delegated Delivery Contract

- GitHub Issues are eligible when `ready-for-agent` is present and `automation-blocked` is absent.
- A Cloud or local execution lease prevents duplicate work.
- Work is serial, one Issue and worktree at a time, from 20:00 until 07:15.
- The nightly hard cap is 750,000 tokens; at 80 percent no new issue is started.
- Two fresh-context verifiers are required: code correctness and product/privacy.
- Successful issue branches remain separate pull requests. A local-only integration worktree may combine conflict-free commits for OpenButler Nightly testing.
- Fully verified PRs may squash-merge after exact SHA and CI revalidation. Stable publishing remains manual.

### L2 to L3

- ten successful worktree fixes;
- verifier, rollback, and circuit breaker have been exercised;
- no privacy incident;
- CI and branch protection remain stable.

L3 auto-merge is restricted to the allowlist in `loop-constraints.md`.

## Human Gates

The hard-stop actions in `.openbutler/automation-policy.yaml` always require a
new human decision. Reversible high-risk changes such as privacy guards,
authentication, sensors, MineContext adapters, Electron lifecycle,
dependencies, schemas, and retention may proceed only with both verifiers,
fresh CI, an isolated Nightly pass, and a verified rollback path.

## Connectors

The local L1 audit uses `gh` read-only. ChatGPT Web reads public GitHub facts and emits review guidance; it is advisory and never the hard trigger. Codex Cloud is enabled only after a docs-only environment smoke. Local Codex remains the authoritative Nightly and device-validation worker.

## Kill Switch

Set `loop-pause-all: true` in `STATE.md`. A loop that observes this flag exits without further reads or actions.
