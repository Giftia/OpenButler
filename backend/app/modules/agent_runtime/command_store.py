"""Atomic API intent/effect receipts, with no request/response content.

The kernel's context-local, reentrant transaction is the atomicity boundary:
reservation, service effects and receipt commit together. A failed command can
be retried safely; a lost successful response replays metadata, never an effect.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from threading import RLock


class CommandConflict(ValueError):
    def __init__(self, code: str, receipt: dict):
        super().__init__(code)
        self.code = code
        self.receipt = receipt


class RuntimeCommandStore:
    def __init__(self, db_path: str | Path, transaction_factory):
        self.path = Path(db_path)
        self._transaction = transaction_factory
        self._lock = RLock()
        with self._db() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS runtime_api_commands (
                    command_id TEXT PRIMARY KEY,
                    operation TEXT NOT NULL,
                    payload_digest TEXT NOT NULL,
                    target_id TEXT,
                    expected_version INTEGER,
                    state TEXT NOT NULL CHECK(state IN ('started', 'completed')),
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                )
            """)

    @contextmanager
    def _db(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @staticmethod
    def _public(row) -> dict:
        return {
            "command_id": row["command_id"], "operation": row["operation"],
            "target_id": row["target_id"], "expected_version": row["expected_version"],
            "state": "completed" if row["state"] == "completed" else "outcome_unknown",
            "created_at": row["created_at"], "completed_at": row["completed_at"],
            "reconciliation_required": row["state"] != "completed",
        }

    def get(self, command_id: str) -> dict | None:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM runtime_api_commands WHERE command_id = ?", (command_id,)).fetchone()
        return self._public(row) if row else None

    def complete(self, command_id: str, target_id: str | None = None) -> None:
        with self._db() as conn:
            self._complete(conn, command_id, target_id)

    @staticmethod
    def _complete(conn, command_id, target_id):
        conn.execute("""UPDATE runtime_api_commands
            SET state = 'completed', target_id = COALESCE(?, target_id), completed_at = ?
            WHERE command_id = ? AND state = 'started'""",
            (target_id, datetime.now(timezone.utc).isoformat(), command_id))

    def execute(self, command_id: str, operation: str, callback, *, payload: dict,
                target_id: str | None = None, expected_version: int | None = None):
        intent = json.dumps({"operation": operation, "target_id": target_id,
                             "expected_version": expected_version, "payload": payload},
                            sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        digest = hashlib.sha256(intent.encode()).hexdigest()
        # Serialize receipt creation with the same-process callback. The durable
        # primary key also fences a concurrent second process using this store.
        with self._lock:
            with self._transaction() as conn:
                existing = conn.execute("SELECT * FROM runtime_api_commands WHERE command_id = ?",
                                        (command_id,)).fetchone()
                if existing:
                    if existing["payload_digest"] == digest and existing["state"] == "completed":
                        return {"replayed": True, "receipt": self._public(existing)}
                    code = ("runtime_command_payload_conflict" if existing["payload_digest"] != digest
                            else "runtime_command_outcome_unknown")
                    raise CommandConflict(code, self._public(existing))
                conn.execute("""INSERT INTO runtime_api_commands
                    (command_id, operation, payload_digest, target_id, expected_version, state, created_at)
                    VALUES (?, ?, ?, ?, ?, 'started', ?)""",
                    (command_id, operation, digest, target_id, expected_version,
                     datetime.now(timezone.utc).isoformat()))
                # Every service transaction/read reuses this same connection.
                # BaseException, including process-crash test faults, rolls back
                # both reservation and service mutations at the outer boundary.
                result = callback()
                entity_id = result.get("id") if isinstance(result, dict) else None
                self._complete(conn, command_id, entity_id if isinstance(entity_id, str) else target_id)
                return result
