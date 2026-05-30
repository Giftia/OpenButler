# Proactive Butler Core

Proactive Butler Core turns imported OpenButler events into a daily butler experience:

```text
PC Activity Events -> Unified Timeline -> Metrics -> Insight Cards -> Butler Inbox -> Briefings -> Feedback
```

The MVP is rules-first and local-first. It does not call external models. It currently uses PC Activity events imported from MineContext and keeps adapters ready for vision, notes, calendar, and smart home context.

## API

- `GET /api/butler/home`
- `GET /api/butler/readiness`
- `GET /api/butler/mvp-report`
- `POST /api/butler/demo/run`
- `POST /api/butler/demo/reset`
- `GET /api/butler/timeline`
- `POST /api/butler/timeline/rebuild`
- `GET /api/butler/metrics/today`
- `GET /api/butler/metrics?days=7`

The `/butler/inbox` page supports evidence detail expansion for every insight card. The detail view exposes local `evidence_refs`, the `evidence_boundary`, confidence, source/type/status metadata, and a path-only note for screenshot evidence. It does not copy screenshots, read screenshot bytes, upload screenshot content, or turn missing evidence into a stronger claim.
- `GET /api/butler/insights`
- `POST /api/butler/insights/generate`
- `POST /api/butler/insights/{insight_id}/feedback`
- `POST /api/butler/insights/{insight_id}/dismiss`
- `POST /api/butler/insights/{insight_id}/snooze`
- `GET /api/butler/briefings/today`
- `POST /api/butler/briefings/generate`
- `GET /api/butler/goals`
- `GET /api/butler/context-recovery`
- `GET /api/butler/export`
- `DELETE /api/butler/data`

## MVP Insights

- `daily_overview`
- `focus_summary`
- `context_switch_warning`
- `workflow_candidate`
- `data_quality_notice`
- `achievement`

All cards include confidence, evidence refs, and an evidence boundary. The boundary is required because MineContext is a local observation source, not final truth for remote systems.

## MVP Readiness

`GET /api/butler/readiness` returns a local self-check for the Proactive Butler Core MVP. It covers:

- MineContext PC Activity source event availability;
- unified timeline rebuild status;
- today metrics availability;
- rule-based insight generation;
- feedback store availability;
- briefing generator availability;
- OpenClaw proactive Butler tool declarations;
- strict privacy guardrails.

The endpoint returns `ready`, `data_insufficient`, or `attention_needed`. `data_insufficient` is expected when no PC Activity events have been imported; it must not fabricate a positive daily state. The endpoint does not call external models, external webhooks, or external APIs, and it does not delete MineContext source data.

The `/butler` page displays the readiness result as the MVP demo status panel. It shows the overall status plus individual checks for PC Activity, timeline, metrics, insights, feedback, briefings, OpenClaw tools, and strict privacy. When the status is `data_insufficient`, the page points the user toward importing today's PC Activity rather than pretending the daily overview is complete.

The `/butler` page also includes a one-click demo path backed by `POST /api/butler/demo/run`. The endpoint runs the local product loop in order:

1. import today's PC Activity from the authorized MineContext adapter;
2. rebuild the unified timeline;
3. generate rule-based proactive insights;
4. generate an evening briefing;
5. refresh the readiness panel.

If MineContext is unavailable, the demo path continues with existing OpenButler data and clearly states that no new PC Activity was imported. It must not fabricate activity events or call external models. The response includes step counts, readiness status, `external_model_used: false`, `copied_screenshots: 0`, `minecontext_source_deleted: 0`, and the standard evidence boundary.

