"""Full native backend composition in a subprocess, synthetic empty DB only.

No listener/native desktop/model starts; Starlette's in-process client exercises
all middleware and startup/shutdown. Source data and user configuration are absent.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SyncCompositionTests(unittest.TestCase):
    def test_exact_native_routes_bypass_only_request_initialization_after_auth(self):
        backend = Path(__file__).resolve().parents[4]
        script = r'''
import sqlite3
import time
from unittest.mock import patch
from uuid import uuid4
from fastapi.testclient import TestClient
from app import main

assert main.task_activity is not None
with patch.object(main, 'init_db', wraps=main.init_db) as initialize, \
     patch.object(main, 'seed_events_if_empty', wraps=main.seed_events_if_empty) as seed, \
     patch.object(main, 'seed_vercel_demo_if_enabled', wraps=main.seed_vercel_demo_if_enabled) as demo_seed:
    with TestClient(main.app, base_url='http://127.0.0.1', client=('127.0.0.1', 34567), follow_redirects=False) as client:
        assert initialize.call_count == 1, 'Startup initialization remains mandatory'
        initialize.reset_mock(); seed.reset_mock(); demo_seed.reset_mock()
        auth = {'X-OpenButler-Session': 'a' * 64}
        request = {'command_id': str(uuid4()), 'expected_version': 1}
        base = '/api/task-activity/sync'
        exact = base + '/' + request['command_id']
        routes = [('GET', base), ('GET', exact), ('POST', base), ('POST', exact + '/stop')]
        with patch.object(main.task_activity, 'start_sync', side_effect=AssertionError('unauthorized handler')), \
             patch.object(main.task_activity, 'sync_operation', side_effect=AssertionError('unauthorized handler')), \
             patch.object(main.task_activity, 'stop_sync', side_effect=AssertionError('unauthorized handler')):
            for method, path in routes:
                response = client.request(method, path, json={} if method == 'POST' else None)
                assert (response.status_code, response.json()) == (401, {'detail': 'local_session_required'})
            response = client.get(base, headers={**auth, 'Origin': 'https://untrusted.invalid'})
            assert response.status_code == 403
        assert initialize.call_count == seed.call_count == demo_seed.call_count == 0
        created = client.post(base, json=request, headers=auth)
        assert created.status_code == 200 and created.json()['operation']['reason'] == 'disabled'
        assert client.get(base, headers=auth).status_code == 200
        assert client.get(exact, headers=auth).json() == created.json()
        assert client.post(exact + '/stop', json={}, headers=auth).json() == created.json()
        missing = client.get(base + '/' + str(uuid4()), headers=auth)
        assert (missing.status_code, missing.json()) == (404, {'detail': 'task_sync_not_found'})
        assert initialize.call_count == seed.call_count == demo_seed.call_count == 0
        writer = sqlite3.connect(main.DB_PATH)
        try:
            writer.execute('BEGIN IMMEDIATE')
            started = time.monotonic()
            response = client.get(exact, headers=auth)
            assert response.status_code == 200 and response.json() == created.json()
            assert time.monotonic() - started < 1, 'GET must not enter initializer write wait'
            response = client.get(base, headers=auth)
            assert response.status_code == 200
            blocked = client.post(base, json={'command_id': str(uuid4()), 'expected_version': 1}, headers=auth)
            assert (blocked.status_code, blocked.json()) == (503, {'detail': 'task_sync_unavailable'})
            assert initialize.call_count == seed.call_count == demo_seed.call_count == 0
        finally:
            writer.rollback(); writer.close()
        near = [('GET', base + '/invalid'), ('POST', exact), ('GET', exact + '/stop'),
                ('HEAD', base), ('GET', base + '/'), ('GET', base + '?extra=1'),
                ('GET', '/api/task-activity/settings'), ('GET', base + '/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')]
        for index, (method, path) in enumerate(near, 1):
            client.request(method, path, headers=auth, json={} if method == 'POST' else None)
            assert initialize.call_count == index, (method, path, initialize.call_count)
            assert seed.call_count == demo_seed.call_count == index
        # Even matching methods/paths do not bypass when native task routes are
        # not mounted. This branch is not a global middleware exemption.
        with patch.object(main, 'task_activity', None):
            client.get(base, headers=auth)
        assert initialize.call_count == len(near) + 1
print('Native async composition contract passed')
'''
        with tempfile.TemporaryDirectory(prefix='openbutler-sync-composition-') as root:
            env = dict(os.environ, PYTHONPATH=str(backend), OPENBUTLER_DATA_DIR=root,
                OPENBUTLER_SESSION_TOKEN='a' * 64, OPENBUTLER_DISABLE_SEED_EVENTS='1',
                OPENBUTLER_DEFAULT_PRIVACY_MODE='strict', OPENBUTLER_ALLOWED_ORIGINS='',
                OPENBUTLER_ENABLE_DEMO_DATA='0', OPENBUTLER_DESKTOP='1',
                OPENBUTLER_DEPLOY_TARGET='local', OPENBUTLER_PREVIEW_BUILTIN='1')
            result = subprocess.run([sys.executable, '-c', script], cwd=backend, env=env,
                                    text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Native async composition contract passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
