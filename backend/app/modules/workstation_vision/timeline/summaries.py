from __future__ import annotations

from datetime import date
from typing import Any

from .aggregator import aggregate_today


def build_summary(events: list[dict[str, Any]], target_date: date | None = None) -> dict[str, Any]:
    metrics = aggregate_today(events)
    return {
        "type": "workstation_time_summary",
        "date": (target_date or date.today()).isoformat(),
        "metrics": {
            "total_present_minutes": round(metrics["total_present_seconds"] / 60),
            "total_away_minutes": round(metrics["total_away_seconds"] / 60),
            "longest_presence_minutes": round(metrics["longest_presence_seconds"] / 60),
            "longest_focus_minutes": round(metrics["longest_focus_seconds"] / 60),
            "deep_work_blocks": metrics["deep_work_blocks"],
            "break_count": metrics["break_count"],
            "fatigue_signal_count": metrics["fatigue_signal_count"],
            "posture_warning_count": metrics["posture_warning_count"],
        },
        "attention_metrics": metrics["attention_metrics"],
        "work_state_distribution": metrics["work_state_distribution"],
        "total_sitting_seconds": metrics["total_sitting_seconds"],
        "total_standing_seconds": metrics["total_standing_seconds"],
        "first_seen_at": metrics["first_seen_at"],
        "last_seen_at": metrics["last_seen_at"],
    }
