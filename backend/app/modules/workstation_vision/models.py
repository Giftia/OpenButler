from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


@dataclass
class WorkstationVisionSessionModel:
    id: str
    user_id: str
    household_id: str | None
    camera_id: str
    status: Literal["running", "stopped", "error"]
    started_at: datetime
    stopped_at: datetime | None
    fps: float
    privacy_mode: Literal["basic", "strict"]
    save_raw_frames: bool
    enabled_detectors: list[str]
    created_at: datetime
    updated_at: datetime


@dataclass
class WorkstationVisionEventModel:
    id: str
    session_id: str
    user_id: str
    type: str
    state: str | None
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int | None
    confidence: float
    reason_codes: list[str] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    evidence: dict[str, Any] = field(default_factory=dict)
    privacy_level: str = "strict_local"
    raw_frame_ref: str | None = None
    created_at: datetime | None = None


@dataclass
class WorkstationVisionSummaryModel:
    id: str
    user_id: str
    date: str
    total_present_seconds: int
    total_away_seconds: int
    total_sitting_seconds: int
    total_standing_seconds: int
    total_low_confidence_seconds: int
    longest_presence_seconds: int
    longest_focus_seconds: int
    break_count: int
    fatigue_signal_count: int
    posture_warning_count: int
    attention_metrics: dict[str, Any]
    work_state_distribution: dict[str, Any]
    created_at: datetime
    updated_at: datetime

