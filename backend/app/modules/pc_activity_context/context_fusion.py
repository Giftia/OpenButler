from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from .service import PCActivityContextService


class ContextFusionService:
    def __init__(self, db_path: Path | str, runtime_dir: Path | str) -> None:
        self.pc_activity = PCActivityContextService(db_path, runtime_dir)

    def get_unified_timeline(self, start_time: datetime, end_time: datetime, sources: list[str]) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        if "minecontext" in sources or "pc_activity" in sources:
            for event in self.pc_activity.events():
                if start_time.isoformat() <= event.get("started_at", "") <= end_time.isoformat():
                    events.append(
                        {
                            "source": "pc_activity",
                            "started_at": event["started_at"],
                            "ended_at": event.get("ended_at"),
                            "title": event.get("title") or event.get("activity_type"),
                            "summary": event.get("summary"),
                            "confidence": event.get("confidence", 0.5),
                            "evidence_level": event.get("evidence_level"),
                            "payload": event,
                        }
                    )
        return sorted(events, key=lambda item: item["started_at"])

    def correlate_pc_activity_with_workstation_presence(self, start_time: datetime, end_time: datetime) -> list[dict[str, Any]]:
        return [
            {
                "type": "pc_activity_presence_correlation_placeholder",
                "time_range": {"start": start_time.isoformat(), "end": end_time.isoformat()},
                "summary": "预留接口：用于关联 PC 活动与视觉感知在场/离座状态。",
                "confidence": 0.0,
            }
        ]

    def generate_context_recovery_pack(self, lookback_hours: int = 24) -> dict[str, Any]:
        return self.pc_activity.context_recovery_pack(lookback_hours)
