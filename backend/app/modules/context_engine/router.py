"""Authenticated by the application session middleware; never mounted publicly."""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict
from typing import Literal

from .audit import PrivacyAuditLedger, RETENTION_DAYS
from .capture import CaptureSettings, CaptureStore, MaskedObservation
from .foundation import ContextEngineStatusService
from .daily_review import DailyReviewRequest, DailyReviewService
from .processor import ObservationProcessor
from .organization_queue import ObservationQueue


class CapturePauseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Literal["user_paused", "session_expired", "source_unavailable", "capture_error", "configuration_changed", "shutdown"] = "user_paused"


def create_context_engine_router(connection_factory, privacy_mode_getter, data_dir: Path,
                                 model_gateway=None, model_authorization=None) -> APIRouter:
    router = APIRouter()
    ledger = PrivacyAuditLedger(connection_factory)
    captures = CaptureStore(connection_factory, data_dir, privacy_mode_getter)
    processor = (ObservationProcessor(captures, model_gateway, model_authorization)
                 if model_gateway is not None and model_authorization is not None else None)

    queue = ObservationQueue(captures, processor) if processor is not None else None
    router.organization_queue = queue

    @router.on_event("shutdown")
    def shutdown_organization():
        captures.pause("shutdown")
        if queue is not None and not queue.close():
            raise RuntimeError("observation_worker_shutdown_timeout")

    def recording_state():
        result = captures.state()
        result["processing_queue"] = queue.state() if queue is not None else {
            "capacity": 0, "queued": 0, "running": 0, "backpressured": 0, "accepting": False}
        return result

    reviews = DailyReviewService(captures, model_gateway, model_authorization)

    @router.post("/api/context-engine/daily-review")
    def daily_review(request: DailyReviewRequest, response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        try:
            return reviews.generate(request)
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid_review_day") from None

    @router.get("/api/context-engine/status")
    def status():
        return {
            **ContextEngineStatusService().get_redacted_status().model_dump(),
            "privacy_mode": "strict" if privacy_mode_getter() == "strict" else "basic",
            "capture_available": True,
            "model_routes_available": bool(model_gateway),
            "audit_retention_days": RETENTION_DAYS,
            "recording": recording_state(),
        }

    @router.post("/api/context-engine/capture/configure")
    def configure_capture(settings: CaptureSettings):
        try:
            result = captures.configure(settings)
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from None
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
        return result

    @router.post("/api/context-engine/capture/start")
    def start_capture():
        try:
            captures.start()
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from None
        return recording_state()

    @router.post("/api/context-engine/capture/pause")
    def pause_capture(request: CapturePauseRequest = CapturePauseRequest()):
        captures.pause(request.reason)
        return recording_state()

    @router.post("/api/context-engine/capture/revoke")
    def revoke_capture():
        captures.revoke()
        return recording_state()

    @router.post("/api/context-engine/observations")
    def ingest_observation(observation: MaskedObservation):
        try:
            result = captures.ingest(observation)
            generation = result.pop("_generation", None)
            if result["recorded"]:
                result["organized"] = False
                result["organization"] = (queue.submit(result["id"], generation=generation)
                    if queue is not None else {"accepted": False, "reason": "model_unavailable"})
                if queue is None:
                    captures.set_result(result["id"], state="model_unavailable", processing_reason="model_unavailable")
            return result
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from None
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None

    @router.get("/api/context-engine/observations")
    def observations(limit: int = Query(default=100, ge=1, le=200)):
        records = captures.list_records(limit)
        return {"count": len(records), "items": records, "coverage_events": captures.list_coverage_events(limit)}

    @router.post("/api/context-engine/observations/{event_id}/retry")
    def retry_observation(event_id: str):
        if queue is None:
            return {"ok": False, "queued": False, "reason": "model_unavailable"}
        result = queue.submit(event_id, retry=True)
        return {"ok": result["accepted"], "queued": result["accepted"], "reason": result["reason"]}

    @router.post("/api/context-engine/observations/{event_id}/delete")
    def delete_observation(event_id: str):
        try:
            return {"deleted": captures.delete_owned(event_id)}
        except PermissionError:
            raise HTTPException(status_code=403, detail="owned_media_path_unsafe") from None

    @router.post("/api/context-engine/retention/run")
    def run_retention():
        try:
            count = captures.expire_owned()
        except PermissionError:
            raise HTTPException(status_code=403, detail="retention_not_authorized") from None
        return {"expired_owned_records": count}

    @router.get("/api/context-engine/evidence/{evidence_id}")
    def evidence(evidence_id: str):
        image = captures.evidence(evidence_id)
        if image is None:
            raise HTTPException(status_code=404, detail="evidence_expired_or_unavailable")
        return Response(image, media_type="image/png", headers={"Cache-Control": "private, no-store"})

    @router.get("/api/privacy/activity")
    def activity(limit: int = Query(default=50, ge=1, le=100)):
        try:
            entries = ledger.recent(limit)
        except Exception:
            raise HTTPException(status_code=503, detail="privacy_audit_unavailable") from None
        return {"entries": [item.model_dump(mode="json") for item in entries],
                "count": len(entries), "retention_days": RETENTION_DAYS}

    return router
