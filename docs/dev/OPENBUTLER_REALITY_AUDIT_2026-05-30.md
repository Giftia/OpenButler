# OpenButler Reality Audit - 2026-05-30

This audit is a facts-only snapshot of the current workspace. It does not evaluate future prompts as truth and does not include feature development or fixes.

## 1. Repository State

Command evidence:

```text
cwd: C:\Users\admin\Desktop\git\OpenButler
git branch --show-current: fatal: not a git repository (or any of the parent directories): .git
git status --short: fatal: not a git repository (or any of the parent directories): .git
git log --oneline -n 10: fatal: not a git repository (or any of the parent directories): .git
```

Fact: the current OpenButler workspace is not a Git repository. Branch, dirty state, and commit history cannot be audited from local Git metadata.

Root entries observed:

```text
.openbutler/
.tmp/
.vercel/
api/
backend/
data/
docs/
frontend/
openclaw/
openclaw-skill/
plugins/
tools/
.gitignore
.vercelignore
AGENTS.md
CHANGELOG.md
current_state.md
docker-compose.yml
README.md
requirements.txt
vercel.json
```

Important structure mismatch: there is no `apps/`, `apps/api/`, or `apps/web/` directory. Actual implementation is under `backend/`, `frontend/`, and `api/`.

## 2. Key Files

Existing files checked:

| File | Exists | Reality note |
|---|---:|---|
| `AGENTS.md` | yes | Repository map exists and points to actual `backend/` and `frontend/` structure. |
| `current_state.md` | yes | Describes many current capabilities; should be treated as documentation, not runtime proof. |
| `README.md` | yes | Contains run commands and API descriptions; broadly aligned with current code but optimistic in places. |
| `docker-compose.yml` | yes | Defines `backend` and `frontend` services; frontend default port is 5173, not 5175. |
| `.openbutler/goals.yaml` | yes | Contains OB-GOAL-001 through OB-GOAL-004. Text displayed as mojibake in PowerShell output. |
| `.openbutler/task_queue.yaml` | yes | Contains many tasks marked `done`, including L2 tasks. Text displayed as mojibake in PowerShell output. |
| `.openbutler/definition_of_done.md` | yes | Exists. |
| `docs/product/NORTH_STAR.md` | yes | Exists. |
| `docs/product/MVP_SCOPE.md` | yes | Exists. |
| `docs/product/ROADMAP.md` | yes | Exists. |
| `docs/privacy/PRIVACY_BOUNDARIES.md` | yes | Exists and reflects strict/no-copy/no-external-model boundaries. |
| `docs/dev/CODEX_WORKFLOW.md` | yes | Exists. |
| `docs/dev/LOCAL_DEVELOPMENT.md` | yes | Exists. |
| `docs/dev/TESTING.md` | yes | Exists. |
| `docs/dev/L2_READINESS_AUDIT.md` | yes | Exists from prior work; not independently trusted without code checks. |

Encoding risk: several files printed through PowerShell with mojibake Chinese strings, including `frontend/src/App.tsx`, `.openbutler/*.yaml`, `openclaw-skill/tools.yaml`, and several backend literals. Build still passes, but UI copy fidelity should be visually verified before using screenshots as product evidence.

## 3. Runtime API Inventory

Extracted from the live FastAPI app route table:

| Method | Path | Module | Real code | Data source | Test evidence |
|---|---|---|---:|---|---|
| GET | `/health` | core | yes | SQLite settings | not directly tested in commands run |
| GET/POST | `/api/privacy-mode` | core | yes | SQLite settings | indirectly in privacy tests |
| GET/POST | `/api/events`, `/api/events/simulate` | core event lake prototype | yes | SQLite `events`, seeded/demo | not primary current tests |
| GET | `/api/plugins` | plugin manifest loader | yes | `backend/app/plugins/*.json` | privacy behavior indirectly tested |
| POST | `/api/chat` | chat router in `main.py` | yes | rule branches, PC Activity, Butler Core, Vision | `test_chat_api_contract.py` |
| GET | `/api/openclaw/skill` | OpenClaw helper | yes | `openclaw/SKILL.md` fallback | docs tests |
| GET/POST/DELETE | `/api/pc-activity/*` | PC Activity Context | yes | MineContext adapter or SQLite PC events | 8 PC tests |
| GET/POST/DELETE/PATCH | `/api/butler/*` | Butler Core | yes | SQLite Butler tables + PC Activity service | 51 Butler tests |
| GET/POST/DELETE | `/api/vision/*` | Vision alias | yes | local eyes adapter or mock + SQLite | 7 vision tests |
| GET/POST/DELETE | `/api/workstation-vision/*` | legacy workstation prefix | yes | same service as `/api/vision` | 7 vision tests |
| GET | `/docs`, `/openapi.json`, `/redoc` | FastAPI | yes | generated | not tested in commands run |

