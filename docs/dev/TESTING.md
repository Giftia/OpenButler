# Testing

## Backend Tests

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest discover -s backend\app\modules
```

Targeted:

```powershell
python -m unittest discover -s backend\app\modules\pc_activity_context\tests
python -m unittest discover -s backend\app\modules\butler_core\tests
python -m unittest discover -s backend\app\modules\workstation_vision\tests
```

## Backend Compile Check

```powershell
python -m compileall -q backend\app
```

## Frontend Build and Type Check

```powershell
cd frontend
npm run build
```

`npm run build` runs TypeScript and Vite. On the Codex Windows sandbox, Vite/esbuild may require an escalated run because subprocess spawning can be blocked.

## Frontend Tests

Use the route smoke script against a running frontend dev or preview server:

```powershell
cd frontend
$env:OPENBUTLER_WEB_BASE_URL="http://127.0.0.1:5175"
npm run smoke:routes
```

The smoke script checks:

- `/butler`
- `/butler/inbox`
- `/metrics`
- `/timeline`
- `/goals`

It verifies that each route returns HTTP 200 and the React app shell. This is a lightweight route availability gate, not a full browser interaction suite.

Static UI contract checks:

```powershell
cd frontend
npm run test:data-controls
npm run test:readiness-panel
npm run test:demo-path
npm run test:demo-smoke-script
npm run test:demo-reset-script
npm run test:butler-ui-flow-script
npm run test:mvp-report-script
npm run test:mvp-report-panel
npm run test:data-insufficient-drill-script
npm run test:butler-browser-smoke-script
npm run test:l1-audit-script
npm run test:productization-records
npm run test:productization-verify-script
npm run test:metrics-trend-panel
npm run test:inbox-evidence-panel
```

`test:readiness-panel` verifies that `/butler` calls `/api/butler/readiness`, renders the MVP demo status panel, displays `data_insufficient`, and states that MineContext source data is untouched.

`test:demo-path` verifies that `/butler` exposes the one-click demo path, calls the backend `POST /api/butler/demo/run` orchestrator, and exposes the safe reset button for `POST /api/butler/demo/reset`. It also checks that the UI copy says reset will not delete PC Activity, the MineContext database, or MineContext screenshot files. The backend contract test verifies that the orchestrator attempts PC Activity import, rebuilds the timeline, generates insights, generates an evening briefing, refreshes readiness, and does not fabricate MineContext data when import fails.

`test:demo-smoke-script` verifies that the reusable smoke command exists and checks the demo API evidence boundary plus strict privacy fields.

`test:demo-reset-script` verifies that the reset smoke command exists and checks that demo reset preserves PC Activity events and MineContext source data.

`test:butler-ui-flow-script` verifies that the lightweight runtime UI-flow smoke exists. It checks the `/butler` button bindings in source and the API calls that back those buttons.

`test:mvp-report-script` verifies that the MVP report smoke command exists and checks `/api/butler/mvp-report`, evidence-boundary assertions, strict privacy assertions, screenshot-copy assertions, and safe reset assertions.

`test:mvp-report-panel` verifies that `/butler` reads `/api/butler/mvp-report` and renders the Productization Harness panel with MVP chain, acceptance checks, next actions, safe action buttons, evidence boundary, and strict privacy fields.

`test:data-insufficient-drill-script` verifies that the data-insufficient drill smoke command exists and checks `/api/butler/demo/data-insufficient-drill`, dry-run flags, privacy fields, next actions, and evidence boundaries.

`test:butler-browser-smoke-script` verifies that the browser-level `/butler` smoke exists, uses local headless Edge/Chrome through CDP, renders Productization Harness sections, clicks the data-insufficient drill, and checks strict privacy text.

`test:l1-audit-script` verifies that the L1 audit smoke exists and checks `GET /api/butler/productization/l1-audit`, result classes, evidence refs, evidence boundaries, and strict privacy counters.

`test:productization-records` verifies the local Productization Harness changelog and demo record. It checks `CHANGELOG.md`, `docs/productization/DEMO_RECORD.md`, the required local acceptance commands, `data/productization/productization-demo-pack.json`, the L1 audit API, strict privacy counters, evidence-boundary wording, and the rule that these records must not contain MineContext source records, screenshot content, raw godview output, screenshot file paths, or copied screenshot evidence.

`test:productization-verify-script` verifies that `npm run verify:productization` exists and chains backend health, demo pack static checks, Productization record checks, runtime demo pack smoke, artifact generation, offline artifact validation, and strict privacy counters.

`test:metrics-trend-panel` verifies that `/metrics` reads `GET /api/butler/metrics?days=7`, renders the recent 7-day trend, includes the data-insufficient empty state, and displays strict privacy counters plus evidence-boundary text.

`test:inbox-evidence-panel` verifies that `/butler/inbox` can expand insight evidence details, show `evidence_refs`, evidence boundary, confidence and source metadata, and keep screenshot evidence as path-only references without copying or reading screenshot content.

`test:mvp-report-panel` also checks that `/butler` exposes the read-only `演练空数据路径` UI entry, calls the data-insufficient drill API wrapper, and displays `dry_run`, `mutates_data`, privacy fields, and evidence boundary copy.

It also verifies that `/butler` reads `GET /api/butler/harness/runs/latest` and displays the `最近 Harness 结果` section.

Runtime demo smoke against a running backend:

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run smoke:butler-demo
npm run smoke:butler-reset
npm run smoke:butler-ui-flow
npm run smoke:butler-mvp-report
npm run smoke:butler-demo-pack
npm run smoke:butler-browser
npm run smoke:butler-l1-audit
npm run artifact:butler-demo-pack
npm run test:demo-pack-artifact-file
npm run test:productization-records
npm run verify:productization
npm run smoke:butler-data-insufficient-drill
```

