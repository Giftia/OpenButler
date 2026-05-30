from __future__ import annotations

from datetime import datetime, timedelta, timezone


def snooze_until(minutes: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
