# Local Development

## Requirements

- Windows PowerShell or a POSIX shell.
- Python 3.11+.
- Node.js 20+.
- Docker Desktop for one-command Compose runs.

## Install Dependencies

Backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

Frontend:

```powershell
cd frontend
npm install
```

## Start Backend

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010
```

## Start Frontend

```powershell
cd frontend
$env:VITE_API_BASE_URL="http://127.0.0.1:8010"
npm run dev -- --host 0.0.0.0 --port 5175
```

## Docker Compose

```bash
docker compose up --build
```

## Mock MineContext

MineContext tests use mock data and do not require a live MineContext install. For runtime demos without MineContext, use PC Activity service tests or seed/import mock events through the service layer. Do not write to the real MineContext directory.

## Web

- Local: `http://localhost:5175`
- Butler: `http://localhost:5175/butler`
- PC Activity: `http://localhost:5175/pc-activity-context`

## API Docs

- `http://127.0.0.1:8010/docs`
- `http://127.0.0.1:8010/health`

## Proactive Butler Demo Smoke

With the backend running, use one command to exercise the local demo loop:

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
```

The smoke command calls `POST /api/butler/demo/run` and verifies the demo response includes the PC Activity import step, timeline rebuild, insight generation, briefing generation, readiness refresh, evidence boundary, and strict privacy fields. It must report `external_model_used: false`, `copied_screenshots: 0`, and `minecontext_source_deleted: 0`.

The reset command calls `POST /api/butler/demo/reset`. It is safe for repeatable demos because it deletes only OpenButler-derived Butler data and verifies PC Activity events plus MineContext source data are preserved.

`smoke:butler-ui-flow` checks the `/butler` source-level button bindings and then exercises the run/reset/readiness API chain against the local backend. It is intentionally lightweight and does not require Playwright or another browser automation dependency.

The `/butler` page also shows the `Productization Harness` panel from `GET /api/butler/mvp-report`, including the MVP chain, acceptance checks, next actions, evidence boundary, and strict privacy fields. If the report is `data_insufficient` or `attention_needed`, the panel shows local repair suggestions such as importing PC Activity or rebuilding the timeline. The action buttons use a hardcoded local whitelist and must not execute arbitrary endpoint strings from the report.

`smoke:butler-mvp-report` runs the same local demo loop, reads `GET /api/butler/mvp-report`, verifies MVP acceptance checks, next actions, and strict privacy fields, then uses the safe reset endpoint. It is the quickest local Productization Harness check for the Proactive Butler Core MVP.

`smoke:butler-demo-pack` runs the local demo loop, reads `GET /api/butler/productization/demo-pack`, verifies readiness, MVP report, active-objective status, latest Harness summaries, evidence boundary, and strict privacy counters, then uses the safe reset endpoint. Use it when you need one command to prove the one-page Productization Harness evidence pack is usable.

`smoke:butler-browser` is the browser-level Productization Harness check. It expects a built frontend in `frontend/dist`, starts a local static server that proxies `/api` to the backend, opens `/butler` in headless Edge or Chrome, verifies the rendered Productization Harness, objective status, one-page demo pack, evidence boundary, and strict privacy fields, then clicks `演练空数据路径` and verifies `dry_run=true` plus `mutates_data=false`. Set `OPENBUTLER_BROWSER_PATH` if Edge/Chrome is not in a standard location.

It also opens `/butler/inbox`, clicks `查看证据详情`, and verifies the evidence detail panel exposes `evidence_boundary`, `privacy_notes`, `未复制截图文件`, and `未调用外部模型`. This is the runtime click proof for the L2 Inbox evidence detail requirement.

`smoke:butler-l1-audit` runs the local demo loop, reads `GET /api/butler/productization/l1-audit`, and verifies every active objective success criterion has a result, evidence refs, and an evidence boundary. It distinguishes `proven`, `needs_attention`, `missing_evidence`, and `out_of_scope`, while preserving strict privacy counters and MineContext source-data boundaries.

`artifact:butler-demo-pack` runs the same local evidence path and writes `data/productization/productization-demo-pack.json`. The artifact is intended for local CI or manual review. It must not include MineContext source records, screenshot bytes, screenshot OCR, raw godview output, copied screenshots, or external-system state.

`test:demo-pack-artifact-file` validates the generated artifact offline. It does not require the backend and does not inspect MineContext. Run it after `artifact:butler-demo-pack` or against an existing artifact.

`test:productization-records` validates the local Productization Harness changelog and demo record:

```text
CHANGELOG.md
docs/productization/DEMO_RECORD.md
```

It checks for the local acceptance commands, `data/productization/productization-demo-pack.json`, the L1 audit API, strict privacy counters, and the evidence boundary that remote repositories, CI, Yunxiao, deployments, and online services require live source-system verification. It also checks that the records do not include MineContext source records, screenshot content, raw godview output, screenshot file paths, or copied screenshot evidence.

`verify:productization` is the current one-command local gate for the Productization Harness when the backend is running. It checks backend health, runs static checks, builds the frontend, runs `smoke:butler-demo-pack`, runs the L1 audit smoke, writes the JSON artifact, validates the artifact offline, and runs the headless `/butler` browser smoke. If the backend is not reachable it exits with a clear start-backend hint. It must keep `external_model_used: false`, `copied_screenshots: 0`, and `minecontext_source_deleted: 0`.

To verify the empty-data recovery path without changing real data:

```powershell
cd frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run smoke:butler-data-insufficient-drill
```

This smoke calls `GET /api/butler/demo/data-insufficient-drill`. The endpoint is synthetic and read-only: it returns `data_insufficient`, `dry_run: true`, and local next actions without importing PC Activity, rebuilding timeline data, copying screenshots, deleting MineContext source data, or calling an external model.

The same drill is available on `/butler` as `演练空数据路径`. Use it when checking the Productization Harness UI empty-state behavior. The button must remain read-only and should display the evidence boundary plus strict privacy fields returned by the API.

The `/butler` page also reads `GET /api/butler/harness/runs/latest` and shows the latest local Harness summaries. To inspect the same data from PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8010/api/butler/harness/runs/latest
```