`smoke:butler-ui-flow` is a lightweight runtime chain test. It does not use a browser automation dependency. It verifies the `/butler` button bindings, Productization Harness panel, and safe next-action handler in source, then calls `POST /api/butler/demo/run`, `GET /api/butler/home`, `POST /api/butler/demo/reset`, and `GET /api/butler/readiness` against a running backend. It checks evidence boundaries, strict privacy fields, and MineContext source preservation.

It also verifies the `/butler` data-insufficient drill button binding and calls `GET /api/butler/demo/data-insufficient-drill` to confirm the drill is dry-run, non-mutating, evidence-bounded, and strict-mode safe.

The same smoke calls `GET /api/butler/harness/runs/latest` after the drill and checks the persisted summary does not report external model use, data mutation, screenshot copying, or MineContext source deletion.

The same smoke also calls `GET /api/butler/productization/objectives/status` and `GET /api/butler/productization/demo-pack`. Objective status must load `.openbutler/goals.yaml`, return declared `success_criteria`, and attach a `source_ref` for every objective. The demo pack must report `schema_version: productization_demo_pack_v1`, `status: ready`, ready readiness and MVP report statuses, proven active objectives, persisted Harness summaries, evidence boundary, and strict privacy counters showing no external model use, no screenshot copying, and no MineContext source deletion.

The Butler API contract tests also cover a synthetic future active objective with no evidence mapper. That objective must return `needs_attention` with an `evidence_mapper_missing` criterion. The `/butler` source checks require visible `缺少 evidence mapper` copy so new goals do not fail silently.

The same contract tests verify the active objective evidence mapper template. `GET /api/butler/productization/objectives/status` must return `evidence_mapper_template` with the template schema version, mapper steps, criterion contract, documentation path, and strict privacy invariants. Unknown active objectives must reference `docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md` in the missing-mapper criterion.

`smoke:butler-mvp-report` is the Productization Harness evidence smoke. It calls `POST /api/butler/demo/run`, reads `GET /api/butler/mvp-report`, then calls `POST /api/butler/demo/reset`. It verifies that the MVP chain is ready after demo run, all acceptance checks include evidence boundaries and next actions, strict privacy fields remain false/zero, screenshots are not copied, and PC Activity plus MineContext source data are preserved by reset.

`smoke:butler-demo-pack` is the focused Productization Harness one-page smoke. It calls `POST /api/butler/demo/run`, reads `GET /api/butler/productization/demo-pack`, then calls `POST /api/butler/demo/reset`. It verifies demo pack schema, readiness status, MVP report status, active-objective status, `.openbutler/goals.yaml` source loading, declared success criteria, Harness summaries, local demo commands, evidence boundary, no external model use, no system notification, no screenshot copying, and no MineContext source deletion.

`smoke:butler-browser` is the browser-level `/butler` Productization Harness smoke. It serves the built `frontend/dist` app locally, proxies API calls to `OPENBUTLER_API_BASE_URL`, opens `/butler` in headless Edge/Chrome through the DevTools protocol, verifies visible Productization Harness, `目标完成度自检`, `一页演示包`, evidence boundary, strict privacy fields, then clicks `演练空数据路径` and checks the rendered `dry_run=true` and `mutates_data=false` state. It does not add a browser automation npm dependency, call external models, copy screenshots, or delete MineContext source data.

`smoke:butler-l1-audit` calls `POST /api/butler/demo/run`, reads `GET /api/butler/productization/l1-audit`, and calls the safe demo reset. It verifies every active objective success criterion has evidence refs and an evidence boundary, and that the current active objectives have no `missing_evidence` or `out_of_scope` rows.

`artifact:butler-demo-pack` writes `data/productization/productization-demo-pack.json` for local CI or manual review. Its static check is `npm run test:demo-pack-artifact-script`. The artifact must include `artifact_schema_version: openbutler_productization_demo_pack_artifact_v1`, the Productization demo pack, evidence boundary, and privacy booleans proving it does not contain MineContext source records, screenshot content, raw godview output, copied screenshots, or external-system state.