Not found:

- `/api/devices/*` route was not present in the extracted route table.
- `/api/acoustic/*` route was not present in the extracted route table.
- `/api/butler/insights/{insight_id}/evidence` route was not present. Evidence details are currently available from insight list payloads and frontend expansion, not a dedicated evidence endpoint.

## 4. Frontend Page Inventory

Actual frontend framework: React + Vite + TypeScript (`frontend/package.json`).

Actual page routing is state-based inside `frontend/src/App.tsx`, not a router package. Path sniffing maps:

| Page path | Component | Data source | Reality |
|---|---|---|---|
| `/butler` | `ButlerHome` | `/api/butler/home`, readiness, MVP report, demo pack, briefings | implemented |
| `/butler/inbox` | `ButlerInbox` | `/api/butler/insights`, feedback/dismiss/snooze APIs | implemented |
| `/metrics` | `MetricsPage` | `/api/butler/metrics/today`, `/api/butler/metrics?days=7` | implemented |
| `/timeline` | `UnifiedTimeline` | `/api/butler/timeline`, rebuild API | implemented |
| `/goals` | `GoalsPage` | `/api/butler/goals`, settings, delete Butler data | implemented |
| `/pc-activity-context` | `PCActivityContext` | `/api/pc-activity/*` | implemented |
| `/vision` | `WorkstationVision` | `/api/vision/*` | implemented |
| `/` | Dashboard and other nav views | `/api/events`, `/api/plugins`, `/api/privacy-mode` | implemented |

Frontend API helper evidence: `frontend/src/lib/api.ts` contains wrappers for the routes above.

Build result:

```text
cd frontend
npm run build
tsc && vite build
1580 modules transformed
dist built successfully
```

## 5. Module Audit

### MineContext / godview Integration

Status: partially implemented, with real script/DB adapters and mock-test coverage.

Evidence:

- `backend/app/integrations/minecontext/config.py`: default workspace path, data path, script names, strict defaults (`read_only=True`, `copy_screenshot_evidence=False`, `include_raw_output=False`, `external_model_allowed=False`).
- `backend/app/integrations/minecontext/godview_client.py`: PowerShell wrapper for query/search scripts, JSON output parsing, timeout handling.
- `backend/app/integrations/minecontext/adapter.py`: health check, query, search, read-only SQLite `activity` export.
- `backend/app/integrations/minecontext/normalizer.py`: query/search normalization, alias matching, sensitive text redaction.
- `backend/app/modules/pc_activity_context/router.py`: `/api/pc-activity/minecontext/status`, query, search, import.
- Tests: `backend/app/modules/pc_activity_context/tests/test_pc_activity_normalizer.py`, `test_pc_activity_service.py`.

Capabilities:

- Time query: yes, via `MineContextGodviewClient.query_at_time`.
- Keyword search: yes, via `MineContextGodviewClient.search`.
- Import PC activity: yes, via read-only SQLite `activity` table if present.
- Evidence boundary: yes in normalized responses and summaries.
- Default read-only: yes.
- Default no screenshot copy: yes.
- Mock mode: tests use mock/fake data; the MineContext adapter itself does not synthesize successful fake MineContext query results when real source is missing.

Gaps:

- No HTTP API adapter implementation was found beyond the planned `access_mode` field.
- Import relies on an expected SQLite table named `activity`; schema drift is handled by returning errors or empty results, not robust schema discovery.
- Real MineContext availability was not verified in this audit to avoid touching user data beyond safe checks.

### PC Activity Context

Status: implemented with tests, but real usefulness depends on local MineContext data/schema.

