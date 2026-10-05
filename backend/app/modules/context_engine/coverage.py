"""Owned capture-control facts, never observations of activity in a missing period.

The durable sequence orders transitions even when the wall clock moves backwards.
A start records permission to try sampling; only an accepted sample closes a gap.
"""

from datetime import datetime, timezone
import json
from uuid import uuid4


def init_coverage_store(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS context_capture_coverage (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        consent_revision TEXT NOT NULL,
        session_id TEXT,
        last_sample_at TEXT,
        first_sample_at TEXT,
        gap_started_at TEXT,
        gap_start_known INTEGER NOT NULL,
        gap_end_at TEXT,
        reason TEXT NOT NULL
    )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS context_capture_coverage_open
        ON context_capture_coverage(sequence) WHERE kind!='started' AND gap_end_at IS NULL""")


def record_boundary(conn, kind, now, reason=None):
    row = conn.execute("""SELECT active,source_kind,consent_revision,provenance,
        last_capture_at,coverage_event_id FROM context_capture_settings WHERE id=1""").fetchone()
    # Repeated starts/stops and shutdown of an already paused process are no-ops.
    if row is None or bool(row[0]) == (kind == "started"):
        return None
    at = now.astimezone(timezone.utc).isoformat()
    previous_start = conn.execute("SELECT occurred_at FROM context_capture_coverage WHERE id=?",
                                  (row[5],)).fetchone()
    unknown = kind == "process_restarted"
    gap_start = (row[4] or (previous_start[0] if previous_start else None)) if unknown else at
    event_id = str(uuid4())
    conn.execute("""INSERT INTO context_capture_coverage
        (id,kind,occurred_at,source_kind,consent_revision,session_id,last_sample_at,
         gap_started_at,gap_start_known,reason) VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (event_id, kind, at, row[1], row[2], json.loads(row[3]).get("session_id"), row[4],
         None if kind == "started" else gap_start, int(kind != "started" and not unknown), reason or kind))
    if kind == "started":
        conn.execute("UPDATE context_capture_settings SET coverage_event_id=? WHERE id=1", (event_id,))
    return event_id


def record_sample(conn, observed, sampling_sequence=None):
    """Called in the same transaction as a stored observation or accepted duplicate."""
    row = conn.execute("""SELECT last_capture_at,coverage_event_id FROM context_capture_settings
        WHERE id=1 AND active=1""").fetchone()
    if not row:
        return
    at = observed.astimezone(timezone.utc).isoformat()
    # Full-screen legacy clients can repeat/backdate frames. Never move this
    # last accepted sample marker backwards or infer a negative gap duration.
    if not row[0] or observed >= datetime.fromisoformat(row[0]):
        conn.execute("""UPDATE context_capture_settings SET last_capture_at=?,
            last_sampling_sequence=COALESCE(?,last_sampling_sequence) WHERE id=1""", (at, sampling_sequence))
    start = conn.execute("""SELECT sequence,occurred_at,first_sample_at
        FROM context_capture_coverage WHERE id=? AND kind='started'""", (row[1],)).fetchone()
    if not start or observed < datetime.fromisoformat(start[1]):
        return
    if start[2] is None:
        conn.execute("UPDATE context_capture_coverage SET first_sample_at=? WHERE id=?", (at, row[1]))
    for sequence, gap_start, recorded_at in conn.execute("""SELECT sequence,gap_started_at,occurred_at
            FROM context_capture_coverage WHERE kind!='started' AND gap_end_at IS NULL AND sequence<?""",
            (start[0],)).fetchall():
        # Recovery itself is only a detection time. Require chronological
        # consistency with both bounds before claiming an endpoint.
        if observed >= datetime.fromisoformat(recorded_at) and (
                gap_start is None or observed >= datetime.fromisoformat(gap_start)):
            conn.execute("UPDATE context_capture_coverage SET gap_end_at=? WHERE sequence=?", (at, sequence))


def list_coverage(conn, limit):
    cursor = conn.execute("""SELECT id,kind,occurred_at,source_kind,consent_revision,session_id,
        last_sample_at,first_sample_at,gap_started_at,gap_start_known,gap_end_at,reason
        FROM context_capture_coverage ORDER BY sequence DESC LIMIT ?""", (limit,))
    keys = [column[0] for column in cursor.description]
    result = []
    for row in cursor.fetchall():
        event = dict(zip(keys, row))
        event["gap_start_known"] = bool(event["gap_start_known"])
        event["gap_end_known"] = event["gap_end_at"] is not None
        result.append(event)
    return result
