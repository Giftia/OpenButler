"""Separate durable synthetic conversation state and dependency withdrawal.

These tables never read or modify the legacy conversations/messages notes.
Hashes retain only intent/dependency identity; withdrawn generated text is erased.
"""
import hashlib
import json

from .store import decode, encode

SCHEMA = """
CREATE TABLE IF NOT EXISTS natural_conversations (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL,
 route_revision INTEGER NOT NULL, route_key TEXT NOT NULL, source_version INTEGER NOT NULL,
 created_at TEXT NOT NULL, consented_at TEXT NOT NULL, withdrawn_reason TEXT,
 route_configuration TEXT NOT NULL, source_expires_at TEXT
);
CREATE TABLE IF NOT EXISTS natural_turns (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES natural_conversations(id),
 request_id TEXT NOT NULL, intent_digest TEXT NOT NULL, retry_digest TEXT NOT NULL, conversation_version INTEGER NOT NULL,
 route_revision INTEGER NOT NULL, source_version INTEGER NOT NULL,
 status TEXT NOT NULL, user_content TEXT, answer TEXT, disposition TEXT, reply_kind TEXT,
 evidence_ids TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL, request_context TEXT NOT NULL,
 goal_id TEXT, retry_of TEXT, superseded_by TEXT, error_code TEXT,
 created_at TEXT NOT NULL, retry_after TEXT NOT NULL,
 UNIQUE(conversation_id,request_id)
);
CREATE TABLE IF NOT EXISTS natural_proposals (
 id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE REFERENCES natural_turns(id),
 version INTEGER NOT NULL, status TEXT NOT NULL, body TEXT,
 adopted_goal_id TEXT, adoption_id TEXT
);
CREATE TABLE IF NOT EXISTS natural_adoptions (
 adoption_id TEXT PRIMARY KEY, intent_digest TEXT NOT NULL, conversation_id TEXT NOT NULL,
 proposal_id TEXT NOT NULL UNIQUE REFERENCES natural_proposals(id),
 goal_id TEXT NOT NULL REFERENCES goals(id), created_at TEXT NOT NULL,
 invalidated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS natural_turns_conversation ON natural_turns(conversation_id,created_at);
"""
GOAL_FIELDS = ("id", "title", "target_id", "success_event_type", "success_value", "status",
               "version", "plan_version", "deadline_at", "source_ids", "evidence_ids")


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def goal_projection(goal):
    return {field: goal[field] for field in GOAL_FIELDS}


def installed(connection):
    return connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='natural_turns'").fetchone() is not None


def dependencies_ok(connection, service, dependencies, now, *, check_turns=True):
    try:
        for eid, fingerprint in dependencies["evidence"].items():
            evidence = decode(connection.execute("SELECT * FROM evidence WHERE id=?", (eid,)).fetchone())
            if (not evidence or evidence["source_id"] != "synthetic"
                    or not service._evidence_ok(connection, evidence, now) or digest(evidence) != fingerprint):
                return False
        for gid, fingerprint in dependencies["goals"].items():
            goal = decode(connection.execute("SELECT * FROM goals WHERE id=?", (gid,)).fetchone())
            if (not goal or goal["source_ids"] != ["synthetic"]
                    or digest(goal_projection(goal)) != fingerprint
                    or not all(service._evidence_ok(connection, service._get(connection, "evidence", eid), now)
                               for eid in goal["evidence_ids"])):
                return False
        for tid in dependencies["turns"] if check_turns else []:
            turn = connection.execute("SELECT status FROM natural_turns WHERE id=?", (tid,)).fetchone()
            if not turn or turn["status"] != "completed":
                return False
        return True
    except (KeyError, TypeError, ValueError):
        return False


