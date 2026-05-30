# Chinese Mojibake Risk Audit

Date: 2026-05-30

## Scope

This audit covers the current OpenButler repository text files and key frontend runtime screens. It does not rewrite files or perform bulk encoding conversion.

Checked areas:

- `frontend/src`
- `frontend/scripts`
- `backend/app`
- `docs`
- `.openbutler`
- `README.md`
- `AGENTS.md`

Ignored generated or runtime directories:

- `frontend/node_modules`
- `frontend/dist`
- `backend/.venv`
- `backend/data`
- `tmp`

## Commands

```powershell
git status --short
rg -n "�|Ã|Â|â€|å|æ|ç|闂|鍫|涓|绠|鏂|鎴|瀹|閫|妯|缁|鐢|鎻|ä¸|\\uFFFD" --glob '!frontend/node_modules/**' --glob '!frontend/dist/**' --glob '!backend/.venv/**' --glob '!backend/data/**' --glob '!tmp/**' .
rg -n "[\\u4e00-\\u9fff]" frontend\\src backend\\app docs .openbutler README.md AGENTS.md --glob '!frontend/dist/**' --glob '!backend/data/**'
cd frontend
npm run build
npm run test:butler-browser-smoke-script
npm run test:inbox-evidence-panel
$env:OPENBUTLER_API_BASE_URL='http://127.0.0.1:8012'
npm run smoke:butler-browser
```

## Findings

- The repository was clean before the audit.
- 466 candidate text files were in scope.
- The mojibake pattern scan found no matching repository text files.
- Chinese source text exists intentionally in UI labels, docs, tests, plugins, and goal files.
- The browser smoke rendered and verified key Chinese UI text on `/butler` and `/butler/inbox`.
- The Inbox evidence detail click path rendered `evidence_boundary` and privacy notes.
- No accidental destructive encoding conversion was performed.

## Encoding Source Assessment

The known mojibake risk appears to come from PowerShell or prior console output rendering, especially when paths or Chinese text are displayed without explicit UTF-8 handling. Current repository text files did not show persistent mojibake signatures in this audit.

For future PowerShell file reads or writes, continue using explicit `-Encoding UTF8` for text files.

## Runtime Verification

The browser smoke used a temporary backend data directory and synthetic demo data:

- API: `http://127.0.0.1:8012`
- `npm run build`: OK
- `npm run test:butler-browser-smoke-script`: OK
- `npm run test:inbox-evidence-panel`: OK
- `npm run smoke:butler-browser`: OK

Privacy counters from the smoke:

- `external_model_used=false`
- `minecontext_source_deleted=0`
- `copied_screenshots=0`

No real MineContext activity was read for this visual verification run.

## Decision

No source file encoding fix is needed in this round. Do not perform bulk recoding unless a future audit identifies a specific corrupt file and its original intended text.
