from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from typing import Any


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def top_minutes(events: list[dict[str, Any]], entity_key: str) -> list[dict[str, Any]]:
    totals: Counter[str] = Counter()
    for event in events:
        name = (event.get("entities") or {}).get(entity_key)
        if name:
            totals[str(name)] += int(event.get("duration_seconds") or 0)
    return [{"name": name, "minutes": round(seconds / 60)} for name, seconds in totals.most_common(5)]


def count_context_switches(events: list[dict[str, Any]]) -> int:
    switches = 0
    previous: str | None = None
    for event in sorted(events, key=lambda item: item.get("started_at") or ""):
        entities = event.get("entities") or {}
        current = entities.get("project_name") or entities.get("app_name") or entities.get("domain") or event.get("event_type")
        if previous is not None and current != previous:
            switches += 1
        previous = str(current)
    return switches


def focus_blocks(events: list[dict[str, Any]], min_minutes: int = 25) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for event in events:
        duration = int(event.get("duration_seconds") or 0)
        tags = {str(tag).lower() for tag in event.get("tags") or []}
        if duration >= min_minutes * 60 and tags.intersection({"coding", "document", "terminal", "vs code", "vscode"}):
            blocks.append(
                {
                    "source_event_id": event.get("id"),
                    "started_at": event.get("started_at"),
                    "ended_at": event.get("ended_at"),
                    "duration_seconds": duration,
                    "title": event.get("title"),
                    "confidence": min(float(event.get("confidence") or 0.5), 0.84),
                }
            )
    return blocks


def high_switch_windows(events: list[dict[str, Any]], window_minutes: int, threshold: int) -> list[dict[str, Any]]:
    ordered = sorted(events, key=lambda item: item.get("started_at") or "")
    windows: list[dict[str, Any]] = []
    for index, event in enumerate(ordered):
        start = parse_dt(event.get("started_at"))
        if not start:
            continue
        end = start + timedelta(minutes=window_minutes)
        window_events = [item for item in ordered[index:] if (parse_dt(item.get("started_at")) or end) <= end]
        switches = count_context_switches(window_events)
        if switches >= threshold:
            windows.append(
                {
                    "started_at": start.isoformat(),
                    "ended_at": end.isoformat(),
                    "switch_count": switches,
                    "event_count": len(window_events),
                    "top_apps": top_minutes(window_events, "app_name"),
                }
            )
            break
    return windows


def build_metric_summary(events: list[dict[str, Any]], settings: dict[str, Any] | None = None) -> dict[str, Any]:
    settings = settings or {}
    focus_min = int(settings.get("focus_block_min_minutes", 25))
    switch_window = int(settings.get("context_switch_window_minutes", 30))
    switch_threshold = int(settings.get("context_switch_threshold", 12))
    total_seconds = sum(int(event.get("duration_seconds") or 0) for event in events)
    blocks = focus_blocks(events, focus_min)
    switch_count = count_context_switches(events)
    return {
        "pc_active_minutes": round(total_seconds / 60),
        "focus_minutes": round(sum(int(block["duration_seconds"]) for block in blocks) / 60),
        "context_switch_count": switch_count,
        "top_apps": top_minutes(events, "app_name"),
        "top_domains": top_minutes(events, "domain"),
        "top_projects": top_minutes(events, "project_name"),
        "focus_blocks": blocks,
        "context_switch_windows": high_switch_windows(events, switch_window, switch_threshold),
        "source_event_count": len(events),
        "low_confidence_event_count": len([event for event in events if float(event.get("confidence") or 0) < 0.55]),
        "confidence": 0.78 if events else 0.2,
    }
