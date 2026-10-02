"""Explicit synthetic natural-chat service. No constructor or read sends HTTP.

Send owns its pre-dispatch commit; never wrap it in an outer API transaction.
A committed unknown request is never automatically retried, including on restart.
Adoption is an independent, atomic, exact-proposal local-goal authorization.
"""
from datetime import datetime, timedelta
import json
import re

from . import conversation_model as model
from .conversation_store import (SCHEMA, dependencies_ok, digest, goal_projection,
                                 maintain_conversations, scrub_turn)
from .models import AuthorizationError, Conflict, NotFound, RuntimeErrorBase
from .store import decode, encode, new_id


class ConversationService:
    def __init__(self, service, planner_control, *, fault_hook=None):
        self.service, self.store, self.planner_control = service, service.store, planner_control
        self.fault_hook = fault_hook
        with self.store.read() as connection:
            connection.executescript(SCHEMA)

    @staticmethod
    def _id(value, name="id"):
        if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value) is None:
            raise RuntimeErrorBase("invalid_conversation_" + name)
        return value

    @staticmethod
    def _version(value):
        if type(value) is not int or value < 1:
            raise RuntimeErrorBase("invalid_conversation_version")
        return value

    def _fault(self, stage):
        if self.fault_hook:
            self.fault_hook(stage)

    def _maintenance(self, connection):
        self.service._maintenance(connection, self.service.now())
        maintain_conversations(connection, self.service, self.service.now())

    @staticmethod
    def _get(connection, conversation_id):
        row = connection.execute("SELECT * FROM natural_conversations WHERE id=?", (conversation_id,)).fetchone()
        if not row:
            raise NotFound("conversation_not_found")
        return dict(row)

    def _state(self, connection):
        state = self.planner_control._load(connection)
        if (state.get("invalid") or state["validated_configuration"] is None or not state["confirmed"]):
            raise AuthorizationError("validated_local_text_route_required")
        self.planner_control._adapter(state)  # strict configuration restore only
        return state

    def _authorized(self, connection, conversation, expected_version=None):
        now = self.service.now()
        state = self._state(connection)
        if (conversation["status"] != "active"
                or expected_version is not None and conversation["version"] != expected_version
                or state["revision"] != conversation["route_revision"]
                or self.planner_control._key(state) != conversation["route_key"]
                or not self.service._source_ok(connection, "synthetic", now, conversation["source_version"])):
            raise AuthorizationError("conversation_consent_stale_or_withdrawn")
        return state

    def _public_conversation(self, connection, conversation, *, turns=False):
        result = {key: conversation[key] for key in ("id", "version", "status", "route_revision", "source_version",
                                                     "created_at", "consented_at", "withdrawn_reason")}
        result.update(boundary="synthetic_loopback_only", source_expires_at=conversation["source_expires_at"],
                      route_configuration=json.loads(conversation["route_configuration"]))
        if turns:
            rows = connection.execute("SELECT * FROM (SELECT rowid AS sequence,* FROM natural_turns "
                                      "WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100) ORDER BY sequence",
                                      (conversation["id"],)).fetchall()
            result["turns"] = [self._public_turn(connection, row) for row in rows]
        return result

    def _public_turn(self, connection, row):
        result = {key: row[key] for key in ("id", "request_id", "conversation_id", "conversation_version",
                  "route_revision", "source_version", "status", "user_content", "answer", "disposition", "reply_kind", "goal_id",
                  "retry_of", "error_code", "created_at", "retry_after")}
        deps = json.loads(row["dependencies"])
        result["evidence_ids"] = json.loads(row["evidence_ids"])
        result["input_evidence_ids"] = sorted(deps["evidence"]) if row["status"] != "withdrawn" else []
        request_context = json.loads(row["request_context"])
        result["expected_goal_version"] = request_context["expected_goal_version"] if row["status"] != "withdrawn" else None
        result["request_evidence_ids"] = request_context["evidence_ids"] if row["status"] != "withdrawn" else []
        result["input_goal_contexts"] = ([goal_projection(self.service._get(connection, "goals", gid))
                                          for gid in sorted(deps["goals"])] if row["status"] != "withdrawn" else [])
        result["citations"] = []
        for eid in result["evidence_ids"]:
            evidence = self.service._get(connection, "evidence", eid)
            result["citations"].append({**{key: evidence[key] for key in ("id", "target_id", "event_type", "observed_at")},
                                        "trust": "untrusted"})
        proposal = connection.execute("SELECT * FROM natural_proposals WHERE turn_id=?", (row["id"],)).fetchone()
        result["proposal"] = None
        if proposal and proposal["body"] and row["status"] == "completed":
            result["proposal"] = {**json.loads(proposal["body"]), "id": proposal["id"], "version": proposal["version"],
                                  "status": proposal["status"], "adopted_goal_id": proposal["adopted_goal_id"]}
        return result

    def list_conversations(self):
        with self.store.transaction() as connection:
            self._maintenance(connection)
            return [self._public_conversation(connection, dict(row)) for row in connection.execute(
                "SELECT * FROM natural_conversations ORDER BY created_at DESC,id DESC LIMIT 100")]

    def get_conversation(self, conversation_id):
        self._id(conversation_id)
        with self.store.transaction() as connection:
            self._maintenance(connection)
            return self._public_conversation(connection, self._get(connection, conversation_id), turns=True)

    def consent(self, conversation_id, *, confirmed, expected_route_revision, expected_source_version, expected_version=None):
        self._id(conversation_id)
        if (confirmed is not True or type(expected_route_revision) is not int or expected_route_revision < 1
                or type(expected_source_version) is not int or expected_source_version < 1):
            raise AuthorizationError("explicit_synthetic_conversation_consent_required")
        if expected_version is not None:
            self._version(expected_version)
        with self.store.transaction() as connection:
            self._maintenance(connection)
            now, state = self.service.now(), self._state(connection)
            if (state["revision"] != expected_route_revision
                    or not self.service._source_ok(connection, "synthetic", now, expected_source_version)):
                raise Conflict("conversation_scope_changed")
            source = self.service._get(connection, "sources", "synthetic")
            existing = connection.execute("SELECT * FROM natural_conversations WHERE id=?", (conversation_id,)).fetchone()
            if existing:
                if existing["version"] != expected_version:
                    raise Conflict("conversation_version_changed")
                for row in connection.execute("SELECT id FROM natural_turns WHERE conversation_id=?", (conversation_id,)):
                    scrub_turn(connection, self.service, row["id"], "conversation_consent_replaced", now)
                connection.execute("UPDATE natural_conversations SET version=version+1,status='active',route_revision=?,"
                                   "route_key=?,source_version=?,consented_at=?,withdrawn_reason=NULL,route_configuration=?,source_expires_at=? WHERE id=?",
                                   (expected_route_revision, self.planner_control._key(state), expected_source_version, now, encode(state["configuration"]), source["expires_at"], conversation_id))
            else:
                if expected_version is not None:
                    raise Conflict("conversation_version_changed")
                connection.execute("INSERT INTO natural_conversations VALUES (?,1,'active',?,?,?,?,?,NULL,?,?)",
                                   (conversation_id, expected_route_revision, self.planner_control._key(state), expected_source_version, now, now, encode(state["configuration"]), source["expires_at"]))
            return self._public_conversation(connection, self._get(connection, conversation_id), turns=True)

    def revoke(self, conversation_id, *, expected_version):
        self._id(conversation_id)
        self._version(expected_version)
        with self.store.transaction() as connection:
            self._maintenance(connection)
            conversation = self._get(connection, conversation_id)
            if conversation["version"] != expected_version:
                raise Conflict("conversation_version_changed")
            connection.execute("UPDATE natural_conversations SET version=version+1,status='revoked',"
                               "withdrawn_reason='conversation_consent_revoked' WHERE id=?", (conversation_id,))
            for row in connection.execute("SELECT id FROM natural_turns WHERE conversation_id=?", (conversation_id,)):
                scrub_turn(connection, self.service, row["id"], "conversation_consent_revoked", self.service.now())
            return self._public_conversation(connection, self._get(connection, conversation_id), turns=True)

    def _context(self, connection, conversation_id, content, goal_id, expected_goal_version, evidence_ids):
        now = self.service.now()
        dependencies = {"evidence": {}, "goals": {}, "turns": []}
        goal = None
        if goal_id is not None:
            raw = self.service._get(connection, "goals", goal_id)
            if (raw["version"] != expected_goal_version or raw["source_ids"] != ["synthetic"]):
                raise Conflict("conversation_goal_context_changed")
            goal = goal_projection(raw)
            dependencies["goals"][goal_id] = digest(goal)
            for eid in raw["evidence_ids"]:
                evidence = self.service._get(connection, "evidence", eid)
                if not self.service._evidence_ok(connection, evidence, now):
                    raise AuthorizationError("conversation_evidence_unavailable")
                dependencies["evidence"][eid] = digest(evidence)
        selected = []
        for eid in evidence_ids:
            evidence = self.service._get(connection, "evidence", eid)
            if evidence["source_id"] != "synthetic" or not self.service._evidence_ok(connection, evidence, now):
                raise AuthorizationError("conversation_evidence_unavailable")
            dependencies["evidence"][eid] = digest(evidence)
            selected.append({key: evidence[key] for key in ("id", "source_id", "source_version", "target_id", "event_type",
                                                           "value", "observed_at", "ingested_at", "expires_at")})
        prior = list(connection.execute("SELECT * FROM natural_turns WHERE conversation_id=? AND status='completed' "
                                        "ORDER BY rowid DESC LIMIT 4", (conversation_id,)).fetchall())[::-1]
        history = [{"user": row["user_content"], "assistant": row["answer"]} for row in prior]
        while True:
            try:
                prompt = model.build_prompt(content, history, goal, selected)
                break
            except ValueError:
                if not history:
                    raise RuntimeErrorBase("conversation_context_too_large") from None
                prior.pop(0)
                history.pop(0)
        for row in prior:
            previous = json.loads(row["dependencies"])
            dependencies["evidence"].update(previous["evidence"])
            dependencies["goals"].update(previous["goals"])
            dependencies["turns"].append(row["id"])
        if len(dependencies["evidence"]) > 64 or len(dependencies["goals"]) > 16:
            raise RuntimeErrorBase("conversation_context_too_large")
        return prompt, selected, dependencies

    def send(self, conversation_id, *, request_id, content, expected_version, goal_id=None,
             expected_goal_version=None, evidence_ids=None, retry_of=None):
        self._id(conversation_id)
        self._id(request_id, "request_id")
        self._version(expected_version)
        if (not isinstance(content, str) or not content.strip() or len(content) > 2000
                or any(ord(ch) < 32 and ch not in '\n\t' or ord(ch) == 127 for ch in content)):
            raise RuntimeErrorBase("invalid_conversation_content")
        if goal_id is not None:
            self._id(goal_id, "goal_id")
            self._version(expected_goal_version)
        elif expected_goal_version is not None:
            raise RuntimeErrorBase("explicit_goal_context_required")
        if retry_of is not None:
            self._id(retry_of, "retry_of")
        evidence_ids = [] if evidence_ids is None else evidence_ids
        if (not isinstance(evidence_ids, list) or len(evidence_ids) > 8
                or any(not isinstance(eid, str) for eid in evidence_ids) or len(set(evidence_ids)) != len(evidence_ids)):
            raise RuntimeErrorBase("invalid_conversation_evidence_ids")
        for eid in evidence_ids:
            self._id(eid, "evidence_id")
        # This check is a correctness requirement, not just an optimization.
        # An outer transaction would roll back a pre-HTTP crash reservation.
        if getattr(self.store._local, "connection", None) is not None:
            raise RuntimeErrorBase("conversation_send_requires_own_transaction")
        intent = {"content": content, "expected_version": expected_version, "goal_id": goal_id,
                  "expected_goal_version": expected_goal_version, "evidence_ids": evidence_ids}
        retry_digest = digest(intent)
        intent_digest = digest({**intent, "retry_of": retry_of})
        with self.store.transaction() as connection:
            self._maintenance(connection)
            conversation = self._get(connection, conversation_id)
            existing = connection.execute("SELECT * FROM natural_turns WHERE conversation_id=? AND request_id=?",
                                          (conversation_id, request_id)).fetchone()
            if existing:
                if existing["intent_digest"] != intent_digest:
                    raise Conflict("conversation_request_payload_conflict")
                return self._public_turn(connection, existing)
            self._authorized(connection, conversation, expected_version)
            now = self.service.now()
            pending = connection.execute("SELECT request_id FROM natural_turns WHERE conversation_id=? "
                                         "AND status='outcome_unknown' AND superseded_by IS NULL AND retry_after>? LIMIT 1",
                                         (conversation_id, now)).fetchone()
            if pending:
                raise Conflict("conversation_send_in_progress")
            if retry_of is not None:
                previous = connection.execute("SELECT * FROM natural_turns WHERE conversation_id=? AND request_id=?",
                                              (conversation_id, retry_of)).fetchone()
                if (not previous or previous["status"] not in {"outcome_unknown", "failed"}
                        or previous["retry_digest"] != retry_digest or previous["superseded_by"] is not None
                        or previous["retry_after"] > now):
                    raise Conflict("conversation_retry_not_available")
                connection.execute("UPDATE natural_turns SET superseded_by=? WHERE id=?", (request_id, previous["id"]))
            prompt, selected, dependencies = self._context(connection, conversation_id, content, goal_id, expected_goal_version, evidence_ids)
            turn_id = new_id("turn")
            retry_after = (datetime.fromisoformat(now) + timedelta(seconds=15)).isoformat(timespec="microseconds")
            connection.execute("INSERT INTO natural_turns "
                "(id,conversation_id,request_id,intent_digest,retry_digest,conversation_version,route_revision,source_version,status,"
                "user_content,dependencies,request_context,goal_id,retry_of,error_code,created_at,retry_after) "
                "VALUES (?,?,?,?,?,?,?,?,'outcome_unknown',?,?,?,?,?,'dispatch_outcome_unknown',?,?)",
                (turn_id, conversation_id, request_id, intent_digest, retry_digest, conversation["version"],
                 conversation["route_revision"], conversation["source_version"], content, encode(dependencies),
                 encode({"expected_goal_version": expected_goal_version, "evidence_ids": evidence_ids}), goal_id, retry_of, now, retry_after))
        self._fault("after_reservation")
        # The reservation above has committed. Crash anywhere below preserves
        # unknown; a different process can only read it, never dispatch it.
        with self.store.transaction() as connection:
            self._maintenance(connection)
            def guard():
                conv = self._get(connection, conversation_id)
                state = self._authorized(connection, conv, expected_version)
                row = connection.execute("SELECT * FROM natural_turns WHERE id=?", (turn_id,)).fetchone()
                if (row["status"] != "outcome_unknown" or row["superseded_by"] is not None
                        or row["intent_digest"] != intent_digest or row["retry_after"] <= self.service.now()
                        or not dependencies_ok(connection, self.service, dependencies, self.service.now())):
                    raise AuthorizationError("conversation_input_withdrawn")
                return state
            try:
                state = guard()
                self._fault("before_dispatch")
                reply = model.dispatch(self.planner_control, state, prompt, selected, self.service.now(), guard)
                self._fault("after_dispatch")
                guard()
                cited = list(dict.fromkeys(reply["evidence_ids"] + (reply["proposal"]["evidence_ids"] if reply["proposal"] else [])))
                connection.execute("UPDATE natural_turns SET status='completed',answer=?,disposition=?,reply_kind=?,evidence_ids=?,error_code=NULL WHERE id=?",
                                   (reply["answer"], reply["disposition"], reply["reply_kind"], encode(cited), turn_id))
                if reply["proposal"] is not None:
                    connection.execute("INSERT INTO natural_proposals (id,turn_id,version,status,body) VALUES (?,?,1,'proposed_unverified',?)",
                                       (new_id("proposal"), turn_id, encode(reply["proposal"])))
                self._fault("before_reply_commit")
            except Exception:
                self._maintenance(connection)
                row = connection.execute("SELECT status FROM natural_turns WHERE id=?", (turn_id,)).fetchone()
                if row["status"] != "withdrawn":
                    connection.execute("UPDATE natural_turns SET status='failed',answer=NULL,disposition=NULL,reply_kind=NULL,evidence_ids='[]',"
                                       "error_code='conversation_model_unavailable' WHERE id=?", (turn_id,))
                    connection.execute("DELETE FROM natural_proposals WHERE turn_id=?", (turn_id,))
            result = self._public_turn(connection, connection.execute("SELECT * FROM natural_turns WHERE id=?", (turn_id,)).fetchone())
        self._fault("after_reply_commit")
        return result

    def get_turn(self, conversation_id, request_id):
        self._id(conversation_id)
        self._id(request_id, "request_id")
        with self.store.transaction() as connection:
            self._maintenance(connection)
            self._get(connection, conversation_id)
            row = connection.execute("SELECT * FROM natural_turns WHERE conversation_id=? AND request_id=?",
                                     (conversation_id, request_id)).fetchone()
            if not row:
                raise NotFound("conversation_turn_not_found")
            return self._public_turn(connection, row)

    def _adoption_result(self, connection, receipt, *, replayed):
        return {"receipt": {"adoption_id": receipt["adoption_id"], "proposal_id": receipt["proposal_id"],
                            "goal_id": receipt["goal_id"], "state": "completed", "created_at": receipt["created_at"]},
                "goal": self.service._goal_detail(connection, self.service._get(connection, "goals", receipt["goal_id"])),
                "replayed": replayed}

    def get_adoption(self, conversation_id, adoption_id):
        self._id(conversation_id)
        self._id(adoption_id, "adoption_id")
        with self.store.transaction() as connection:
            self._maintenance(connection)
            row = connection.execute("SELECT * FROM natural_adoptions WHERE conversation_id=? AND adoption_id=?",
                                     (conversation_id, adoption_id)).fetchone()
            if not row:
                raise NotFound("conversation_adoption_not_found")
            return self._adoption_result(connection, row, replayed=True)

    def adopt(self, conversation_id, proposal_id, *, expected_version, adoption_id, confirmed):
        self._id(conversation_id)
        self._id(proposal_id, "proposal_id")
        self._id(adoption_id, "adoption_id")
        self._version(expected_version)
        if confirmed is not True:
            raise AuthorizationError("explicit_proposal_adoption_required")
        intent = digest({"conversation_id": conversation_id, "proposal_id": proposal_id,
                         "expected_version": expected_version, "confirmed": confirmed})
        with self.store.transaction() as connection:
            self._maintenance(connection)
            receipt = connection.execute("SELECT * FROM natural_adoptions WHERE adoption_id=?", (adoption_id,)).fetchone()
            if receipt:
                if receipt["intent_digest"] != intent:
                    raise Conflict("conversation_adoption_payload_conflict")
                return self._adoption_result(connection, receipt, replayed=True)
            conv = self._get(connection, conversation_id)
            self._authorized(connection, conv)
            proposal = connection.execute("SELECT p.*,t.conversation_id,t.dependencies,t.status AS turn_status "
                "FROM natural_proposals p JOIN natural_turns t ON t.id=p.turn_id WHERE p.id=?", (proposal_id,)).fetchone()
            if not proposal or proposal["conversation_id"] != conversation_id:
                raise NotFound("conversation_proposal_not_found")
            if (proposal["version"] != expected_version or proposal["status"] != "proposed_unverified"
                    or proposal["turn_status"] != "completed" or not proposal["body"]
                    or not dependencies_ok(connection, self.service, json.loads(proposal["dependencies"]), self.service.now())):
                raise Conflict("conversation_proposal_unavailable")
            body = json.loads(proposal["body"])
            now = self.service.now()
            if body["deadline_at"] and body["deadline_at"] <= now:
                raise Conflict("conversation_proposal_deadline_expired")
            # Existing service revalidates exact target evidence and activation.
            # Uncited/cross-target context dependencies stay in natural_adoptions.
            goal = self.service.create_goal(body["title"], body["target_id"], body["success_event_type"], body["success_value"],
                evidence_ids=body["evidence_ids"], source_ids=["synthetic"], deadline_at=body["deadline_at"],
                candidate_key="conversation:" + proposal_id)
            goal = self.service.activate_goal(goal["id"], goal["version"])
            connection.execute("INSERT INTO natural_adoptions (adoption_id,intent_digest,conversation_id,proposal_id,goal_id,created_at) VALUES (?,?,?,?,?,?)",
                               (adoption_id, intent, conversation_id, proposal_id, goal["id"], now))
            connection.execute("UPDATE natural_proposals SET status='adopted',adopted_goal_id=?,adoption_id=? WHERE id=?",
                               (goal["id"], adoption_id, proposal_id))
            self._fault("before_adoption_commit")
            result = self._adoption_result(connection, connection.execute("SELECT * FROM natural_adoptions WHERE adoption_id=?", (adoption_id,)).fetchone(), replayed=False)
        self._fault("after_adoption_commit")
        return result
