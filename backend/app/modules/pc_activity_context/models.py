from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


@dataclass
class PCActivityEventModel:
    id: str
    user_id: str
    household_id: str | None
    source: Literal["minecontext"]
    source_activity_id: str | None
    source_context_id: str | None
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int | None
    title: str | None
    summary: str | None
    app_name: str | None
    window_title: str | None
    url: str | None
    domain: str | None
    project_name: str | None
    repo_name: str | None
    document_name: str | None
    activity_type: str
    confidence: float
    evidence_level: str
    evidence: dict[str, Any] = field(default_factory=dict)
    screenshot_paths: list[str] = field(default_factory=list)
    raw_ref: str | None = None
    privacy_level: str = "local_sensitive"
    created_at: datetime | None = None
    updated_at: datetime | None = None
