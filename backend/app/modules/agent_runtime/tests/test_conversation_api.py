"""Synthetic ASGI wiring contracts; real HTTP/model behavior is tested separately."""
from pathlib import Path
import tempfile
import unittest

from fastapi import FastAPI

from app.modules.agent_runtime.router import create_agent_runtime_router
from app.modules.agent_runtime.service import RuntimeService
from app.modules.agent_runtime.tests import test_runtime_api as existing_api_tests

TOKEN = existing_api_tests.TOKEN
from app.security.local_session import LocalSessionMiddleware, LocalSessionPolicy
from app.security.origin_policy import OriginPolicy


class ConversationsStub:
    def __init__(self, service):
        self.service = service
        self.calls = []

    def record(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs, getattr(self.service.store._local, "connection", None) is not None))
        return {"id": "synthetic-chat", "version": 1}

    def list_conversations(self):
        self.record("list")
        return []

    def get_conversation(self, conversation_id):
        return self.record("get", conversation_id)

    def consent(self, *args, **kwargs):
        return self.record("consent", *args, **kwargs)

    def revoke(self, *args, **kwargs):
        return self.record("revoke", *args, **kwargs)

    def send(self, *args, **kwargs):
        return self.record("send", *args, **kwargs)

    def get_turn(self, *args, **kwargs):
        return self.record("turn", *args, **kwargs)

    def adopt(self, *args, **kwargs):
        return self.record("adopt", *args, **kwargs)

    def get_adoption(self, *args, **kwargs):
        return self.record("adoption", *args, **kwargs)


class ConversationApiTests(unittest.TestCase):
    request = existing_api_tests.RuntimeApiTests.request

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "synthetic-runtime.sqlite3"
        self.service = RuntimeService(self.path)
        self.conversations = ConversationsStub(self.service)
        self.app = FastAPI()
        self.app.include_router(create_agent_runtime_router(self.service, command_db_path=self.path,
                                                           conversation_service=self.conversations))
        self.app.add_middleware(LocalSessionMiddleware, policy=LocalSessionPolicy("local", TOKEN, OriginPolicy.local()))

    def consent_body(self):
        return {"command_id": "grant-chat", "confirmed": True, "expected_route_revision": 2,
                "expected_source_version": 1, "expected_version": None}

    def turn_body(self):
        return {"request_id": "turn-1", "expected_version": 1, "content": "Generated sample only",
                "goal_id": None, "expected_goal_version": None, "evidence_ids": [], "retry_of": None}

    def test_session_origin_and_local_only_boundary(self):
        for path, body in [("/conversations", None), ("/conversations/synthetic-chat/turns", self.turn_body()),
                           ("/conversations/synthetic-chat/consent", self.consent_body())]:
            self.assertEqual(self.request(path, body, token=None)[0], 401)
            self.assertEqual(self.request(path, body, origin="https://untrusted.invalid")[0], 403)
        self.assertEqual(self.conversations.calls, [])

    def test_consent_is_atomic_command_and_replay_does_not_repeat(self):
        body = self.consent_body()
        code, result, headers = self.request("/conversations/synthetic-chat/consent", body)
        self.assertEqual(code, 200, result)
        self.assertIn("no-store", headers["cache-control"])
        self.assertEqual(self.conversations.calls[-1], ("consent", ("synthetic-chat",),
                         {"confirmed": True, "expected_route_revision": 2, "expected_source_version": 1,
                          "expected_version": None}, True))
        code, result, _ = self.request("/conversations/synthetic-chat/consent", body)
        self.assertEqual(code, 200)
        self.assertTrue(result["replayed"])
        self.assertEqual(len(self.conversations.calls), 1)
        self.assertEqual(self.request("/conversations/synthetic-chat/consent", {**body, "expected_route_revision": 3})[0], 409)

    def test_dispatch_and_adoption_own_their_transaction_boundaries(self):
        code, result, _ = self.request("/conversations/synthetic-chat/turns", self.turn_body())
        self.assertEqual(code, 200, result)
        self.assertEqual(self.conversations.calls[-1], ("send", ("synthetic-chat",), self.turn_body(), False))
        body = {"adoption_id": "adopt-1", "expected_version": 1, "confirmed": True}
        self.assertEqual(self.request("/conversations/synthetic-chat/proposals/proposal-1/adopt", body)[0], 200)
        self.assertEqual(self.conversations.calls[-1], ("adopt", ("synthetic-chat", "proposal-1"), body, False))
        self.assertEqual(self.request("/conversations/synthetic-chat/turns/turn-1")[0], 200)
        self.assertEqual(self.conversations.calls[-1][1], ("synthetic-chat", "turn-1"))
        self.assertEqual(self.request("/conversations/synthetic-chat/adoptions/adopt-1")[0], 200)
        self.assertEqual(self.conversations.calls[-1][1], ("synthetic-chat", "adopt-1"))

    def test_strict_input_caps_confirmation_and_identifiers(self):
        path = "/conversations/synthetic-chat/consent"
        for body in [{**self.consent_body(), "confirmed": 1}, {**self.consent_body(), "expected_version": True},
                     {k: v for k, v in self.consent_body().items() if k != "expected_version"},
                     {**self.consent_body(), "route": "https://untrusted.invalid"}]:
            self.assertEqual(self.request(path, body)[0], 422)
        path = "/conversations/synthetic-chat/turns"
        for change in [{"content": "x" * 2001}, {"evidence_ids": [f"id-{n}" for n in range(9)]},
                       {"request_id": "../escape"}, {"request_id": "x" * 101}, {"expected_version": True},
                       {"execute": True}, {"expected_goal_version": 0}, {"goal_id": "goal-1"},
                       {"expected_goal_version": 1}, {"evidence_ids": ["ev-1", "ev-1"]}]:
            self.assertEqual(self.request(path, {**self.turn_body(), **change})[0], 422)
        self.assertEqual(self.conversations.calls, [])

    def test_legacy_notes_are_separate_and_errors_are_constant(self):
        body = {"conversation_id": "legacy-notes", "client_message_id": "note-1", "content": "Generated note"}
        self.assertEqual(self.request("/chat", body)[0], 200)
        self.assertEqual(self.conversations.calls, [])
        self.assertEqual(self.service.list_messages("legacy-notes")[0]["content"], "Generated note")
        def fail(*args, **kwargs):
            raise RuntimeError("private-provider-details")
        self.conversations.send = fail
        code, result, headers = self.request("/conversations/synthetic-chat/turns", self.turn_body())
        self.assertEqual(code, 503)
        self.assertEqual(result, {"detail": "runtime_temporarily_unavailable"})
        self.assertIn("no-store", headers["cache-control"])
