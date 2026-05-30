from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from .schemas import StartSessionRequest, StopSessionRequest, WorkstationVisionSettings
from .service import WorkstationVisionService

router = APIRouter(prefix="/api/workstation-vision", tags=["workstation-vision"])
vision_router = APIRouter(prefix="/api/vision", tags=["vision"])

_service: WorkstationVisionService | None = None


def configure_workstation_vision(db_path: Path | str) -> None:
    global _service
    _service = WorkstationVisionService(db_path)


def service() -> WorkstationVisionService:
    if _service is None:
        raise HTTPException(status_code=500, detail="Workstation vision service is not configured.")
    return _service


@router.get("/cameras")
def cameras() -> dict[str, Any]:
    return service().list_cameras()


@vision_router.get("/cameras")
def vision_cameras() -> dict[str, Any]:
    return cameras()


@router.post("/session/start")
def start_session(payload: StartSessionRequest) -> dict[str, Any]:
    try:
        return service().start_session(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@vision_router.post("/session/start")
def vision_start_session(payload: StartSessionRequest) -> dict[str, Any]:
    return start_session(payload)


@router.post("/session/stop")
def stop_session(payload: StopSessionRequest = StopSessionRequest()) -> dict[str, Any]:
    return service().stop_session(payload.session_id)


@vision_router.post("/session/stop")
def vision_stop_session(payload: StopSessionRequest = StopSessionRequest()) -> dict[str, Any]:
    return stop_session(payload)


@router.get("/status")
def status() -> dict[str, Any]:
    return service().status()


@vision_router.get("/status")
def vision_status() -> dict[str, Any]:
    return status()


@router.get("/events")
def events(event_type: str | None = None) -> dict[str, Any]:
    items = service().events(event_type)
    return {"items": items, "count": len(items)}


@vision_router.get("/events")
def vision_events(event_type: str | None = None) -> dict[str, Any]:
    return events(event_type)


@router.get("/summary/today")
def summary_today() -> dict[str, Any]:
    return service().today_summary()


@vision_router.get("/summary/today")
def vision_summary_today() -> dict[str, Any]:
    return summary_today()


@router.get("/summary")
def summary() -> dict[str, Any]:
    return service().today_summary()


@vision_router.get("/summary")
def vision_summary() -> dict[str, Any]:
    return summary()


@router.get("/attention-heatmap")
def attention_heatmap() -> dict[str, Any]:
    return service().today_summary().get("attention_metrics", {})


@vision_router.get("/attention-heatmap")
def vision_attention_heatmap() -> dict[str, Any]:
    return attention_heatmap()


@router.get("/posture")
def posture() -> dict[str, Any]:
    items = service().events("posture_state")
    return {"items": items, "count": len(items)}


@vision_router.get("/posture")
def vision_posture() -> dict[str, Any]:
    return posture()


@router.get("/fatigue")
def fatigue() -> dict[str, Any]:
    items = service().events("fatigue_signal")
    return {"items": items, "count": len(items)}


@vision_router.get("/fatigue")
def vision_fatigue() -> dict[str, Any]:
    return fatigue()


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return service().get_settings().model_dump()


@vision_router.get("/settings")
def vision_get_settings() -> dict[str, Any]:
    return get_settings()


@router.post("/settings")
def update_settings(payload: WorkstationVisionSettings) -> dict[str, Any]:
    return service().update_settings(payload.model_dump()).model_dump()


@vision_router.post("/settings")
def vision_update_settings(payload: WorkstationVisionSettings) -> dict[str, Any]:
    return update_settings(payload)


@router.delete("/data/today")
def delete_today_data() -> dict[str, Any]:
    return service().clear_events(today_only=True)


@vision_router.delete("/data/today")
def vision_delete_today_data() -> dict[str, Any]:
    return delete_today_data()


@router.delete("/data")
def delete_all_data() -> dict[str, Any]:
    return service().clear_events(today_only=False)


@vision_router.delete("/data")
def vision_delete_all_data() -> dict[str, Any]:
    return delete_all_data()


@router.get("/export")
def export_data() -> dict[str, Any]:
    return service().export_events()


@vision_router.get("/export")
def vision_export_data() -> dict[str, Any]:
    return export_data()