def scrub_turn(connection, service, turn_id, reason, now):
    row = connection.execute("SELECT status FROM natural_turns WHERE id=?", (turn_id,)).fetchone()
    if not row or row["status"] == "withdrawn":
        return
    connection.execute("UPDATE natural_turns SET status='withdrawn',user_content=NULL,answer=NULL,"
                       "disposition=NULL,reply_kind=NULL,evidence_ids='[]',error_code=? WHERE id=?", (reason, turn_id))
    connection.execute("UPDATE natural_proposals SET body=NULL,status='withdrawn' WHERE turn_id=?", (turn_id,))


def maintain_adoptions(connection, service, now):
    if not installed(connection):
        return
    for row in connection.execute("SELECT a.*,t.dependencies,t.source_version FROM natural_adoptions a "
                                  "JOIN natural_proposals p ON p.id=a.proposal_id "
                                  "JOIN natural_turns t ON t.id=p.turn_id WHERE a.invalidated=0").fetchall():
        if (not service._source_ok(connection, "synthetic", now, row["source_version"])
                or not dependencies_ok(connection, service, json.loads(row["dependencies"]), now, check_turns=False)):
            # Adoption grants independent goal authority; later model route or
            # conversation consent changes do not retract that authority. All
            # underlying data dependencies nevertheless remain live constraints.
            changed = connection.execute("UPDATE natural_adoptions SET invalidated=1 WHERE adoption_id=? AND invalidated=0",
                                         (row["adoption_id"],)).rowcount
            if not changed:
                continue
            goal = service._get(connection, "goals", row["goal_id"])
            service._invalidate_goal(connection, goal, "conversation_input_withdrawn", now, forget=True)


def invalidate_conversations(connection, service, reason, now):
    if not installed(connection):
        return
    connection.execute("UPDATE natural_conversations SET status='withdrawn',version=version+1,withdrawn_reason=? "
                       "WHERE status='active'", (reason,))
    for row in connection.execute("SELECT id FROM natural_turns WHERE status!='withdrawn'").fetchall():
        scrub_turn(connection, service, row["id"], reason, now)


def invalidate_goal_context(connection, service, goal_id, now):
    if not installed(connection):
        return
    for row in connection.execute("SELECT id,dependencies FROM natural_turns WHERE status!='withdrawn'").fetchall():
        if goal_id in json.loads(row["dependencies"])["goals"]:
            scrub_turn(connection, service, row["id"], "goal_context_changed", now)
    maintain_adoptions(connection, service, now)


def maintain_conversations(connection, service, now):
    if not installed(connection):
        return
    source = decode(connection.execute("SELECT * FROM sources WHERE id='synthetic'").fetchone())
    # Use the same exact-schema state validator as dispatch. Restoring a
    # control facade is inert and cannot probe or dispatch a model.
    from .planner_control import PlannerControl
    control = PlannerControl(service)
    state = control._load(connection)
    route_key = control._key(state)
    ready = not state.get("invalid") and state["confirmed"] and state["validated_configuration"] is not None
    for conv in connection.execute("SELECT * FROM natural_conversations WHERE status='active'").fetchall():
        if (not ready or conv["route_revision"] != state.get("revision") or conv["route_key"] != route_key
                or not source or not service._source_ok(connection, "synthetic", now, conv["source_version"])):
            connection.execute("UPDATE natural_conversations SET status='withdrawn',version=version+1,"
                               "withdrawn_reason='conversation_scope_changed' WHERE id=?", (conv["id"],))
    # Iterate because an invalidated adopted goal can itself be another turn's
    # explicit context. Each pass permanently withdraws at least one turn.
    changed = True
    while changed:
        changed = False
        for row in connection.execute("SELECT t.*,c.status AS consent_status,c.version AS consent_version "
                                      "FROM natural_turns t JOIN natural_conversations c ON c.id=t.conversation_id "
                                      "WHERE t.status!='withdrawn'").fetchall():
            if (row["consent_status"] != "active" or row["conversation_version"] != row["consent_version"]
                    or not dependencies_ok(connection, service, json.loads(row["dependencies"]), now)):
                scrub_turn(connection, service, row["id"], "conversation_input_withdrawn", now)
                changed = True
    maintain_adoptions(connection, service, now)
