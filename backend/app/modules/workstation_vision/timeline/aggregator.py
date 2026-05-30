from __future__ import annotations

from datetime import datetime
from typing import Any


def seconds_between(start: str, end: str | None = None) -> int:
    start_dt = datetime.fromisoformat(start)
    end_dt = datetime.fromisoformat(end) if end else datetime.now(start_dt.tzinfo)
    return max(0, int((end_dt - start_dt).total_seconds()))


def aggregate_today(events: list[dict[str, Any]]) -> dict[str, Any]:
    total_present = 0
    total_away = 0
    sitting = 0
    standing = 0
    low_confidence = 0
    longest_presence = 0
    longest_focus = 0
    break_count = 0
    fatigue_count = 0
    posture_warnings = 0
    attention_totals = {
        "screen_focus_ratio": 0.0,
        "desk_focus_ratio": 0.0,
        "phone_focus_ratio": 0.0,
        "off_screen_ratio": 0.0,
        "unknown_ratio": 0.0,
    }
    attention_samples = 0
    work_state_distribution: dict[str, int] = {}
    first_seen_at: str | None = None
    last_seen_at: str | None = None

    for event in events:
        duration = int(event.get("duration_seconds") or 0)
        event_type = event.get("type")
        state = event.get("state")
        confidence = float(event.get("confidence") or 0)
        if confidence < 0.5:
            low_confidence += duration
        if event_type == "presence_state":
            if state == "present":
                total_present += duration
                longest_presence = max(longest_presence, duration)
                first_seen_at = first_seen_at or event.get("started_at")
                last_seen_at = event.get("ended_at") or event.get("started_at")
            elif state == "away":
                total_away += duration
                break_count += 1
        elif event_type == "posture_state":
            if state == "sitting":
                sitting += duration
            elif state == "standing":
                standing += duration
            if "looking_down" in event.get("reason_codes", []):
                posture_warnings += 1
        elif event_type == "attention_heatmap":
            metrics = event.get("metrics", {})
            for key in attention_totals:
                attention_totals[key] += float(metrics.get(key, 0))
            attention_samples += 1
            if float(metrics.get("screen_focus_ratio", 0)) >= 0.6:
                longest_focus = max(longest_focus, duration)
        elif event_type == "fatigue_signal" and state in {"medium", "high"}:
            fatigue_count += 1
        elif event_type == "observable_work_state":
            work_state_distribution[state or "unknown"] = work_state_distribution.get(state or "unknown", 0) + duration

    if attention_samples:
        attention_metrics = {
            key: round(value / attention_samples, 3)
            for key, value in attention_totals.items()
        }
    else:
        attention_metrics = attention_totals

    return {
        "total_present_seconds": total_present,
        "total_away_seconds": total_away,
        "total_sitting_seconds": sitting,
        "total_standing_seconds": standing,
        "total_low_confidence_seconds": low_confidence,
        "longest_presence_seconds": longest_presence,
        "longest_focus_seconds": longest_focus,
        "break_count": break_count,
        "deep_work_blocks": 1 if longest_focus >= 25 * 60 else 0,
        "fatigue_signal_count": fatigue_count,
        "posture_warning_count": posture_warnings,
        "attention_metrics": attention_metrics,
        "work_state_distribution": work_state_distribution,
        "first_seen_at": first_seen_at,
        "last_seen_at": last_seen_at,
    }

