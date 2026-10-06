"""Small strict contracts for the local runtime and its replaceable planner.

Evidence is untrusted data. Neither evidence text nor a planner result grants
permission to execute an action. The engine independently validates every result.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Protocol

LOCAL_ACTIONS = frozenset({"prepare_plan", "inbox_notice", "ask_user"})
GOAL_STATES = frozenset({"candidate", "active", "waiting_external", "paused", "completed", "cancelled"})
WAKE_KINDS = frozenset({"event", "time", "user", "recovery"})


class RuntimeErrorBase(ValueError):
    """A safe, user-correctable runtime contract violation."""


class NotFound(RuntimeErrorBase):
    pass


class Conflict(RuntimeErrorBase):
    pass


class AuthorizationError(RuntimeErrorBase):
    pass


class PlannerUnavailable(RuntimeError):
    pass


class PlannerBudgetExceeded(PlannerUnavailable):
    def __init__(self, reset_at):
        self.reset_at = timestamp(reset_at)
        super().__init__("model_daily_budget")


class SimulatedCrash(BaseException):
    """Test-only process interruption; deliberately bypasses error recovery."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp(value: datetime | str | None = None) -> str:
    if value is None:
        value = utc_now()
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise RuntimeErrorBase("Invalid timestamp") from None
    if not isinstance(value, datetime):
        raise RuntimeErrorBase("A timezone-aware timestamp is required")
    if value.tzinfo is None or value.utcoffset() is None:
        raise RuntimeErrorBase("A timezone-aware timestamp is required")
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def text_field(value: str, name: str, limit: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise RuntimeErrorBase(f"{name} must be a nonempty string of at most {limit} characters")
    return value.strip()


@dataclass(frozen=True)
class ActionSpec:
    kind: Literal["prepare_plan", "inbox_notice", "ask_user"]
    key: str
    message: str


@dataclass(frozen=True)
class PlanProposal:
    """Unverified user-visible text; steps are never executable parameters."""

    summary: str
    steps: tuple[str, ...]
    evidence_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlannerDecision:
    disposition: Literal["wait", "complete"] = "wait"
    evidence_ids: tuple[str, ...] = ()
    actions: tuple[ActionSpec, ...] = ()
    proposed_plan: PlanProposal | None = None


class Planner(Protocol):
    """Pure replaceable planning boundary; no authority or effect is delegated."""

    name: str

    def decide(self, goal: dict[str, Any], evidence: list[dict[str, Any]], now: str) -> PlannerDecision:
        ...


class GuardedPlanner(Planner, Protocol):
    """Decision-only provider boundary; the engine owns authority and effects.

    The engine holds a serialized scope transaction while calling this method.
    The implementation must invoke the callback at actual transport dispatch
    and after response, and fail closed on configuration changes or bad output.
    """

    @property
    def configuration_revision(self) -> int:
        ...

    @property
    def allowed_sources(self) -> frozenset[str]:
        ...

    def decide_guarded(self, goal: dict[str, Any], evidence: list[dict[str, Any]], now: str,
                       *, dispatch_precondition: Callable[[], None]) -> PlannerDecision:
        ...


class BudgetedGuardedPlanner(GuardedPlanner, Protocol):
    """Optional durable pre-dispatch reservation seam used by PlannerControl."""

    def reserve_attempt(self, connection: Any, claimed_revision: int) -> str | None:
        ...

    def decide_guarded(self, goal: dict[str, Any], evidence: list[dict[str, Any]], now: str,
                       *, dispatch_precondition: Callable[[], None],
                       attempt_reservation: str | None = None) -> PlannerDecision:
        ...
