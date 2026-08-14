# OpenButler 24x7 Delegated Delivery

## Roles

- ChatGPT Web reviews public product and privacy facts. It does not trigger local work.
- Codex Cloud is the daytime maker only after an isolated docs-only smoke proves repository access.
- Local Codex is the authoritative Nightly maker, verifier, packager and device-test worker.
- GitHub Issues and pull requests are the shared queue and public evidence.

## Daily Windows

| Time | Action |
|---|---|
| 08:30 | Publish redacted morning report; start daytime Cloud polling |
| 09:00 | Prepare decision-complete Issues |
| 13:30 | Product/privacy review checkpoint |
| 19:30 | Stop daytime Cloud polling and freeze the local queue |
| 20:00 | Start serial local execution |
| 07:15 | Stop claiming new Issues |
| 08:20 | Finish smoke, report and process cleanup |

All times use Asia/Shanghai.

## Daytime Cloud Dispatcher

`tools/nightly/daytime-cloud-controller.mjs` submits or resumes at most one
`ready-for-agent` Issue between 08:30 and 19:30. The Windows scheduler invokes
it every 30 minutes. Installations default to `dry-run`; `execute` requires
the already-smoked environment ID in the Windows user environment.

The controller refuses conflicting leases, open implementation pull requests,
unmet dependencies, hard-stop work, and specifications changed after their
`ready-for-agent` approval. It persists only redacted task metadata under the
ignored `data/daytime-cloud/` directory.

A supervised cutoff-independent smoke may pass `--now=<ISO timestamp>` in
`dry-run` mode. Execute mode always uses the real local clock, so this option
cannot bypass the daytime window.

`npm run cloud:smoke` is the deterministic no-product-change smoke. It uses a
local fixture and asserts that selection performs no lease, Cloud, GitHub,
product, or personal-data mutation. The separate `cloud:preflight` command
remains authoritative for live authentication and environment configuration.

Ready results are applied in an isolated worktree only after the Issue
fingerprint, exact `origin/main` SHA, exact unified diff, changed paths,
privacy boundaries, exact diff, and base SHA are rechecked. The controller does
not execute Cloud-authored product code on the user's PC; required tests first
run in GitHub CI. The controller creates or
updates a draft pull request and moves the Issue to review; it never merges.

## Merge Gate

A pull request may be squash-merged only when its exact head SHA has:

1. the six required repository checks;
2. a code verifier approval;
3. a product/privacy verifier approval;
4. no requested-changes review;
5. Nightly isolation evidence when the change is high risk;
6. no hard-stop condition from `.openbutler/automation-policy.yaml`.

Changing the head SHA invalidates all prior evidence. A failed post-merge main build creates a
revert pull request. The controller does not force-push or weaken branch protection.

## Real Data

Nightly may read at most the last 48 hours from an approved local source. The source is read-only.
Imported test data goes to the Nightly user-data directory and expires after 48 hours. Screenshots
are not copied; reports contain aggregate counts only. Strict mode forbids external models and
webhooks.

## Cloud Degradation

`codex cloud list --json` proves authentication but not a usable OpenButler environment. The
dispatcher therefore requires both `OPENBUTLER_CODEX_CLOUD_ENV_ID` and successful authentication,
and fails closed otherwise. The docs-only smoke remains the evidence that the configured checkout is
usable; it does not prove independent remote reachability. Without either gate, ChatGPT Web continues
review and local Codex implements at night.
