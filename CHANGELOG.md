# Changelog

## 2026-05-29 - Productization Harness L1

### Added

- Added the repository-level Productization Harness facts for OpenButler: `AGENTS.md`, product docs, architecture docs, privacy boundaries, development workflow, goals, task queue, and Definition of Done.
- Added Proactive Butler Core acceptance surfaces for local validation: readiness, MVP report, active objective status, demo pack, L1 audit, local Harness run summaries, and safe demo reset.
- Added local verification commands for the Productization Harness:
  - `npm run verify:productization`
  - `npm run smoke:butler-demo-pack`
  - `npm run smoke:butler-l1-audit`
  - `npm run smoke:butler-browser`
  - `npm run artifact:butler-demo-pack`
  - `npm run test:demo-pack-artifact-file`
- Added a stable local artifact path for review and lightweight CI handoff:
  - `data/productization/productization-demo-pack.json`

### Verified Boundaries

- The Productization Harness verifies local OpenButler-derived state only.
- `external_model_used=false` and `external_model_allowed=false` are required privacy assertions.
- `minecontext_source_deleted=0` and `copied_screenshots=0` are required privacy assertions.
- The artifact and smoke checks do not contain MineContext source records, screenshot bytes, screenshot content, raw godview output, or copied screenshot evidence.
- The Harness does not verify remote repositories, CI status, deployments, Yunxiao state, or online services. Those remain source-system facts that require live verification.

### Known Limits

- This workspace is not currently a Git repository, so `git status --short` cannot be used as the change detector here.
- Browser validation uses a local headless Edge/Chrome CDP smoke rather than a full browser regression framework.
- The Productization Harness proves the local OpenButler loop and privacy counters; it is not proof of MineContext source correctness or remote-system state.