With a backend running locally, the demo API can be smoke-tested from the frontend workspace:

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run smoke:butler-demo
npm run smoke:butler-reset
npm run smoke:butler-ui-flow
```

`POST /api/butler/demo/reset` is the safe reset path for repeatable demos. It deletes only OpenButler-derived Butler data: unified timeline events, metric snapshots, insight cards, briefings, and Productization Harness summaries. It preserves PC Activity events, the MineContext source database, and MineContext screenshot files. The response includes the deleted and preserved scopes plus the standard evidence boundary.

The `/butler` page exposes the same reset path through a `重置演示数据` action. The UI must keep the scope visible: it resets only OpenButler-derived timeline, metrics, insights, briefings, and Harness summaries, and it does not delete PC Activity records, MineContext databases, or MineContext screenshot files.

`smoke:butler-ui-flow` is the current lightweight runtime check for the `/butler` demo controls. It verifies the source-level button bindings for run/reset and then calls the local run, home, reset, and readiness APIs in sequence. It is not a full browser-click test; adding Playwright-style browser interaction remains a later hardening task.

`GET /api/butler/mvp-report` is the current Productization Harness evidence endpoint for the Proactive Butler Core MVP. It is read-only apart from writing an audit entry. The report combines readiness status, the MineContext-to-feedback MVP chain, acceptance checks, privacy fields, demo paths, verification commands, and known limitations into one response. It must report `external_model_used: false`, `external_model_allowed: false`, `minecontext_source_deleted: 0`, and `copied_screenshots: 0`.

The `/butler` page displays this report as the `Productization Harness` panel. The panel shows:

- the overall MVP report status;
- the MineContext -> PCActivityEvent -> Unified Timeline -> Metrics -> Insight Cards -> Briefings -> Feedback chain;
- the first acceptance checks with passed/attention-needed status;
- each acceptance check's next action;
- the evidence boundary;
- strict privacy fields for external model use, external model allowance, MineContext source deletion, and screenshot copying.

When the report is not `ready`, `/butler` shows the first actionable repair suggestions. These are suggestions only. They do not execute external writes, do not call cloud models, do not copy screenshots, and do not delete MineContext source data. Common next actions include importing today's PC Activity, rebuilding the unified timeline, generating today metrics, generating rule-based insights, opening Butler Inbox, or reviewing privacy/OpenClaw configuration.

The safe actions are implemented as an explicit frontend whitelist rather than executing arbitrary endpoint strings from the report. Supported button actions are:

- import today's PC Activity from the authorized local MineContext adapter;
- rebuild the unified timeline;
- refresh today metrics;
- generate rule-based insights;
- generate an evening briefing;
- open Butler Inbox;
- open privacy settings;
- display a manual review message for OpenClaw, evidence-boundary, report, or data-safety review.

Unsupported actions show an explainable message and do nothing. The UI must not turn the report into a generic API executor.

With a backend running locally, the MVP report can be smoke-tested from the frontend workspace:

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run smoke:butler-mvp-report
```

The smoke command runs the local demo path, reads `/api/butler/mvp-report`, verifies all acceptance checks pass, then calls the safe reset endpoint. It is an API-level productization check, not a full browser-click test. If MineContext is unavailable or no PC Activity data exists, the report returns `data_insufficient` instead of fabricating a positive MVP state.

`GET /api/butler/demo/data-insufficient-drill` is a read-only recovery drill for the same Productization Harness. It returns a synthetic empty-workspace report with `status: data_insufficient`, `dry_run: true`, and `mutates_data: false`. The drill does not inspect, import, delete, or rewrite real MineContext data. It exists to verify that OpenButler can show actionable recovery steps when the source chain is empty.

The drill response includes next actions for:

- importing authorized PC Activity;
- rebuilding the unified timeline;
- generating today's metrics;
- generating local-rule insights;
- generating a briefing after enough evidence exists.

It must keep `external_model_used: false`, `external_model_allowed: false`, `copied_screenshots: 0`, and `minecontext_source_deleted: 0`. Its evidence boundary must state that it is a synthetic drill, not a claim about the current user's real activity state.

