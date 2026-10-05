from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from pydantic import ValidationError

from app.modules.context_engine.audit import PrivacyAuditLedger, init_privacy_audit
from app.modules.context_engine.privacy import AuditedPrivacyGuard
from app.security.privacy_guard import PrivacyDecision, PrivacyGuard, PrivacyRequest


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "owned.sqlite3"
        self.now = datetime(2026, 9, 22, tzinfo=timezone.utc)
        self.db = lambda: sqlite3.connect(self.path, factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            conn.execute("CREATE TABLE unrelated_source (value TEXT)")
            conn.execute("INSERT INTO unrelated_source VALUES ('synthetic-do-not-touch')")
        self.ledger = PrivacyAuditLedger(self.db, lambda: self.now)
        self.guard = AuditedPrivacyGuard(self.ledger)

    def request(self, **kwargs):
        return PrivacyRequest(action="capture", mode="strict", **kwargs)

    def test_allow_and_deny_are_both_recorded_before_operation(self):
        operation = Mock()
        with self.assertRaisesRegex(PermissionError, "authorization_required"):
            self.guard.require(self.request())
            operation()
        operation.assert_not_called()
        self.guard.require(self.request(authorized=True))
        rows = self.ledger.recent()
        self.assertEqual([row.allowed for row in rows], [True, False])
        for row in rows:
            self.assertEqual(set(row.model_dump()), {"action", "allowed", "reason_code", "mode", "recorded_at"})

    def test_no_payload_field_or_arbitrary_action_reason(self):
        for overrides in ({"payload": {"apiKey": "synthetic"}}, {"reason_code": "private-title"},
                          {"action": "C:\\private\\image.png"}, {"mode": "private-url"}):
            data = dict(action="capture", allowed=False, reason_code="authorization_required", mode="strict")
            data.update(overrides)
            with self.assertRaises(ValidationError):
                PrivacyDecision.model_validate(data)
        self.assertEqual(self.ledger.recent(), [])

    def test_audit_failure_prevents_operation_and_has_no_raw_error(self):
        operation = Mock()
        with patch.object(self.ledger, "append", side_effect=RuntimeError("private-path-and-key")):
            with self.assertRaisesRegex(PermissionError, "^privacy_audit_unavailable$"):
                self.guard.require(self.request(authorized=True))
                operation()
        operation.assert_not_called()

    def test_retention_boundary_and_capacity_touch_only_owned_rows(self):
        self.guard.require(self.request(authorized=True))
        self.now += timedelta(days=7)
        self.assertEqual(self.ledger.recent(), [])
        with patch("app.modules.context_engine.audit.MAX_RECORDS", 3):
            for _ in range(5):
                self.guard.require(self.request(authorized=True))
        self.assertEqual(len(self.ledger.recent()), 3)
        with self.db() as conn:
            self.assertEqual(conn.execute("SELECT value FROM unrelated_source").fetchone()[0], "synthetic-do-not-touch")

    def test_explicit_delete_and_restart(self):
        self.guard.require(self.request(authorized=True))
        reopened = PrivacyAuditLedger(self.db, lambda: self.now)
        self.assertEqual(len(reopened.recent()), 1)
        with self.assertRaises(PermissionError):
            reopened.delete_owned_history(confirmed=False)
        self.assertEqual(reopened.delete_owned_history(confirmed=True), 1)
        self.assertEqual(reopened.recent(), [])
        with self.db() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM unrelated_source").fetchone()[0], 1)

    def test_limits_and_timezone_are_validated(self):
        for limit in (0, 101, -1, True, "50"):
            with self.assertRaises(ValueError):
                self.ledger.recent(limit)
        self.now = datetime(2026, 9, 22)
        with self.assertRaises(ValueError):
            self.ledger.append(PrivacyGuard().evaluate(self.request()))

    def test_corrupted_row_not_exposed(self):
        with self.db() as conn:
            conn.execute("""INSERT INTO context_privacy_activity
                (recorded_at, action, allowed, reason_code, mode) VALUES (?, ?, 0, ?, 'strict')""",
                (int(self.now.timestamp()), "capture", "synthetic-private-content"))
        with self.assertRaises(ValidationError):
            self.ledger.recent()


if __name__ == "__main__":
    unittest.main()
