from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.integrations.minecontext.config import MineContextSettings


class PCActivitySettings(BaseModel):
    enabled: bool = False
    source: str = "minecontext"
    minecontext: MineContextSettings = Field(default_factory=MineContextSettings)
    privacy_mode: str = "strict"


class QueryAtTimeRequest(BaseModel):
    when: str = Field(min_length=1, max_length=120)
    window_minutes: int = Field(default=10, ge=1, le=240)
    include_screenshot_paths: bool = True
    include_raw_output: bool = False


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    start_time: str | None = None
    end_time: str | None = None
    limit: int = Field(default=20, ge=1, le=100)
    include_screenshot_paths: bool = True
    include_raw_output: bool = False


class ImportRequest(BaseModel):
    start_time: str | None = None
    end_time: str | None = None
    lookback_hours: int = Field(default=24, ge=1, le=24 * 31)
    limit: int = Field(default=200, ge=1, le=2000)


class UnifiedTimelineEvent(BaseModel):
    source: str
    started_at: str
    ended_at: str | None = None
    title: str
    summary: str | None = None
    confidence: float
    evidence_level: str
    payload: dict[str, Any] = Field(default_factory=dict)
