# OpenButler Vision

OpenButler Vision adds local-first USB camera sensing by reusing the global `camera-eye` skill from `C:\Users\admin\.codex\skills\camera-eye`. It is no longer limited to a workstation-only concept: the MVP provides local visual status, presence, posture, attention-zone estimates, lighting context, and non-medical fatigue suggestions.

## Camera Eye Adapter

`backend/app/integrations/local_eyes_adapter.py` calls:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\admin\.codex\skills\camera-eye\scripts\camera_eye.ps1
```

The adapter maps `camera-eye` list/capture output into OpenButler visual metadata. Captured images are analyzed locally with Pillow heuristics and deleted immediately when `save_raw_frames=false`.

## APIs

Primary API:

- `GET /api/vision/cameras`
- `POST /api/vision/session/start`
- `POST /api/vision/session/stop`
- `GET /api/vision/status`
- `GET /api/vision/events`
- `GET /api/vision/summary/today`
- `GET /api/vision/summary`
- `GET /api/vision/attention-heatmap`
- `GET /api/vision/posture`
- `GET /api/vision/fatigue`
- `POST /api/vision/settings`
- `GET /api/vision/settings`
- `DELETE /api/vision/data/today`
- `DELETE /api/vision/data`
- `GET /api/vision/export`

Compatibility API remains available under `/api/workstation-vision/*`.

## Mock Mode

Mock mode is disabled by default. To force mock mode:

```powershell
$env:OPENBUTLER_VISION_MOCK=1
```

## Safety Language

The module uses terms such as "possibly tired", "observable work state", and "based on observable clues". It must not output medical diagnosis, psychological diagnosis, personality judgment, or hidden-monitoring functionality.

## MVP Limits

- No medical-grade fatigue detection.
- No precise eye tracking.
- No face identity recognition.
- No emotion recognition.
- No employee performance monitoring.
- No remote cloud camera monitoring.