With a backend running locally:

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run smoke:butler-data-insufficient-drill
```

The `/butler` page exposes the same drill as the `演练空数据路径` button in the Productization Harness area. The UI shows the returned next actions, `dry_run`, `mutates_data`, privacy counters, and evidence boundary. This button is deliberately read-only: it does not import PC Activity, rebuild timeline data, generate real insights, copy screenshots, delete MineContext source data, or call external models.

## Harness Run Summaries

`GET /api/butler/harness/runs/latest` returns the latest local Productization Harness summaries by run type. Current run types:

- `mvp_report`
- `data_insufficient_drill`

These summaries are persisted in OpenButler's local SQLite database so the `/butler` page can show the most recent verification state after refresh. They store only:

- run kind and status;
- dry-run and mutation flags;
- failed check ids;
- privacy counters;
- evidence boundary;
- creation timestamp.

They do not store MineContext source records, raw godview output, screenshot bytes, screenshot OCR, copied screenshots, or external-system state. The endpoint is local read-only and exists to improve Productization Harness continuity.

## Objective Status

`GET /api/butler/productization/objectives/status` maps the active objectives in `.openbutler/goals.yaml` to current local evidence. The endpoint reads the active objective ids, titles, priorities, and success criteria from the YAML file, then applies known local evidence mappers for the current P0 objectives. If a future objective is declared without a mapper, the endpoint should surface it as `needs_attention` instead of silently ignoring it. It checks:

- Proactive Butler Core MVP evidence: `/butler` UI source, today metrics, insight generation, feedback, OpenClaw tool declaration, and strict privacy flags.
- MineContext to unified timeline evidence: timeline rebuild, timeline event count, evidence boundaries, and MineContext source preservation.
- Productization harness evidence: `AGENTS.md`, roadmap, Definition of Done, testing docs, and privacy boundary docs.

The endpoint returns `goals_source`, `priority`, `success_criteria`, `source_ref`, and `proven` or `needs_attention` per criterion and per objective. It does not mark the long-running Codex goal complete by itself; it is a local evidence map for humans and future agents. It does not call external models, does not copy screenshots, does not inspect or mutate MineContext source data, and does not verify remote repositories, CI, Yunxiao, deployments, or online services.

The `/butler` Productization Harness panel shows the same data in `目标完成度自检`.

The target card displays the declared `priority`, `success_criteria`, and `.openbutler/goals.yaml` source reference. If a future active objective is declared before an evidence mapper exists, the backend returns `needs_attention` with `evidence_mapper_missing`, and the `/butler` card must show `缺少 evidence mapper` instead of hiding the goal.

The mapper template lives in `docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md` and is also returned by the objective status API as `evidence_mapper_template`. New active objectives must add a `criteria_by_objective` mapper in `backend/app/modules/butler_core/service.py`, preserve local evidence refs and evidence boundaries, add tests, and keep strict privacy counters safe. Unknown objectives must continue to return `needs_attention` until their mapper is implemented.

`GET /api/butler/productization/l1-audit` expands the objective status into a success-criterion-level audit report. It lists each declared `success_criteria` entry from `.openbutler/goals.yaml`, the mapped evidence source, the verification result, and the evidence boundary. Allowed results are:

- `proven`
- `needs_attention`
- `missing_evidence`
- `out_of_scope`

`missing_evidence` means the declared goal is in scope but lacks a local mapper or evidence criterion. `out_of_scope` means the item requires external-source verification, such as remote repositories, CI, Yunxiao, deployments, or online services. The endpoint is local-only: it does not call external models, copy screenshots, mutate MineContext, or perform external writes.

## Productization Demo Pack

`GET /api/butler/productization/demo-pack` aggregates the current local Productization Harness evidence into one response:

- readiness summary and checks;
- MVP report chain, acceptance checks, privacy counters, and evidence boundary;
- active objective status from `.openbutler/goals.yaml`;
- latest persisted Harness run summaries;
- local demo commands.

The `/butler` page shows this response as `一页演示包`. It is intended for quick local acceptance before the next Codex task: one screen should show whether the active objectives are proven, whether the MVP loop is ready, and whether strict privacy counters remain safe.

The endpoint does not call external models, copy screenshots, delete MineContext source data, or verify remote repositories, CI, Yunxiao, deployments, or online services. Its evidence boundary must keep those limits explicit.

## Productization Demo Pack Artifact

`npm run artifact:butler-demo-pack` writes a stable local JSON artifact to:

```text
data/productization/productization-demo-pack.json
```

The script runs the local demo path, reads `GET /api/butler/productization/demo-pack`, writes the artifact, then calls the safe reset endpoint. The artifact uses `artifact_schema_version: openbutler_productization_demo_pack_artifact_v1` and contains:

- the Productization demo pack;
- strict privacy counters;
- evidence boundary text;
- explicit booleans stating it does not contain MineContext source records, screenshot content, raw godview output, or external-system state.

This artifact is for local Productization Harness acceptance and future CI/manual review. It is OpenButler-derived data only and must not be treated as proof of remote repositories, CI, Yunxiao, deployments, or online services.

Use `npm run test:demo-pack-artifact-file` to validate the artifact offline. This check reads only `data/productization/productization-demo-pack.json`; it does not require the backend to be running and does not read MineContext source data. It verifies the artifact schema, Productization demo pack schema, ready/proven statuses, evidence boundaries, active objectives, and privacy flags.

## Productization Verify Command

`npm run verify:productization` is the current one-command local acceptance gate for the Productization Harness. It expects the backend to be running and then executes:

1. demo pack smoke script static check;
2. demo pack artifact script static check;
3. browser smoke script static check;
4. frontend production build;
5. runtime `smoke:butler-demo-pack`;
6. `artifact:butler-demo-pack`;
7. offline `test:demo-pack-artifact-file`;
8. `smoke:butler-l1-audit`;
9. headless browser `smoke:butler-browser`.

The command first checks `GET /health` and prints a clear backend-start hint when the API is unavailable. The browser smoke serves the built `frontend/dist` app locally, proxies `/api` to the backend, opens `/butler` in headless Edge/Chrome, verifies visible Productization Harness sections, then clicks the data-insufficient drill and verifies the dry-run state. It is a local harness gate only: it does not call external models, send external webhooks, copy screenshots, delete MineContext source data, or verify remote repositories, CI, Yunxiao, deployments, or online services.

## Data-Insufficient State

When there are no imported PC Activity events, `/api/butler/home` returns:

- a conservative headline that says PC activity data is insufficient;
- a `data_quality_notice` insight;
- an `import_pc_activity` suggested action;
- the normal evidence boundary;
- `external_model_used: false`.

The `/butler` page displays a visible data-insufficient state with actions to import today's MineContext PC activity or open the PC Activity Context page. It must not fabricate a daily overview when source event count is zero.

## Feedback Dampening

Insight feedback is part of the MVP loop:

- repeated `dismissed`, `not_useful`, or `too_frequent` feedback lowers the priority of the same insight type;
- repeated `inaccurate` feedback suppresses the same insight type after the configured threshold;
- `data_quality_notice` remains available even after inaccurate feedback because it protects against fabricated conclusions;
- feedback stores the insight type so dampening still works after old insight cards are cleaned up.
- `/api/chat` routes proactive feedback phrases such as `这个建议不准确` and `以后少提醒` into the same feedback store. If there is no active actionable insight, chat must say that no feedback target exists instead of inventing one.
- `/api/chat` routes "今天我主要做了什么" through Butler overview and "帮我生成晚间复盘" through Butler briefing, so recent-activity answers include key numbers and the evidence boundary rather than relying on chat memory.

Default thresholds live in proactive butler settings:

- `reduce_priority_after_dismiss_count`: `3`
- `disable_type_after_inaccurate_count`: `3`

## Structured Export

`GET /api/butler/export` returns OpenButler-derived structured data:

- unified timeline events;
- metric snapshots;
- insight cards;
- briefings;
- goals;
- Productization Harness summaries;
- proactive butler settings.

It does not export MineContext source databases, raw screenshots, screenshot bytes, OCR output, copied image content, raw godview output, or external-system state. Screenshot evidence remains path-reference-only if it is already present in OpenButler evidence refs.

## Retention and Deletion Controls

The `/goals` page includes the current local retention policy and an explicit Butler data deletion control.

Default retention policy:

- Butler-derived timeline, metrics, insights, and briefings: 365 days.
- Insight feedback: 365 days.
- Butler audit log: 90 days.

`DELETE /api/butler/data` deletes only OpenButler-derived proactive Butler data:

- `unified_timeline_events`;
- `butler_metric_snapshots`;
- `insight_cards`;
- `butler_briefings`.
- `butler_harness_runs`.

It preserves:

- PC Activity events imported into OpenButler;
- MineContext source databases;
- MineContext screenshot files;
- screenshot path references stored outside the deleted Butler records.

The Web UI requires the user to type `DELETE BUTLER` before invoking deletion and states that MineContext original data is not deleted.
