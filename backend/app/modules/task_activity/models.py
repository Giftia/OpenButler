"""User work is distinct from the agent runtime's executable plan steps."""
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Priority = Literal['low', 'normal', 'high', 'urgent']
TaskStatus = Literal['todo', 'doing', 'done']
Relation = Literal['work', 'preparation', 'reference', 'possible']


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid')

    @field_validator('*', mode='after')
    @classmethod
    def bounded_text(cls, value):
        if isinstance(value, str) and any(ord(c) < 32 and c not in '\n\t' for c in value):
            raise ValueError('invalid_text')
        return value


class Versioned(Contract):
    expected_version: int = Field(ge=1, strict=True)


class Command(Contract):
    command_id: UUID


class SyncStart(Command, Versioned):
    pass


class SyncStop(Contract):
    pass


class TaskCreate(Command):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=2000)
    priority: Priority = 'normal'
    due_at: datetime | None = None

    @field_validator('title')
    @classmethod
    def title_not_blank(cls, value):
        if not value.strip():
            raise ValueError('empty_title')
        return value.strip()

    @field_validator('due_at')
    @classmethod
    def aware(cls, value):
        if value is not None:
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError('timezone_required')
            return value.astimezone(timezone.utc)
        return value


class TaskEdit(Versioned):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    priority: Priority | None = None
    status: TaskStatus | None = None
    due_at: datetime | None = None
    archived: bool | None = Field(default=None, strict=True)
    confirmed: bool | None = Field(default=None, strict=True)
    _aware = field_validator('due_at')(TaskCreate.aware.__func__)

    @model_validator(mode='after')
    def explicit_values(self):
        if any(getattr(self, key) is None for key in self.model_fields_set - {'due_at'}):
            raise ValueError('null_field_not_allowed')
        if self.title is not None and not self.title.strip():
            raise ValueError('empty_title')
        if self.confirmed is False:
            raise ValueError('confirmation_cannot_be_undone')
        return self


class ActivityCreate(Command):
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(default='', max_length=1000)
    start_at: datetime
    end_at: datetime
    _aware = field_validator('start_at', 'end_at')(TaskCreate.aware.__func__)

    @model_validator(mode='after')
    def valid_interval(self):
        if not self.title.strip() or self.end_at < self.start_at:
            raise ValueError('invalid_activity_interval')
        if (self.end_at - self.start_at).total_seconds() > 86400:
            raise ValueError('activity_interval_too_long')
        return self


class LinkEdit(Versioned):
    relation: Relation
    decision: Literal['accepted', 'rejected']
    primary: bool = Field(default=False, strict=True)

    @model_validator(mode='after')
    def primary_work_only(self):
        if self.primary and (self.decision != 'accepted' or self.relation not in {'work', 'preparation'}):
            raise ValueError('primary_requires_work')
        return self


class CheckpointEdit(Versioned):
    next_step: str = Field(max_length=1000)
    resource_ref: str = Field(default='', max_length=500)


class ResourceCreate(Versioned):
    command_id: UUID
    kind: Literal['url', 'file', 'document', 'window']
    label: str = Field(min_length=1, max_length=200)
    reference: str = Field(min_length=1, max_length=1000)


class MergeRequest(Versioned):
    target_id: str = Field(min_length=1, max_length=80)
    target_version: int = Field(ge=1, strict=True)


class DiscoveryResolution(Versioned):
    decision: Literal['accept', 'dismiss']


class SettingsEdit(Versioned):
    auto_discovery: bool = Field(strict=True)
    confirmed: bool = Field(strict=True)
    provider: Literal['evidence_rules_v1', 'local_model_v1'] = 'evidence_rules_v1'


class RuntimeBridge(Versioned):
    goal_id: str | None = Field(default=None, max_length=128)
