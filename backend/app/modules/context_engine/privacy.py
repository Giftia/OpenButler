"""An audited precondition, not a new capture, import, or network capability."""

from app.security.privacy_guard import PrivacyDecision, PrivacyGuard, PrivacyRequest
from .audit import PrivacyAuditLedger


class AuditedPrivacyGuard:
    def __init__(self, ledger: PrivacyAuditLedger) -> None:
        self._ledger = ledger
        self._guard = PrivacyGuard()

    def require(self, request: PrivacyRequest) -> PrivacyDecision:
        decision = self._guard.evaluate(request)
        try:
            self._ledger.append(decision)
        except Exception:
            # A failed ledger must not become permission to run an operation.
            raise PermissionError("privacy_audit_unavailable") from None
        if not decision.allowed:
            raise PermissionError(decision.reason_code)
        return decision
