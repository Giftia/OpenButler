# OpenButler 24x7 Delegated Delivery

## Roles

- ChatGPT Web reviews public product and privacy facts. It does not trigger local work.
- Codex Cloud is the daytime maker only after an isolated docs-only smoke proves repository access.
- Local Codex is the authoritative Nightly maker, verifier, packager and device-test worker.
- GitHub Issues and pull requests are the shared queue and public evidence.

## Daily Windows

| Time | Action |
|---|---|
| 08:30 | Publish redacted morning report |
| 09:00 | Prepare decision-complete Issues |
| 13:30 | Product/privacy review checkpoint |
| 19:30 | Freeze the local queue |
| 20:00 | Start serial local execution |
| 07:15 | Stop claiming new Issues |
| 08:20 | Finish smoke, report and process cleanup |

All times use Asia/Shanghai.

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

`codex cloud list --json` proves authentication but not a usable OpenButler environment. Daytime
implementation remains disabled until `OPENBUTLER_CODEX_CLOUD_ENV_ID` completes a docs-only smoke
pull request. Without it, ChatGPT Web continues review and local Codex implements at night.
