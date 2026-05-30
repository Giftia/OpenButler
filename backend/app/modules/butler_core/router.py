from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from .schemas import (
    BriefingGenerateRequest,
    DemoRunRequest,
    GenerateInsightsRequest,
    GoalPatchRequest,
    GoalRequest,
    InsightFeedbackRequest,
    PCActivityImportPreviewRequest,
    ProactiveButlerSettings,
    SnoozeRequest,
)
from .service import ButlerCoreService

router = APIRouter(prefix="/api/butler", tags=["butler"])

_service: ButlerCoreService | None = None


def configure_butler_core(db_path: Path | str, runtime_dir: Path | str) -> None:
    global _service
    _service = ButlerCoreService(db_path, runtime_dir)


def service() -> ButlerCoreService:
    if _service is None:
        raise HTTPException(status_code=500, detail="Butler core service is not configured.")
    return _service


@router.get("/home")
def home() -> dict[str, Any]:
    return service().home()


@router.get("/readiness")
def readiness() -> dict[str, Any]:
    return service().readiness()


@router.get("/mvp-report")
def mvp_report() -> dict[str, Any]:
    return service().mvp_report()


@router.get("/demo/data-insufficient-drill")
def data_insufficient_drill() -> dict[str, Any]:
    return service().data_insufficient_drill()


@router.get("/harness/runs/latest")
def latest_harness_runs() -> dict[str, Any]:
    return service().latest_harness_runs()


@router.get("/productization/objectives/status")
def productization_objective_status() -> dict[str, Any]:
    return service().productization_objective_status()


@router.get("/productization/l1-audit")
def productization_l1_audit_report() -> dict[str, Any]:
    return service().productization_l1_audit_report()


@router.get("/productization/demo-pack")
def productization_demo_pack() -> dict[str, Any]:
    return service().productization_demo_pack()


@router.post("/demo/run")
def run_demo(payload: DemoRunRequest = DemoRunRequest()) -> dict[str, Any]:
    return service().run_demo_path(
        import_pc_activity=payload.import_pc_activity,
        lookback_hours=payload.lookback_hours,
        limit=payload.limit,
        briefing_type=payload.briefing_type,
    )


@router.post("/demo/reset")
def reset_demo() -> dict[str, Any]:
    return service().reset_demo_path()


@router.post("/import/pc-activity/preview")
def preview_pc_activity_import(payload: PCActivityImportPreviewRequest = PCActivityImportPreviewRequest()) -> dict[str, Any]:
    return service().preview_pc_activity_import(
        lookback_days=payload.lookback_days,
        dry_run=payload.dry_run,
        include_screenshot_paths=payload.include_screenshot_paths,
        copy_screenshots=payload.copy_screenshots,
        limit=payload.limit,
    )


@router.get("/timeline")
def timeline(
    start_time: str | None = None,
    end_time: str | None = None,
    source: str | None = None,
    event_type: str | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
) -> dict[str, Any]:
    items = service().timeline(start_time, end_time, source, event_type, limit)
    return {"items": items, "count": len(items)}


@router.post("/timeline/rebuild")
def rebuild_timeline() -> dict[str, Any]:
    return service().rebuild_timeline()


@router.get("/metrics/today")
def metrics_today() -> dict[str, Any]:
    return service().metrics_today()


@router.get("/metrics")
def metrics(start_date: str | None = None, end_date: str | None = None, days: int = Query(default=7, ge=1, le=31)) -> dict[str, Any]:
    return service().metrics_range(start_date, end_date, days)


@router.get("/insights")
def insights(status: str | None = None, type: str | None = None, priority: int | None = None) -> dict[str, Any]:
    items = service().insights(status, type, priority)
    return {"items": items, "count": len(items)}


@router.get("/insights/noise-evaluation")
def insight_noise_evaluation() -> dict[str, Any]:
    return service().insight_noise_evaluation()


@router.post("/insights/generate")
def generate_insights(payload: GenerateInsightsRequest = GenerateInsightsRequest()) -> dict[str, Any]:
    return service().generate_insights(payload.force)


@router.post("/insights/{insight_id}/feedback")
def feedback(insight_id: str, payload: InsightFeedbackRequest) -> dict[str, Any]:
    try:
        return service().submit_feedback(insight_id, payload.feedback_type, payload.comment)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Insight not found.") from exc


@router.post("/insights/{insight_id}/dismiss")
def dismiss(insight_id: str) -> dict[str, Any]:
    try:
        return service().dismiss_insight(insight_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Insight not found.") from exc


@router.post("/insights/{insight_id}/snooze")
def snooze(insight_id: str, payload: SnoozeRequest = SnoozeRequest()) -> dict[str, Any]:
    try:
        return service().snooze_insight(insight_id, payload.minutes)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Insight not found.") from exc


@router.get("/briefings/today")
def briefings_today() -> dict[str, Any]:
    return service().today_briefings()


@router.post("/briefings/generate")
def generate_briefing(payload: BriefingGenerateRequest) -> dict[str, Any]:
    return service().generate_briefing(payload.type)


@router.get("/goals")
def goals() -> dict[str, Any]:
    items = service().goals()
    return {"items": items, "count": len(items)}


@router.post("/goals")
def create_goal(payload: GoalRequest) -> dict[str, Any]:
    return service().create_goal(payload.model_dump())


@router.patch("/goals/{goal_id}")
def update_goal(goal_id: str, payload: GoalPatchRequest) -> dict[str, Any]:
    item = service().update_goal(goal_id, payload.model_dump())
    if not item:
        raise HTTPException(status_code=404, detail="Goal not found.")
    return item


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: str) -> dict[str, Any]:
    return service().delete_goal(goal_id)


@router.get("/context-recovery")
def context_recovery(lookback_hours: int = Query(default=24, ge=1, le=24 * 14)) -> dict[str, Any]:
    return service().context_recovery(lookback_hours)


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return service().get_settings().model_dump()


@router.post("/settings")
def update_settings(payload: ProactiveButlerSettings) -> dict[str, Any]:
    return service().update_settings(payload.model_dump())


@router.get("/export")
def export_data() -> dict[str, Any]:
    return service().export_data()


@router.delete("/data")
def delete_data() -> dict[str, Any]:
    return service().clear_data()