Evidence:

- `backend/app/modules/pc_activity_context/models.py`: `PCActivityEventModel`.
- `service.py`: DB init, idempotent event creation, import, preview import, summary, clear events, context recovery pack.
- `router.py`: actual API prefix `/api/pc-activity`.
- Timeline helpers: `timeline/activity_timeline.py`, `project_switching.py`, `workflow_patterns.py`.
- Tests: 8 tests passed.

Capabilities:

- PC events: yes, stored in SQLite table `pc_activity_events`.
- Summary today: yes, from OpenButler-imported events.
- App/domain usage: yes.
- Focus blocks: yes, rule-based.
- Workflow candidates: yes, simple rule-based.
- Idempotent import protection: yes in `create_event()` by `source_activity_id` or stable fingerprint.
- 7-day dry-run: yes through Butler endpoint `POST /api/butler/import/pc-activity/preview`, delegating to `PCActivityContextService.preview_import_activities`.

Gaps:

- `/api/pc-activity/minecontext/import` is not a dry-run endpoint; it writes OpenButler PC events.
- 7-day import preview exists under `/api/butler/import/pc-activity/preview`, not under `/api/pc-activity`.
- Actual historical import quality is unverified against real MineContext data in this audit.

### Proactive Butler Core

Status: implemented, rule-based, tested.

Evidence:

- `backend/app/modules/butler_core/models.py`: `UnifiedTimelineEventModel`, `ButlerMetricSnapshotModel`, `InsightCardModel`.
- `service.py`: DB tables for timeline, metrics, insights, briefings, goals, feedback, audit log, harness runs.
- `unified_timeline.py`: PC activity to unified event conversion.
- `metrics_engine.py`: active minutes, focus blocks, context switches, top apps/domains/projects.
- `insight_engine.py`: rule insights, feedback penalties, noise evaluation.
- `briefing_generator.py`: briefing generation.
- `butler_inbox.py`: snooze helper.
- `router.py`: `/api/butler/*`.
- Tests: 51 Butler tests passed.

Capabilities:

- Rebuild timeline from PC Activity: yes.
- Metrics today and 7-day range: yes.
- Insight generation: yes, local rules only.
- Butler Inbox: yes, insight list/status/feedback/snooze/dismiss.
- Feedback loop: yes, affects priority/suppression behavior by insight type.
- Noise evaluation: yes at `/api/butler/insights/noise-evaluation`.
- Briefings: yes for generator endpoint; weekly review is covered by tests.
- Goals: yes basic CRUD plus seeded defaults.
- Context recovery: yes.

Gaps:

- No dedicated `ButlerBriefingModel` dataclass was found in `models.py`, though the DB table and APIs exist.
- Insight evidence details are not exposed as a dedicated `/api/butler/insights/{id}/evidence` endpoint.
- Rules are simple and local; not a learned personalization engine.

### Web Frontend

Status: implemented and buildable; data is API-backed with demo/seed data paths.

Evidence:

- `frontend/src/App.tsx`: all pages in a single file.
- `frontend/src/lib/api.ts`: API client wrappers.
- `frontend/scripts/*.mjs`: smoke/static/productization scripts.
- `npm run build`: passed.

Gaps:

- No component directory split exists despite earlier planned `components/butler/*`.
- No browser smoke was run during this audit because the user asked for audit only and not to alter runtime state. Existing scripts exist.
- UI copy may contain mojibake based on file output; needs visual verification.

### OpenClaw Skill

Status: implemented as documentation/tool declaration; not proven as an executable tool bridge.

Evidence:

- `openclaw/SKILL.md`.
- `openclaw-skill/SKILL.md`.
- `openclaw-skill/tools.yaml`.
- `docs/openclaw_integration.md`.
- Tests: `backend/app/modules/butler_core/tests/test_openclaw_skill_docs.py`.

Capabilities:

- Tools are declared for vision, PC Activity, proactive Butler overview, insights, briefings, feedback.

Gaps:

- Some tool declarations are client-filter conventions rather than one-to-one backend endpoints, e.g. `explain_insight_evidence` maps to `GET /api/butler/insights` with client filtering.
- No runtime OpenClaw tool server execution was tested in this audit.

### Plugin System

