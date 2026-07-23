# OpenButler Loop Constraints

These rules are binding for every automated loop.

## L2 Delegated Authority

- One Issue, one isolated worktree, one branch and one pull request.
- A maker may modify only the Issue scope. Code and product/privacy verification use fresh contexts.
- OpenButler Nightly may be built, installed and smoke-tested automatically. The stable channel is never automatic.
- Real activity may be read only through the bounded Nightly adapter described in `.openbutler/automation-policy.yaml`.
- Never read secrets, cookies, raw model output, raw audio/video, or screenshot contents.
- Never call external models or webhooks in strict mode.

## Push And Merge

- Never push directly to `main`.
- L2 and L3 use one isolated worktree and one branch per Issue.
- Delegated L2 may squash-merge only after required CI, two independent verifier approvals,
  fresh head-SHA validation and any required Nightly smoke.
- A changed head SHA, requested-changes review, missing evidence or failed check invalidates approval.
- A failed post-merge `main` build creates a revert pull request; the controller never force-pushes `main`.

### Future L3 Allowlist

- documentation synchronization;
- tests that do not weaken assertions;
- user-facing copy changes with no behavior change;
- small, explicit static-type fixes.

### Hard Stop And Escalate

- deleting or mutating source personal data;
- uploading activity, screenshots, databases, API keys or raw output;
- purchases, subscriptions, billing or external-account changes;
- irreversible external writes;
- weakening branch protection, privacy rules or test assertions;
- data migration without a tested rollback.

High-risk but reversible changes such as authentication, privacy guards, Electron lifecycle,
dependencies, schemas and retention require the security verifier and Nightly isolation smoke.

## Product Safety

- Do not delete or mutate MineContext source data.
- Do not copy screenshots or persist raw audio/video by default.
- In strict mode, external models and webhooks remain forbidden.
- Low-confidence identity must resolve to `unknown`.
- Do not infer medical, psychological, personality, employee-performance, or moral judgments.
- Do not treat generated summaries as final truth for remote systems.

## Implementation Discipline

- One issue per worktree.
- Execution requires `ready-for-agent`, no `automation-blocked` label, no open implementation PR,
  and no unexpired `cloud-running` or `nightly-running` lease.
- Nightly work is serial. Stop starting new issues at 07:15 Asia/Shanghai or 80 percent of the 750,000-token nightly cap.
- A local Preview integration worktree is never a merge source. Only independently verified issue pull requests may be approved and merged.
- Run relevant tests before proposing a fix.
- Never disable tests or assertions to pass CI.
- Stop after three failed attempts and escalate with evidence.
- Re-read this file before any push, merge, privacy-sensitive operation, or external action.

## Morning Evidence

- Nightly may merge fully verified Issue pull requests but never publishes the stable channel.
- `OpenButler Preview` must use a separate app id, install directory, and user-data directory.
- Acceptance packs may contain issue numbers, PR numbers, commit SHAs, test names, and redacted summaries only.
- A merge approval is stale when a PR head SHA changes, a required check is no longer green, or a requested-change review appears.
- Stable packaging, release and installation remain a separate manually approved operation.

## Kill Switch

If `STATE.md` contains `loop-pause-all: true`, exit immediately.
