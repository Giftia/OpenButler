# Vision Privacy Policy

OpenButler Vision is opt-in and local-first. It is designed for personal and family self-management, not hidden monitoring, employee surveillance, school surveillance, public-space monitoring, or non-consensual use.

## What Is Collected

- USB camera availability and selected camera id from the local `camera-eye` skill.
- Local visual metadata such as presence, posture estimate, object labels, lighting proxy, confidence, and timestamps.
- Derived vision events such as `presence_state`, `posture_state`, `attention_heatmap`, `fatigue_signal`, and `observable_work_state`.
- Aggregated metrics such as actual present time, away time, posture distribution, attention ratios, and fatigue-signal counts.

## What Is Not Collected By Default

- Raw camera frames are not saved by default.
- Video streams are not persisted by default.
- Face identity recognition is not performed.
- Medical diagnosis, psychological diagnosis, personality judgment, intelligence judgment, or emotion-disorder inference is not performed.
- External cloud model calls, external APIs, and external webhooks are not used in strict mode.

## Default Retention

- Raw frames: captured by `camera-eye`, analyzed locally, then deleted by OpenButler when `save_raw_frames=false`.
- Derived events: retained as structured local data.
- Evidence: stores local metadata summaries, confidence, method, and reason codes.

## How To Turn It Off

- Use the Web page `视觉感知` and click `停止分析`.
- Disable `视觉感知开关` in the privacy panel.
- API: `POST /api/vision/session/stop`.

## How To Delete Data

- API:
  - `DELETE /api/vision/data/today`
  - `DELETE /api/vision/data`

## How To Export Data

- API: `GET /api/vision/export`.
- Export contains structured events and summaries, not raw frames unless raw-frame saving was explicitly enabled.

## Strict Mode Behavior

- Requires local-only processing.
- Blocks cloud models, cloud APIs, external network model calls, and external webhooks.
- Forces `save_raw_frames = false`.
- Uses `strict_local` plugin manifests.

## Basic Mode Behavior

- The current MVP still uses local processing.
- Future cloud or webhook integrations must be explicit, permissioned, audited, and visible in the UI.

## Model Boundary

The module reuses the global `camera-eye` skill. It does not implement camera drivers and does not upload frames. Local Pillow heuristics are used for MVP visual metadata.

## Multi-User Boundary

Each session has `user_id` and optional `household_id`. Camera analysis must only be enabled by an authorized user. If multiple people are visible or confidence is low, the module should lower confidence or return `unknown` rather than forcing personal state attribution.

