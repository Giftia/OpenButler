from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


EvidenceLevel = Literal[
    "activity_record",
    "screenshot_path",
    "context_summary",
    "semantic_hit",
    "generated_report",
]
MatchLevel = Literal["confirmed_match", "likely_match", "weak_hint", "not_confirmed"]


class MineContextHealth(BaseModel):
    available: bool
    mode: str
    workspace_dir: str
    data_dir: str
    query_script_exists: bool
    search_script_exists: bool
    app_db_exists: bool
    capabilities: list[str] = Field(default_factory=list)
    error: str | None = None


class MineContextGodviewResult(BaseModel):
    can_confirm: bool
    confidence: float
    time_range: dict[str, Any]
    activity_ids: list[str] = Field(default_factory=list)
    context_ids: list[str] = Field(default_factory=list)
    summary: str
    evidence_level: EvidenceLevel
    evidence_boundary: str
    screenshot_paths: list[str] = Field(default_factory=list)
    raw_source: Literal["minecontext_godview", "minecontext_http", "minecontext_db", "openbutler_event_lake"] = "minecontext_godview"
    raw_output: dict[str, Any] | None = None


class MineContextSearchResult(BaseModel):
    match_level: MatchLevel
    can_confirm: bool
    confidence: float
    source_kind: str
    source_id: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    title: str | None = None
    summary: str
    matched_keywords: list[str] = Field(default_factory=list)
    evidence_level: EvidenceLevel
    evidence_boundary: str
    screenshot_paths: list[str] = Field(default_factory=list)
    raw_source: Literal["minecontext_godview", "minecontext_http", "minecontext_db", "openbutler_event_lake"] = "minecontext_godview"


class MineContextActivity(BaseModel):
    source_activity_id: str
    started_at: datetime
    ended_at: datetime | None = None
    title: str | None = None
    summary: str | None = None
    resources: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
