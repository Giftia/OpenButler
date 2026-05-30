# Plugins Directory

This directory is reserved for a future three-stage plugin marketplace or external plugin package layout.

Current runtime truth:

```text
backend/app/plugins/*.json
```

The backend loads plugin manifests from `backend/app/plugins/*.json` in `backend/app/main.py`. `GET /api/plugins` returns those manifests and evaluates strict-mode availability.

Do not treat this top-level `plugins/` directory as the current runtime plugin source. Do not add current production manifests here unless the backend loader is changed and tested.
