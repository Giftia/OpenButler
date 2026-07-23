# OpenButler Nightly Delivery Loop

## Purpose

The Nightly loop turns decision-complete GitHub Issues into verified pull requests, an isolated desktop candidate, and a redacted morning report. Delegated L2 may auto-merge a pull request only after all repository, verifier, CI, Nightly, privacy, and exact-SHA gates pass. Stable releases remain manual.

```text
GitHub queue -> one execution lease -> isolated maker -> focused tests
-> engineering verifier + product/privacy verifier -> one PR per Issue
-> isolated Nightly -> exact-SHA merge gate -> redacted morning report
```

ChatGPT Web is an independent reviewer. Its public-repository review is advisory because Scheduled Tasks are not a reliable control-plane trigger. GitHub and the local controller remain authoritative. Codex Cloud is enabled only after a repository environment smoke; when unavailable, implementation falls back to the local Nightly queue.

## Current Authority

The repository is in delegated L2 after the supervised scheduler dry-run `2026-07-23T15-15-37-644Z` and recorded user authorization. The current authority is defined by `.openbutler/automation-policy.yaml`, `STATE.md`, `LOOP.md`, and `loop-constraints.md`. `--mode=dry-run` remains report-only; `--mode=execute` is allowed only when those facts agree.

## Queue Contract

An Issue is eligible only when:

- it is open;
- `ready-for-agent` is present;
- declared dependencies are closed;
- the specification is decision complete;
- no active Cloud or Nightly lease exists;
- no `automation-blocked` or equivalent blocking label exists;
- no open implementation pull request already claims the Issue.

The controller marks the Issue `nightly-running` while holding the lease. After
creating a pull request it removes `ready-for-agent`, clears the lease, and adds
`review-pending`. Open implementation pull requests are checked independently,
so a failed label transition cannot cause duplicate implementation.

High-risk work includes privacy, consent, authentication, sensors, MineContext, Electron lifecycle, installers, schemas, migrations, retention and external writes.
It requires both verifier results, explicit rollback evidence, a successful
isolated Nightly run, and fresh exact-SHA CI. The hard-stop actions in
`.openbutler/automation-policy.yaml` are never eligible for automatic execution.

## Runtime

- Start: 20:00 Asia/Shanghai.
- Stop starting work: 07:15.
- Finalize, auto-merge eligible work, and clean Preview processes: 08:20.
- Produce the redacted morning report: 08:30.
- Hard cap: 750,000 tokens per night and 160,000 per Issue.
- Work is serial. One Issue lease, one worktree, one maker, and two fresh-context verifiers exist at a time.
- Three failed attempts or an `ESCALATE_HUMAN` verdict stops that Issue.
- Runtime artifacts are written only under ignored `data/nightly/<run-id>/`.

Install or refresh the scheduled tasks:

```powershell
powershell -ExecutionPolicy Bypass -File tools\nightly\install-scheduled-tasks.ps1 -Mode execute
Get-ScheduledTask -TaskName OpenButler-Nightly-Delivery,OpenButler-Nightly-Cutoff,OpenButler-Nightly-Finalize,OpenButler-Morning-Report
```

The controller independently enforces the level and pause flag even if a task is misconfigured.

## Candidate, Acceptance, And Merge

`OpenButler Nightly` uses a distinct app id, executable name, backend image and user-data directory. The morning report contains only redacted Issue/PR/test evidence. It never contains activity titles, URLs, API keys, screenshot paths, database contents, or raw output.

The controller combines verifier-approved pull requests in queue order inside an ignored integration worktree. A conflict stops the combination at the last safe pull request; it is never resolved automatically. The generated Nightly installer is preserved under the local run directory and installed side by side with the stable channel.

The acceptance pack records:

- Issue, pull request, and exact head SHA;
- Cloud or local execution surface;
- risk level and both verifier verdicts;
- focused tests, CI, Nightly, and real-data-smoke status;
- privacy invariants and rollback reference;
- merge or block reason.

Before automatic merge, `auto-merge-controller.mjs` rechecks the exact PR head SHA, green required checks, both verifier verdicts, `acceptance-ready`, `auto-merge-eligible`, rollback evidence, and the additional Nightly requirement for high-risk changes. A changed SHA invalidates every prior approval.

After merge, the controller waits for GitHub Actions on the exact new `main` SHA. If main CI fails, it creates a revert pull request instead of force-pushing. Automatic Nightly delivery never creates a stable GitHub Release or replaces the installed stable application.

## Real Data Boundary

Nightly may run the approved 48-hour local smoke only in an isolated Nightly
database. The source remains read-only. The smoke returns aggregate counts and
privacy booleans only, does not copy screenshots, and does not call external
models or webhooks. Isolated copies are removed after 48 hours. A synthetic
fallback is reported as synthetic and never presented as a real-data pass.

## Failure Policy

- Dirty base checkout: stop.
- Missing GitHub evidence: stop with partial evidence.
- Sensitive path or content: stop the night.
- CI failure: keep the PR unapproved and label it `nightly-failed`.
- Nightly packaging failure: retain the previous working Nightly.
- Any hard-stop action: label `automation-blocked` and require a new explicit decision.
- Scheduler registration without a completed run and report is not runtime proof.
