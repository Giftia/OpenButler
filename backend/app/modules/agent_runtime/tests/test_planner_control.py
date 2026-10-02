"""Synthetic planner selection/control; all transport is mock or loopback HTTP."""
import asyncio
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import unittest

from fastapi import FastAPI

from app.modules.agent_runtime.command_store import RuntimeCommandStore, CommandConflict
from app.modules.agent_runtime.models import AuthorizationError, Conflict, RuntimeErrorBase, PlannerUnavailable
from app.modules.agent_runtime.planner_control import PlannerControl, SETTING_KEY
from app.modules.agent_runtime.router import create_agent_runtime_router
from app.modules.agent_runtime.service import RuntimeService
from app.modules.agent_runtime.store import encode
from app.modules.model_gateway import Gateway
from app.security.privacy_guard import PrivacyGuard

NOW = datetime(2026, 10, 2, 2, 0, tzinfo=timezone.utc)
CONFIG = {"protocol": "openai_compatible", "endpoint": "http://127.0.0.1:32123/v1",
          "model": "synthetic-text", "scope": "synthetic_only", "confirmed": True}


class SyntheticTransport:
    def __init__(self):
        self.calls = []
        self.fail_probe = False
        self.fail_plan = False
        self.on_plan = None

    def post(self, route, payload):
        self.calls.append((route, payload))
        prompt = payload["messages"][0]["content"]
        if prompt == "Reply with the word READY.":
            if self.fail_probe:
                raise OSError("never-reflect-secret-or-local-path")
            content = "READY"
        else:
            if self.on_plan:
                self.on_plan()
            if self.fail_plan:
                raise OSError("never-reflect-secret-or-local-path")
            request = json.loads(prompt)["untrusted_context"]
            goal, evidence = request["goal"], request["evidence"]
            active = goal["status"] == "active"
            done = not active and bool(evidence)
            result = {"schema_version": 1, "disposition": "complete" if done else "wait",
                      "evidence_ids": [evidence[0]["id"]] if done else [], "actions": [], "plan": None}
            if active:
                result["actions"] = [{"kind": "prepare_plan", "key": "prepare"}]
                result["plan"] = {"summary": "Track the synthetic delivery", "steps": ["Wait for synthetic evidence"], "evidence_ids": []}
            if done:
                result["actions"] = [{"kind": "inbox_notice", "key": "completion"}]
            content = json.dumps(result)
        return {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}


class PlannerControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openbutler-planner-control-")
        self.path = Path(self.temp.name) / "synthetic-runtime.sqlite3"
        self.now = NOW
        self.transport = SyntheticTransport()
        self.service = RuntimeService(self.path, clock=lambda: self.now)
        self.control = self.make_control(self.service)
        self.service.planner = self.control
        self.commands = RuntimeCommandStore(self.path, self.service.store.transaction)

    def tearDown(self):
        self.temp.cleanup()

    def make_control(self, service):
        return PlannerControl(service, gateway_factory=lambda: Gateway(PrivacyGuard(), self.transport))

    def configure(self, command_id="configure-1", **changes):
        values = {**CONFIG, **changes}
        return self.commands.execute(command_id, "configure_planner", lambda: self.control.configure(**values), payload=values)

    def goal(self, source="synthetic"):
        self.service.grant_source(source)
        goal = self.service.create_goal(title="Synthetic delivery", target_id="fixture-order",
                                        success_event_type="delivery_status", success_value="delivered",
                                        source_ids=[source])
        return self.service.activate_goal(goal["id"], goal["version"])

    def decide_reserved(self, goal):
        with self.service.store.transaction() as connection:
            token = self.control.reserve_attempt(connection, self.control.configuration_revision)
        return self.control.decide_guarded(goal, [], self.service.now(),
                                           dispatch_precondition=lambda: None, attempt_reservation=token)

    def test_constructor_reads_selection_and_idle_never_probe(self):
        self.assertEqual(self.control.status()["selected_mode"], "deterministic")
        self.assertTrue(self.control.status()["ready"])
        self.assertEqual(self.transport.calls, [])
        self.service.set_enabled(True)
        for _ in range(3):
            self.service.run_once()
            self.control.status()
        self.assertEqual(self.transport.calls, [])

    def test_configure_probe_is_explicit_and_selection_separate(self):
        result = self.configure()
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(result["selected_mode"], "deterministic")
        self.assertTrue(result["model_ready"])
        self.assertFalse(result["needs_validation"])
        self.assertFalse(self.service.status()["enabled"])
        self.assertEqual(self.control.select("local_model")["selected_mode"], "local_model")
        self.assertEqual(len(self.transport.calls), 1)
        self.service.run_once()
        self.assertEqual(len(self.transport.calls), 1)

    def test_invalid_routes_and_scope_or_missing_consent_never_send(self):
        for changed in ({"confirmed": False}, {"confirmed": 1}, {"scope": "goal_tracking"},
                        {"scope": "user_statement"}, {"scope": "masked_image"}):
            with self.assertRaises(AuthorizationError):
                self.control.configure(**{**CONFIG, **changed})
        for endpoint in ("https://api.example.test/v1", "http://10.0.0.1/v1", "http://user:secret@localhost/v1",
                         "http://localhost/v1?api_key=secret", "http://localhost/v1#secret"):
            with self.assertRaises(RuntimeErrorBase):
                self.control.configure(**{**CONFIG, "endpoint": endpoint})
        with self.assertRaises(Conflict):
            self.control.select("local_model")
        self.assertEqual(self.transport.calls, [])

    def test_command_replay_does_not_reprobe_and_changed_payload_conflicts(self):
        first = self.configure()
        self.assertTrue(self.configure()["replayed"])
        self.assertEqual(len(self.transport.calls), 1)
        with self.assertRaises(CommandConflict):
            self.configure(model="different-model")
        self.assertEqual(self.control.status()["configuration_revision"], first["configuration_revision"])
        self.assertEqual(len(self.transport.calls), 1)

    def test_failed_outer_commit_never_selects_cached_uncommitted_config(self):
        self.configure()
        self.control.select("local_model")
        before = self.control.status()
        values = {**CONFIG, "model": "uncommitted-model"}

        def fail_after_configure():
            self.control.configure(**values)
            raise RuntimeError("simulated failure after mutation before outer commit")

        with self.assertRaises(RuntimeError):
            self.commands.execute("failed-configure", "configure_planner", fail_after_configure, payload=values)
        self.assertIsNone(self.commands.get("failed-configure"))
        self.assertEqual(self.control.status(), before)
        self.configure("good-after-failed", model="committed-model")
        goal = self.goal()
        self.service.set_enabled(True)
        self.service.run_once()
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "waiting_external")
        self.assertEqual(self.transport.calls[-1][0].model, "committed-model")

    def test_failed_probe_preserves_selected_mode_without_silent_fallback(self):
        self.configure()
        self.control.select("local_model")
        self.transport.fail_probe = True
        status = self.configure("failed-probe", model="unavailable-model")
        self.assertEqual(status["selected_mode"], "local_model")
        self.assertFalse(status["ready"])
        self.assertTrue(status["needs_validation"])
        self.assertEqual(status["last_failure"], "local_text_probe_failed")
        self.assertNotIn("never-reflect", json.dumps(status))
        goal = self.goal()
        self.service.set_enabled(True)
        self.service.run_once()
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "active")
        calls = len(self.transport.calls)
        self.assertTrue(self.control.select("deterministic")["ready"])
        self.service.run_once()
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "waiting_external")
        self.assertEqual(len(self.transport.calls), calls)

    def test_restart_restores_validated_route_without_startup_probe_and_completes_wait(self):
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        self.service.run_once()
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "waiting_external")
        count = len(self.transport.calls)
        restarted = RuntimeService(self.path, clock=lambda: self.now)
        control = self.make_control(restarted)
        restarted.planner = control
        self.assertEqual(control.status()["selected_mode"], "local_model")
        self.assertTrue(control.status()["ready"])
        restarted.run_once()
        self.assertEqual(len(self.transport.calls), count)
        self.now += timedelta(seconds=1)
        restarted.add_evidence("synthetic", "synthetic-arrival", "fixture-order", "delivery_status", "delivered", self.now)
        restarted.run_once()
        self.assertEqual(restarted.get_goal(goal["id"])["status"], "completed")
        self.assertEqual(len(self.transport.calls), count + 1)
        self.assertNotEqual(self.transport.calls[-1][1]["messages"][0]["content"], "Reply with the word READY.")

    def test_user_statement_goal_never_reaches_local_model(self):
        self.configure()
        self.control.select("local_model")
        goal = self.goal(source="user_statement")
        self.service.set_enabled(True)
        self.service.run_once()
        self.assertEqual(len(self.transport.calls), 1)
        self.assertNotEqual(self.service.get_goal(goal["id"])["status"], "completed")

    def test_post_response_route_switch_rejects_result_and_clears_proposal(self):
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        switched = []

        def hook(stage, _):
            if stage == "after_planner" and not switched:
                switched.append(True)
                self.control.select("deterministic")
        self.service.fault_hook = hook
        self.service.run_once(max_wakes=1)
        result = self.service.get_goal(goal["id"])
        self.assertEqual(result["status"], "active")
        self.assertIsNone(result.get("proposed_plan"))
        self.assertEqual(self.service.list_receipts(), [])
        self.service.fault_hook = None
        self.service.run_once()
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "waiting_external")

    def test_malformed_persisted_authority_fails_closed_without_probe(self):
        self.configure()
        self.control.select("local_model")
        with self.service.store.transaction() as connection:
            raw = json.loads(connection.execute("SELECT value FROM runtime_settings WHERE key=?", (SETTING_KEY,)).fetchone()[0])
            raw["validated_configuration"]["allowed_sources"] = ["user_statement"]
            connection.execute("UPDATE runtime_settings SET value=? WHERE key=?", (encode(raw), SETTING_KEY))
        restarted = RuntimeService(self.path, clock=lambda: self.now)
        control = self.make_control(restarted)
        self.assertEqual(control.status()["selected_mode"], "local_model")
        self.assertFalse(control.status()["ready"])
        self.assertEqual(control.status()["last_failure"], "planner_configuration_invalid")
        self.assertEqual(len(self.transport.calls), 1)
        self.assertTrue(control.select("deterministic")["ready"])
        self.assertTrue(control.status()["ready"])

    def test_unparseable_persisted_selection_can_be_explicitly_reset(self):
        with self.service.store.transaction() as connection:
            connection.execute("INSERT INTO runtime_settings (key,value) VALUES (?,?)", (SETTING_KEY, "not valid JSON"))
        status = self.control.status()
        self.assertFalse(status["ready"])
        self.assertTrue(status["needs_validation"])
        self.assertEqual(status["last_failure"], "planner_configuration_invalid")
        self.assertTrue(self.control.select("deterministic")["ready"])
        self.assertTrue(self.service.status()["planner"])
        self.assertEqual(self.transport.calls, [])

    def test_pre_dispatch_cross_instance_selection_change_prevents_send(self):
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        other_service = RuntimeService(self.path, clock=lambda: self.now)
        other = self.make_control(other_service)
        changed = []
        def hook(stage, _):
            if stage == "before_planner" and not changed:
                changed.append(True)
                other.select("deterministic")
        self.service.fault_hook = hook
        self.service.run_once(max_wakes=1)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "active")
        self.assertEqual(self.control.status()["selected_mode"], "deterministic")

    def test_runtime_failure_is_durable_and_redacted_then_recovers(self):
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        self.transport.fail_plan = True
        self.service.run_once(max_wakes=1)
        status = self.control.status()
        self.assertFalse(status["ready"])
        self.assertEqual(status["selected_mode"], "local_model")
        self.assertFalse(status["needs_validation"])
        self.assertEqual(status["last_failure"], "model_planner_unavailable")
        self.assertEqual(status["daily_budget"]["used"], 1)
        self.assertNotIn("never-reflect", json.dumps(status))
        restarted = self.make_control(RuntimeService(self.path, clock=lambda: self.now))
        self.assertEqual(restarted.status()["last_failure"], "model_planner_unavailable")
        self.transport.fail_plan = False
        self.now += timedelta(seconds=20)
        self.service.run_once()
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "waiting_external")
        self.assertTrue(self.control.status()["ready"])
        self.assertIsNone(self.control.status()["last_failure"])

    def test_daily_model_attempt_quota_survives_restart_and_config_switches(self):
        from app.modules.agent_runtime.models import PlannerBudgetExceeded
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        for _ in range(20):
            self.decide_reserved(goal)
        self.assertEqual(self.control.status()["daily_budget"]["remaining"], 0)
        count = len(self.transport.calls)
        with self.assertRaises(PlannerBudgetExceeded):
            self.decide_reserved(goal)
        self.assertEqual(len(self.transport.calls), count)
        restarted = self.make_control(RuntimeService(self.path, clock=lambda: self.now))
        self.assertEqual(restarted.status()["daily_budget"]["used"], 20)
        restarted.select("deterministic")
        restarted.select("local_model")
        self.assertEqual(restarted.status()["daily_budget"]["used"], 20)
        self.configure("manual-revalidate", model="validated-next")
        self.assertEqual(self.control.status()["daily_budget"]["used"], 20)
        self.now += timedelta(days=1)
        self.decide_reserved(goal)
        self.assertEqual(self.control.status()["daily_budget"]["used"], 1)

    def test_daily_exhaustion_defers_engine_wake_to_next_day(self):
        from app.modules.agent_runtime.planner_control import USAGE_KEY
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        with self.service.store.transaction() as connection:
            connection.execute("INSERT INTO runtime_settings (key,value) VALUES (?,?)",
                               (USAGE_KEY, encode({"day": self.now.date().isoformat(), "count": 20})))
        self.service.run_once()
        self.assertEqual(len(self.transport.calls), 1)
        current = self.service.get_goal(goal["id"])
        self.assertEqual(current["status"], "active")
        self.assertEqual(current["blocked_reason"], "model_daily_budget")
        with self.service.store.read() as connection:
            wakes = connection.execute("SELECT due_at,reason FROM wakes WHERE status='queued'").fetchall()
        self.assertTrue(wakes)
        self.assertTrue(all(wake["reason"] == "model_daily_budget" for wake in wakes))
        self.assertTrue(all(wake["due_at"].startswith("2026-10-03T00:00:00") for wake in wakes))
        self.service.set_enabled(False)
        self.now += timedelta(days=1)
        self.service.run_once()
        self.assertEqual(len(self.transport.calls), 1)

    def test_reservation_requires_commit_is_one_shot_and_abandoned_slots_count(self):
        self.configure()
        self.control.select("local_model")
        goal = self.goal()
        self.service.set_enabled(True)
        with self.assertRaises(RuntimeError):
            with self.service.store.transaction() as connection:
                token = self.control.reserve_attempt(connection, self.control.configuration_revision)
                raise RuntimeError("rollback reservation")
        with self.assertRaises(PlannerUnavailable):
            self.control.decide_guarded(goal, [], self.service.now(), dispatch_precondition=lambda: None,
                                        attempt_reservation=token)
        self.assertEqual(self.control.status()["daily_budget"]["used"], 0)
        self.assertEqual(len(self.transport.calls), 1)
        with self.service.store.transaction() as connection:
            token = self.control.reserve_attempt(connection, self.control.configuration_revision)
            with self.assertRaises(PlannerUnavailable):
                self.control.decide_guarded(goal, [], self.service.now(), dispatch_precondition=lambda: None,
                                            attempt_reservation=token)
        self.assertEqual(len(self.transport.calls), 1)
        self.control.decide_guarded(goal, [], self.service.now(), dispatch_precondition=lambda: None,
                                    attempt_reservation=token)
        with self.assertRaises(PlannerUnavailable):
            self.control.decide_guarded(goal, [], self.service.now(), dispatch_precondition=lambda: None,
                                        attempt_reservation=token)
        self.assertEqual(len(self.transport.calls), 2)
        self.assertEqual(self.control.status()["daily_budget"]["used"], 1)
        with self.service.store.transaction() as connection:
            self.control.reserve_attempt(connection, self.control.configuration_revision)
        self.assertEqual(self.control.status()["daily_budget"]["used"], 2)

    def test_process_death_after_http_send_keeps_budget_charged(self):
        calls = []
        transport = SyntheticTransport()
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(body)
                response = transport.post(None, body)
                payload = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            manager = PlannerControl(self.service)
            manager.configure(**{**CONFIG, "endpoint": f"http://127.0.0.1:{server.server_port}/v1"})
            manager.select("local_model")
            self.service.planner = manager
            goal = self.goal()
            self.service.set_enabled(True)
            code = r"""
import os,sys
from datetime import datetime,timezone
from app.modules.agent_runtime.service import RuntimeService
from app.modules.agent_runtime.planner_control import PlannerControl
from app.modules.model_gateway import Gateway
from app.modules.model_gateway.gateway import HttpTransport
from app.security.privacy_guard import PrivacyGuard
class CrashAfterResponse(HttpTransport):
    def post(self,route,payload):
        response=super().post(route,payload)
        os._exit(73)
service=RuntimeService(sys.argv[1],clock=lambda:datetime(2026,10,2,2,0,tzinfo=timezone.utc))
service.planner=PlannerControl(service,gateway_factory=lambda:Gateway(PrivacyGuard(),CrashAfterResponse()))
service.run_once(max_wakes=1)
"""
            child = subprocess.run([sys.executable, "-c", code, str(self.path)], capture_output=True, timeout=15)
            self.assertEqual(child.returncode, 73, child.stderr.decode())
            self.assertEqual(len(calls), 2, "one explicit READY plus one planning request")
            self.assertEqual(manager.status()["daily_budget"]["used"], 1)
            self.now += timedelta(seconds=61)
            restarted = RuntimeService(self.path, clock=lambda: self.now)
            restarted.planner = PlannerControl(restarted)
            self.assertEqual(restarted.planner.status()["daily_budget"]["used"], 1)
            self.assertEqual(len(calls), 2, "restart/status cannot probe")
            restarted.run_once(max_wakes=1)
            self.assertEqual(restarted.planner.status()["daily_budget"]["used"], 2)
            self.assertEqual(len(calls), 3)
            self.assertEqual(restarted.get_goal(goal["id"])["status"], "waiting_external")
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)

    def test_real_loopback_http_probe_uses_text_route_only(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((self.path, body, dict(self.headers)))
                payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": "READY"}, "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            manager = PlannerControl(self.service)
            status = manager.configure(**{**CONFIG, "endpoint": f"http://127.0.0.1:{server.server_port}/v1"})
            self.assertTrue(status["model_ready"])
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], "/v1/chat/completions")
            self.assertEqual(calls[0][1]["messages"], [{"role": "user", "content": "Reply with the word READY."}])
            self.assertNotIn("Authorization", calls[0][2])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)

    def api(self, path, body=None):
        app = FastAPI()
        app.include_router(create_agent_runtime_router(self.service, command_db_path=self.path, planner_control=self.control))
        payload = json.dumps(body).encode() if body is not None else b""
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                 "method": "POST" if body is not None else "GET", "scheme": "http",
                 "path": "/api/agent-runtime" + path, "query_string": b"", "root_path": "",
                 "headers": [(b"content-type", b"application/json")], "client": ("127.0.0.1", 12345),
                 "server": ("127.0.0.1", 8000)}
        output = []
        async def receive():
            return {"type": "http.request", "body": payload, "more_body": False}
        async def send(value):
            output.append(value)
        asyncio.run(app(scope, receive, send))
        code = next(item["status"] for item in output if item["type"] == "http.response.start")
        data = json.loads(b"".join(item.get("body", b"") for item in output if item["type"] == "http.response.body"))
        return code, data

    def test_api_exact_schema_and_replay_are_safe(self):
        base = {"command_id": "api-configure", **CONFIG}
        for changes in ({"api_key": "secret"}, {"mode": "custom"}, {"thinking": True},
                        {"confirmed": 1}, {"scope": "goal_tracking"}):
            code, body = self.api("/planner/configure", {**base, **changes})
            self.assertEqual(code, 422, body)
            self.assertNotIn("secret", json.dumps(body))
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.api("/planner/configure", base)[0], 200)
        self.assertTrue(self.api("/planner/configure", base)[1]["replayed"])
        self.assertEqual(self.api("/planner/configure", {**base, "model": "changed"})[0], 409)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.api("/planner/select", {"command_id": "api-select", "mode": "local_model"})[0], 200)
        self.assertEqual(self.api("/planner")[1]["selected_mode"], "local_model")


if __name__ == "__main__":
    unittest.main()
