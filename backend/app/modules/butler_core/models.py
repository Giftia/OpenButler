from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


@dataclass
class UnifiedTimelineEventModel:
    id: str
    user_id: str
    household_id: str | None
    source: str
    source_event_id: str | None
    source_type: str
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int | None
    title: str
    summary: str | None
    event_type: str
    entities: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    confidence: float = 0.5
    evidence_level: str = "context_summary"
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    evidence_boundary: str = ""
    privacy_level: str = "local_sensitive"
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class ButlerMetricSnapshotModel:
    id: str
    user_id: str
    date: date
    period: str
    metric_key: str
    metric_name: str
    value: float
    unit: str
    dimension: dict[str, Any]
    comparison: dict[str, Any] | None
    source_event_count: int
    confidence: float
    evidence_refs: list[dict[str, Any]]
    created_at: datetime


@dataclass
class InsightCardModel:
    id: str
    user_id: str
    household_id: str | None
    type: str
    title: str
    summary: str
    detail: str | None
    severity: str
    priority: int
    status: str
    suggested_actions: list[dict[str, Any]]
    metrics: dict[str, Any]
    evidence_refs: list[dict[str, Any]]
    evidence_boundary: str
    confidence: float
    generated_by: str
    generated_at: datetime
    expires_at: datetime | None