Status: manifest loader implemented; runtime execution not implemented as plugin pipeline.

Evidence:

- Top-level `plugins/` contains empty stage directories in the scan.
- Actual loaded manifests are JSON files in `backend/app/plugins/*.json`.
- `backend/app/main.py` loads `backend/app/plugins/*.json` via `load_plugin_manifests()` and evaluates strict privacy availability via `privacy_evaluation()`.

Capabilities:

- `/api/plugins` returns manifests and strict-mode availability.
- Manifest privacy, model provider, and permissions affect availability.

Gaps:

- Top-level `plugins/preprocess`, `plugins/timeline`, `plugins/tools` were present but no files were found by `rg --files`.
- Plugin schemas/permissions are not validated against a formal schema in runtime code.
- Plugins are not executable runtime units; they are metadata manifests.

### Privacy and Security

Status: partially implemented with concrete guards and tests; not a full central Privacy Guard.

Evidence:

- `backend/app/main.py`: privacy mode storage and plugin blocking for strict mode.
- `PCActivityContextService.update_settings()`: strict disables external models and screenshot copying.
- `PCActivityContextService.preview_import_activities()`: dry-run, no DB mutation, no external model/webhook, no screenshot copy.
- `ButlerCoreService.update_settings()`: strict disables external model allowance and system notifications.
- `ButlerCoreService.clear_data()`: deletes only Butler-derived data and reports `minecontext_source_deleted: 0`.
- Audit tables: `pc_activity_audit_log`, `butler_audit_log`, `workstation_vision_audit_log`.
- Tests explicitly check strict/no-copy/no-delete/no-raw-output behavior.

Gaps:

- No class named `PrivacyGuard` was found.
- No global outbound network interception layer was found.
- No external webhook sender implementation was found; strict blocks external-webhook plugin availability, but there is not a general webhook runtime to intercept.
- Audit logging exists per module, not as a unified audit API.

## 6. Tests Run

Commands and results:

```text
$env:PYTHONPATH='C:\Users\admin\Desktop\git\OpenButler\backend'
python -m unittest discover -s backend\app\modules\pc_activity_context\tests
Ran 8 tests in 0.095s - OK

python -m unittest discover -s backend\app\modules\butler_core\tests
Ran 51 tests in 6.204s - OK

python -m unittest discover -s backend\app\modules\workstation_vision\tests
Ran 7 tests in 0.114s - OK

cd frontend
npm run build
tsc && vite build - OK
```

Not run in this audit:

- `npm run verify:productization`, because it is a harness command that may write/update local artifacts under `data/productization/`.
- Browser click smoke tests, because this audit was limited to fact alignment and no runtime UI interaction was required.
- Real MineContext query/import against user data.

## 7. Documentation vs Code Drift

| Item | Docs/prompt claim | Code fact | Risk | Suggested correction |
|---|---|---|---|---|
| Directory layout | `apps/api`, `apps/web` | actual `backend`, `frontend`, `api` | Future prompts target wrong paths | Update planning prompts and docs to actual layout. |
| Git state | Implied repo lifecycle | no `.git` repository | Cannot branch/commit/audit diff | Initialize/restore Git repo before productization workflow. |
| Plugin location | top-level `plugins/preprocess|timeline|tools` | top-level dirs empty; runtime uses `backend/app/plugins/*.json` | Codex may add unused YAML | Make `backend/app/plugins` canonical or wire top-level plugins. |
| Plugin runtime | Three-stage plugin system | manifests are loaded; not executable pipeline | Overstates extensibility | Document as manifest registry until execution exists. |
| Evidence detail endpoint | L2 prompt requested `/api/butler/insights/{id}/evidence` | route not found | API consumers may fail | Add endpoint or update docs to use `/api/butler/insights`. |
| OpenClaw tools | Tool declarations imply direct tools | docs/YAML exist; no runtime bridge test | Integration may be paper-only | Add executable OpenClaw validation path. |
| Privacy Guard | Central Privacy Guard described | distributed checks, no `PrivacyGuard` class | Harder to reason globally | Either add central guard or document distributed enforcement. |
| HTTP MineContext adapter | Priority mentions HTTP API | no HTTP client implementation found | Prompt may assume unsupported mode | Mark HTTP adapter as future. |
| UI component structure | component directories planned | `App.tsx` monolith | Maintenance risk | Refactor later, not during audit. |
| Encoding | Chinese product copy expected | multiple files display mojibake in PowerShell output | UI trust/product polish risk | Audit file encodings and browser output. |
| `/api/devices`, `/api/acoustic` | Mentioned in earlier contexts | routes not found | Future prompts may chase missing modules | Keep explicitly out of scope. |
| Real 7-day import | Task queue marks done | preview API exists; real source not verified in audit | May be only structurally done | Validate with real MineContext dry-run separately. |

