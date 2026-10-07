"""RC-default safety checks; no models, capture or native processes."""
from pathlib import Path
from contextlib import closing
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI
from app.modules.agent_runtime.service import RuntimeService
from app.modules.agent_runtime.private_rc import PrivateRcRuntimeService
from app.modules.agent_runtime.engine import RuntimeEngine
from app.modules.agent_runtime.models import AuthorizationError
from app.modules.agent_runtime.router import create_agent_runtime_router
from app.modules.agent_runtime.tests import test_runtime_api as api_tests
from app.modules.agent_runtime.tests.test_conversation_api import ConversationsStub


class PrivateRcTests(unittest.TestCase):
    request = api_tests.RuntimeApiTests.request

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'runtime.sqlite3'
        self.now = datetime(2026, 10, 6, 0, 0, tzinfo=timezone.utc)
        old = RuntimeService(self.path, clock=lambda: self.now)
        old.grant_source('synthetic')
        self.goal = old.create_goal('Retained original goal', 'exact-target', 'done', True,
                                    source_ids=['synthetic'])
        self.goal = old.activate_goal(self.goal['id'], self.goal['version'])
        old.append_message('notes', 'user', 'Retained manual note', 'note-1')
        old.set_enabled(True)
        self.service = PrivateRcRuntimeService(self.path, clock=lambda: self.now)
        self.conversations = ConversationsStub(self.service)
        self.app = FastAPI()
        self.app.include_router(create_agent_runtime_router(self.service, command_db_path=self.path,
                                                           conversation_service=self.conversations))

    def rows(self):
        with closing(sqlite3.connect(self.path)) as connection, connection:
            return {name: connection.execute('SELECT * FROM ' + name).fetchall() for name in
                    ['goals', 'plans', 'tasks', 'actions', 'wakes', 'outbox', 'receipts', 'runtime_settings', 'messages']}

    def test_active_legacy_goal_and_direct_engine_cannot_advance_or_mutate(self):
        before = self.rows()
        self.service.planner.decide = lambda *args: self.fail('RC must not call a planner')
        self.assertEqual(self.service.run_once()['processed_wakes'], 0)
        self.assertEqual(RuntimeEngine(self.service).run_once()['executed_actions'], 0)
        self.assertEqual(self.rows(), before)
        with self.assertRaises(AuthorizationError):
            self.service.activate_goal(self.goal['id'], self.goal['version'])
        with self.assertRaises(AuthorizationError):
            self.service.control_goal(self.goal['id'], 'resume', self.goal['version'])
        with self.assertRaises(AuthorizationError):
            self.service.set_enabled(True)
        self.assertEqual(self.rows(), before)

    def test_projection_is_unavailable_without_rewriting_data(self):
        before = self.rows()
        status = self.service.status()
        self.assertFalse(status['enabled'])
        self.assertTrue(status['rc_goal_automation_unavailable'])
        self.assertFalse(status['conversation_goal_adoption_enabled'])
        goal = self.service.get_goal(self.goal['id'])
        self.assertEqual(goal['status'], 'active')
        self.assertTrue(goal['content_withheld'])
        self.assertEqual(goal['verification_status'], 'unverified')
        self.assertNotEqual(goal['title'], 'Retained original goal')
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.service.list_messages('notes')[0]['content'], 'Retained manual note')

    def test_pause_cancel_and_disable_remain_available(self):
        paused = self.service.control_goal(self.goal['id'], 'pause', self.goal['version'])
        self.assertEqual(paused['status'], 'paused')
        cancelled = self.service.control_goal(self.goal['id'], 'cancel', paused['version'])
        self.assertEqual(cancelled['status'], 'cancelled')
        self.service.set_enabled(False)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute('SELECT title FROM goals WHERE id=?', (self.goal['id'],)).fetchone()[0], 'Retained original goal')

    def test_public_adoption_denied_before_creation_but_receipt_reads_remain(self):
        before = self.rows()
        body = {'adoption_id': 'adopt-1', 'expected_version': 1, 'confirmed': True}
        status, result, _ = self.request('/conversations/synthetic-chat/proposals/proposal-1/adopt', body)
        self.assertEqual(status, 409)
        self.assertEqual(result['detail'], 'private_rc_goal_automation_unavailable')
        self.assertEqual(self.conversations.calls, [])
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.request('/conversations/synthetic-chat/adoptions/adopt-1')[0], 200)

    def test_application_composes_rc_service_without_a_runtime_override(self):
        source = (Path(__file__).parents[3] / 'main.py').read_text()
        self.assertIn('agent_runtime = PrivateRcRuntimeService(agent_runtime_path)', source)
        self.assertNotIn('agent_runtime = RuntimeService(agent_runtime_path)', source)


    def test_model_chat_dispatch_and_derived_turn_content_are_unavailable(self):
        from app.modules.agent_runtime.conversation_service import ConversationService
        chat = ConversationService(self.service, object())
        before = self.rows()
        with self.assertRaises(AuthorizationError):
            chat.send('legacy', request_id='new-turn', content='No selected goal', expected_version=1)
        body = {'request_id': 'new-turn', 'content': 'No selected goal', 'expected_version': 1,
                'goal_id': None, 'expected_goal_version': None, 'evidence_ids': [], 'retry_of': None}
        self.assertEqual(self.request('/conversations/legacy/turns', body)[0], 409)
        self.assertEqual(self.conversations.calls, [])
        self.assertEqual(self.rows(), before)
        fields = ('id', 'request_id', 'conversation_id', 'conversation_version', 'route_revision',
                  'source_version', 'status', 'user_content', 'answer', 'disposition', 'reply_kind',
                  'goal_id', 'retry_of', 'error_code', 'created_at', 'retry_after')
        row = dict.fromkeys(fields, None)
        row.update(id='old-turn', request_id='old-turn', conversation_id='legacy', status='completed',
                   user_content='OLD DERIVED GOAL INPUT', answer='OLD VERIFIED COMPLETION CLAIM')
        original = dict(row)
        result = chat._public_turn(None, row)
        self.assertEqual(row, original)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['request_id'], 'old-turn')
        self.assertIsNone(result['answer'])
        self.assertIsNone(result['user_content'])
        self.assertEqual(result['input_goal_contexts'], [])
        self.assertEqual(result['citations'], [])

    def test_legacy_completion_notices_are_projected_without_rewriting_messages(self):
        old = RuntimeService(self.path, clock=lambda: self.now)
        old.configure(cooldown_seconds=0)
        old.run_once()
        self.now += timedelta(seconds=1)
        old.add_evidence('synthetic', 'completion-proof', 'exact-target', 'done', True, self.now)
        old.run_once()
        original = old.list_inbox()
        self.assertTrue(original)
        before = self.rows()
        projected = self.service.list_inbox()
        self.assertEqual([item['id'] for item in projected], [item['id'] for item in original])
        self.assertTrue(all('暂不展示' in item['message'] for item in projected))
        self.assertEqual(self.rows(), before)
        read = self.service.mark_notice_read(projected[0]['id'])
        self.assertIsNotNone(read['read_at'])
        self.assertIn('暂不展示', read['message'])
        with closing(sqlite3.connect(self.path)) as connection, connection:
            stored = connection.execute('SELECT message FROM outbox WHERE id=?', (read['id'],)).fetchone()[0]
        self.assertEqual(stored, original[0]['message'])


if __name__ == '__main__':
    unittest.main()
