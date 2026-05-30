# Codex Workflow

When Codex works on OpenButler:

1. Read `AGENTS.md`.
2. Read the relevant docs under `docs/`.
3. Check `.openbutler/goals.yaml` and `.openbutler/task_queue.yaml`.
4. If a new active objective is involved, read `docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md`.
5. Inspect the current code before editing.
6. Make a small plan for non-trivial work.
7. Implement in small scoped changes.
8. Add or update tests when behavior changes.
9. Run the smallest relevant checks, then broader checks when risk is higher.
10. Self-review for privacy boundaries, evidence boundaries, and strict mode.
11. For Productization Harness changes, run `npm run verify:productization` against a local backend.
12. Output a clear change summary, tests run, known risks, and next steps.

## Rules

- Do not auto-merge.
- Do not auto-deploy.
- Do not delete MineContext source data.
- Do not rewrite completed MineContext/godview integration without a concrete bug.
- Do not add new hardware integrations in the current stage.
- Do not call external models in strict mode.
- Do not answer recent-activity questions from chat memory when a tool/API exists.

## Good Task Shape

Each task should identify:

- goal id,
- product user value,
- files likely touched,
- data/privacy risk,
- tests required,
- demo route or API to verify.
