# OpenButler Loop Constraints

These rules are binding for every automated loop.

## L1 Authority

- Report only. Do not modify tracked files, product data, GitHub issues, pull requests, branches, deployments, or settings.
- Write reports only below ignored `data/loop-runs/` or as GitHub Actions artifacts.
- Never read real MineContext activity, screenshots, runtime databases, microphone data, camera data, secrets, cookies, tokens, or raw output.
- Never call external models or external webhooks.

## Push And Merge

- Never push directly to `main`.
- L2 and L3 use one isolated worktree and one branch per issue.
- L2 always opens a pull request and waits for human merge.
- L3 may auto-merge only allowlisted changes after all promotion gates pass.

### Future L3 Allowlist

- documentation synchronization;
- tests that do not weaken assertions;
- user-facing copy changes with no behavior change;
- small, explicit static-type fixes.

### Never Auto-Merge

- privacy, identity, consent, authorization, sensors, or retention;
- MineContext, data migration, or real personal data handling;
- Electron startup, tray, installer, updater, or process lifecycle;
- dependencies, lockfiles, API contracts, schemas, or database changes;
- GitHub workflows, branch protection, loop governance, deployment, or external writes;
- more than five changed files.

## Product Safety

- Do not delete or mutate MineContext source data.
- Do not copy screenshots or persist raw audio/video by default.
- In strict mode, external models and webhooks remain forbidden.
- Low-confidence identity must resolve to `unknown`.
- Do not infer medical, psychological, personality, employee-performance, or moral judgments.
- Do not treat generated summaries as final truth for remote systems.

## Implementation Discipline

- One issue per worktree.
- Nightly execution requires both `ready-for-agent` and `nightly-approved`; high-risk approval must be attributable to `Giftia` after GitHub GraphQL `lastEditedAt`. If that specification timestamp cannot be audited, the Issue is rejected.
- Nightly work is serial. Stop starting new issues at 06:15 Asia/Shanghai or 80 percent of the 750,000-token nightly cap.
- A local Preview integration worktree is never a merge source. Only independently verified issue pull requests may be approved and merged.
- Run relevant tests before proposing a fix.
- Never disable tests or assertions to pass CI.
- Stop after three failed attempts and escalate with evidence.
- Re-read this file before any push, merge, privacy-sensitive operation, or external action.

## Morning Acceptance

- Nightly work never merges or publishes the stable channel.
- `OpenButler Preview` must use a separate app id, install directory, and user-data directory.
- Acceptance packs may contain issue numbers, PR numbers, commit SHAs, test names, and redacted summaries only.
- A merge approval is stale when a PR head SHA changes, a required check is no longer green, or a requested-change review appears.
- Stable packaging, release, and installation run only after fresh human approval of the exact acceptance pack.

## Kill Switch

If `STATE.md` contains `loop-pause-all: true`, exit immediately.
