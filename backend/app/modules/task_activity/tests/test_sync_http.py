"""In-process async route contracts; no native app, socket, or real model."""
from threading import Event
import time
import unittest
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.modules.task_activity import models
from app.modules.task_activity.router import create_task_router
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests import test_extraction_lifecycle as lifecycle


class SyncHttpTests(TaskFixture, unittest.TestCase):
    configure_model = lifecycle.ExtractionLifecycleTests.configure_model
    ocr_source = lifecycle.ExtractionLifecycleTests.ocr_source

    def setUp(self):
        TaskFixture.setUp(self)
        self.addCleanup(lambda: self.service.close(timeout=3))

    def client(self):
        app = FastAPI()
        app.include_router(create_task_router(self.service))
        return TestClient(app)

    def payload(self):
        return {'command_id': str(uuid4()), 'expected_version': self.service.settings()['version']}

    def test_disabled_immediate_result_and_exact_version_hash(self):
        with self.client() as client:
            payload = self.payload()
            result = client.post('/api/task-activity/sync', json=payload)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers['cache-control'], 'private, no-store')
            op = result.json()['operation']
            self.assertEqual((op['state'], op['settled'], op['reason']), ('complete', True, 'disabled'))
            path = '/api/task-activity/sync/' + payload['command_id']
            self.assertEqual(client.get(path).json(), result.json())
            self.assertEqual(client.post(path + '/stop', json={}).json(), result.json())
            changed = client.post('/api/task-activity/sync', json={**payload, 'expected_version': payload['expected_version'] + 1})
            self.assertEqual((changed.status_code, changed.json()), (409, {'detail': 'command_conflict'}))
            stale = client.post('/api/task-activity/sync', json={**payload, 'command_id': str(uuid4()), 'expected_version': 999})
            self.assertEqual((stale.status_code, stale.json()), (409, {'detail': 'version_conflict'}))
            unknown = client.get('/api/task-activity/sync/' + str(uuid4()))
            self.assertEqual((unknown.status_code, unknown.json()), (404, {'detail': 'task_sync_not_found'}))
            self.assertEqual(client.post('/api/task-activity/sync', json={}).status_code, 422)
            self.assertEqual(client.post('/api/task-activity/sync', json={**payload, 'expected_version': True}).status_code, 422)
            self.assertEqual(client.post(path + '/stop', json={'unexpected': True}).status_code, 422)

    def test_pending_returns_before_provider_and_activity_is_independently_readable(self):
        self.configure_model(empty=True)
        self.ocr_source()
        entered, release = Event(), Event()
        self.transport.on_post = lambda: (entered.set(), release.wait(5))
        self.addCleanup(release.set)
        with self.client() as client:
            payload = self.payload()
            started = time.monotonic()
            response = client.post('/api/task-activity/sync', json=payload)
            self.assertEqual(response.status_code, 202)
            self.assertLess(time.monotonic() - started, 1)
            self.assertTrue(entered.wait(3))
            path = '/api/task-activity/sync/' + payload['command_id']
            self.assertEqual(client.get(path).json()['operation']['state'], 'pending')
            self.assertEqual(client.get('/api/task-activity/activities').status_code, 200)
            self.assertEqual(len(client.get('/api/task-activity/activities').json()['items']), 1)
            self.assertEqual(client.post('/api/task-activity/sync', json=payload).status_code, 202)
            stopped = client.post(path + '/stop', json={})
            self.assertEqual((stopped.status_code, stopped.json()['operation']['state']), (202, 'stopping'))
            self.assertEqual(len(self.transport.calls), 1)
            release.set()
            deadline = time.monotonic() + 5
            while not client.get(path).json()['operation']['settled'] and time.monotonic() < deadline:
                Event().wait(.005)
            final = client.get(path).json()['operation']
            self.assertEqual((final['state'], final['processed']), ('interrupted', 0))
            self.assertEqual(client.post(path + '/stop', json={}).status_code, 200)
            self.assertEqual(len(self.transport.calls), 1)

    def test_router_shutdown_reports_unsettled_worker(self):
        self.configure_model(empty=True)
        self.ocr_source()
        entered, release = Event(), Event()
        self.transport.on_post = lambda: (entered.set(), release.wait(5))
        self.addCleanup(release.set)
        original = self.service.close
        self.service.close = lambda **kwargs: original(timeout=kwargs.get('timeout', .01))
        with self.assertRaisesRegex(RuntimeError, '^task_worker_shutdown_timeout$'):
            with self.client() as client:
                self.assertEqual(client.post('/api/task-activity/sync', json=self.payload()).status_code, 202)
                self.assertTrue(entered.wait(3))
        self.assertEqual(self.service.sync_operation()['operation']['state'], 'stopping')
        release.set()
        self.assertTrue(original(timeout=3))


if __name__ == '__main__':
    unittest.main()