`test:demo-pack-artifact-file` is the offline artifact gate. It reads `data/productization/productization-demo-pack.json` and validates artifact schema, Productization demo pack schema, ready/proven statuses, active objective structure, evidence boundaries, and privacy flags. It does not require a running backend and must not inspect MineContext source data.

`verify:productization` is the one-command local Productization Harness gate. It expects a running backend, checks `/health`, runs static script checks, builds the frontend, runs `smoke:butler-demo-pack`, runs `smoke:butler-l1-audit`, writes `data/productization/productization-demo-pack.json`, runs the offline artifact validator, then runs the headless browser `/butler` smoke. It does not call external models, copy screenshots, delete MineContext source data, or verify remote repositories, CI, Yunxiao, deployments, or online services.

`smoke:butler-data-insufficient-drill` calls `GET /api/butler/demo/data-insufficient-drill` and verifies the synthetic empty-workspace recovery path. It must report `dry_run: true`, `mutates_data: false`, `status: data_insufficient`, actionable next actions for the local recovery sequence, evidence boundaries on every check, and privacy fields showing no external model, no screenshot copy, and no MineContext source deletion.

## Lint

No separate lint script is configured yet. Add one before enforcing lint as a release gate.

## API Contract Smoke

```powershell
Invoke-RestMethod http://127.0.0.1:8010/health
Invoke-RestMethod http://127.0.0.1:8010/api/butler/home
Invoke-RestMethod http://127.0.0.1:8010/api/butler/readiness
Invoke-RestMethod http://127.0.0.1:8010/api/butler/mvp-report
Invoke-RestMethod http://127.0.0.1:8010/api/butler/demo/data-insufficient-drill
Invoke-RestMethod http://127.0.0.1:8010/api/butler/harness/runs/latest
Invoke-RestMethod http://127.0.0.1:8010/api/butler/productization/objectives/status
Invoke-RestMethod http://127.0.0.1:8010/api/butler/productization/l1-audit
Invoke-RestMethod http://127.0.0.1:8010/api/butler/productization/demo-pack
Invoke-RestMethod http://127.0.0.1:8010/api/butler/metrics/today
Invoke-RestMethod "http://127.0.0.1:8010/api/butler/metrics?days=7"
```

## Butler API Contract Tests

The proactive butler contract tests live in `backend/app/modules/butler_core/tests/test_butler_api_contract.py`.

They cover:

- timeline rebuild,
- today metrics,
- `/api/butler/home` response shape,
- `/api/butler/readiness` status and strict privacy checks,
- `/api/butler/mvp-report` acceptance checks, next actions, MVP chain, data-insufficient state, and strict privacy fields,
- `/api/butler/demo/data-insufficient-drill` synthetic read-only recovery path,
- `/api/butler/harness/runs/latest` persisted local Harness summaries,
- `/api/butler/productization/objectives/status` active objective evidence mapping loaded from `.openbutler/goals.yaml`,
- `/api/butler/productization/l1-audit` success-criterion-level L1 audit results,
- `/api/butler/productization/demo-pack` one-page local Harness evidence aggregation,
- `/api/butler/metrics?days=7` recent trend response, data-insufficient state, evidence boundary, and strict privacy counters,
- `/api/butler/demo/run` one-click demo orchestration,
- `/api/butler/demo/reset` safe demo reset preserving PC Activity and MineContext source data,
- `/api/butler/export` includes Harness summaries without raw MineContext or screenshot content,
- `DELETE /api/butler/data` deletes Harness summaries while preserving PC Activity and MineContext source data,
- insight feedback,
- briefing generation,
- evidence boundaries and strict-mode privacy defaults.

Run them with:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest backend.app.modules.butler_core.tests.test_butler_api_contract
```

`/api/butler/readiness` returns `ready` when imported PC Activity data exists, `data_insufficient` when no PC Activity events exist, or `attention_needed` when a guardrail or tool declaration is missing.

Chat feedback routing is covered by:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest backend.app.modules.butler_core.tests.test_proactive_chat_tool
```

These tests verify that phrases such as `这个建议不准确` and `以后少提醒` write to the Butler feedback store, preserve evidence boundaries, and do not invent a feedback target when no active insight exists.

The `/api/chat` contract is covered at the route-function level without `httpx`:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest backend.app.modules.butler_core.tests.test_chat_api_contract
```

These tests verify that "今天我主要做了什么" routes to Butler overview, "帮我生成晚间复盘" routes to Butler briefing, chat feedback writes to insight feedback, and data-insufficient replies do not fabricate a daily conclusion.

## Privacy Tests

Privacy-sensitive tests should verify:

- strict mode does not call external models,
- MineContext is read-only,
- screenshots are not copied by default,
- evidence boundaries are present,
- Butler data deletion does not delete MineContext source data.

## MineContext Mock Tests

Use mock godview JSON/Markdown and mock PCActivityEvent records. CI must not require a real `C:\Users\admin\AppData\Local\MineContext` directory.
