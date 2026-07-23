# OpenButler Loop Operations

## Install

The loop tools are isolated under `tools/loop` and pinned with an npm lockfile.

```powershell
Push-Location tools/loop
npm ci --registry=https://registry.npmjs.org
Pop-Location
```

The upstream packages are scoped:

```text
@cobusgreyling/loop-init@1.4.0
@cobusgreyling/loop-audit@1.6.0
@cobusgreyling/loop-cost@1.1.0
@cobusgreyling/loop-sync@1.0.0
@cobusgreyling/loop-context@1.1.0
@cobusgreyling/loop-worktree@1.0.0
```

Do not use unscoped names such as `loop-audit`; they are not published under those names.

## Run L1 Manually

```powershell
Push-Location tools/loop
npm run audit:governance -- --github
Pop-Location
```

Reports are written to `data/loop-runs/<run-id>/` and ignored by Git.

Exit codes:

- `0`: clean.
- `2`: repository or governance drift.
- `3`: partial evidence or a circuit breaker.

## Scheduled L1 Gate

The canonical local schedule is Windows Task Scheduler. PR #19 supplies an idempotent installer for a 19:00 local dry-run and an 08:00 acceptance-pack opening. Until that PR is merged and the tasks are installed with runtime readback, the schedule is `not verified`.

Every L1 dry-run reads the `loop-pause-all` flag and writes only ignored artifacts under `data/nightly/`. ChatGPT Web's 17:30 preflight and 08:00 report are independent read-only reviews; they do not trigger local Codex and do not count as local runtime evidence.

## What L1 Can Read

- tracked governance documents;
- Git refs and status;
- GitHub repository metadata, issues, labels, workflows, checks, and branch protection;
- existence of evidence paths claimed by task records.

## What L1 Cannot Read Or Change

- MineContext activity or source databases;
- screenshots, raw output, microphone, or camera data;
- product runtime databases;
- tracked source files;
- GitHub issues, labels, pull requests, branches, or settings;
- deployments, external models, or webhooks.

## Promotion

L1 remains report-only until one supervised nightly dry-run has accepted runtime readback, stays within budget, and produces no unresolved governance drift. Promotion still requires the exact human approval `批准进入 L2` and a governance PR. L2 requires isolated worktrees and an independent verifier. L3 remains disabled until ten successful L2 fixes, an exercised rollback and circuit breaker, stable CI, and zero privacy incidents.

## Failure Handling

- Invalid YAML, multiple active goals, or unrelated canonical history stops the run.
- GitHub 429 and 5xx responses may be retried twice.
- Three consecutive infrastructure failures pause scheduling and require human review.
- Set `loop-pause-all: true` in `STATE.md` to stop future runs.

## Relationship To Productization Harness

The existing Productization Harness may write local audit rows and artifacts. It is useful product evidence, but it is not the report-only governance loop. L1 does not call its write-capable endpoints.
