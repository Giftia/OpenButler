"""Real literal-loopback HTTP, generated synthetic conversations only."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from app.modules.model_gateway.tests.local_provider_fixture import LocalProviderMetadata
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from app.modules.agent_runtime.conversation_model import INSTRUCTIONS, parse_response
from app.modules.agent_runtime.conversation_service import ConversationService
from app.modules.agent_runtime.models import (AuthorizationError, Conflict, NotFound, PlannerUnavailable,
                                               RuntimeErrorBase, SimulatedCrash)
from app.modules.agent_runtime.planner_control import PlannerControl
from app.modules.agent_runtime.service import RuntimeService

NOW = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)


def answer(content="Synthetic reply"):
    return {"schema_version": 1, "disposition": "answer", "answer": content, "evidence_ids": [], "proposal": None}


def proposal():
    return {"schema_version": 1, "disposition": "proposal", "answer": "Review this synthetic tracking goal before adoption.",
            "evidence_ids": [], "proposal": {"title": "Track synthetic ticket", "target_id": "synthetic-ticket-42",
            "success_event_type": "closed", "success_value": True, "deadline_at": None, "evidence_ids": [],
            "plan": {"summary": "Wait for the exact synthetic completion event.", "steps": ["Prepare local tracking.", "Wait for matching authorized evidence."]}}}


class Handler(LocalProviderMetadata, BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        state = self.server.state
        state["requests"].append(body)
        prompt = body["messages"][0]["content"]
        probe = prompt == "Reply with the word READY."
        if probe:
            content = "READY"
        else:
            if state.get("entered"):
                state["entered"].set()
                state["release"].wait(5)
            if state.get("on_request"):
                state["on_request"]()
            reply = state.get("reply", proposal())
            content = reply if isinstance(reply, str) else json.dumps(reply)
        message = {"role": "assistant", "content": content, **state.get("extra_message", {})}
        result = ({"message": message, "done": True, "done_reason": "stop"} if self.path == "/api/chat" else
                  {"choices": [{"message": message, "finish_reason": "stop"}]})
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_):
        pass


class NaturalConversationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.state = {"requests": []}
        self.tmp = tempfile.TemporaryDirectory(prefix="synthetic-conversation-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "runtime.sqlite3"
        self.now = NOW
        self.service = RuntimeService(self.path, clock=lambda: self.now)
        self.control = PlannerControl(self.service)
        self.service.planner = self.control
        self.chat = ConversationService(self.service, self.control)

    def configure(self, protocol="openai_compatible"):
        return self.control.configure(protocol=protocol, endpoint=self.base + ("/v1" if protocol == "openai_compatible" else ""),
                                      model="synthetic-text", scope="synthetic_only", confirmed=True)

    def consent(self, conversation_id="synthetic-conversation"):
        self.configure()
        source = self.service.grant_source("synthetic")
        return self.chat.consent(conversation_id, confirmed=True, expected_route_revision=self.control.configuration_revision,
                                 expected_source_version=source["version"], expected_version=None)

    def send(self, request_id="request-1", **kwargs):
        return self.chat.send("synthetic-conversation", request_id=request_id, content=kwargs.pop("content", "Track synthetic-ticket-42 until closed is true"),
                              expected_version=kwargs.pop("expected_version", 1), **kwargs)

    def adopt(self, turn, adoption_id="adopt-1"):
        return self.chat.adopt("synthetic-conversation", turn["proposal"]["id"], expected_version=1,
                              adoption_id=adoption_id, confirmed=True)

    def calls(self):
        return [entry for entry in self.server.state["requests"] if entry["messages"][0]["content"] != "Reply with the word READY."]

    def evidence(self, name="event-1", target="synthetic-ticket-42", expires=False):
        return self.service.add_evidence("synthetic", name, target, "opened", True, self.now,
                                        expires_at=self.now + timedelta(seconds=5) if expires else None)

    def reopen(self):
        self.service = RuntimeService(self.path, clock=lambda: self.now)
        self.control = PlannerControl(self.service)
        self.service.planner = self.control
        self.chat = ConversationService(self.service, self.control)

    def test_inert_default_no_implicit_consent_or_note_processing(self):
        self.assertEqual(self.chat.list_conversations(), [])
        self.assertEqual(self.server.state["requests"], [])
        self.service.append_message("legacy", "user", "Synthetic note; do not treat as a command", "note-1")
        self.configure()
        self.service.grant_source("synthetic")
        with self.assertRaises(NotFound):
            self.send()
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.service.status()["enabled"])

    def test_restart_reply_adopt_once_then_existing_runtime_followthrough(self):
        self.consent()
        turn = self.send()
        self.assertEqual(turn["status"], "completed")
        self.assertEqual(turn["proposal"]["status"], "proposed_unverified")
        self.reopen()
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1"), turn)
        result = self.adopt(turn)
        self.assertEqual(result["goal"]["status"], "active")
        self.assertFalse(self.service.status()["enabled"])
        self.assertEqual(self.adopt(turn)["receipt"], result["receipt"])
        with self.assertRaises(Conflict):
            self.adopt(turn, "different-adoption")
        self.assertEqual(len(self.service.list_goals()), 1)
        self.service.set_enabled(True)
        self.service.run_once()
        self.assertEqual(self.service.get_goal(result["goal"]["id"])["status"], "waiting_external")
        self.now += timedelta(seconds=1)
        self.service.add_evidence("synthetic", "closed-proof", "synthetic-ticket-42", "closed", True, self.now)
        self.service.run_once()
        self.assertEqual(self.service.get_goal(result["goal"]["id"])["status"], "completed")
        self.assertEqual(len(self.calls()), 1)

    def test_ambiguity_is_question_without_adoption(self):
        self.consent()
        self.server.state["reply"] = {**answer("Which synthetic target and completion condition should I track?"), "disposition": "question"}
        turn = self.send(content="Track that thing")
        self.assertEqual(turn["disposition"], "question")
        self.assertIsNone(turn["proposal"])
        with self.assertRaises(NotFound):
            self.chat.adopt("synthetic-conversation", "missing", expected_version=1, adoption_id="a", confirmed=True)
        self.assertEqual(self.service.list_goals(), [])

    def test_model_guess_for_ambiguous_input_is_forced_to_question(self):
        self.consent()
        self.server.state["reply"] = proposal()
        turn = self.send(content="Track that thing")
        self.assertEqual(turn["disposition"], "question")
        self.assertEqual(turn["reply_kind"], "clarification")
        self.assertIsNone(turn["proposal"])
        self.assertEqual(self.service.list_goals(), [])
        self.assertEqual(self.send("missing-predicate", content="Track synthetic-ticket-42")["disposition"], "question")

    def test_old_history_never_selects_target_but_explicit_basis_can(self):
        self.consent()
        self.server.state["reply"] = answer("Synthetic previous target discussed")
        self.send("history", content="Track synthetic-ticket-42 until closed is true")
        self.server.state["reply"] = proposal()
        ambiguous = self.send(content="Yes, please track it")
        self.assertEqual(ambiguous["reply_kind"], "clarification")
        self.assertIsNone(ambiguous["proposal"])
        item = self.evidence()
        selected = self.send("selected", content="Track the explicitly selected target until closed is true", evidence_ids=[item["id"]])
        self.assertEqual(selected["disposition"], "proposal")
        self.assertEqual(selected["reply_kind"], "model")

    def test_corrupted_route_record_scrubs_prior_output_without_dispatch(self):
        self.consent()
        self.send()
        with self.service.store.transaction() as connection:
            state = json.loads(connection.execute("SELECT value FROM runtime_settings WHERE key='planner_selection'").fetchone()[0])
            state["unexpected"] = True
            connection.execute("UPDATE runtime_settings SET value=? WHERE key='planner_selection'", (json.dumps(state),))
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1")["status"], "withdrawn")
        self.assertEqual(len(self.calls()), 1)

    def test_route_change_between_reservation_and_dispatch_prevents_http(self):
        self.consent()
        def change(stage):
            if stage == "after_reservation":
                self.control.select("local_model")
        self.chat.fault_hook = change
        self.assertEqual(self.send()["status"], "withdrawn")
        self.assertEqual(self.calls(), [])

    def test_source_expiry_scrubs_output_and_blocks_adoption(self):
        self.configure()
        source = self.service.grant_source("synthetic", expires_at=self.now + timedelta(seconds=5))
        self.chat.consent("synthetic-conversation", confirmed=True, expected_route_revision=1, expected_source_version=source["version"])
        turn = self.send()
        self.now += timedelta(seconds=6)
        with self.assertRaises(AuthorizationError):
            self.adopt(turn)
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1")["status"], "withdrawn")
        self.assertEqual(self.service.list_goals(), [])

    def test_goal_status_change_without_version_invalidates_history(self):
        self.consent()
        goal = self.service.create_goal("Synthetic context", "synthetic-ticket-42", "closed", True, source_ids=["synthetic"])
        goal = self.service.activate_goal(goal["id"], goal["version"])
        self.server.state["reply"] = answer("Synthetic goal is active")
        turn = self.send(goal_id=goal["id"], expected_goal_version=goal["version"])
        self.assertEqual(turn["input_goal_contexts"][0]["status"], "active")
        self.service.set_enabled(True)
        self.service.run_once()
        current = self.service.get_goal(goal["id"])
        self.assertEqual(current["version"], goal["version"])
        self.assertEqual(current["status"], "waiting_external")
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1")["status"], "withdrawn")

    def test_duplicate_request_and_changed_payload(self):
        self.consent()
        one = self.send()
        self.assertEqual(self.send(), one)
        with self.assertRaises(Conflict):
            self.send(content="Changed synthetic instruction")
        self.assertEqual(len(self.calls()), 1)

    def test_strict_response_rejects_malformed_tools_leaks_and_unknown_refs(self):
        self.consent()
        invalid = ["not json", "{}", json.dumps({**answer(), "tools": []}),
                   json.dumps({**answer(), "evidence_ids": ["unseen"]}),
                   json.dumps({**answer(), "proposal": proposal()["proposal"]}),
                   json.dumps({**answer(), "answer": "<think>hidden</think>"}),
                   json.dumps({**answer(), "answer": INSTRUCTIONS[:100]})]
        bad = proposal()
        bad["proposal"]["target_id"] = "latest"
        invalid.append(json.dumps(bad))
        for index, reply in enumerate(invalid):
            self.server.state["reply"] = reply
            turn = self.send("invalid-" + str(index))
            self.assertEqual(turn["status"], "failed")
            self.assertIsNone(turn["answer"])
            self.assertIsNone(turn["proposal"])
        self.server.state["reply"] = answer()
        self.server.state["extra_message"] = {"tool_calls": [{"function": {"name": "synthetic-tool"}}]}
        self.assertEqual(self.send("tool-envelope")["status"], "failed")

    def test_exact_synthetic_refs_and_unchosen_source_are_rejected(self):
        self.consent()
        first = self.evidence()
        self.server.state["reply"] = {**answer("Synthetic evidence received"), "evidence_ids": [first["id"]]}
        turn = self.send(evidence_ids=[first["id"]])
        self.assertEqual(turn["citations"][0]["id"], first["id"])
        self.assertEqual(turn["citations"][0]["trust"], "untrusted")
        self.service.grant_source("user_statement")
        other = self.service.add_evidence("user_statement", "user-event", "other", "closed", True, self.now)
        with self.assertRaises(AuthorizationError):
            self.send("wrong-source", evidence_ids=[other["id"]])
        self.assertEqual(len(self.calls()), 1)

    def test_expiry_scrubs_uncited_history_and_adopted_goal(self):
        self.consent()
        item = self.evidence(target="other-synthetic-target", expires=True)
        self.server.state["reply"] = answer("Synthetic source was included but not cited")
        first = self.send(evidence_ids=[item["id"]])
        self.server.state["reply"] = proposal()
        second = self.send("followup")
        self.assertEqual(second["input_evidence_ids"], [item["id"]])
        adopted = self.adopt(second)
        self.now += timedelta(seconds=6)
        self.assertEqual(self.chat.get_turn("synthetic-conversation", first["request_id"])["status"], "withdrawn")
        self.assertEqual(self.chat.get_turn("synthetic-conversation", second["request_id"])["status"], "withdrawn")
        goal = self.service.get_goal(adopted["goal"]["id"])
        self.assertEqual(goal["status"], "paused")
        self.assertEqual(goal["title"], "Source removed")
        self.assertEqual(goal["source_ids"], [])
        self.assertEqual(self.chat.get_adoption("synthetic-conversation", "adopt-1")["receipt"]["goal_id"], goal["id"])

    def test_route_changes_withdraw_chat_but_preserve_independent_adopted_goal(self):
        self.consent()
        turn = self.send()
        goal = self.adopt(turn)["goal"]
        self.configure("ollama_native")
        self.assertEqual(self.chat.get_conversation("synthetic-conversation")["status"], "withdrawn")
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1")["status"], "withdrawn")
        self.assertEqual(self.service.get_goal(goal["id"])["status"], "active")
        with self.assertRaises(AuthorizationError):
            self.send("after-route")
        self.assertEqual(len(self.calls()), 1)

    def test_source_delete_scrubs_chat_not_legacy_notes(self):
        self.consent()
        self.service.append_message("legacy", "user", "Synthetic legacy note", "legacy-1")
        self.send()
        self.service.delete_source("synthetic")
        current = self.chat.get_conversation("synthetic-conversation")
        self.assertEqual(current["status"], "withdrawn")
        self.assertIsNone(current["turns"][0]["user_content"])
        self.assertIsNone(current["turns"][0]["answer"])
        self.assertEqual(self.service.list_messages("legacy")[0]["content"], "Synthetic legacy note")
        with self.service.store.read() as db:
            self.assertIsNone(db.execute("SELECT body FROM natural_proposals").fetchone()[0])

    def test_explicit_consent_revoke_does_not_reexpand_on_source_regrant(self):
        self.consent()
        turn = self.send()
        self.chat.revoke("synthetic-conversation", expected_version=1)
        self.service.revoke_source("synthetic")
        source = self.service.grant_source("synthetic")
        self.assertEqual(self.chat.get_conversation("synthetic-conversation")["status"], "revoked")
        with self.assertRaises(AuthorizationError):
            self.send("new-request", expected_version=2)
        renewed = self.chat.consent("synthetic-conversation", confirmed=True, expected_version=2,
            expected_source_version=source["version"], expected_route_revision=self.control.configuration_revision)
        self.assertEqual(renewed["version"], 3)
        self.assertEqual(renewed["turns"][0]["status"], "withdrawn")

    def test_explicit_goal_context_version_no_latest_and_cancel_dependency(self):
        self.consent()
        context = self.service.create_goal("Synthetic context", "context-42", "closed", True, source_ids=["synthetic"])
        with self.assertRaises(RuntimeErrorBase):
            self.send(goal_id=context["id"])
        turn = self.send(goal_id=context["id"], expected_goal_version=context["version"])
        self.assertEqual(turn["input_goal_contexts"][0]["id"], context["id"])
        derived = self.adopt(turn)["goal"]
        self.service.control_goal(context["id"], "cancel", context["version"])
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1")["status"], "withdrawn")
        self.assertEqual(self.service.get_goal(derived["id"])["status"], "paused")

    def test_adopted_goal_pause_and_cancel_use_existing_controls(self):
        self.consent()
        goal = self.adopt(self.send())["goal"]
        paused = self.service.control_goal(goal["id"], "pause", goal["version"])
        cancelled = self.service.control_goal(goal["id"], "cancel", paused["version"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.adopt(self.chat.get_turn("synthetic-conversation", "request-1"))["goal"]["status"], "cancelled")
        self.assertFalse(self.service.status()["enabled"])

    def test_after_reservation_crash_unknown_requires_explicit_retry(self):
        self.consent()
        def crash(stage):
            if stage == "after_reservation":
                raise SimulatedCrash()
        self.chat.fault_hook = crash
        with self.assertRaises(SimulatedCrash):
            self.send()
        self.reopen()
        self.assertEqual(self.send()["status"], "outcome_unknown")
        self.assertEqual(self.calls(), [])
        with self.assertRaises(Conflict):
            self.send("retry", retry_of="request-1")
        self.now += timedelta(seconds=16)
        self.assertEqual(self.send("retry", retry_of="request-1")["status"], "completed")
        self.assertEqual(self.send()["status"], "outcome_unknown")
        self.assertEqual(len(self.calls()), 1)

    def test_process_death_after_http_never_resends_automatically(self):
        self.consent()
        script = '''import os,sys
from datetime import datetime
from app.modules.agent_runtime.service import RuntimeService
from app.modules.agent_runtime.planner_control import PlannerControl
from app.modules.agent_runtime.conversation_service import ConversationService
s=RuntimeService(sys.argv[1],clock=lambda:datetime.fromisoformat(sys.argv[2])); p=PlannerControl(s)
def fault(stage):
 if stage=='after_dispatch': os._exit(23)
c=ConversationService(s,p,fault_hook=fault)
c.send('synthetic-conversation',request_id='request-1',content='Track synthetic-ticket-42 until closed is true',expected_version=1)
'''
        result = subprocess.run([sys.executable, "-c", script, str(self.path), self.now.isoformat()], timeout=10, capture_output=True)
        self.assertEqual(result.returncode, 23, result.stderr.decode())
        self.assertEqual(len(self.calls()), 1)
        self.reopen()
        self.assertEqual(self.send()["status"], "outcome_unknown")
        self.assertEqual(self.service.list_goals(), [])
        self.assertEqual(len(self.calls()), 1)

    def test_lost_reply_and_lost_adoption_response_reconcile_committed_results(self):
        self.consent()
        def crash(stage):
            if stage == "after_reply_commit":
                raise SimulatedCrash()
        self.chat.fault_hook = crash
        with self.assertRaises(SimulatedCrash):
            self.send()
        self.reopen()
        turn = self.send()
        self.assertEqual(turn["status"], "completed")
        def adoption_crash(stage):
            if stage == "after_adoption_commit":
                raise SimulatedCrash()
        self.chat.fault_hook = adoption_crash
        with self.assertRaises(SimulatedCrash):
            self.adopt(turn)
        self.reopen()
        result = self.chat.get_adoption("synthetic-conversation", "adopt-1")
        self.assertTrue(result["replayed"])
        self.assertEqual(self.adopt(turn)["receipt"], result["receipt"])
        self.assertEqual(len(self.service.list_goals()), 1)
        self.assertEqual(len(self.calls()), 1)

    def test_before_adoption_commit_rolls_back_goal_and_receipt_together(self):
        self.consent()
        turn = self.send()
        def crash(stage):
            if stage == "before_adoption_commit":
                raise SimulatedCrash()
        self.chat.fault_hook = crash
        with self.assertRaises(SimulatedCrash):
            self.adopt(turn)
        self.assertEqual(self.service.list_goals(), [])
        with self.assertRaises(NotFound):
            self.chat.get_adoption("synthetic-conversation", "adopt-1")
        self.chat.fault_hook = None
        self.assertEqual(self.adopt(turn)["goal"]["status"], "active")

    def test_source_withdrawal_between_reservation_and_dispatch_blocks_http(self):
        self.consent()
        def revoke(stage):
            if stage == "after_reservation":
                self.service.revoke_source("synthetic")
        self.chat.fault_hook = revoke
        self.assertEqual(self.send()["status"], "withdrawn")
        self.assertEqual(self.calls(), [])

    def test_expiry_during_http_scrubs_output(self):
        self.consent()
        evidence = self.evidence(expires=True)
        self.server.state["on_request"] = lambda: setattr(self, "now", self.now + timedelta(seconds=6))
        turn = self.send(evidence_ids=[evidence["id"]])
        self.assertEqual(turn["status"], "withdrawn")
        self.assertIsNone(turn["answer"])
        self.assertIsNone(turn["proposal"])

    def test_withdrawal_waits_for_bounded_inflight_exchange_then_hides_result(self):
        self.consent()
        entered, release = threading.Event(), threading.Event()
        self.server.state.update(entered=entered, release=release)
        outcomes = []
        thread = threading.Thread(target=lambda: outcomes.append(self.send()))
        thread.start()
        self.assertTrue(entered.wait(2))
        revoked = threading.Event()
        withdraw = threading.Thread(target=lambda: (self.service.revoke_source("synthetic"), revoked.set()))
        withdraw.start()
        self.assertFalse(revoked.wait(.1))
        release.set()
        thread.join(4)
        withdraw.join(4)
        self.assertTrue(revoked.is_set())
        self.assertEqual(self.chat.get_turn("synthetic-conversation", "request-1")["status"], "withdrawn")
        self.assertEqual(len(self.calls()), 1)

    def test_second_distinct_send_cannot_overlap_reserved_request(self):
        self.consent()
        outcomes = []
        def second(stage):
            if stage == "after_reservation":
                other = ConversationService(self.service, self.control)
                with self.assertRaises(Conflict):
                    outcomes.append(other.send("synthetic-conversation", request_id="parallel", content="Synthetic second", expected_version=1))
        self.chat.fault_hook = second
        self.assertEqual(self.send()["status"], "completed")
        self.assertEqual(outcomes, [])
        self.assertEqual(len(self.calls()), 1)

    def test_send_refuses_outer_transaction(self):
        self.consent()
        with self.service.store.transaction():
            with self.assertRaises(RuntimeErrorBase):
                self.send()
        self.assertEqual(self.calls(), [])

    def test_original_retry_context_preserved_separate_from_history_dependencies(self):
        self.consent()
        first, second = self.evidence("one"), self.evidence("two")
        self.server.state["reply"] = answer()
        self.send("prior", evidence_ids=[first["id"]])
        self.server.state["reply"] = "malformed"
        failed = self.send(evidence_ids=[second["id"]])
        self.assertEqual(failed["request_evidence_ids"], [second["id"]])
        self.assertEqual(set(failed["input_evidence_ids"]), {first["id"], second["id"]})
        self.now += timedelta(seconds=16)
        self.server.state["reply"] = answer()
        self.assertEqual(self.send("retry", evidence_ids=failed["request_evidence_ids"], retry_of="request-1")["status"], "completed")

    def test_ollama_text_only_conversation(self):
        self.configure("ollama_native")
        self.service.grant_source("synthetic")
        self.chat.consent("synthetic-conversation", confirmed=True, expected_route_revision=1, expected_source_version=1)
        self.assertEqual(self.send()["status"], "completed")
        payload = self.calls()[0]
        self.assertFalse(payload["stream"])
        self.assertEqual(len(payload["messages"]), 1)
        self.assertNotIn("images", payload["messages"][0])


if __name__ == "__main__":
    unittest.main()

