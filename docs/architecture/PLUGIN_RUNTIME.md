# Plugin Runtime

## Current Runtime Source of Truth

The current runtime plugin manifest source is:

```text
backend/app/plugins/*.json
```

`backend/app/main.py` sets:

```python
PLUGIN_DIR = BASE_DIR / "plugins"
```

Because `BASE_DIR` is `backend/app`, `/api/plugins` loads JSON manifests from `backend/app/plugins`.

## Top-Level `plugins/`

The top-level `plugins/` directory is currently a reserved placeholder for a future external plugin or marketplace layout. It is not loaded by the backend today.

Do not treat top-level `plugins/preprocess`, `plugins/timeline`, or `plugins/tools` as the current runtime source.

## What `/api/plugins` Does Today

`GET /api/plugins`:

1. Reads `backend/app/plugins/*.json`.
2. Adds a `manifest_path`.
3. Evaluates each manifest against the current privacy mode.
4. Returns `runtime.available` and `runtime.blocked_reasons`.

## Current Manifest Semantics

Manifests are JSON metadata. They describe:

- `id`
- `name`
- `stage`
- `version`
- `input_schema`
- `output_schema`
- `privacy_level`
- `model_requirements`
- `permissions`
- `prompt_template`

Some manifests include additional fields such as retention notes.

## Current Validation Reality

Current runtime checks:

- In `strict` mode, plugins with `privacy_level` outside `strict` or `strict_local` are blocked.
- In `strict` mode, plugins with `model_requirements.provider == "cloud"` are blocked.
- In `strict` mode, plugins requesting `external_network`, `cloud_api`, or `external_webhook` permissions are blocked.

Current runtime does not:

- execute plugin logic,
- run a schema validator over `input_schema` or `output_schema`,
- enforce permissions at a central plugin executor,
- load top-level plugin package directories,
- sandbox plugin code.

## Future Plugin Marketplace Migration

A future plugin marketplace should be a separate architecture task. It should define:

1. Canonical plugin package layout.
2. Whether top-level `plugins/` replaces or feeds `backend/app/plugins/`.
3. Manifest schema validation.
4. Runtime execution model.
5. Permission enforcement.
6. Privacy-mode policy.
7. Test fixtures and compatibility checks.
8. Migration path for existing `backend/app/plugins/*.json`.

Until that task exists, `backend/app/plugins/*.json` remains the runtime source of truth.
