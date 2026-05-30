from __future__ import annotations

from datetime import datetime
from typing import Any


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def app_usage(events: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for event in events:
        key = event.get("app_name") or event.get("activity_type") or "unknown"
        totals[str(key)] = totals.get(str(key), 0) + int(event.get("duration_seconds") or 0)
    return dict(sorted(totals.items(), key=lambda item: item[1], reverse=True))


def domain_usage(events: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for event in events:
        domain = event.get("domain")
        if domain:
            totals[str(domain)] = totals.get(str(domain), 0) + int(event.get("duration_seconds") or 0)
    return dict(sorted(totals.items(), key=lambda item: item[1], reverse=True))


def focus_blocks(events: list[dict[str, Any]], min_minutes: int = 25) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for event in events:
        duration = int(event.get("duration_seconds") or 0)
        if duration >= min_minutes * 60 and event.get("activity_type") in {"coding", "document", "terminal"}:
            blocks.append(
                {
                    "started_at": event.get("started_at"),
                    "ended_at": event.get("ended_at"),
                    "duration_seconds": duration,
                    "label": event.get("title") or event.get("app_name") or "PC focus block",
                    "confidence": min(float(event.get("confidence") or 0.5), 0.82),
                }
            )
    return blocks
