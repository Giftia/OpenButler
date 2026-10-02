"""Authenticated by the application session middleware; never mounted publicly."""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Response

from .audit import PrivacyAuditLedger, RETENTION_DAYS
from .capture import CaptureSettings, CaptureStore, MaskedObservation
from .foundation import ContextEngineStatusService
from .daily_review import DailyReviewRequest, DailyReviewService
from .processor import ObservationProcessor


def create_context_engine_router(connection_factory, privacy_mode_getter, data_dir: Path,
                                 model_gateway=None, model_authorization=None) -> APIRouter:
    router = APIRouter()
    ledger = PrivacyAuditLedger(connection_factory)
    captures = CaptureStore(connection_factory, data_dir, privacy_mode_getter)
    processor = (ObservationProcessor(captures, model_gateway, model_authorization)
                 if model_gateway is not None and model_authorization is not None else None)

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
            "recording": captures.state(),
        }

    @router.post("/api/context-engine/capture/configure")
    def configure_capture(settings: CaptureSettings):
        try:
            captures.configure(settings)
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from None
        return {"configured": True, "active": False}

    @router.post("/api/context-engine/capture/start")
    def start_capture():
        try:
            captures.start()
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from None
        return captures.state()

    @router.post("/api/context-engine/capture/pause")
    def pause_capture():
        captures.pause()
        return captures.state()

    @router.post("/api/context-engine/capture/revoke")
    def revoke_capture():
        captures.revoke()
        return captures.state()

    @router.post("/api/context-engine/observations")
    def ingest_observation(observation: MaskedObservation):
        try:
            result = captures.ingest(observation)
            if result["recorded"] and processor is not None:
                raw = captures._validate_png(observation.masked_png_base64)
                result["organized"] = processor.process(result["id"], raw)
            return result
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from None
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None

    @router.get("/api/context-engine/observations")
    def observations(limit: int = Query(default=100, ge=1, le=200)):
        records = captures.list_records(limit)
        return {"count": len(records), "items": records}

    @router.post("/api/context-engine/observations/{event_id}/retry")
    def retry_observation(event_id: str):
        if processor is None or not model_gateway.status().ready:
            return {"ok": False, "reason": "model_unavailable"}
        image = captures.prepare_retry(event_id)
        if image is None:
            return {"ok": False, "reason": "record_or_evidence_unavailable"}
        return {"ok": processor.process(event_id, image)}

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
