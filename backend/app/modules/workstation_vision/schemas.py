from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

PrivacyMode = Literal["basic", "strict"]
SessionStatus = Literal["running", "stopped", "error"]


class WorkstationVisionSettings(BaseModel):
    enabled: bool = False
    default_camera_id: str | None = None
    privacy_mode: PrivacyMode = "strict"
    save_raw_frames: bool = False
    raw_frame_retention_days: int = 0
    derived_event_retention_days: int = 365
    use_mock_local_eyes: bool = False
    debounce_seconds: dict[str, int] = Field(
        default_factory=lambda: {"presence": 15, "posture": 10}
    )
    thresholds: dict[str, float] = Field(
        default_factory=lambda: {
            "long_sitting_minutes": 50,
            "long_presence_minutes": 90,
            "looking_down_minutes": 15,
            "low_light_lux_proxy": 0.25,
        }
    )
    fps: dict[str, float] = Field(
        default_factory=lambda: {
            "presence": 1.0,
            "posture": 0.2,
            "attention": 0.2,
            "fatigue": 0.1,
        }
    )
    enabled_detectors: list[str] = Field(
        default_factory=lambda: ["presence", "posture", "attention", "fatigue", "work_state"]
    )


class StartSessionRequest(BaseModel):
    camera_id: str = "usb-camera-0"
    fps: float = Field(default=1.0, gt=0, le=5)
    privacy_mode: PrivacyMode = "strict"
    save_raw_frames: bool = False
    enabled_detectors: list[str] = Field(
        default_factory=lambda: ["presence", "posture", "attention", "fatigue", "work_state"]
    )
    user_id: str = "demo-user"
    household_id: str | None = None
    user_confirmed: bool = True


class StopSessionRequest(BaseModel):
    session_id: str | None = None


class WorkstationVisionSession(BaseModel):
    id: str
    user_id: str
    household_id: str | None
    camera_id: str
    status: SessionStatus
    started_at: str
    stopped_at: str | None
    fps: float
    privacy_mode: PrivacyMode
    save_raw_frames: bool
    enabled_detectors: list[str]
    created_at: str
    updated_at: str


class WorkstationVisionEvent(BaseModel):
    id: str
    session_id: str
    user_id: str
    type: str
    state: str | None = None
    started_at: str
    ended_at: str | None = None
    duration_seconds: int | None = None
    confidence: float
    reason_codes: list[str] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    privacy_level: str = "strict_local"
    raw_frame_ref: str | None = None
    created_at: str
