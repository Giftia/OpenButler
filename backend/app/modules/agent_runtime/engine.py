"""Bounded lease-driven local work; no scheduler is installed by this module.

Crash semantics: outbox effect, receipt and task checkpoint commit together.
Acknowledging action success is a separate transaction, so an unknown result is
resolved by reading the immutable receipt before any retry. Cancellation and
revocation serialize against the effect transaction. This is exactly-once local
outbox insertion, not a claim of exactly-once delivery to external systems.
"""
from datetime import datetime, timedelta, timezone

from .models import LOCAL_ACTIONS, PlanProposal, PlannerBudgetExceeded, PlannerDecision, PlannerUnavailable, RuntimeErrorBase, timestamp
from .store import decode, encode, new_id

MESSAGES = {
    "prepare": "已准备获批的本地计划。",
    "started": "目标已启用，正在等待与完成条件匹配的新依据。",
    "completion": "新的已授权依据与目标完成条件匹配，已记录为完成；这不代表已核验外部系统。",
    "deadline": "截止时间已到，仍未收到匹配的完成依据。请查看、调整或取消此目标。",
}
ACTION_KINDS = {"prepare": "prepare_plan", "started": "inbox_notice", "completion": "inbox_notice", "deadline": "ask_user"}


def later(now, seconds):
    return timestamp(datetime.fromisoformat(now) + timedelta(seconds=seconds))