These summaries are local OpenButler verification records. They do not include MineContext source records, screenshot content, copied screenshots, or external-system facts.

They are included in `GET /api/butler/export` as structured OpenButler data and are removed by `DELETE /api/butler/data` together with other Butler-derived records. The deletion path still preserves PC Activity events, MineContext databases, and MineContext screenshot files.

To inspect active objective evidence:

```powershell
Invoke-RestMethod http://127.0.0.1:8010/api/butler/productization/objectives/status
Invoke-RestMethod http://127.0.0.1:8010/api/butler/productization/l1-audit
```

This endpoint maps `.openbutler/goals.yaml` active objectives to local API, UI-source, and documentation evidence. It returns the loaded `goals_source`, each objective's declared priority and success criteria, and the local evidence status. It is read-only with respect to MineContext and does not verify remote systems.

The L1 audit endpoint expands that mapper output into one row per declared success criterion. It returns `proven`, `needs_attention`, `missing_evidence`, or `out_of_scope` for every item, plus evidence refs and the evidence boundary.

## L2 PC Activity Import Preview

To preview a recent-history import without writing OpenButler events or touching MineContext source data:

```powershell
$body = @{
  source = "minecontext"
  lookback_days = 7
  dry_run = $true
  include_screenshot_paths = $true
  copy_screenshots = $false
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  http://127.0.0.1:8010/api/butler/import/pc-activity/preview
```

The response includes estimated source events, estimated new events, estimated duplicates, screenshot path count, warnings, privacy counters, and an evidence boundary. This endpoint is intentionally preview-only: `dry_run: false` is rejected here, screenshots are not copied, no external model is called, and MineContext source data is not modified.

The Butler Inbox at `/butler/inbox` can expand each insight card to show local evidence details. It displays `evidence_refs`, `evidence_boundary`, confidence, source/type/status, and a path-only note for screenshot evidence. It does not copy, read, or upload screenshot content.

To inspect feedback-driven noise reduction:

```powershell
Invoke-RestMethod http://127.0.0.1:8010/api/butler/insights/noise-evaluation
```

The response is local and rule-based. It summarizes feedback counts, priority delta, cooldown minutes, suppression recommendations, protected notice status, privacy counters, and evidence boundary. Protected notices such as `data_quality_notice` and `privacy_notice` must not be permanently suppressed.

To inspect the recent metrics trend used by `/metrics`:

```powershell
Invoke-RestMethod "http://127.0.0.1:8010/api/butler/metrics?days=7"
```

The response includes `trend`, `summary`, strict privacy counters, and an evidence boundary. It is built from local OpenButler metric snapshots only. When no metric snapshots exist, `/metrics` must show a data-insufficient empty state instead of inferring a trend.

For Vercel-style product demos without a real MineContext data directory, start the backend with synthetic demo seeding:

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
$env:OPENBUTLER_DEPLOY_TARGET="vercel"
$env:OPENBUTLER_DATA_DIR="C:\Users\admin\Desktop\git\OpenButler\data\vercel_smoke_tmp"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8010
```

This creates shareable demo PC Activity events only when the local OpenButler PC Activity table is empty. The demo records are marked as demo-only, contain no screenshot paths, do not read or mutate MineContext, and allow `/butler`, `/metrics`, `/timeline`, and `/butler/inbox` to demonstrate the full product loop on stateless deployments.

If a future active objective is added to `.openbutler/goals.yaml` before a matching evidence mapper exists, the objective status API should return `needs_attention` with `evidence_mapper_missing`, and `/butler` should show `缺少 evidence mapper`.

Use `docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md` when adding a new active objective mapper. The API returns the same contract in `evidence_mapper_template` so future Codex runs can see the required mapper steps, criterion shape, tests, and privacy invariants.

To inspect the one-page Productization demo pack:

```powershell
Invoke-RestMethod http://127.0.0.1:8010/api/butler/productization/demo-pack
```

This response aggregates readiness, MVP report, active-objective status, and the latest Harness summaries. The `/butler` page shows the same data as `一页演示包`. It must keep `external_model_used: false`, `copied_screenshots: 0`, and `minecontext_source_deleted: 0`.
