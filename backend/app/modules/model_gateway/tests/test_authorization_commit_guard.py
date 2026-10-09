"""Synthetic transaction races; no network, model or live settings are used."""
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Event, Thread
import unittest

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.model_gateway.gateway import CallAuthorization
from app.modules.model_gateway.router import (
    ModelSettingsInput, RouteInput, create_model_settings_router,
)
from app.modules.task_activity.model_discovery import LocalModelDiscovery
from app.modules.task_activity.tests.test_model_discovery import model_source


class SyntheticTransport:
    def post(self, route, payload, *, cancel_event=None):
        image = 'images' in payload['messages'][0]
        content = ('TEST 42' if image else 'READY' if 'format' not in payload else
                   json.dumps({'proposals': [{'title': 'review synthetic plan',
                       'quote': 'I need to review synthetic plan.', 'self_assigned': True,
                       'unfinished': True, 'confidence': .95}]}))
        return {'message': {'role': 'assistant', 'content': content}, 'done': True, 'done_reason': 'stop'}


class AuthorizationCommitGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.sqlite3'
        self.mode = 'strict'
        def db():
            return sqlite3.connect(self.path, timeout=2)
        self.db = db
        with db() as conn:
            init_privacy_audit(conn)
            conn.execute('CREATE TABLE result(value TEXT)')
        self.router = create_model_settings_router(db, lambda: self.mode,
            lambda mode: setattr(self, 'mode', mode))
        self.router.gateway._transport = SyntheticTransport()
        self.endpoints = {route.path: route.endpoint for route in self.router.routes}
        self.route = RouteInput(protocol='ollama_native', mode='local',
                                endpoint='http://127.0.0.1:11434', model='synthetic')
        self.assertTrue(self.endpoints['/api/model_settings/update'](
            ModelSettingsInput(image=self.route, text=self.route))['ok'])
        self.provider = LocalModelDiscovery(self.router.gateway, self.router.current_authorization,
                                            authorization_guard=self.router.authorization_guard)

    def extract(self):
        return self.provider.extract(model_source('I need to review synthetic plan.'),
                                     validate=lambda: None, cancel_event=Event())

    def test_guard_yields_current_authorization_without_model_request(self):
        with self.router.authorization_guard() as auth:
            self.assertEqual(auth, CallAuthorization(authorized=True, redacted=True))
            self.assertTrue(self.router.gateway._dispatch_lock._is_owned())
            self.assertEqual(self.router.current_authorization(), auth)
        self.assertFalse(self.router.gateway._dispatch_lock._is_owned())

    def test_model_settings_update_cannot_pass_commit_or_invert_locks(self):
        batch = self.extract()
        started, updated, read_auth = Event(), Event(), Event()
        failures = []
        replacement = self.route.model_copy(update={'model': 'replacement-synthetic'})
        def update():
            started.set()
            try:
                result = self.endpoints['/api/model_settings/update'](
                    ModelSettingsInput(image=replacement, text=replacement))
                if not result['ok']:
                    failures.append(result)
                updated.set()
            except Exception as error:
                failures.append(error)
        def read():
            self.router.current_authorization()
            read_auth.set()
        worker = Thread(target=update, daemon=True)
        reader = Thread(target=read, daemon=True)
        try:
            with self.provider.commit_guard(batch):
                worker.start()
                reader.start()
                self.assertTrue(started.wait(1))
                self.assertFalse(updated.wait(.1))
                self.assertFalse(read_auth.is_set())
                with self.db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    conn.execute('INSERT INTO result VALUES(?)', (batch[0].title,))
                    self.assertFalse(updated.is_set())
                # Commit has happened, but both model locks still belong to us.
                self.assertFalse(updated.is_set())
            worker.join(2)
            reader.join(2)
            self.assertFalse(worker.is_alive())
            self.assertFalse(reader.is_alive())
            self.assertTrue(updated.is_set())
            self.assertTrue(read_auth.is_set())
            self.assertFalse(failures)
            with self.db() as conn:
                self.assertEqual(conn.execute('SELECT value FROM result').fetchall(),
                                 [('review synthetic plan',)])
        finally:
            for thread in (worker, reader):
                if thread.ident is not None:
                    thread.join(2)

    def test_new_configuration_after_extraction_blocks_database_publication(self):
        batch = self.extract()
        replacement = self.route.model_copy(update={'model': 'replacement-synthetic'})
        self.assertTrue(self.endpoints['/api/model_settings/update'](
            ModelSettingsInput(image=replacement, text=replacement))['ok'])
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            with self.provider.commit_guard(batch), self.db() as conn:
                conn.execute('INSERT INTO result VALUES(?)', (batch[0].title,))
        with self.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM result').fetchone()[0], 0)

    def test_current_authorization_change_after_extraction_blocks_publication(self):
        batch = self.extract()
        # Simulates the existing policy mutation boundary, without changing any
        # real application mode or persisted settings.
        with self.router.gateway._dispatch_lock:
            self.mode = 'basic'
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            with self.provider.commit_guard(batch):
                self.fail('stale model authorization entered publication')


if __name__ == '__main__':
    unittest.main()
