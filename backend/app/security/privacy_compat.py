"""Restrict legacy settings without treating feature flags as authorization."""

from typing import Literal

from .privacy_guard import PrivacyGuard, PrivacyRequest


def restrict_legacy_setting(
    *, action: Literal["model_external", "screenshot_copy"], mode: str, enabled: bool,
) -> bool:
    """A basic-mode result preserves a setting only, never execution permission.

    Vision raw-frame saving uses the same strict restriction as screenshot copying.
    This helper must not replace PrivacyGuard.require at new execution boundaries.
    """
    if action not in {"model_external", "screenshot_copy"}:
        raise ValueError("unsupported_legacy_privacy_action")
    if mode == "basic":
        return enabled
    if mode != "strict":
        return False
    decision = PrivacyGuard().evaluate(PrivacyRequest(action=action, mode="strict"))
    return enabled and decision.allowed
