# OpenButler Nightly Delivery Loop

## Purpose

The nightly loop turns approved GitHub Issues into reviewable pull requests and a local desktop acceptance pack. It does not replace human product acceptance and does not merge at night.

```text
GitHub queue -> local Codex maker -> focused tests -> independent verifier
-> one PR per Issue -> local Preview candidate -> morning acceptance -> human approval
```

ChatGPT Web is an independent reviewer. Its 17:30 preflight and 08:00 report use public GitHub facts only. The local controller does not depend on a ChatGPT task or webhook to start.

## Current Authority

The repository is at L1. `tools/nightly/nightly-controller.mjs` therefore accepts only `--mode=dry-run`. An execute request exits before creating a worktree or changing GitHub. One supervised scheduled dry-run with accepted runtime readback and the exact user approval `批准进入 L2` are required before a human-reviewed governance PR can record L2.

## Queue Contract

An Issue is eligible only when:

- it is open;
- `ready-for-agent` and `nightly-approved` are both present;
- high-risk approval is from `Giftia` and strictly later than GitHub GraphQL `lastEditedAt`; unavailable edit evidence fails closed;
- declared dependencies are closed;
- the specification is decision complete;
- high-risk work was approved by `Giftia` after the latest specification edit;
- no open implementation pull request already claims the Issue.

As soon as the controller creates a pull request, it removes `ready-for-agent`
and `nightly-approved` from the source Issue and adds `ready-for-human`. Open
pull requests are also checked independently, so a failed label transition
cannot cause the next night to create a duplicate implementation PR.

High-risk work includes privacy, consent, authentication, sensors, MineContext, Electron lifecycle, installers, schemas, migrations, retention and external writes.

## Runtime

- Start: 19:00 Asia/Shanghai.
- Stop starting work: 06:15 or 600,000 tokens.
- Hard cap: 750,000 tokens per night and 160,000 per Issue.
- Work is serial. One worktree and one maker/verifier pair exist at a time.
- Three failed attempts or an `ESCALATE_HUMAN` verdict stops that Issue.
- Runtime artifacts are written only under ignored `data/nightly/<run-id>/`.

Install or refresh the scheduled tasks:

```powershell
powershell -ExecutionPolicy Bypass -File tools\nightly\install-scheduled-tasks.ps1 -Mode dry-run
Get-ScheduledTask -TaskName OpenButler-Nightly-Delivery,OpenButler-Morning-Acceptance
```

Do not install with `-Mode execute` before L2 is approved. The controller independently enforces the level even if the task is misconfigured.

## Acceptance And Merge

`OpenButler Preview` uses a distinct app id, executable name, backend image and user-data directory. The morning page displays only redacted Issue/PR/test evidence. It never shows activity titles, URLs, API keys, screenshot paths, database data or raw output.

The controller cherry-picks accepted PR commits into an ignored integration worktree in queue order. A conflict stops the combination at the last safe PR; it is never resolved automatically. The generated Preview installer is preserved under the local run directory and installed side by side with the stable channel.

The acceptance center saves feedback locally and generates one of these commands:

```text
批准合并 PR #21 #22
只批准 PR #21
修复 PR #22：<失败场景>
```

Before merge, `approve-release.mjs` rechecks the exact PR head SHA, green required checks, review state and `acceptance-ready` label. A changed SHA invalidates the morning approval.

After merge, the release helper waits for GitHub Actions on the exact new `main` SHA, reruns the core local gates, increments the desktop patch version for the artifact, creates a GitHub Release, and silently installs the stable package. A CI or packaging failure leaves merged code intact but does not replace the installed stable application.

## Failure Policy

- Dirty base checkout: stop.
- Missing GitHub evidence: stop with partial evidence.
- Sensitive path or content: stop the night.
- CI failure: keep the PR unapproved and label it `nightly-failed`.
- Preview packaging failure: retain the previous working Preview.
- Scheduler registration without a completed run and report is not runtime proof.
