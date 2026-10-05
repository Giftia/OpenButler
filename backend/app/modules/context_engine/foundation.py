"""Source-independent, non-I/O contracts; event payloads are never status data."""

from datetime import datetime
from typing import Any, Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SourceId = Literal["screen_capture", "minecontext", "manual", "synthetic"]


class EventEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    event_id: str = Field(min_length=1, max_length=200)
    source_id: SourceId
    source_event_id: str = Field(min_length=1, max_length=300)
    observed_at: datetime
    event_type: str = Field(pattern=r"^[a-z][a-z0-9_.-]{0,119}$")
    payload: dict[str, Any] = Field(default_factory=dict, repr=False)

    @field_validator("observed_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("observed_at requires a timezone")
        return value


class SourceCapability(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_id: SourceId
    enabled: bool = False
    access_mode: Literal["read_only"] = "read_only"
    supports_backfill: bool = False
    supports_live_observations: bool = False


class ContextEngineStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    state: Literal["foundation_only"] = "foundation_only"
    capabilities: tuple[SourceCapability, ...] = ()
    evidence_boundary: Literal["capability_metadata_only"] = "capability_metadata_only"


class ContextEngineStatusService:
    def __init__(self, capabilities: Iterable[SourceCapability] = ()) -> None:
        self._capabilities = tuple(capabilities)

    def get_redacted_status(self) -> ContextEngineStatus:
        return ContextEngineStatus(capabilities=self._capabilities)
