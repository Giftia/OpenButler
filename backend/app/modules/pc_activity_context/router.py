from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from .schemas import ImportRequest, PCActivitySettings, QueryAtTimeRequest, SearchRequest
from .service import PCActivityContextService

router = APIRouter(prefix="/api/pc-activity", tags=["pc-activity"])

_service: PCActivityContextService | None = None


def configure_pc_activity_context(db_path: Path | str, runtime_dir: Path | str) -> None:
    global _service
    _service = PCActivityContextService(db_path, runtime_dir)


def service() -> PCActivityContextService:
    if _service is None:
        raise HTTPException(status_code=500, detail="PC activity context service is not configured.")
    return _service


@router.get("/minecontext/status")
def minecontext_status() -> dict[str, Any]:
    return service().status()


@router.post("/minecontext/query-at-time")
def query_at_time(payload: QueryAtTimeRequest) -> dict[str, Any]:
    return service().query_at_time(payload.when, payload.window_minutes, payload.include_raw_output)


@router.post("/minecontext/search")
def search(payload: SearchRequest) -> dict[str, Any]:
    return service().search(payload.query, payload.limit, payload.include_raw_output)


@router.post("/minecontext/import")
def import_activities(payload: ImportRequest) -> dict[str, Any]:
    now = datetime.now()
    start = datetime.fromisoformat(payload.start_time) if payload.start_time else now - timedelta(hours=payload.lookback_hours)
    end = datetime.fromisoformat(payload.end_time) if payload.end_time else now
    return service().import_activities(start, end, payload.limit)


@router.get("/events")
def events() -> dict[str, Any]:
    items = service().events()
    return {"items": items, "count": len(items)}


@router.get("/summary/today")
def summary_today() -> dict[str, Any]:
    return service().summary()


@router.get("/summary")
def summary() -> dict[str, Any]:
    return service().summary()


@router.get("/focus-blocks")
def focus_blocks() -> dict[str, Any]:
    summary_data = service().summary()
    return {"items": summary_data["focus_blocks"], "count": len(summary_data["focus_blocks"])}


@router.get("/app-usage")
def app_usage() -> dict[str, Any]:
    return service().summary()["app_usage"]


@router.get("/domain-usage")
def domain_usage() -> dict[str, Any]:
    return service().summary()["domain_usage"]


@router.get("/workflow-candidates")
def workflow_candidates() -> dict[str, Any]:
    items = service().summary()["workflow_candidates"]
    return {"items": items, "count": len(items)}


@router.get("/evidence/{event_id}")
def evidence(event_id: str) -> dict[str, Any]:
    item = service().get_event(event_id)
    if not item:
        raise HTTPException(status_code=404, detail="PC activity event not found.")
    return {
        "event_id": event_id,
        "evidence_level": item["evidence_level"],
        "screenshot_paths": item["screenshot_paths"],
        "evidence": item["evidence"],
        "evidence_boundary": "默认只保存 MineContext 截图路径，不复制截图内容。",
    }


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return service().get_settings().model_dump()


@router.post("/settings")
def update_settings(payload: PCActivitySettings) -> dict[str, Any]:
    return service().update_settings(payload.model_dump()).model_dump()


@router.delete("/events")
def delete_events() -> dict[str, Any]:
    return service().clear_events()


@router.get("/context-recovery-pack")
def context_recovery_pack(lookback_hours: int = 24) -> dict[str, Any]:
    return service().context_recovery_pack(lookback_hours)
