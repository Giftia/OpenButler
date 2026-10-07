"""Pure privacy policy; decisions neither authorize nor execute real operations."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

PrivacyAction = Literal[
    "capture", "screenshot_copy", "model_local", "model_external", "webhook",
    "migration", "retention", "external_write", "source_mutation",
]
PrivacyMode = Literal["strict", "basic"]
PrivacyReasonCode = Literal[
    "allowed", "source_mutation_forbidden", "strict_mode_forbidden",
    "authorization_required", "capture_paused", "source_not_read_only",
    "target_not_owned", "redaction_required",
]


class PrivacyRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, strict=True, revalidate_instances="always",
    )

    action: PrivacyAction
    mode: PrivacyMode
    authorized: bool = False
    redacted: bool = False
    source_read_only: bool = True
    target_owned: bool = False
    paused: bool = False


class PrivacyDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    action: PrivacyAction
    allowed: bool
    reason_code: PrivacyReasonCode
    mode: PrivacyMode


class PrivacyGuard:
    def evaluate(self, request: PrivacyRequest) -> PrivacyDecision:
        # Revalidate copies/constructed instances before trusting authorization flags.
        request = PrivacyRequest.model_validate(request)
        reason: PrivacyReasonCode = "allowed"
        if request.action == "source_mutation":
            reason = "source_mutation_forbidden"
        elif request.mode == "strict" and request.action in {
            "model_external", "webhook", "screenshot_copy", "external_write",
        }:
            reason = "strict_mode_forbidden"
        elif not request.authorized:
            reason = "authorization_required"
        elif request.action == "capture" and request.paused:
            reason = "capture_paused"
        elif request.action == "migration" and not request.source_read_only:
            reason = "source_not_read_only"
        elif request.action in {"migration", "retention"} and not request.target_owned:
            reason = "target_not_owned"
        elif request.action in {"model_external", "webhook"} and not request.redacted:
            reason = "redaction_required"
        return PrivacyDecision(
            action=request.action, allowed=reason == "allowed", reason_code=reason, mode=request.mode,
        )

    def require(self, request: PrivacyRequest) -> PrivacyDecision:
        decision = self.evaluate(request)
        if not decision.allowed:
            raise PermissionError(decision.reason_code)
        return decision