## 8. Maturity Ratings

Scale: L0 not found, L1 docs/plan, L2 mock/static UI, L3 API exists but not fully real-data-backed, L4 end-to-end runnable but test-light, L5 end-to-end runnable with tests.

| Capability | Rating | Reason |
|---|---:|---|
| MineContext time query | L4 | Real script wrapper and API exist; tests cover parser, not live MineContext. |
| MineContext keyword search | L4 | Real script wrapper, aliases, parser tests; live source not tested. |
| PC Activity import | L5 | SQLite import path, idempotency, tests. Real schema risk remains. |
| PC Activity today summary | L5 | Implemented and tested on mock/imported events. |
| Unified timeline | L5 | Conversion/rebuild API/tests exist. |
| Today metrics | L5 | Metrics engine/API/tests exist. |
| Active insights | L5 | Rule engine/API/tests exist. |
| Butler Inbox | L4 | API/UI exist and feedback tested; browser click smoke not run in this audit. |
| Evidence details | L3 | Inline insight evidence exists; dedicated evidence API absent. |
| User feedback | L5 | Feedback status and penalty tests exist. |
| Noise reduction rules | L5 | Rule and evaluation endpoint/tests exist. |
| 7-day historical import | L3 | Dry-run preview exists; true 7-day write import not a dedicated flow. |
| Dry-run import | L5 | Preview API and strict privacy tests exist. |
| OpenClaw Skill | L3 | Declarations and docs tests exist; runtime tool execution not proven. |
| strict privacy mode | L4 | Multiple code guards/tests; no global network-level enforcement. |
| Web Dashboard | L4 | Build passes and API-backed pages exist; browser smoke not run in audit. |
| Test system | L4 | Backend and frontend build healthy; no CI found. |
| Local one-command start | L3 | Docker Compose exists; not run in audit. |

## 9. Next Best P0 Tasks

Suggested queue, not executed:

```yaml
tasks:
  - id: OB-AUDIT-TASK-001
    title: "Restore or initialize Git repository metadata"
    priority: P0
    status: needs-human
    why: "Current workspace is not a Git repo, so branch/status/log and safe change tracking are impossible."
    depends_on: []
    done_when:
      - "git status works"
      - "current branch is known"
      - "baseline commit or remote is confirmed"
    files_likely_touched:
      - ".git/"
    risks:
      - "Requires human decision on whether this folder should be initialized or reconnected to an existing remote."

  - id: OB-AUDIT-TASK-002
    title: "Verify real MineContext 7-day dry-run against local data"
    priority: P0
    status: ready
    why: "The API exists and tests pass with fakes, but real source compatibility is not proven by this audit."
    depends_on:
      - "Existing MineContext data directory and godview workspace"
    done_when:
      - "POST /api/butler/import/pc-activity/preview returns real estimated_source_events or a clear error"
      - "No DB writes, screenshot copies, external model calls, or source mutations occur"
      - "Result is documented as evidence"
    files_likely_touched:
      - "docs/dev/L2_READINESS_AUDIT.md"
    risks:
      - "Reads local user activity metadata; should stay dry-run and path-only."

  - id: OB-AUDIT-TASK-003
    title: "Add or align Butler insight evidence detail contract"
    priority: P0
    status: ready
    why: "Frontend can expand evidence refs, but the requested dedicated evidence API is absent."
    depends_on:
      - "Existing /api/butler/insights"
    done_when:
      - "Either /api/butler/insights/{id}/evidence exists with tests, or docs/OpenClaw declarations explicitly use /api/butler/insights"
      - "Evidence boundary and screenshot path-only behavior are tested"
    files_likely_touched:
      - "backend/app/modules/butler_core/router.py"
      - "backend/app/modules/butler_core/service.py"
      - "backend/app/modules/butler_core/tests/test_butler_api_contract.py"
      - "frontend/src/App.tsx"
    risks:
      - "Must not expose raw_output or screenshot contents."
```

