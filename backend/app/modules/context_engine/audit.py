"""Bounded, metadata-only ledger in OpenButler's database, never a source DB."""

from datetime import datetime, timedelta, timezone
import sqlite3
from typing import Callable

from pydantic import BaseModel, ConfigDict

from app.security.privacy_guard import PrivacyDecision, PrivacyGuard, PrivacyRequest

RETENTION_DAYS = 7
MAX_RECORDS = 10_000


def init_privacy_audit(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS context_privacy_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        action TEXT NOT NULL,
        allowed INTEGER NOT NULL CHECK(allowed IN (0, 1)),
        reason_code TEXT NOT NULL,
        mode TEXT NOT NULL
    )""")


class AuditEntry(PrivacyDecision):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    recorded_at: datetime


class PrivacyAuditLedger:
    def __init__(self, connection_factory: Callable, clock=None) -> None:
        self._db = connection_factory
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("audit_clock_requires_timezone")
        return now.astimezone(timezone.utc)

    @staticmethod
    def _prune(conn, now: datetime) -> None:
        cutoff = int((now - timedelta(days=RETENTION_DAYS)).timestamp())
        conn.execute("DELETE FROM context_privacy_activity WHERE recorded_at <= ?", (cutoff,))
        conn.execute("""DELETE FROM context_privacy_activity WHERE id NOT IN
            (SELECT id FROM context_privacy_activity ORDER BY id DESC LIMIT ?)""", (MAX_RECORDS,))

    def append(self, decision: PrivacyDecision) -> None:
        # Revalidate even constructed/copied models; accept no extensible payload.
        decision = PrivacyDecision.model_validate(decision.model_dump())
        now = self._now()
        with self._db() as conn:
            conn.execute("""INSERT INTO context_privacy_activity
                (recorded_at, action, allowed, reason_code, mode) VALUES (?, ?, ?, ?, ?)""",
                (int(now.timestamp()), decision.action, int(decision.allowed),
                 decision.reason_code, decision.mode))
            self._prune(conn, now)

    def recent(self, limit: int = 50) -> list[AuditEntry]:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("audit_limit_out_of_range")
        with self._db() as conn:
            self._prune(conn, self._now())
            rows = conn.execute("""SELECT recorded_at, action, allowed, reason_code, mode
                FROM context_privacy_activity ORDER BY id DESC LIMIT ?""", (limit,)).fetchall()
        return [AuditEntry(
            recorded_at=datetime.fromtimestamp(row[0], timezone.utc), action=row[1],
            allowed=bool(row[2]), reason_code=row[3], mode=row[4],
        ) for row in rows]

    def delete_owned_history(self, *, confirmed: bool) -> int:
        PrivacyGuard().require(PrivacyRequest(
            action="retention", mode="strict", authorized=confirmed, target_owned=True,
        ))
        with self._db() as conn:
            result = conn.execute("DELETE FROM context_privacy_activity")
            return result.rowcount
