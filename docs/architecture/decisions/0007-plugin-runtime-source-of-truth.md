# ADR 0007: Plugin Runtime Source of Truth

## Status

Accepted

## Context

The repository contains both:

```text
plugins/
backend/app/plugins/*.json
```

Earlier plans described top-level `plugins/preprocess`, `plugins/timeline`, and `plugins/tools` as the plugin system. Current code does not load those directories. The backend loads JSON manifests from `backend/app/plugins/*.json`.

## Decision

For the current productization stage, `backend/app/plugins/*.json` is the runtime source of truth for plugin manifests.

The top-level `plugins/` directory is reserved for a future external plugin/package layout and must not be treated as runtime-loaded.

## Consequences

- `/api/plugins` reflects `backend/app/plugins/*.json`.
- New current-runtime plugin manifests should go under `backend/app/plugins/`.
- Docs and task prompts must not claim top-level `plugins/` is currently executable or loaded.
- Top-level `plugins/README.md` should explain the reserved status.

## Future

A future plugin marketplace task should define a formal package format, manifest schema, loader, permission enforcement, migration path, and compatibility tests.
