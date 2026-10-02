"""Small local control plane, protected by the application's session middleware.

Legacy free-text chat remains durable notes only. The separate synthetic model
conversation surface returns untrusted replies/proposals; adoption is explicit.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path as ApiPath, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator
from starlette.responses import JSONResponse

from .command_store import CommandConflict, RuntimeCommandStore
from .models import AuthorizationError, Conflict, NotFound, RuntimeErrorBase

Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
SourceId = Literal["synthetic", "user_statement"]
EntityId = Annotated[str, ApiPath(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
Limit = Annotated[int, Query(ge=1, le=100)]
ConversationId = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
ConversationEntityId = Annotated[str, ApiPath(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]


class StrictPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CommandPayload(StrictPayload):
    command_id: Identifier


class EnabledPayload(CommandPayload):
    enabled: bool = Field(strict=True)


class PlannerConfigurePayload(CommandPayload):
    protocol: Literal["openai_compatible", "ollama_native"]
    endpoint: str = Field(min_length=1, max_length=512)
    model: str = Field(min_length=1, max_length=200)
    scope: Literal["synthetic_only"]
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_model_confirmation(cls, value):
        if value is not True:
            raise ValueError("explicit_confirmation_required")
        return value


class PlannerSelectPayload(CommandPayload):
    mode: Literal["deterministic", "local_model"]


class SettingsPayload(CommandPayload):
    quiet_until: datetime | None = None
    daily_notice_budget: int | None = Field(default=None, ge=0, le=1000, strict=True)
    cooldown_seconds: int | None = Field(default=None, ge=0, le=86400, strict=True)
    max_actions_per_run: int | None = Field(default=None, ge=1, le=100, strict=True)

    @field_validator("quiet_until")
    @classmethod
    def aware_time(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("timezone_required")
        return value


class GrantPayload(CommandPayload):
    confirmed: Literal[True]
    scope: Literal["goal_tracking"] = "goal_tracking"
    expires_at: datetime | None = None

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("explicit_confirmation_required")
        return value

    @field_validator("expires_at")
    @classmethod
    def aware_time(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("timezone_required")
        return value


def _bounded_json(value: JsonValue) -> JsonValue:
    def inspect(item, depth=0):
        if depth > 6:
            raise ValueError("value_too_nested")
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("nonfinite_value")
        if isinstance(item, dict):
            for child in item.values():
                inspect(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                inspect(child, depth + 1)
    inspect(value)
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode()) > 8192:
        raise ValueError("value_too_large")
    return value


class EvidencePayload(GrantPayload):
    source_id: SourceId
    source_event_id: Identifier
    target_id: Identifier
    event_type: Identifier
    value: JsonValue
    observed_at: datetime

    _value_size = field_validator("value")(_bounded_json)

    @field_validator("observed_at")
    @classmethod
    def aware_observation(cls, value):
        if value.tzinfo is None:
            raise ValueError("timezone_required")
        return value


class GoalPayload(CommandPayload):
    title: str = Field(min_length=1, max_length=240)
    target_id: Identifier
    success_event_type: Identifier
    success_value: JsonValue
    evidence_ids: list[Identifier] = Field(default_factory=list, max_length=32)
    source_ids: list[SourceId] = Field(default_factory=list, max_length=2)
    deadline_at: datetime | None = None

    _value_size = field_validator("success_value")(_bounded_json)

    @field_validator("deadline_at")
    @classmethod
    def aware_deadline(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("timezone_required")
        return value


class GoalVersionPayload(CommandPayload):
    expected_version: int = Field(ge=1, le=2_147_483_647, strict=True)


class GoalControlPayload(GoalVersionPayload):
    operation: Literal["pause", "resume", "cancel"]


class GoalUpdatePayload(GoalVersionPayload):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    target_id: Identifier | None = None
    success_event_type: Identifier | None = None
    success_value: JsonValue = None
    deadline_at: datetime | None = None

    _value_size = field_validator("success_value")(_bounded_json)
    _deadline_time = field_validator("deadline_at")(GoalPayload.aware_deadline.__func__)


class ChatPayload(StrictPayload):
    conversation_id: Identifier = "local-preview"
    content: str = Field(min_length=1, max_length=4000)
    client_message_id: Identifier


class ConversationConsentPayload(CommandPayload):
    confirmed: Literal[True]
    expected_route_revision: int = Field(ge=1, le=2_147_483_647, strict=True)
    expected_source_version: int = Field(ge=1, le=2_147_483_647, strict=True)
    expected_version: int | None = Field(ge=1, le=2_147_483_647, strict=True)

    _explicit_confirmation = field_validator("confirmed", mode="before")(GrantPayload.explicit_confirmation.__func__)


class ConversationRevokePayload(CommandPayload):
    expected_version: int = Field(ge=1, le=2_147_483_647, strict=True)


class ConversationTurnPayload(StrictPayload):
    request_id: ConversationId
    expected_version: int = Field(ge=1, le=2_147_483_647, strict=True)
    content: str = Field(min_length=1, max_length=2000)
    goal_id: ConversationId | None = None
    expected_goal_version: int | None = Field(default=None, ge=1, le=2_147_483_647, strict=True)
    evidence_ids: list[ConversationId] = Field(default_factory=list, max_length=8)
    retry_of: ConversationId | None = None

    @model_validator(mode="after")
    def exact_context(self):
        if (self.goal_id is None) != (self.expected_goal_version is None):
            raise ValueError("explicit_versioned_goal_context_required")
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("duplicate_evidence_ids")
        return self


class ConversationAdoptPayload(StrictPayload):
    adoption_id: ConversationId
    expected_version: int = Field(ge=1, le=2_147_483_647, strict=True)
    confirmed: Literal[True]

    _explicit_confirmation = field_validator("confirmed", mode="before")(GrantPayload.explicit_confirmation.__func__)


class RuntimeApiRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            try:
                response = await original(request)
            except CommandConflict as error:
                response = JSONResponse({"detail": error.code, "receipt": error.receipt}, status_code=409)
            except RequestValidationError:
                response = JSONResponse({"detail": "invalid_runtime_request"}, status_code=422)
            except NotFound:
                response = JSONResponse({"detail": "runtime_item_not_found"}, status_code=404)
            except AuthorizationError:
                response = JSONResponse({"detail": "runtime_authorization_required"}, status_code=403)
            except Conflict:
                response = JSONResponse({"detail": "runtime_version_or_state_conflict"}, status_code=409)
            except RuntimeErrorBase:
                response = JSONResponse({"detail": "invalid_runtime_request"}, status_code=422)
            except HTTPException as error:
                # All HTTPExceptions in this module use a fixed code.
                response = JSONResponse({"detail": error.detail}, status_code=error.status_code)
            except Exception:
                response = JSONResponse({"detail": "runtime_temporarily_unavailable"}, status_code=503)
            response.headers["Cache-Control"] = "private, no-store"
            return response

        return handler


def create_agent_runtime_router(service, supervisor=None, *, command_db_path: Path | str, planner_control=None, conversation_service=None) -> APIRouter:
    """Mount only on the local session-protected app, never the public demo."""
    router = APIRouter(prefix="/api/agent-runtime", route_class=RuntimeApiRoute)
    if Path(command_db_path).resolve() != Path(service.store.path).resolve():
        raise ValueError("runtime_command_database_mismatch")
    commands = RuntimeCommandStore(command_db_path, service.store.transaction)

    def mutate(payload: CommandPayload, operation: str, callback, *, target_id=None):
        result = commands.execute(payload.command_id, operation, callback,
                                  # Omitted PATCH/settings fields differ from
                                  # explicit null (which can clear a value).
                                  payload=payload.model_dump(mode="json", exclude_unset=True),
                                  target_id=target_id,
                                  expected_version=getattr(payload, "expected_version", None))
        if supervisor is not None:
            supervisor.kick()
        return result

    def items(value):
        return {"items": value, "count": len(value)}

    @router.get("/status")
    def status():
        return service.status()

    def planner_manager():
        if planner_control is None:
            raise HTTPException(503, "runtime_planner_control_unavailable")
        return planner_control

    @router.get("/planner")
    def planner_status():
        return planner_manager().status()

    @router.post("/planner/configure")
    def planner_configure(payload: PlannerConfigurePayload):
        manager = planner_manager()
        values = payload.model_dump(exclude={"command_id"})
        return mutate(payload, "configure_planner", lambda: manager.configure(**values))

    @router.post("/planner/select")
    def planner_select(payload: PlannerSelectPayload):
        manager = planner_manager()
        return mutate(payload, "select_planner", lambda: manager.select(payload.mode))

    @router.post("/enabled")
    def enabled(payload: EnabledPayload):
        return mutate(payload, "set_enabled", lambda: service.set_enabled(payload.enabled))

    @router.post("/settings")
    def settings(payload: SettingsPayload):
        values = payload.model_dump(exclude_unset=True, exclude={"command_id"})
        if not values or any(value is None for key, value in values.items() if key != "quiet_until"):
            raise HTTPException(422, "invalid_runtime_request")
        if isinstance(values.get("quiet_until"), datetime):
            values["quiet_until"] = values["quiet_until"].isoformat()
        return mutate(payload, "configure", lambda: service.configure(**values))

    @router.get("/sources")
    def sources():
        return items(service.list_sources())

    @router.post("/sources/{source_id}/grant")
    def grant(source_id: SourceId, payload: GrantPayload):
        return mutate(payload, "grant_source", lambda: service.grant_source(
            source_id, scope=payload.scope,
            expires_at=payload.expires_at.isoformat() if payload.expires_at else None), target_id=source_id)

    @router.post("/sources/{source_id}/revoke")
    def revoke(source_id: SourceId, payload: CommandPayload):
        return mutate(payload, "revoke_source", lambda: service.revoke_source(source_id), target_id=source_id)

    @router.post("/sources/{source_id}/delete")
    def delete(source_id: SourceId, payload: CommandPayload):
        # The service owns invalidation of dependent goals, plans and notices.
        return mutate(payload, "delete_source", lambda: service.delete_source(source_id), target_id=source_id)

    @router.get("/evidence")
    def evidence(limit: Limit = 100):
        return items(service.list_evidence(limit=limit))

    @router.post("/evidence")
    def add_evidence(payload: EvidencePayload):
        return mutate(payload, "add_evidence", lambda: service.add_evidence(
            source_id=payload.source_id, source_event_id=payload.source_event_id,
            target_id=payload.target_id, event_type=payload.event_type, value=payload.value,
            observed_at=payload.observed_at.isoformat(),
            expires_at=payload.expires_at.isoformat() if payload.expires_at else None,
            provenance={"kind": "local_user_supplied", "source_system_verified": False}),
            target_id=payload.source_id)

    @router.get("/goals")
    def goals(limit: Limit = 100):
        return items(service.list_goals(limit=limit))

    @router.post("/goals")
    def create_goal(payload: GoalPayload):
        return mutate(payload, "create_goal", lambda: service.create_goal(
            title=payload.title, target_id=payload.target_id,
            success_event_type=payload.success_event_type, success_value=payload.success_value,
            evidence_ids=payload.evidence_ids, source_ids=payload.source_ids,
            deadline_at=payload.deadline_at.isoformat() if payload.deadline_at else None,
            candidate_key="api-command:" + payload.command_id))

    @router.get("/goals/{goal_id}")
    def get_goal(goal_id: EntityId):
        return service.get_goal(goal_id)

    @router.post("/goals/{goal_id}/activate")
    def activate(goal_id: EntityId, payload: GoalVersionPayload):
        return mutate(payload, "activate_goal", lambda: service.activate_goal(
            goal_id, payload.expected_version), target_id=goal_id)

    @router.patch("/goals/{goal_id}")
    def update(goal_id: EntityId, payload: GoalUpdatePayload):
        changes = payload.model_dump(exclude_unset=True, exclude={"command_id", "expected_version"})
        if not changes or any(changes.get(field, "") is None for field in
                              ("title", "target_id", "success_event_type")):
            raise HTTPException(422, "invalid_runtime_request")
        if isinstance(changes.get("deadline_at"), datetime):
            changes["deadline_at"] = changes["deadline_at"].isoformat()
        return mutate(payload, "update_goal", lambda: service.update_goal(
            goal_id, payload.expected_version, **changes), target_id=goal_id)

    @router.post("/goals/{goal_id}/control")
    def control(goal_id: EntityId, payload: GoalControlPayload):
        return mutate(payload, "control_goal_" + payload.operation, lambda: service.control_goal(
            goal_id, payload.operation, payload.expected_version), target_id=goal_id)

    @router.get("/inbox")
    def inbox(limit: Limit = 100):
        return items(service.list_inbox(limit=limit))

    @router.post("/inbox/{notice_id}/read")
    def read_notice(notice_id: EntityId, payload: CommandPayload):
        return mutate(payload, "mark_notice_read", lambda: service.mark_notice_read(notice_id), target_id=notice_id)

    @router.get("/runs")
    def runs(limit: Limit = 100):
        return items(service.list_runs(limit=limit))

    @router.get("/chat")
    def chat(conversation_id: Identifier = "local-preview", limit: Limit = 100):
        return items(service.list_messages(conversation_id, limit=limit))

    @router.post("/chat")
    def append_chat(payload: ChatPayload):
        # No command dispatcher and no goal inference is called on this path.
        return service.append_message(payload.conversation_id, "user", payload.content, payload.client_message_id)

    def conversations_manager():
        if conversation_service is None:
            raise HTTPException(503, "runtime_conversation_unavailable")
        return conversation_service

    @router.get("/conversations")
    def conversations():
        return items(conversations_manager().list_conversations())

    @router.get("/conversations/{conversation_id}")
    def conversation(conversation_id: ConversationEntityId):
        return conversations_manager().get_conversation(conversation_id)

    @router.post("/conversations/{conversation_id}/consent")
    def conversation_consent(conversation_id: ConversationEntityId, payload: ConversationConsentPayload):
        return mutate(payload, "conversation_consent", lambda: conversations_manager().consent(
            conversation_id, confirmed=payload.confirmed,
            expected_route_revision=payload.expected_route_revision,
            expected_source_version=payload.expected_source_version,
            expected_version=payload.expected_version), target_id=conversation_id)

    @router.post("/conversations/{conversation_id}/revoke")
    def conversation_revoke(conversation_id: ConversationEntityId, payload: ConversationRevokePayload):
        return mutate(payload, "conversation_revoke", lambda: conversations_manager().revoke(
            conversation_id, expected_version=payload.expected_version), target_id=conversation_id)

    @router.post("/conversations/{conversation_id}/turns")
    def conversation_send(conversation_id: ConversationEntityId, payload: ConversationTurnPayload):
        # The service commits its own dispatch reservation before HTTP. An outer
        # command transaction would refund a dispatched attempt after a crash.
        return conversations_manager().send(conversation_id, **payload.model_dump())

    @router.get("/conversations/{conversation_id}/turns/{request_id}")
    def conversation_turn(conversation_id: ConversationEntityId, request_id: ConversationEntityId):
        return conversations_manager().get_turn(conversation_id, request_id)

    @router.post("/conversations/{conversation_id}/proposals/{proposal_id}/adopt")
    def conversation_adopt(conversation_id: ConversationEntityId, proposal_id: ConversationEntityId,
                           payload: ConversationAdoptPayload):
        # Adoption owns a dedicated durable intent/receipt, independent of model
        # dispatch and of the legacy command receipt namespace.
        result = conversations_manager().adopt(conversation_id, proposal_id, **payload.model_dump())
        if supervisor is not None:
            supervisor.kick()
        return result

    @router.get("/conversations/{conversation_id}/adoptions/{adoption_id}")
    def conversation_adoption(conversation_id: ConversationEntityId, adoption_id: ConversationEntityId):
        return conversations_manager().get_adoption(conversation_id, adoption_id)

    @router.get("/commands/{command_id}")
    def command_status(command_id: EntityId):
        receipt = commands.get(command_id)
        if receipt is None:
            raise HTTPException(404, "runtime_command_not_found")
        if receipt["state"] == "outcome_unknown" and receipt["operation"] == "create_goal":
            # Reconcile only by the exact stable kernel key. This read never
            # reruns a mutation and never stores/returns stale goal content.
            goal = service.get_goal_by_candidate_key("api-command:" + command_id)
            if goal is not None:
                commands.complete(command_id, goal["id"])
                receipt = commands.get(command_id)
        return receipt

    return router
