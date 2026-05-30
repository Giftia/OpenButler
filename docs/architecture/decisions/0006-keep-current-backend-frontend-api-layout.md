# ADR 0006: Keep Current Backend / Frontend / API Layout

## Status

Accepted

## Context

Older prompts and planning documents repeatedly assumed an `apps/api` and `apps/web` layout. The actual repository uses:

```text
backend/
frontend/
api/
```

The existing implementation, tests, Docker files, Vercel adapter, and documentation already depend on this layout.

## Decision

Keep the current `backend/`, `frontend/`, and `api/` layout for the near term. Do not migrate to `apps/api` or `apps/web` as part of ordinary feature development.

## Rationale

- The current code and tests are already organized around this layout.
- Directory migration would create churn unrelated to product behavior.
- The current highest risk is prompt/document drift, not directory naming.
- A stable Git baseline and accurate architecture documents are more valuable than a cosmetic layout migration.

## Consequences

- All future prompts, tasks, and docs must reference `backend/`, `frontend/`, and `api/`.
- References to `apps/api` or `apps/web` should be treated as stale unless a dedicated migration has been accepted.
- Code changes should not move directories during unrelated work.

## Future

If a monorepo migration becomes valuable later, open a dedicated migration RFC with tests, rollback strategy, and path-mapping plan.
