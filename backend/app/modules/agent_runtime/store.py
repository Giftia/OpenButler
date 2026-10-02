"""Dedicated SQLite store. Every mutation is serialized across processes.

This database contains only opt-in local runtime state, never existing source
stores or capture data. Local effects and their receipts share one transaction.
"""
import json
import sqlite3
import threading
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

SCHEMA = """
CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, version INTEGER NOT NULL,
 status TEXT NOT NULL, consented_at TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS evidence (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 source_version INTEGER NOT NULL, source_event_id TEXT NOT NULL,
 target_id TEXT NOT NULL, event_type TEXT NOT NULL, value TEXT NOT NULL,
 observed_at TEXT NOT NULL, ingested_at TEXT NOT NULL, expires_at TEXT,
 provenance TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
 invalid_reason TEXT, UNIQUE(source_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS evidence_target ON evidence(target_id,event_type,valid);
CREATE TABLE IF NOT EXISTS assertions (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, statement TEXT NOT NULL,
 evidence_ids TEXT NOT NULL, source_ids TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
 id TEXT PRIMARY KEY, candidate_key TEXT UNIQUE, title TEXT NOT NULL,
 target_id TEXT NOT NULL, success_event_type TEXT NOT NULL, success_value TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
 source_ids TEXT NOT NULL, evidence_ids TEXT NOT NULL, deadline_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, activated_at TEXT,
 wait_target TEXT NOT NULL, checkpoint TEXT NOT NULL DEFAULT '{}',
 completion_evidence_ids TEXT NOT NULL DEFAULT '[]', blocked_reason TEXT,
 completed_at TEXT, resume_status TEXT, plan_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS plans (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
 version INTEGER NOT NULL, goal_version INTEGER NOT NULL, status TEXT NOT NULL,
 source_versions TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(goal_id,version)
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
 task_key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 UNIQUE(plan_id,task_key)
);
CREATE TABLE IF NOT EXISTS approvals (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
 goal_version INTEGER NOT NULL, plan_version INTEGER NOT NULL,
 source_versions TEXT NOT NULL, allowed_actions TEXT NOT NULL,
 valid INTEGER NOT NULL DEFAULT 1, approved_at TEXT NOT NULL,
 invalid_reason TEXT
);
CREATE TABLE IF NOT EXISTS actions (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
 goal_version INTEGER NOT NULL, plan_version INTEGER NOT NULL,
 approval_id TEXT NOT NULL REFERENCES approvals(id), kind TEXT NOT NULL,
 action_key TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, due_at TEXT NOT NULL, lease_token TEXT,
 lease_until TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS actions_due ON actions(status,due_at);
CREATE TABLE IF NOT EXISTS receipts (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
 idempotency_key TEXT NOT NULL UNIQUE, outcome TEXT NOT NULL,
 effect_id TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
 goal_id TEXT NOT NULL REFERENCES goals(id), kind TEXT NOT NULL,
 message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
);
CREATE TABLE IF NOT EXISTS wakes (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), kind TEXT NOT NULL,
 dedupe_key TEXT NOT NULL, status TEXT NOT NULL, due_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
 created_at TEXT NOT NULL, reason TEXT, UNIQUE(goal_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS wakes_due ON wakes(status,due_at);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
 finished_at TEXT, processed_wakes INTEGER NOT NULL DEFAULT 0,
 executed_actions INTEGER NOT NULL DEFAULT 0, checkpoint TEXT NOT NULL DEFAULT '{}',
 lease_until TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 role TEXT NOT NULL, content TEXT NOT NULL, client_message_id TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(conversation_id,client_message_id)
);
"""


def new_id(prefix):
    return f"{prefix}_{uuid4().hex}"


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


JSON_FIELDS = frozenset({"value", "provenance", "statement", "source_ids", "evidence_ids", "success_value", "wait_target", "checkpoint", "completion_evidence_ids", "source_versions", "allowed_actions", "payload", "details"})
BOOL_FIELDS = frozenset({"valid"})


def decode(row):
    if row is None:
        return None
    item = dict(row)
    for key in item:
        if key in JSON_FIELDS:
            item[key] = json.loads(item[key])
        elif key in BOOL_FIELDS:
            item[key] = bool(item[key])
    if "source_event_id" in item:
        item["trust"] = "untrusted"
    return item


class Store:
    def __init__(self, db_path):
        self.path = str(db_path)
        self._local = threading.local()
        if self.path == ":memory:":
            raise ValueError("Runtime requires a durable SQLite file")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as connection:
            connection.executescript(SCHEMA)
            defaults = {"enabled": False, "quiet_until": None, "daily_notice_budget": 20,
                        "cooldown_seconds": 0, "max_actions_per_run": 10}
            for key, value in defaults.items():
                connection.execute("INSERT OR IGNORE INTO runtime_settings VALUES (?,?)", (key, encode(value)))
            connection.commit()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=15000")
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    @contextmanager
    def transaction(self):
        existing = getattr(self._local, "connection", None)
        if existing is not None:
            savepoint = "nested_" + uuid4().hex
            existing.execute(f"SAVEPOINT {savepoint}")
            try:
                yield existing
                existing.execute(f"RELEASE SAVEPOINT {savepoint}")
            except BaseException:
                existing.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                existing.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise
            return
        connection = self.connect()
        self._local.connection = connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            self._local.connection = None
            connection.close()

    @contextmanager
    def read(self):
        existing = getattr(self._local, "connection", None)
        if existing is not None:
            yield existing
            return
        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def settings(connection):
        return {row["key"]: json.loads(row["value"]) for row in connection.execute("SELECT * FROM runtime_settings")}
