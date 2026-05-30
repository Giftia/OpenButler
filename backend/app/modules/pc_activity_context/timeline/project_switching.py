from __future__ import annotations

from typing import Any


def context_switch_count(events: list[dict[str, Any]]) -> int:
    count = 0
    previous: str | None = None
    for event in sorted(events, key=lambda item: item.get("started_at") or ""):
        current = event.get("project_name") or event.get("app_name") or event.get("activity_type") or "unknown"
        if previous is not None and current != previous:
            count += 1
        previous = str(current)
    return count
