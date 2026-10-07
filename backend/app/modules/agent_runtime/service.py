"""Explicit local service API. Constructing it starts no worker or capture.

Only synthetic fixtures and explicitly entered user statements are accepted in
this milestone. An HTTP layer must authenticate the local user; this layer never
infers approval from a sentence, source payload, model output or notification.
"""
from datetime import datetime, timedelta
from typing import Any

from .models import (AuthorizationError, Conflict, NotFound, RuntimeErrorBase,
                     LOCAL_ACTIONS, WAKE_KINDS, timestamp, text_field, utc_now)
from .planner import DeterministicPlanner
from .store import Store, decode, encode, new_id

UNSET = object()
SOURCE_IDS = frozenset({"synthetic", "user_statement"})


class RuntimeService:
    def __init__(self, db_path, *, clock=None, planner=None, fault_hook=None):
        self.store = Store(db_path)
        self.db_path = self.store.path
        self.clock = clock or utc_now
        self.planner = planner or DeterministicPlanner()
        self.fault_hook = fault_hook

    def now(self):
        return timestamp(self.clock())

    @staticmethod
    def _get(connection, table, item_id):
        if table not in {"sources", "evidence", "goals", "actions", "wakes", "outbox"}:
            raise RuntimeErrorBase("Unsupported entity")
        result = decode(connection.execute(f"SELECT * FROM {table} WHERE id=?", (item_id,)).fetchone())
        if result is None:
            raise NotFound(f"{table} item not found")
        return result

    @staticmethod
    def _version(goal, expected_version):
        if type(expected_version) is not int or goal["version"] != expected_version:
            raise Conflict("Goal version changed; refresh and approve the current version")

    @staticmethod
    def _json(value, limit=16000):
        try:
            result = encode(value)
        except (TypeError, ValueError):
            raise RuntimeErrorBase("Value must be finite JSON") from None
        if len(result) > limit:
            raise RuntimeErrorBase("Local value is too large")
        return result

    def _source_ok(self, connection, source_id, now, version=None):
        source = decode(connection.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone())
        return bool(source and source["status"] == "active" and source["scope"] == "goal_tracking"
                    and (not source["expires_at"] or source["expires_at"] > now)
                    and (version is None or source["version"] == version))

    def _evidence_ok(self, connection, evidence, now):
        return bool(evidence["valid"] and evidence["observed_at"] <= now
                    and (not evidence["expires_at"] or evidence["expires_at"] > now)
                    and self._source_ok(connection, evidence["source_id"], now, evidence["source_version"]))

    def _approval(self, connection, goal, now):
        approval = decode(connection.execute(
            "SELECT * FROM approvals WHERE goal_id=? AND goal_version=? AND plan_version=? AND valid=1 ORDER BY rowid DESC LIMIT 1",
            (goal["id"], goal["version"], goal["plan_version"])).fetchone())
        if not approval:
            return None
        if set(approval["source_versions"]) != set(goal["source_ids"]):
            return None
        if not all(self._source_ok(connection, key, now, version) for key, version in approval["source_versions"].items()):
            return None
        if not all(self._evidence_ok(connection, self._get(connection, "evidence", eid), now) for eid in goal["evidence_ids"]):
            return None
        return approval

    def _clear_proposals(self, connection, goal_id=None):
        """Withdraw generated display text while preserving fixed effect facts."""
        sql = "SELECT id,payload FROM actions WHERE action_key='prepare'"
        args = ()
        if goal_id is not None:
            sql += " AND goal_id=?"
            args = (goal_id,)
        for row in connection.execute(sql, args).fetchall():
            payload = decode(row)["payload"]
            if "proposal" in payload:
                payload.pop("proposal")
                payload.pop("proposal_dependencies", None)
                connection.execute("UPDATE actions SET payload=? WHERE id=?", (encode(payload), row["id"]))

    def _invalidate_goal(self, connection, goal, reason, now, *, forget=False):
        self._clear_proposals(connection, goal["id"])
        connection.execute("UPDATE approvals SET valid=0,invalid_reason=? WHERE goal_id=? AND valid=1", (reason, goal["id"]))
        # Executed effects keep their immutable receipts even if acknowledgment
        # was lost. Never mislabel a committed effect as cancelled.
        connection.execute("UPDATE actions SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE goal_id=? AND id IN (SELECT action_id FROM receipts)", (goal["id"],))
        connection.execute("UPDATE actions SET status='cancelled',error=?,lease_token=NULL,lease_until=NULL WHERE goal_id=? AND status IN ('queued','executing','unknown') AND id NOT IN (SELECT action_id FROM receipts)", (reason, goal["id"]))
        connection.execute("UPDATE wakes SET status='cancelled',reason=?,lease_token=NULL,lease_until=NULL WHERE goal_id=? AND status IN ('queued','running')", (reason, goal["id"]))
        connection.execute("UPDATE plans SET status='invalidated' WHERE goal_id=? AND status='approved'", (goal["id"],))
        connection.execute("UPDATE tasks SET status='invalidated' WHERE plan_id IN (SELECT id FROM plans WHERE goal_id=?) AND status='pending'", (goal["id"],))
        next_status = "paused" if goal["status"] in {"active", "waiting_external"} else goal["status"]
        connection.execute("UPDATE goals SET status=?,blocked_reason=?,updated_at=?,version=version+1 WHERE id=?", (next_status, reason, now, goal["id"]))
        if forget:
            wake_ids = {row["id"] for row in connection.execute("SELECT id FROM wakes WHERE goal_id=?", (goal["id"],))}
            for run_row in connection.execute("SELECT id,checkpoint FROM runs").fetchall():
                checkpoint = decode(run_row)["checkpoint"]
                if checkpoint.get("last_wake_id", checkpoint.get("wake_id")) in wake_ids:
                    connection.execute("UPDATE runs SET checkpoint='{}' WHERE id=?", (run_row["id"],))
            connection.execute("UPDATE goals SET title='Source removed',target_id='deleted',success_event_type='deleted',evidence_ids='[]',source_ids='[]',completion_evidence_ids='[]',checkpoint='{}',success_value='null',wait_target='{}' WHERE id=?", (goal["id"],))

        from .conversation_store import invalidate_goal_context
        invalidate_goal_context(connection, self, goal["id"], now)

    def _invalidate_source(self, connection, source_id, reason, now, *, forget=False):
        from .conversation_store import invalidate_conversations
        if source_id == "synthetic":
            invalidate_conversations(connection, self, reason, now)
        evidence_ids = {row["id"] for row in connection.execute("SELECT id FROM evidence WHERE source_id=?", (source_id,))}
        connection.execute("UPDATE evidence SET valid=0,invalid_reason=? WHERE source_id=?", (reason, source_id))
        for row in connection.execute("SELECT * FROM assertions WHERE valid=1").fetchall():
            assertion = decode(row)
            if source_id in assertion["source_ids"] or evidence_ids.intersection(assertion["evidence_ids"]):
                connection.execute("UPDATE assertions SET valid=0 WHERE id=?", (assertion["id"],))
        for row in connection.execute("SELECT * FROM goals").fetchall():
            goal = decode(row)
            if source_id in goal["source_ids"] or evidence_ids.intersection(goal["evidence_ids"] + goal["completion_evidence_ids"]):
                self._invalidate_goal(connection, goal, reason, now, forget=forget)
        if forget:
            connection.execute("UPDATE evidence SET value='null',provenance='{}',source_event_id='deleted:' || id,target_id='deleted',event_type='deleted' WHERE source_id=?", (source_id,))
            # All derived assertions from the deleted source are erased, not
            # merely hidden; receipts contain only engine-authored local facts.
            for row in connection.execute("SELECT * FROM assertions").fetchall():
                assertion = decode(row)
                if source_id in assertion["source_ids"] or evidence_ids.intersection(assertion["evidence_ids"]):
                    connection.execute("UPDATE assertions SET statement='null',evidence_ids='[]',source_ids='[]',valid=0 WHERE id=?", (assertion["id"],))

    def _maintenance(self, connection, now):
        for row in connection.execute("SELECT id FROM sources WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?", (now,)).fetchall():
            connection.execute("UPDATE sources SET status='expired',version=version+1 WHERE id=?", (row["id"],))
            self._invalidate_source(connection, row["id"], "source_expired", now)
        expired = [row["id"] for row in connection.execute("SELECT id FROM evidence WHERE valid=1 AND expires_at IS NOT NULL AND expires_at<=?", (now,))]
        for evidence_id in expired:
            connection.execute("UPDATE evidence SET valid=0,invalid_reason='evidence_expired' WHERE id=?", (evidence_id,))
            for row in connection.execute("SELECT * FROM goals").fetchall():
                goal = decode(row)
                if evidence_id in goal["evidence_ids"] + goal["completion_evidence_ids"]:
                    self._invalidate_goal(connection, goal, "evidence_expired", now)
            for row in connection.execute("SELECT * FROM assertions WHERE valid=1").fetchall():
                if evidence_id in decode(row)["evidence_ids"]:
                    connection.execute("UPDATE assertions SET valid=0 WHERE id=?", (row["id"],))
        if expired:
            expired_ids = set(expired)
            for row in connection.execute("SELECT id,payload FROM actions WHERE action_key='prepare'").fetchall():
                payload = decode(row)["payload"]
                if expired_ids.intersection(payload.get("proposal_dependencies", [])):
                    payload.pop("proposal", None)
                    payload.pop("proposal_dependencies", None)
                    connection.execute("UPDATE actions SET payload=? WHERE id=?", (encode(payload), row["id"]))
        from .conversation_store import maintain_conversations
        maintain_conversations(connection, self, now)
        # Receipt reconciliation is safe even before a lease expires: a receipt
        # proves the only permitted local effect was already committed.
        connection.execute("UPDATE actions SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE status IN ('executing','unknown','queued') AND id IN (SELECT action_id FROM receipts)")
        connection.execute("UPDATE actions SET status='queued',lease_token=NULL,lease_until=NULL,error='recovered_uncommitted_action' WHERE status IN ('executing','unknown') AND (lease_until IS NULL OR lease_until<=?) AND id NOT IN (SELECT action_id FROM receipts)", (now,))
        connection.execute("UPDATE wakes SET status='queued',kind='recovery',lease_token=NULL,lease_until=NULL,reason='recovered_lease' WHERE status='running' AND lease_until<=?", (now,))
        connection.execute("UPDATE runs SET status='interrupted',finished_at=?,error='lease_expired' WHERE status='running' AND lease_until<=?", (now, now))

    def status(self):
        now = self.now()
        with self.store.transaction() as connection:
            self._maintenance(connection, now)
            settings = self.store.settings(connection)
            counts = {name: connection.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
                      for name in ("goals", "evidence", "actions", "receipts", "wakes", "runs")}
            counts["pending_wakes"] = connection.execute("SELECT count(*) FROM wakes WHERE status='queued'").fetchone()[0]
            counts["pending_actions"] = connection.execute("SELECT count(*) FROM actions WHERE status IN ('queued','executing','unknown')").fetchone()[0]
            counts["unread_notices"] = connection.execute("SELECT count(*) FROM outbox WHERE kind IN ('inbox_notice','ask_user') AND read_at IS NULL").fetchone()[0]
            work_due = connection.execute("SELECT min(due_at) FROM (SELECT due_at FROM wakes WHERE status='queued' UNION ALL SELECT due_at FROM actions WHERE status='queued')").fetchone()[0]
            maintenance_due = connection.execute("SELECT min(due_at) FROM (SELECT lease_until AS due_at FROM wakes WHERE status='running' UNION ALL SELECT lease_until AS due_at FROM actions WHERE status IN ('executing','unknown') UNION ALL SELECT expires_at AS due_at FROM sources WHERE status='active' AND expires_at IS NOT NULL UNION ALL SELECT expires_at AS due_at FROM evidence WHERE valid=1 AND expires_at IS NOT NULL UNION ALL SELECT lease_until AS due_at FROM runs WHERE status='running')").fetchone()[0]
            blocked = "disabled" if not settings["enabled"] else None
            if not blocked and settings["quiet_until"] and settings["quiet_until"] > now:
                blocked = "quiet_hours"
                if work_due and work_due < settings["quiet_until"]:
                    work_due = settings["quiet_until"]
            next_due = min((value for value in (work_due, maintenance_due) if value), default=None)
            if not blocked:
                pending_delay = connection.execute("SELECT error FROM actions WHERE status='queued' AND due_at>? AND error IN ('daily_budget','cooldown') ORDER BY due_at LIMIT 1", (now,)).fetchone()
                if pending_delay:
                    blocked = pending_delay["error"]
            return {"enabled": settings["enabled"], "planner": getattr(self.planner, "name", type(self.planner).__name__),
                    "next_wake_at": next_due if settings["enabled"] else None,
                    "counts": counts, "blocked_reason": blocked, "settings": settings,
                    "boundary": "local_only_no_capture_no_external_actions", "schema_version": 1}

    def set_enabled(self, enabled):
        if type(enabled) is not bool:
            raise RuntimeErrorBase("enabled must be a boolean")
        with self.store.transaction() as connection:
            now = self.now()
            self._maintenance(connection, now)
            settings = self.store.settings(connection)
            previous = settings["enabled"]
            connection.execute("UPDATE runtime_settings SET value=? WHERE key='enabled'", (encode(enabled),))
            if enabled != previous:
                connection.execute("INSERT INTO runtime_settings VALUES ('execution_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encode(settings.get("execution_epoch", 0) + 1),))
            if not enabled:
                connection.execute("UPDATE wakes SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running'")
                connection.execute("UPDATE actions SET status='queued',lease_token=NULL,lease_until=NULL WHERE status IN ('executing','unknown') AND id NOT IN (SELECT action_id FROM receipts)")
            if enabled and not previous:
                for row in connection.execute("SELECT * FROM goals WHERE status IN ('active','waiting_external')").fetchall():
                    goal = decode(row)
                    self._enqueue(connection, goal["id"], "recovery", f"enable:{new_id('epoch')}", now, now)
        return self.status()

    def configure(self, *, quiet_until=UNSET, daily_notice_budget=UNSET, cooldown_seconds=UNSET, max_actions_per_run=UNSET):
        values = {}
        if quiet_until is not UNSET:
            values["quiet_until"] = timestamp(quiet_until) if quiet_until is not None else None
        for key, value, maximum in (("daily_notice_budget", daily_notice_budget, 1000),
                                    ("cooldown_seconds", cooldown_seconds, 86400),
                                    ("max_actions_per_run", max_actions_per_run, 100)):
            if value is not UNSET:
                if type(value) is not int or not 0 <= value <= maximum or (key == "max_actions_per_run" and value == 0):
                    raise RuntimeErrorBase(f"Invalid {key}")
                values[key] = value
        with self.store.transaction() as connection:
            for key, value in values.items():
                connection.execute("UPDATE runtime_settings SET value=? WHERE key=?", (encode(value), key))
            if values:
                settings = self.store.settings(connection)
                connection.execute("INSERT INTO runtime_settings VALUES ('execution_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encode(settings.get("execution_epoch", 0) + 1),))
                # Explicit policy changes reevaluate deferred local delivery;
                # planner-failure backoff and actual time deadlines stay intact.
                connection.execute("UPDATE actions SET due_at=?,error=NULL WHERE status='queued' AND error IN ('quiet_hours','daily_budget','cooldown')", (self.now(),))
                connection.execute("UPDATE wakes SET due_at=?,reason=NULL WHERE status='queued' AND reason='quiet_hours'", (self.now(),))
        return self.status()

    def list_sources(self):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            return [decode(row) for row in connection.execute("SELECT * FROM sources ORDER BY id")]

    def grant_source(self, source_id, scope="goal_tracking", expires_at=None):
        if source_id not in SOURCE_IDS or scope != "goal_tracking":
            raise AuthorizationError("This milestone permits only synthetic or explicit user_statement goal_tracking sources")
        now = self.now()
        expires_at = timestamp(expires_at) if expires_at else None
        if expires_at and expires_at <= now:
            raise RuntimeErrorBase("Source consent expiry must be in the future")
        with self.store.transaction() as connection:
            self._maintenance(connection, now)
            source = decode(connection.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone())
            if source and source["status"] == "active" and source["scope"] == scope and source["expires_at"] == expires_at:
                return source
            version = source["version"] + 1 if source else 1
            if source:
                self._invalidate_source(connection, source_id, "source_consent_changed", now)
            connection.execute("INSERT INTO sources VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,version=excluded.version,status=excluded.status,consented_at=excluded.consented_at,expires_at=excluded.expires_at", (source_id, scope, version, "active", now, expires_at))
            return self._get(connection, "sources", source_id)

    def _change_source(self, source_id, status):
        with self.store.transaction() as connection:
            source = self._get(connection, "sources", source_id)
            if source["status"] == status:
                return source
            if source["status"] == "deleted" and status != "deleted":
                raise Conflict("Deleted source must be explicitly granted again")
            now = self.now()
            connection.execute("UPDATE sources SET status=?,version=version+1 WHERE id=?", (status, source_id))
            self._invalidate_source(connection, source_id, f"source_{status}", now, forget=status == "deleted")
            return self._get(connection, "sources", source_id)

    def revoke_source(self, source_id):
        return self._change_source(source_id, "revoked")

    def delete_source(self, source_id):
        return self._change_source(source_id, "deleted")

    def add_evidence(self, source_id, source_event_id, target_id, event_type, value, observed_at, expires_at=None, provenance=None):
        source_event_id = text_field(source_event_id, "source_event_id", 200)
        target_id = text_field(target_id, "target_id", 200)
        event_type = text_field(event_type, "event_type", 100)
        if target_id.lower() in {"latest", "last", "most_recent", "*"}:
            raise RuntimeErrorBase("An exact stable target_id is required")
        value_json = self._json(value)
        provenance_json = self._json(provenance or {})
        if not isinstance(provenance or {}, dict):
            raise RuntimeErrorBase("provenance must be an object")
        now = self.now()
        observed_at = timestamp(observed_at)
        expires_at = timestamp(expires_at) if expires_at else None
        if observed_at > now or (expires_at and expires_at <= now):
            raise RuntimeErrorBase("Evidence must be observed now or earlier and not already expired")
        if event_type == "commitment_open":
            self._candidate_value(value)  # Typed schema, not text-to-tool parsing.
        with self.store.transaction() as connection:
            self._maintenance(connection, now)
            if not self._source_ok(connection, source_id, now):
                raise AuthorizationError("Source has no current goal_tracking consent")
            existing = decode(connection.execute("SELECT * FROM evidence WHERE source_id=? AND source_event_id=?", (source_id, source_event_id)).fetchone())
            if existing:
                if (existing["target_id"], existing["event_type"], encode(existing["value"]), existing["observed_at"], existing["expires_at"], encode(existing["provenance"])) != (target_id, event_type, value_json, observed_at, expires_at, provenance_json):
                    raise Conflict("source_event_id already refers to different immutable evidence")
                if not self._evidence_ok(connection, existing, now):
                    raise Conflict("Evidence event was invalidated; use a new source event ID")
                return existing
            source = self._get(connection, "sources", source_id)
            evidence_id = new_id("ev")
            connection.execute("INSERT INTO evidence (id,source_id,source_version,source_event_id,target_id,event_type,value,observed_at,ingested_at,expires_at,provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (evidence_id, source_id, source["version"], source_event_id, target_id, event_type, value_json, observed_at, now, expires_at, provenance_json))
            connection.execute("INSERT INTO assertions VALUES (?,?,?,?,?,?,?)", (new_id("fact"), "explicit_user" if source_id == "user_statement" else "observation", encode({"target_id": target_id, "event_type": event_type, "value": value}), encode([evidence_id]), encode([source_id]), 1, now))
            evidence = self._get(connection, "evidence", evidence_id)
            if event_type == "commitment_open":
                self._discover_one(connection, evidence, now)
            for row in connection.execute("SELECT * FROM goals WHERE status IN ('active','waiting_external') AND target_id=?", (target_id,)).fetchall():
                goal = decode(row)
                if source_id in goal["source_ids"]:
                    self._enqueue(connection, goal["id"], "event", f"evidence:{evidence_id}", now, now)
            return evidence

    @staticmethod
    def _candidate_value(value):
        if not isinstance(value, dict) or not {"title", "completion_event_type", "completion_value"} <= value.keys() or value.keys() - {"title", "completion_event_type", "completion_value", "deadline_at"}:
            raise RuntimeErrorBase("commitment_open requires only title, completion_event_type, completion_value, optional deadline_at")
        text_field(value["title"], "title", 300)
        event_type = text_field(value["completion_event_type"], "completion_event_type", 100)
        if event_type == "commitment_open":
            raise RuntimeErrorBase("Completion event must differ from commitment_open")
        if value.get("deadline_at"):
            timestamp(value["deadline_at"])

    def _discover_one(self, connection, evidence, now):
        if not self._evidence_ok(connection, evidence, now) or evidence["event_type"] != "commitment_open":
            return None
        value = evidence["value"]
        self._candidate_value(value)
        key = f"evidence:{evidence['id']}"
        existing = decode(connection.execute("SELECT * FROM goals WHERE candidate_key=?", (key,)).fetchone())
        if existing:
            return existing
        goal = self._create_goal(connection, title=value["title"], target_id=evidence["target_id"],
                                 success_event_type=value["completion_event_type"], success_value=value["completion_value"],
                                 evidence_ids=[evidence["id"]], source_ids=[evidence["source_id"]],
                                 deadline_at=value.get("deadline_at"), candidate_key=key, now=now)
        connection.execute("INSERT INTO assertions VALUES (?,?,?,?,?,?,?)", (new_id("fact"), "inference", encode({"candidate_goal_id": goal["id"], "meaning": "A typed commitment may merit tracking; no authorization inferred."}), encode([evidence["id"]]), encode([evidence["source_id"]]), 1, now))
        return goal

    def discover_candidates(self):
        with self.store.transaction() as connection:
            now = self.now()
            self._maintenance(connection, now)
            goals = []
            for row in connection.execute("SELECT * FROM evidence WHERE valid=1 AND event_type='commitment_open' ORDER BY ingested_at,id").fetchall():
                goal = self._discover_one(connection, decode(row), now)
                if goal:
                    goals.append(self._goal_detail(connection, goal))
            return goals

    def _create_goal(self, connection, *, title, target_id, success_event_type, success_value, evidence_ids, source_ids, deadline_at, candidate_key, now):
        title = text_field(title, "title", 300)
        target_id = text_field(target_id, "target_id", 200)
        if target_id.lower() in {"latest", "last", "most_recent", "*"}:
            raise RuntimeErrorBase("An exact stable target_id is required")
        success_event_type = text_field(success_event_type, "success_event_type", 100)
        success_json = self._json(success_value)
        if not isinstance(evidence_ids, list) or not isinstance(source_ids, list):
            raise RuntimeErrorBase("Source and evidence IDs must be lists")
        if len(evidence_ids) > 50 or len(source_ids) > 2:
            raise RuntimeErrorBase("Too many goal references")
        evidence_ids = sorted(set(evidence_ids))
        source_ids = sorted(set(source_ids))
        for evidence_id in evidence_ids:
            evidence = self._get(connection, "evidence", evidence_id)
            if not self._evidence_ok(connection, evidence, now) or evidence["target_id"] != target_id:
                raise AuthorizationError("Goal basis must be valid authorized evidence for this exact target")
            source_ids.append(evidence["source_id"])
        source_ids = sorted(set(source_ids))
        if not source_ids or not all(self._source_ok(connection, sid, now) for sid in source_ids):
            raise AuthorizationError("Explicit authorized source IDs are required")
        deadline_at = timestamp(deadline_at) if deadline_at else None
        if candidate_key is not None:
            candidate_key = text_field(candidate_key, "candidate_key", 300)
            existing = decode(connection.execute("SELECT * FROM goals WHERE candidate_key=?", (candidate_key,)).fetchone())
            if existing:
                actual = (existing["title"], existing["target_id"], existing["success_event_type"], encode(existing["success_value"]), existing["evidence_ids"], existing["source_ids"], existing["deadline_at"])
                expected = (title, target_id, success_event_type, success_json, evidence_ids, source_ids, deadline_at)
                if actual != expected:
                    raise Conflict("candidate_key already refers to a different goal")
                return existing
        goal_id = new_id("goal")
        wait_target = {"target_id": target_id, "event_type": success_event_type, "value": success_value}
        connection.execute("INSERT INTO goals (id,candidate_key,title,target_id,success_event_type,success_value,status,source_ids,evidence_ids,deadline_at,created_at,updated_at,wait_target) VALUES (?,?,?,?,?,?,'candidate',?,?,?,?,?,?)", (goal_id, candidate_key, title, target_id, success_event_type, success_json, encode(source_ids), encode(evidence_ids), deadline_at, now, now, encode(wait_target)))
        self._new_plan(connection, self._get(connection, "goals", goal_id), now)
        return self._get(connection, "goals", goal_id)

    def create_goal(self, title, target_id, success_event_type, success_value, evidence_ids=None, source_ids=None, deadline_at=None, candidate_key=None):
        with self.store.transaction() as connection:
            now = self.now()
            self._maintenance(connection, now)
            goal = self._create_goal(connection, title=title, target_id=target_id, success_event_type=success_event_type,
                                     success_value=success_value, evidence_ids=evidence_ids or [], source_ids=source_ids or [],
                                     deadline_at=deadline_at, candidate_key=candidate_key, now=now)
            return self._goal_detail(connection, goal)

    def _new_plan(self, connection, goal, now):
        source_versions = {sid: self._get(connection, "sources", sid)["version"] for sid in goal["source_ids"]}
        plan_id = new_id("plan")
        connection.execute("INSERT INTO plans VALUES (?,?,?,?,?,?,?)", (plan_id, goal["id"], goal["plan_version"], goal["version"], "proposed", encode(source_versions), now))
        for key, kind in (("prepare", "prepare_plan"), ("started", "inbox_notice"), ("wait", "wait_for_evidence"), ("completion", "inbox_notice"), ("deadline", "ask_user")):
            connection.execute("INSERT INTO tasks VALUES (?,?,?,?,?)", (new_id("task"), plan_id, key, kind, "pending"))

    def activate_goal(self, goal_id, expected_version):
        with self.store.transaction() as connection:
            now = self.now()
            self._maintenance(connection, now)
            goal = self._get(connection, "goals", goal_id)
            self._version(goal, expected_version)
            if goal["status"] not in {"candidate", "paused"}:
                raise Conflict("Only candidate or paused goals can be explicitly activated")
            if not goal["source_ids"] or not all(self._source_ok(connection, sid, now) for sid in goal["source_ids"]):
                raise AuthorizationError("Goal sources are not currently authorized")
            if not all(self._evidence_ok(connection, self._get(connection, "evidence", eid), now) for eid in goal["evidence_ids"]):
                raise AuthorizationError("Goal basis was invalidated; create a new candidate from fresh evidence")
            # An explicit activation approves the exact current goal and plan.
            # The transition increments the version, and approval stores that
            # new version. Repeated old requests cannot re-enable a paused goal.
            new_version = goal["version"] + 1
            plan_version = goal["plan_version"]
            plan = connection.execute("SELECT status FROM plans WHERE goal_id=? AND version=?", (goal_id, plan_version)).fetchone()
            if plan["status"] == "invalidated":
                plan_version += 1
                connection.execute("UPDATE goals SET plan_version=? WHERE id=?", (plan_version, goal_id))
                self._new_plan(connection, self._get(connection, "goals", goal_id), now)
            source_versions = {sid: self._get(connection, "sources", sid)["version"] for sid in goal["source_ids"]}
            connection.execute("UPDATE approvals SET valid=0,invalid_reason='superseded' WHERE goal_id=? AND valid=1", (goal_id,))
            approval_id = new_id("approval")
            connection.execute("INSERT INTO approvals (id,goal_id,goal_version,plan_version,source_versions,allowed_actions,approved_at) VALUES (?,?,?,?,?,?,?)", (approval_id, goal_id, new_version, plan_version, encode(source_versions), encode(sorted(LOCAL_ACTIONS)), now))
            connection.execute("UPDATE goals SET status='active',version=?,activated_at=?,updated_at=?,blocked_reason=NULL,checkpoint=?,completion_evidence_ids='[]',completed_at=NULL WHERE id=?", (new_version, now, now, encode({"stage": "approved", "approval_id": approval_id, "goal_version": new_version, "plan_version": plan_version}), goal_id))
            connection.execute("UPDATE plans SET status='approved',goal_version=?,source_versions=? WHERE goal_id=? AND version=?", (new_version, encode(source_versions), goal_id, plan_version))
            self._enqueue(connection, goal_id, "user", f"activate:{new_version}", now, now)
            if goal["deadline_at"]:
                self._enqueue(connection, goal_id, "time", f"deadline:{new_version}", goal["deadline_at"], now)
            return self._goal_detail(connection, self._get(connection, "goals", goal_id))

    def update_goal(self, goal_id, expected_version, *, title=None, target_id=None, success_event_type=None, success_value=UNSET, deadline_at=UNSET):
        with self.store.transaction() as connection:
            now = self.now()
            self._maintenance(connection, now)
            goal = self._get(connection, "goals", goal_id)
            self._version(goal, expected_version)
            if goal["status"] in {"completed", "cancelled"}:
                raise Conflict("Terminal goals are immutable; create a new goal")
            if target_id is not None and target_id != goal["target_id"]:
                raise RuntimeErrorBase("Create a new candidate to change the exact target and its evidence basis")
            title = text_field(title, "title", 300) if title is not None else goal["title"]
            event_type = text_field(success_event_type, "success_event_type", 100) if success_event_type is not None else goal["success_event_type"]
            value = goal["success_value"] if success_value is UNSET else success_value
            self._json(value)
            deadline = goal["deadline_at"] if deadline_at is UNSET else (timestamp(deadline_at) if deadline_at else None)
            self._invalidate_goal(connection, goal, "goal_changed", now)
            connection.execute("UPDATE goals SET title=?,success_event_type=?,success_value=?,deadline_at=?,status='candidate',activated_at=NULL,plan_version=plan_version+1,wait_target=?,checkpoint='{}' WHERE id=?", (title, event_type, encode(value), deadline, encode({"target_id": goal["target_id"], "event_type": event_type, "value": value}), goal_id))
            goal = self._get(connection, "goals", goal_id)
            self._new_plan(connection, goal, now)
            return self._goal_detail(connection, goal)

    def control_goal(self, goal_id, operation, expected_version):
        if operation == "resume":
            return self.activate_goal(goal_id, expected_version)
        if operation not in {"pause", "cancel"}:
            raise RuntimeErrorBase("Unknown goal operation")
        with self.store.transaction() as connection:
            now = self.now()
            goal = self._get(connection, "goals", goal_id)
            self._version(goal, expected_version)
            if goal["status"] in {"completed", "cancelled"}:
                raise Conflict("Terminal goals cannot be paused or cancelled")
            self._invalidate_goal(connection, goal, "user_" + operation, now)
            connection.execute("UPDATE goals SET status=?,resume_status=? WHERE id=?", ("paused" if operation == "pause" else "cancelled", goal["status"], goal_id))
            return self._goal_detail(connection, self._get(connection, "goals", goal_id))

    def _goal_detail(self, connection, goal):
        plan = decode(connection.execute("SELECT * FROM plans WHERE goal_id=? AND version=?", (goal["id"], goal["plan_version"])).fetchone())
        if plan:
            plan["tasks"] = [decode(row) for row in connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY rowid", (plan["id"],))]
        goal["next_wake_at"] = connection.execute("SELECT min(due_at) FROM (SELECT due_at FROM wakes WHERE goal_id=? AND status='queued' UNION ALL SELECT due_at FROM actions WHERE goal_id=? AND status='queued' UNION ALL SELECT lease_until AS due_at FROM wakes WHERE goal_id=? AND status='running' UNION ALL SELECT lease_until AS due_at FROM actions WHERE goal_id=? AND status IN ('executing','unknown'))", (goal["id"],) * 4).fetchone()[0]
        unavailable = any(not self._source_ok(connection, sid, self.now()) for sid in goal["source_ids"])
        unavailable = unavailable or any(not self._evidence_ok(connection, self._get(connection, "evidence", eid), self.now()) for eid in goal["evidence_ids"])
        if unavailable:
            # Consent revocation also withdraws derived content from public
            # reads. Minimal IDs, lifecycle and action history remain visible.
            goal.update(title="Source unavailable", target_id="unavailable", success_event_type="unavailable", success_value=None,
                        evidence_ids=[], completion_evidence_ids=[], wait_target={}, checkpoint={"stage": "evidence_withdrawn"})
        goal["verification_status"] = ("withdrawn" if goal["completed_at"] and goal["blocked_reason"] else "verified") if goal["status"] == "completed" else "unverified"
        if plan:
            plan["proposal"] = None
            plan["proposal_dependencies"] = None
            if not unavailable:
                prepared = connection.execute(
                    "SELECT payload FROM actions WHERE goal_id=? AND goal_version=? AND plan_version=? "
                    "AND action_key='prepare' ORDER BY rowid DESC LIMIT 1",
                    (goal["id"], goal["version"], goal["plan_version"])).fetchone()
                if prepared:
                    payload = decode(prepared)["payload"]
                    plan["proposal"] = payload.get("proposal")
                    # Publish only the engine-authored dependency IDs, so a
                    # mixed client snapshot can also hide uncited-input drafts.
                    if plan["proposal"] is not None:
                        plan["proposal_dependencies"] = payload.get("proposal_dependencies")
        goal["plan"] = plan
        goal["approval"] = decode(connection.execute("SELECT * FROM approvals WHERE goal_id=? ORDER BY rowid DESC LIMIT 1", (goal["id"],)).fetchone())
        return goal

    def get_goal(self, goal_id):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            return self._goal_detail(connection, self._get(connection, "goals", goal_id))

    @staticmethod
    def _limit(limit):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise RuntimeErrorBase("limit must be between 1 and 1000")
        return limit

    def get_goal_by_candidate_key(self, candidate_key):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            goal = decode(connection.execute("SELECT * FROM goals WHERE candidate_key=?", (candidate_key,)).fetchone())
            if not goal:
                raise NotFound("Candidate not found")
            return self._goal_detail(connection, goal)

    def list_goals(self, limit=100):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            return [self._goal_detail(connection, decode(row)) for row in connection.execute("SELECT * FROM goals ORDER BY created_at DESC,id DESC LIMIT ?", (self._limit(limit),)).fetchall()]

    def list_evidence(self, limit=100):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            return [decode(row) for row in connection.execute("SELECT * FROM evidence WHERE valid=1 ORDER BY ingested_at DESC,id DESC LIMIT ?", (self._limit(limit),))]

    def list_assertions(self, limit=100):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            return [decode(row) for row in connection.execute("SELECT * FROM assertions WHERE valid=1 ORDER BY created_at DESC,id DESC LIMIT ?", (self._limit(limit),))]

    def _enqueue(self, connection, goal_id, kind, dedupe_key, due_at, now):
        if kind not in WAKE_KINDS:
            raise RuntimeErrorBase("Unsupported wake kind")
        dedupe_key = text_field(dedupe_key, "dedupe_key", 300)
        existing = decode(connection.execute("SELECT * FROM wakes WHERE goal_id=? AND dedupe_key=?", (goal_id, dedupe_key)).fetchone())
        if existing:
            return existing
        wake_id = new_id("wake")
        connection.execute("INSERT INTO wakes (id,goal_id,kind,dedupe_key,status,due_at,created_at) VALUES (?,?,?,?,'queued',?,?)", (wake_id, goal_id, kind, dedupe_key, due_at, now))
        return self._get(connection, "wakes", wake_id)

    def enqueue_wake(self, goal_id, kind, dedupe_key, due_at=None):
        with self.store.transaction() as connection:
            now = self.now()
            self._maintenance(connection, now)
            goal = self._get(connection, "goals", goal_id)
            if goal["status"] not in {"active", "waiting_external"}:
                raise Conflict("Only active or waiting goals accept wakes")
            return self._enqueue(connection, goal_id, kind, dedupe_key, timestamp(due_at) if due_at else now, now)

    def list_inbox(self, limit=100):
        with self.store.read() as connection:
            return [decode(row) for row in connection.execute("SELECT * FROM outbox WHERE kind IN ('inbox_notice','ask_user') ORDER BY created_at DESC,id DESC LIMIT ?", (self._limit(limit),))]

    def mark_notice_read(self, notice_id):
        with self.store.transaction() as connection:
            notice = self._get(connection, "outbox", notice_id)
            if notice["kind"] not in {"inbox_notice", "ask_user"}:
                raise NotFound("Inbox notice not found")
            connection.execute("UPDATE outbox SET read_at=COALESCE(read_at,?) WHERE id=?", (self.now(), notice_id))
            return self._get(connection, "outbox", notice_id)

    def list_runs(self, limit=100):
        with self.store.read() as connection:
            results = [decode(row) for row in connection.execute("SELECT * FROM runs ORDER BY started_at DESC,id DESC LIMIT ?", (self._limit(limit),))]
            for item in results:
                item["checkpoint"] = {key: value for key, value in item["checkpoint"].items() if key in {
                    "stage", "last_wake_id", "wake_id", "goal_version", "plan_version", "bounded", "max_wakes", "max_actions", "retry_at", "error"}}
            return results

    def list_actions(self, goal_id=None):
        with self.store.transaction() as connection:
            self._maintenance(connection, self.now())
            query = "SELECT * FROM actions" + (" WHERE goal_id=?" if goal_id else "") + " ORDER BY created_at,id"
            return [decode(row) for row in connection.execute(query, (goal_id,) if goal_id else ())]

    def list_receipts(self):
        with self.store.read() as connection:
            return [decode(row) for row in connection.execute("SELECT * FROM receipts ORDER BY created_at,id")]

    def append_message(self, conversation_id, role, content, client_message_id):
        conversation_id = text_field(conversation_id, "conversation_id", 100)
        client_message_id = text_field(client_message_id, "client_message_id", 200)
        content = text_field(content, "content", 10000)
        if role not in {"user", "assistant"}:
            raise RuntimeErrorBase("Only user and assistant conversation roles are supported")
        with self.store.transaction() as connection:
            existing = decode(connection.execute("SELECT * FROM messages WHERE conversation_id=? AND client_message_id=?", (conversation_id, client_message_id)).fetchone())
            if existing:
                if existing["content"] != content or existing["role"] != role:
                    raise Conflict("client_message_id already refers to different message content")
                return existing
            now = self.now()
            connection.execute("INSERT OR IGNORE INTO conversations VALUES (?,?)", (conversation_id, now))
            message_id = new_id("msg")
            connection.execute("INSERT INTO messages VALUES (?,?,?,?,?,?)", (message_id, conversation_id, role, content, client_message_id, now))
            return decode(connection.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone())

    def list_messages(self, conversation_id, limit=100):
        with self.store.read() as connection:
            return [decode(row) for row in connection.execute("SELECT * FROM (SELECT rowid AS sequence,* FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY sequence", (conversation_id, self._limit(limit)))]

    def run_once(self, max_wakes=10):
        from .engine import RuntimeEngine
        return RuntimeEngine(self).run_once(max_wakes=max_wakes)