class RuntimeEngine:
    def __init__(self, service):
        self.s = service
        self.store = service.store

    def _hook(self, stage, value):
        if self.s.fault_hook:
            self.s.fault_hook(stage, value)

    def run_once(self, max_wakes=10):
        if type(max_wakes) is not int or not 1 <= max_wakes <= 100:
            raise RuntimeErrorBase("max_wakes must be between 1 and 100")
        if getattr(self.s, "rc_goal_automation_unavailable", False):
            return self.s.automation_blocked()
        now = self.s.now()
        run_id = new_id("run")
        with self.store.transaction() as connection:
            self.s._maintenance(connection, now)
            settings = self.store.settings(connection)
            reason = "disabled" if not settings["enabled"] else ("quiet_hours" if settings["quiet_until"] and settings["quiet_until"] > now else None)
            if reason:
                return {"id": None, "status": "blocked", "reason": reason, "processed_wakes": 0, "executed_actions": 0}
            connection.execute("INSERT INTO runs (id,status,started_at,lease_until) VALUES (?,'running',?,?)", (run_id, now, later(now, 60)))
        processed = executed = 0
        try:
            for _ in range(max_wakes):
                claimed = self._claim_wake(run_id)
                if not claimed:
                    break
                processed += 1
                self._process_wake(claimed, run_id)
            for _ in range(settings["max_actions_per_run"]):
                claimed = self._claim_action()
                if not claimed:
                    break
                executed += int(self._execute_action(claimed))
            with self.store.transaction() as connection:
                now = self.s.now()
                connection.execute("UPDATE runs SET status='completed',finished_at=?,processed_wakes=?,executed_actions=?,checkpoint=? WHERE id=?", (now, processed, executed, encode({"bounded": True, "max_wakes": max_wakes, "max_actions": settings["max_actions_per_run"]}), run_id))
                return decode(connection.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())
        except Exception as error:
            with self.store.transaction() as connection:
                connection.execute("UPDATE runs SET status='failed',finished_at=?,processed_wakes=?,executed_actions=?,error=? WHERE id=?", (self.s.now(), processed, executed, type(error).__name__, run_id))
            raise

    def _claim_wake(self, run_id):
        now = self.s.now()
        with self.store.transaction() as connection:
            self.s._maintenance(connection, now)
            settings = self.store.settings(connection)
            if not settings["enabled"] or (settings["quiet_until"] and settings["quiet_until"] > now):
                return None
            connection.execute("UPDATE wakes SET status='cancelled',reason='goal_not_active' WHERE status='queued' AND goal_id IN (SELECT id FROM goals WHERE status NOT IN ('active','waiting_external'))")
            row = connection.execute("SELECT * FROM wakes WHERE status='queued' AND due_at<=? ORDER BY due_at,created_at,id LIMIT 1", (now,)).fetchone()
            if not row:
                return None
            wake = decode(row)
            token = new_id("lease")
            connection.execute("UPDATE wakes SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='queued'", (token, later(now, 60), wake["id"]))
            connection.execute("UPDATE runs SET lease_until=?,checkpoint=? WHERE id=?", (later(now, 60), encode({"wake_id": wake["id"], "stage": "planning"}), run_id))
            wake = self.s._get(connection, "wakes", wake["id"])
            goal = self.s._get(connection, "goals", wake["goal_id"])
            source_placeholders = ",".join("?" for _ in goal["source_ids"]) or "NULL"
            evidence = [decode(item) for item in connection.execute(
                "SELECT e.* FROM evidence e JOIN sources s ON s.id=e.source_id "
                f"WHERE e.source_id IN ({source_placeholders}) AND e.target_id=? AND e.event_type=? AND e.value=? AND e.valid=1 "
                "AND e.observed_at>? AND e.observed_at<=? AND e.ingested_at>=? "
                "AND (e.expires_at IS NULL OR e.expires_at>?) "
                "AND s.status='active' AND s.scope='goal_tracking' AND s.version=e.source_version "
                "AND (s.expires_at IS NULL OR s.expires_at>?) "
                "ORDER BY e.observed_at DESC,e.id DESC LIMIT 1000",
                (*goal["source_ids"], goal["target_id"], goal["success_event_type"], encode(goal["success_value"]),
                 goal["activated_at"], now, goal["activated_at"], now, now))]
            evidence = [item for item in evidence if self._matches(connection, goal, item, now)]
            planner = self.s.planner
            return {"wake": wake, "goal": goal, "evidence": evidence,
                    "execution_epoch": settings.get("execution_epoch", 0),
                    "planner": planner,
                    "planner_revision": getattr(planner, "configuration_revision", None)}

    def _matches(self, connection, goal, evidence, now):
        return bool(goal["activated_at"] and evidence["source_id"] in goal["source_ids"]
                    and evidence["target_id"] == goal["target_id"]
                    and evidence["event_type"] == goal["success_event_type"]
                    and encode(evidence["value"]) == encode(goal["success_value"])
                    and evidence["observed_at"] > goal["activated_at"]
                    and evidence["ingested_at"] >= goal["activated_at"]
                    and self.s._evidence_ok(connection, evidence, now))

    def _planner_scope(self, connection, claimed):
        """Revalidate exact current authority while holding SQLite's write lock.

        Model transport holds this transaction until its bounded call returns.
        A concurrent withdrawal therefore commits either before dispatch (no
        send), or after the already-started call finishes. It cannot retract
        bytes already sent. The separate apply transaction validates again.
        """
        now = self.s.now()
        self.s._maintenance(connection, now)
        planner, snapshot, wake = claimed["planner"], claimed["goal"], claimed["wake"]
        current = self.s._get(connection, "wakes", wake["id"])
        goal = self.s._get(connection, "goals", snapshot["id"])
        settings = self.store.settings(connection)
        allowed_sources = getattr(planner, "allowed_sources", frozenset(goal["source_ids"]))
        if (self.s.planner is not planner
                or getattr(planner, "configuration_revision", None) != claimed["planner_revision"]
                or not settings["enabled"]
                or settings.get("execution_epoch", 0) != claimed["execution_epoch"]
                or settings["quiet_until"] and settings["quiet_until"] > now
                or current["status"] != "running" or current["lease_token"] != wake["lease_token"]
                or not current["lease_until"] or current["lease_until"] <= now
                or goal["version"] != snapshot["version"]
                or goal["plan_version"] != snapshot["plan_version"]
                or goal["status"] != snapshot["status"]
                or goal["status"] not in {"active", "waiting_external"}
                or not set(goal["source_ids"]) <= allowed_sources
                or not self.s._approval(connection, goal, now)):
            raise PlannerUnavailable("planning_scope_changed")
        for item in claimed["evidence"]:
            current_item = self.s._get(connection, "evidence", item["id"])
            if not self._matches(connection, goal, current_item, now):
                raise PlannerUnavailable("planning_evidence_changed")

    @staticmethod
    def _proposal_payload(decision, goal, claimed):
        proposal = decision.proposed_plan
        if proposal is None:
            return None
        # The kernel validates the proposal independently of the model adapter.
        # No planner may use generated text as executable action parameters.
        known = {item["id"] for item in claimed["evidence"]}
        def valid_text(value, maximum):
            return (isinstance(value, str) and bool(value.strip()) and len(value) <= maximum
                    and not any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
                    and not any(tag in value.lower() for tag in ("<think", "</think", "<analysis", "</analysis")))
        if (not isinstance(proposal, PlanProposal) or decision.disposition != "wait"
                or goal["status"] != "active"
                or not any(action.kind == "prepare_plan" and action.key == "prepare" for action in decision.actions)
                or not valid_text(proposal.summary, 500) or not isinstance(proposal.steps, tuple)
                or not 1 <= len(proposal.steps) <= 4
                or any(not valid_text(step, 160) for step in proposal.steps)
                or not isinstance(proposal.evidence_ids, tuple) or len(proposal.evidence_ids) > 8
                or any(not isinstance(ref, str) or ref not in known for ref in proposal.evidence_ids)
                or len(set(proposal.evidence_ids)) != len(proposal.evidence_ids)):
            raise RuntimeErrorBase("Planner proposal is invalid")
        return {"summary": proposal.summary, "steps": list(proposal.steps),
                "evidence_ids": list(proposal.evidence_ids), "status": "proposed_unverified",
                "authored_by": "planner", "executable": False}

    def _process_wake(self, claimed, run_id):
        wake, snapshot = claimed["wake"], claimed["goal"]
        try:
            self._hook("before_planner", snapshot)
            planner = claimed["planner"]
            guarded = getattr(planner, "decide_guarded", None)
            if callable(guarded):
                # Lock order is always DB -> Gateway. Never hold a Gateway
                # dispatch lock while acquiring a new Store transaction.
                reservation_args = {}
                reserve = getattr(planner, "reserve_attempt", None)
                if callable(reserve):
                    # Commit quota reservation before entering transport. A
                    # killed process cannot roll a sent request out of budget.
                    with self.store.transaction() as connection:
                        self._planner_scope(connection, claimed)
                        reservation = reserve(connection, claimed["planner_revision"])
                    reservation_args["attempt_reservation"] = reservation
                planning_error = None
                with self.store.transaction() as connection:
                    def validate_scope():
                        self._planner_scope(connection, claimed)
                    try:
                        validate_scope()
                        decision = guarded(dict(snapshot), list(claimed["evidence"]), self.s.now(),
                                           dispatch_precondition=validate_scope, **reservation_args)
                        validate_scope()
                    except Exception as error:
                        # Commit conservative attempt budgets and maintenance
                        # even when the provider fails; generated effects are
                        # never applied in this transaction.
                        planning_error = error
                if planning_error is not None:
                    raise planning_error
            else:
                decision = planner.decide(dict(snapshot), list(claimed["evidence"]), self.s.now())
            if not isinstance(decision, PlannerDecision) or decision.disposition not in {"wait", "complete"}:
                raise RuntimeErrorBase("Planner returned an unsupported decision")
            self._hook("after_planner", snapshot)
            with self.store.transaction() as connection:
                now = self.s.now()
                self.s._maintenance(connection, now)
                current_wake = self.s._get(connection, "wakes", wake["id"])
                goal = self.s._get(connection, "goals", snapshot["id"])
                settings = self.store.settings(connection)
                if callable(guarded):
                    # Derived proposal text can depend on any supplied input,
                    # including evidence the model chose not to cite. Validate
                    # the complete snapshot again after the dispatch lock gap.
                    self._planner_scope(connection, claimed)
                if current_wake["status"] != "running" or current_wake["lease_token"] != wake["lease_token"]:
                    return
                if (not settings["enabled"] or settings.get("execution_epoch", 0) != claimed["execution_epoch"]
                        or self.s.planner is not claimed["planner"]
                        or getattr(self.s.planner, "configuration_revision", None) != claimed["planner_revision"]):
                    connection.execute("UPDATE wakes SET status='queued',lease_token=NULL,lease_until=NULL,reason='runtime_paused' WHERE id=?", (wake["id"],))
                    return
                if (goal["version"] != snapshot["version"] or goal["plan_version"] != snapshot["plan_version"]
                        or goal["status"] not in {"active", "waiting_external"}):
                    connection.execute("UPDATE wakes SET status='cancelled',reason='goal_changed',lease_token=NULL,lease_until=NULL WHERE id=?", (wake["id"],))
                    return
                approval = self.s._approval(connection, goal, now)
                if not approval:
                    self.s._invalidate_goal(connection, goal, "approval_invalid", now)
                    return
                if settings["quiet_until"] and settings["quiet_until"] > now:
                    connection.execute("UPDATE wakes SET status='queued',due_at=?,lease_token=NULL,lease_until=NULL,reason='quiet_hours' WHERE id=?", (settings["quiet_until"], wake["id"]))
                    return
                allowed_keys = set()
                if goal["status"] == "active":
                    allowed_keys.update(("prepare", "started"))
                if goal["deadline_at"] and now >= goal["deadline_at"]:
                    allowed_keys.add("deadline")
                if decision.disposition == "complete":
                    if goal["status"] != "waiting_external" or not decision.evidence_ids:
                        raise RuntimeErrorBase("Completion needs a durable wait and explicit fresh evidence")
                    proof = [self.s._get(connection, "evidence", eid) for eid in decision.evidence_ids]
                    if not all(self._matches(connection, goal, item, now) for item in proof):
                        raise RuntimeErrorBase("Planner completion evidence failed independent verification")
                    allowed_keys = {"completion"}
                elif decision.evidence_ids:
                    raise RuntimeErrorBase("Wait decisions must not claim completion evidence")
                if len(decision.actions) > 4:
                    raise RuntimeErrorBase("Planner action budget exceeded")
                proposal = self._proposal_payload(decision, goal, claimed)
                for action in decision.actions:
                    if action.kind not in LOCAL_ACTIONS or action.key not in allowed_keys or ACTION_KINDS.get(action.key) != action.kind:
                        raise RuntimeErrorBase("Planner action is outside the approved local plan")
                    self._queue_action(connection, goal, approval, action.key, now,
                                       proposal=proposal if action.key == "prepare" else None,
                                       dependencies=[item["id"] for item in claimed["evidence"]])
                if decision.disposition == "complete":
                    checkpoint = {"stage": "verified_completion", "last_wake_id": wake["id"], "evidence_ids": list(decision.evidence_ids), "goal_version": goal["version"], "plan_version": goal["plan_version"]}
                    connection.execute("UPDATE goals SET status='completed',completed_at=?,updated_at=?,completion_evidence_ids=?,checkpoint=?,blocked_reason=NULL WHERE id=?", (now, now, encode(list(decision.evidence_ids)), encode(checkpoint), goal["id"]))
                    connection.execute("UPDATE plans SET status='completed' WHERE goal_id=? AND version=?", (goal["id"], goal["plan_version"]))
                    connection.execute("UPDATE tasks SET status='succeeded' WHERE plan_id IN (SELECT id FROM plans WHERE goal_id=? AND version=?) AND task_key='wait'", (goal["id"], goal["plan_version"]))
                    connection.execute("UPDATE wakes SET status='cancelled',reason='goal_completed' WHERE goal_id=? AND status='queued'", (goal["id"],))
                else:
                    checkpoint = {"stage": "waiting_external", "last_wake_id": wake["id"], "goal_version": goal["version"], "plan_version": goal["plan_version"], "wait_target": goal["wait_target"], "deadline_at": goal["deadline_at"]}
                    connection.execute("UPDATE goals SET status='waiting_external',updated_at=?,checkpoint=?,blocked_reason=NULL WHERE id=?", (now, encode(checkpoint), goal["id"]))
                    # Evidence may have arrived between activation and first
                    # wake. First persist the waiting checkpoint, then verify
                    # it in a separate bounded wake rather than skipping it.
                    if goal["status"] == "active" and claimed["evidence"]:
                        self.s._enqueue(connection, goal["id"], "event", f"postwait:{goal['version']}", now, now)
                connection.execute("UPDATE wakes SET status='done',lease_token=NULL,lease_until=NULL,reason=NULL WHERE id=?", (wake["id"],))
                connection.execute("UPDATE runs SET checkpoint=? WHERE id=?", (encode(checkpoint), run_id))
        except Exception as error:
            with self.store.transaction() as connection:
                self.s._maintenance(connection, self.s.now())
                current = self.s._get(connection, "wakes", wake["id"])
                if current["status"] != "running" or current["lease_token"] != wake["lease_token"]:
                    return
                now = self.s.now()
                delay = min(3600, 2 ** min(current["attempts"], 12))
                retry_at = error.reset_at if isinstance(error, PlannerBudgetExceeded) else later(now, delay)
                reason = "model_daily_budget" if isinstance(error, PlannerBudgetExceeded) else "planner_retry"
                recorder = getattr(claimed["planner"], "record_failure", None)
                if callable(recorder) and not isinstance(error, PlannerBudgetExceeded):
                    recorder(connection, claimed["planner_revision"])
                connection.execute("UPDATE wakes SET status='queued',due_at=?,lease_token=NULL,lease_until=NULL,reason=? WHERE id=?", (retry_at, reason if isinstance(error, PlannerBudgetExceeded) else type(error).__name__, wake["id"]))
                connection.execute("UPDATE goals SET blocked_reason=?,checkpoint=? WHERE id=? AND status IN ('active','waiting_external')", (reason, encode({"stage": "retry_pending", "wake_id": wake["id"], "retry_at": retry_at, "error": type(error).__name__}), snapshot["id"]))

    def _queue_action(self, connection, goal, approval, key, now, *, proposal=None, dependencies=()):
        payload = {"message": MESSAGES[key]}
        if proposal is not None:
            payload["proposal"] = proposal
            # Engine-authored dependencies include every supplied input, even
            # when the model elects not to cite it. Conservative over-redaction
            # of the bounded evidence snapshot is safer than retaining text.
            payload["proposal_dependencies"] = list(dependencies)
        idempotency_key = f"{goal['id']}:{goal['version']}:{goal['plan_version']}:{key}"
        connection.execute("INSERT OR IGNORE INTO actions (id,goal_id,goal_version,plan_version,approval_id,kind,action_key,payload,status,idempotency_key,created_at,due_at) VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?)", (new_id("action"), goal["id"], goal["version"], goal["plan_version"], approval["id"], ACTION_KINDS[key], key, encode(payload), idempotency_key, now, now))

    def _action_allowed(self, connection, action, now):
        goal = self.s._get(connection, "goals", action["goal_id"])
        approval = self.s._approval(connection, goal, now)
        allowed_status = goal["status"] in {"active", "waiting_external"} or (goal["status"] == "completed" and action["action_key"] == "completion")
        return bool(allowed_status and approval and approval["id"] == action["approval_id"]
                    and action["goal_version"] == goal["version"] and action["plan_version"] == goal["plan_version"]
                    and action["kind"] in approval["allowed_actions"] and action["kind"] in LOCAL_ACTIONS
                    and ACTION_KINDS.get(action["action_key"]) == action["kind"])

    def _policy_delay(self, connection, action, settings, now):
        if settings["quiet_until"] and settings["quiet_until"] > now:
            return settings["quiet_until"], "quiet_hours"
        if action["kind"] == "prepare_plan":
            return None
        day_start = now[:10] + "T00:00:00.000000+00:00"
        notices = connection.execute("SELECT count(*) FROM outbox WHERE kind IN ('inbox_notice','ask_user') AND created_at>=?", (day_start,)).fetchone()[0]
        if notices >= settings["daily_notice_budget"]:
            tomorrow = timestamp(datetime.fromisoformat(day_start) + timedelta(days=1))
            return tomorrow, "daily_budget"
        if settings["cooldown_seconds"]:
            last = connection.execute("SELECT max(created_at) FROM outbox WHERE kind IN ('inbox_notice','ask_user')").fetchone()[0]
            if last and later(last, settings["cooldown_seconds"]) > now:
                return later(last, settings["cooldown_seconds"]), "cooldown"
        return None

    def _claim_action(self):
        now = self.s.now()
        with self.store.transaction() as connection:
            self.s._maintenance(connection, now)
            settings = self.store.settings(connection)
            if not settings["enabled"]:
                return None
            # Scan a bounded prefix; invalid/deferred actions don't starve every
            # later goal, and no entire queue is loaded into memory.
            for row in connection.execute("SELECT * FROM actions WHERE status='queued' AND due_at<=? ORDER BY due_at,created_at,rowid LIMIT 100", (now,)).fetchall():
                action = decode(row)
                if not self._action_allowed(connection, action, now):
                    connection.execute("UPDATE actions SET status='cancelled',error='authorization_changed' WHERE id=?", (action["id"],))
                    continue
                delay = self._policy_delay(connection, action, settings, now)
                if delay:
                    connection.execute("UPDATE actions SET due_at=?,error=? WHERE id=?", (*delay, action["id"]))
                    continue
                token = new_id("lease")
                connection.execute("UPDATE actions SET status='executing',lease_token=?,lease_until=?,attempts=attempts+1,error=NULL WHERE id=?", (token, later(now, 60), action["id"]))
                return self.s._get(connection, "actions", action["id"])
        return None

    def _execute_action(self, claimed):
        self._hook("before_action", claimed)
        with self.store.transaction() as connection:
            now = self.s.now()
            self.s._maintenance(connection, now)
            action = self.s._get(connection, "actions", claimed["id"])
            receipt = connection.execute("SELECT id FROM receipts WHERE action_id=?", (action["id"],)).fetchone()
            if receipt:
                return False
            if action["status"] != "executing" or action["lease_token"] != claimed["lease_token"]:
                return False
            settings = self.store.settings(connection)
            if not settings["enabled"]:
                connection.execute("UPDATE actions SET status='queued',lease_token=NULL,lease_until=NULL WHERE id=?", (action["id"],))
                return False
            if not self._action_allowed(connection, action, now):
                connection.execute("UPDATE actions SET status='cancelled',error='authorization_changed',lease_token=NULL,lease_until=NULL WHERE id=?", (action["id"],))
                return False
            delay = self._policy_delay(connection, action, settings, now)
            if delay:
                connection.execute("UPDATE actions SET status='queued',due_at=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=?", (*delay, action["id"]))
                return False
            effect_id = new_id("effect")
            connection.execute("INSERT INTO outbox VALUES (?,?,?,?,?,?,NULL)", (effect_id, action["id"], action["goal_id"], action["kind"], MESSAGES[action["action_key"]], now))
            connection.execute("INSERT INTO receipts VALUES (?,?,?,?,?,?,?)", (new_id("receipt"), action["id"], action["idempotency_key"], "succeeded", effect_id, now, encode({"kind": action["kind"], "goal_id": action["goal_id"], "goal_version": action["goal_version"], "plan_version": action["plan_version"], "local_outbox_committed": True})))
            connection.execute("UPDATE tasks SET status='succeeded' WHERE plan_id IN (SELECT id FROM plans WHERE goal_id=? AND version=?) AND task_key=?", (action["goal_id"], action["plan_version"], action["action_key"]))
            self._hook("inside_effect_transaction", action)
        # A process can die here. The committed receipt prevents a second
        # insertion, even though action.status still says executing.
        self._hook("after_effect_commit", claimed)
        with self.store.transaction() as connection:
            connection.execute("UPDATE actions SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE id=? AND id IN (SELECT action_id FROM receipts)", (claimed["id"],))
        return True
