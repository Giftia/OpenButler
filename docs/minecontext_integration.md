# MineContext PC Activity Integration

OpenButler treats MineContext as a local PC observation layer. MineContext keeps its own screen/activity data; OpenButler reads it through the existing godview scripts or a read-only SQLite fallback, normalizes the result, and writes derived PC activity events into the OpenButler event lake.

## Default Paths

- Workspace: `C:\Users\admin\Documents\Codex\2026-05-21\pc-windows10-minecontext-volcengine-minecontext-https`
- MineContext data: `C:\Users\admin\AppData\Local\MineContext`
- Query script: `tools\run_minecontext_godview_query.ps1`
- Search script: `tools\run_minecontext_godview_search.ps1`

Override with `OPENBUTLER_MINECONTEXT_WORKSPACE` and `OPENBUTLER_MINECONTEXT_HOME`.

## API

- `GET /api/pc-activity/minecontext/status`
- `POST /api/pc-activity/minecontext/query-at-time`
- `POST /api/pc-activity/minecontext/search`
- `POST /api/pc-activity/minecontext/import`
- `GET /api/pc-activity/events`
- `GET /api/pc-activity/summary/today`
- `GET /api/pc-activity/app-usage`
- `GET /api/pc-activity/domain-usage`
- `GET /api/pc-activity/workflow-candidates`
- `DELETE /api/pc-activity/events`

## Evidence Boundary

High confidence comes from MineContext activity records and screenshot paths. Context summaries and semantic hits are useful clues but are not final facts. Generated reports, todos, and tips are weak hints. OpenButler answers must say whether an action can be confirmed and must preserve activity ids, context ids, screenshot paths, confidence, and the uncertainty boundary.

Remote facts such as deployment success, Git commits, CI results, Yunxiao task state, or online API health are not confirmed by MineContext. Those require live source-system checks.
