# Productization Harness Demo Record

Date: 2026-05-29

This record documents the local Productization Harness demo path for OpenButler. It is intentionally limited to OpenButler-derived status, evidence boundaries, and privacy counters. It does not contain MineContext source records, screenshot content, screenshot bytes, raw godview output, copied screenshots, or external-system state.

## Local Demo Command

Start the backend:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8010
```

Run the Productization Harness gate:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\frontend
$env:OPENBUTLER_API_BASE_URL="http://127.0.0.1:8010"
npm run verify:productization
```

## Artifact

The local review artifact is written to:

```text
data/productization/productization-demo-pack.json
```

The artifact is OpenButler-derived. It must not include MineContext source records, screenshot content, raw godview output, copied screenshots, or external-system state.

## API Evidence Surfaces

- `GET /api/butler/productization/l1-audit`
- `GET /api/butler/productization/demo-pack`
- `GET /api/butler/mvp-report`
- `GET /api/butler/readiness`
- `GET /api/butler/productization/objectives/status`
- `GET /api/butler/harness/runs/latest`

## Expected L1 Result

The current L1 audit should show:

- objective count: 3
- success criteria count: 13
- `proven`: 13
- `missing_evidence`: 0
- `out_of_scope`: 0

Every objective criterion must include evidence references and an evidence boundary.

## Privacy Assertions

The demo path must report:

- `external_model_used=false`
- `external_model_allowed=false`
- `system_notification_enabled=false`
- `minecontext_source_deleted=0`
- `copied_screenshots=0`

The demo path must remain local and strict-mode compatible. It must not call external models, send external webhooks, copy screenshots, delete MineContext source data, or perform external writes.

## Evidence Boundary

The Productization Harness can prove that the local OpenButler loop is wired:

```text
MineContext-derived PC Activity -> Unified Timeline -> Metrics -> Insights -> Briefings -> Feedback -> Productization evidence
```

It cannot prove remote repositories, CI, Yunxiao, deployments, online services, or external task states. Those facts require live source-system verification.

## Known Limits

- The demo validates the local Productization Harness, not the complete accuracy of MineContext source observations.
- Headless browser smoke validates key `/butler` rendering and data-insufficient drill behavior, not every UI path.
- No system notification is sent by default.
- No external write is executed by default; future external actions must remain drafts until the user confirms.

