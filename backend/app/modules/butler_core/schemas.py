from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ProactiveButlerSettings(BaseModel):
    enabled: bool = True
    default_mode: str = "local_first"
    insight_generation: dict[str, Any] = Field(
        default_factory=lambda: {
            "auto_generate_on_open": True,
            "scheduled_briefings": True,
            "use_llm_summary": False,
            "external_model_allowed": False,
        }
    )
    notification: dict[str, Any] = Field(
        default_factory=lambda: {
            "system_notification_enabled": False,
            "web_inbox_enabled": True,
            "max_cards_per_day": 8,
            "quiet_hours": {"start": "23:00", "end": "08:00"},
        }
    )
    metrics: dict[str, Any] = Field(
        default_factory=lambda: {
            "focus_block_min_minutes": 25,
            "context_switch_window_minutes": 30,
            "context_switch_threshold": 12,
            "workflow_candidate_min_occurrences": 3,
        }
    )
    privacy: dict[str, Any] = Field(
        default_factory=lambda: {
            "strict_mode_respected": True,
            "store_evidence_refs": True,
            "store_raw_source_text": False,
            "redact_sensitive_text": True,
        }
    )
    feedback: dict[str, Any] = Field(
        default_factory=lambda: {
            "reduce_priority_after_dismiss_count": 3,
            "disable_type_after_inaccurate_count": 3,
            "too_frequent_priority_reduction": 10,
            "too_frequent_cooldown_minutes": 240,
            "useful_priority_boost": 5,
            "accepted_action_priority_boost": 5,
            "max_positive_priority_boost": 10,
            "protected_notice_types": ["data_quality_notice", "privacy_notice"],
        }
    )
    retention: dict[str, Any] = Field(
        default_factory=lambda: {
            "derived_data_retention_days": 365,
            "feedback_retention_days": 365,
            "audit_log_retention_days": 90,
        }
    )


class TimelineQuery(BaseModel):
    start_time: str | None = None
    end_time: str | None = None
    source: str | None = None
    event_type: str | None = None
    limit: int = Field(default=100, ge=1, le=1000)


class GenerateInsightsRequest(BaseModel):
    force: bool = False


class InsightFeedbackRequest(BaseModel):
    feedback_type: Literal["useful", "not_useful", "inaccurate", "too_frequent", "remind_later", "accepted_action", "dismissed"]
    comment: str | None = Field(default=None, max_length=500)


class SnoozeRequest(BaseModel):
    minutes: int = Field(default=60, ge=5, le=60 * 24 * 14)


class BriefingGenerateRequest(BaseModel):
    type: Literal["morning", "midday", "evening", "context_recovery", "weekly_review"] = "evening"


class DemoRunRequest(BaseModel):
    import_pc_activity: bool = True
    lookback_hours: int = Field(default=24, ge=1, le=24 * 31)
    limit: int = Field(default=200, ge=1, le=2000)
    briefing_type: Literal["morning", "midday", "evening", "context_recovery"] = "evening"


class PCActivityImportPreviewRequest(BaseModel):
    source: Literal["minecontext"] = "minecontext"
    lookback_days: int = Field(default=7, ge=1, le=31)
    dry_run: bool = True
    include_screenshot_paths: bool = True
    copy_screenshots: bool = False
    limit: int = Field(default=1000, ge=1, le=5000)


class GoalRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    goal_type: str = "focus"
    target: dict[str, Any] = Field(default_factory=dict)
    schedule: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    privacy_level: str = "local_private"


class GoalPatchRequest(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    goal_type: str | None = None
    target: dict[str, Any] | None = None
    schedule: dict[str, Any] | None = None
    enabled: bool | None = None
    privacy_level: str | None = None