Blocked or needs-human:

- Real full import enablement should not be defaulted without product/privacy confirmation.
- Git workflow cannot be considered productization-ready until repository metadata exists.
- UI copy/encoding correction needs visual confirmation to avoid accidental text churn.

## 10. Reality Snapshot

```yaml
openbutler_reality_snapshot:
  repo:
    branch: null
    dirty: unknown_not_git_repository
    last_commit: null
  current_stage: "Proactive Butler Core L2 implemented structurally; reality audit found Git and evidence-endpoint gaps"
  actually_working:
    - "FastAPI app imports and exposes /health, /api/pc-activity/*, /api/butler/*, /api/vision/*"
    - "PC Activity tests passed: 8/8"
    - "Butler Core tests passed: 51/51"
    - "Vision tests passed: 7/7"
    - "Frontend TypeScript/Vite build passed"
    - "PCActivityEvent, UnifiedTimelineEvent, metrics, insights, feedback, dry-run preview exist in code"
  partially_working:
    - "MineContext real adapter exists, but live local MineContext query/import was not executed in this audit"
    - "OpenClaw skill declarations exist, but runtime tool invocation was not validated"
    - "Plugin manifests load, but plugins are not executable pipeline units"
    - "strict privacy mode has code guards/tests but no global network interceptor"
  docs_only:
    - "apps/api and apps/web directory layout"
    - "central PrivacyGuard class"
    - "MineContext HTTP API adapter"
  missing:
    - "Git repository metadata"
    - "dedicated /api/butler/insights/{insight_id}/evidence route"
    - "/api/devices/*"
    - "/api/acoustic/*"
    - "CI workflow evidence"
  api_available:
    - "/api/pc-activity/minecontext/status"
    - "/api/pc-activity/minecontext/query-at-time"
    - "/api/pc-activity/minecontext/search"
    - "/api/pc-activity/minecontext/import"
    - "/api/butler/home"
    - "/api/butler/import/pc-activity/preview"
    - "/api/butler/timeline/rebuild"
    - "/api/butler/metrics/today"
    - "/api/butler/metrics"
    - "/api/butler/insights"
    - "/api/butler/insights/noise-evaluation"
    - "/api/butler/briefings/generate"
    - "/api/butler/context-recovery"
  web_pages_available:
    - "/butler"
    - "/butler/inbox"
    - "/metrics"
    - "/timeline"
    - "/goals"
    - "/pc-activity-context"
    - "/vision"
  tests:
    backend: "66 unittest tests run across pc_activity_context, butler_core, workstation_vision; all passed"
    frontend: "npm run build passed"
    failing: []
  minecontext:
    status: "adapter exists; live availability not checked"
    query_at_time: "implemented via PowerShell godview script wrapper"
    keyword_search: "implemented via PowerShell godview script wrapper and alias matching"
    import: "implemented through read-only SQLite activity export"
    evidence_boundary: "present in normalized results and summaries"
  butler_core:
    unified_timeline: "implemented and tested"
    metrics: "implemented and tested"
    insights: "implemented and tested"
    inbox: "implemented; dedicated evidence endpoint missing"
    feedback: "implemented and tested"
    briefing: "implemented and tested"
  privacy:
    strict_mode: "implemented as settings/plugin/module guards"
    no_external_model: "tested in Butler/PC paths"
    no_screenshot_copy: "default false and tested in dry-run paths"
  next_best_tasks:
    - "Restore/initialize Git metadata"
    - "Run real MineContext 7-day dry-run preview and record evidence"
    - "Align dedicated insight evidence detail API or docs"
  warnings_for_future_prompts:
    - "Use backend/frontend/api paths, not apps/api/apps/web"
    - "Do not assume top-level plugins YAML are runtime-loaded"
    - "Do not assume MineContext HTTP API exists"
    - "Do not assume a central PrivacyGuard class exists"
    - "Treat task_queue done status as documentation until verified by code/tests"
```
