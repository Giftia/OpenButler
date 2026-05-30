# Active Objective Evidence Mappers

This document is the development template for mapping `.openbutler/goals.yaml` active objectives to Productization Harness evidence.

## Purpose

`GET /api/butler/productization/objectives/status` must never silently ignore a declared active objective. Every active objective must either:

- map to local evidence and return `proven`, or
- return `needs_attention` with `evidence_mapper_missing`.

The mapper is an evidence map for local OpenButler productization state. It is not proof of remote repositories, CI, Yunxiao, deployments, online services, or MineContext source truth.

## Add A New Objective Mapper

1. Add the objective to `.openbutler/goals.yaml` under `active_objectives`.
2. Add an entry in `criteria_by_objective` inside `backend/app/modules/butler_core/service.py`.
3. For each declared success criterion, add one or more local criteria using the local `criterion(...)` helper.
4. Each criterion must include stable `id`, human-readable `title`, `passed` condition, `evidence_refs`, optional structured `details`, and the standard evidence boundary.
5. Prefer local APIs, local repository files, local script outputs, and local artifacts as evidence.
6. Add or update tests in `backend/app/modules/butler_core/tests/test_butler_api_contract.py`.
7. Update docs if the mapper adds a new API, UI, artifact, privacy behavior, or verification command.
8. Run Productization Harness checks before marking the task done.

## Criterion Template

```python
criterion(
    "stable_snake_case_id",
    "Human-readable criterion title",
    local_condition_is_true,
    [
        {"kind": "api", "path": "GET /api/..."},
        {"kind": "file", "path": "docs/..."},
    ],
    {"structured": "local evidence details"},
)
```

Allowed `evidence_refs.kind` values should stay local and reviewable:

- `api`
- `file`
- `route`
- `script`
- `artifact`

## Required Privacy Invariants

Every mapper must preserve:

- `external_model_used: false`
- `external_model_allowed: false` for strict-mode core checks
- `minecontext_source_deleted: 0`
- `copied_screenshots: 0` unless a future explicit user-approved flow says otherwise
- no external webhook requirement
- no external write execution
- no MineContext source mutation

## Evidence Boundary

Every criterion and every objective response must keep an evidence boundary. Use local evidence wording:

```text
Objective status is derived from local OpenButler APIs, local repository files, and Productization Harness checks. It does not inspect or mutate MineContext source data and does not verify remote repositories, CI, Yunxiao, deployments, or online services.
```

Do not use objective mappers to claim:

- a remote deployment succeeded,
- a remote repository state changed,
- a Yunxiao/Jira task is complete,
- a cloud service is healthy,
- MineContext generated summaries are final facts.

## Missing Mapper Behavior

If an objective is declared before a mapper exists, keep the default behavior:

```text
status: needs_attention
criterion id: evidence_mapper_missing
```

The missing-mapper criterion must include:

- `.openbutler/goals.yaml` as the declared source,
- this template document as the implementation guide,
- `template_schema_version: active_objective_evidence_mapper_template_v1`,
- required steps for implementing the mapper.

This makes new product goals visible without pretending they are proven.

## Required Tests

At minimum, tests must verify:

- known objectives return `proven` when evidence is present,
- unknown objectives return `needs_attention`,
- `evidence_mapper_missing` is visible for unknown objectives,
- the response includes `evidence_mapper_template`,
- the template includes required steps, criterion contract, and privacy invariants,
- every criterion includes `evidence_refs` and `evidence_boundary`,
- strict privacy counters remain safe,
- MineContext source deletion remains `0`.

## Verification Commands

```powershell
$env:PYTHONPATH="C:\Users\admin\Desktop\git\OpenButler\backend"
python -m unittest backend.app.modules.butler_core.tests.test_butler_api_contract
python -m unittest discover -s backend\app\modules
python -m compileall -q backend\app

cd frontend
npm run verify:productization
```
