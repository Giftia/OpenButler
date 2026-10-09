"""Fixed discovery failure codes with synthetic sources/transports only."""
from contextlib import contextmanager
import json
import unittest
from threading import Event
from time import monotonic
from uuid import uuid4
from unittest.mock import Mock, patch

from fastapi import Response

from app.modules.model_gateway.gateway import (
    CallAuthorization, Gateway, ModelRoute, ProviderTimeoutError, RouteError,
)
from app.modules.task_activity import models
from app.modules.task_activity.discovery import DiscoveryResultError
from app.modules.task_activity.evidence import TaskContextIncomplete
from app.modules.task_activity.model_discovery import LocalModelDiscovery
from app.modules.task_activity.router import create_task_router
from app.modules.task_activity.service import DISCOVERY_ERROR_CODES, TaskError, _discovery_failure
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests.test_model_discovery import Guard, ITEM, QUOTE, Transport


class FailureTaxonomyTests(TaskFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.transport = Transport()
        self.gateway = Gateway(Guard(), self.transport)
        self.gateway._configuration = (7, {'text': ModelRoute(
            'ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')})
        self.auth = CallAuthorization(authorized=True, redacted=True)
        self.provider = LocalModelDiscovery(self.gateway, lambda: self.auth)
        self.service.model_provider = self.provider
        self.service.provider = Mock(extract=Mock(side_effect=AssertionError('No fallback')))
        self.enable('local_model_v1')

    def assert_failed(self, source, code, operation=None):
        with self.assertRaises(TaskError) as raised:
            (operation or (lambda: self.service.process_observation(source['id'])))()
        self.assertEqual((raised.exception.code, raised.exception.status), (code, 409))
        self.assertEqual(self.service.settings()['last_error'], code)
        receipt = self.sql('SELECT * FROM work_extraction_receipts WHERE source_record_id=?', (source['id'],))[0]
        self.assertEqual((receipt['state'], receipt['attempt']), ('failed', 1))
        self.assertEqual(set(receipt), {'source_record_id', 'state', 'attempt', 'evidence_fingerprint'})
        for table in ('work_tasks', 'work_discoveries', 'work_task_links'):
            self.assertEqual(self.sql('SELECT * FROM ' + table), [])
        self.assertEqual(self.sql('SELECT valid FROM work_activities WHERE source_record_id=?',
                                  (source['id'],)), [{'valid': 1}])
        self.service.provider.extract.assert_not_called()
        return raised.exception

    def test_schema_source_and_envelope_failures_remain_distinct(self):
        cases = [
            ('not JSON', {}, 'invalid_discovery_result'),
            (json.dumps({'proposals': [{**ITEM, 'title': 'invented task'}]}), {}, 'discovery_source_mismatch'),
            (json.dumps({'proposals': [ITEM]}), {'thinking': 'SYNTHETIC_RAW_CONTENT'}, 'invalid_provider_response'),
        ]
        for content, extra, code in cases:
            with self.subTest(code=code):
                self.transport.content, self.transport.message_extra = content, extra
                self.assert_failed(self.source(QUOTE), code)

    def test_fixed_failure_categories_persist_without_raw_exception_text(self):
        class UnsafeTextError(RuntimeError):
            def __str__(self):
                raise AssertionError('Unknown exception text must not be read')

        cases = [
            (TaskContextIncomplete('SYNTHETIC_RAW_CONTENT'), 'task_context_incomplete'),
            (DiscoveryResultError('invalid_discovery_result'), 'invalid_discovery_result'),
            (DiscoveryResultError('discovery_source_mismatch'), 'discovery_source_mismatch'),
            (PermissionError('authorization_revoked'), 'discovery_authorization_changed'),
            (TaskError('discovery_authorization_changed', 409), 'discovery_authorization_changed'),
            (RouteError('model_unavailable'), 'local_model_unavailable'),
            (RouteError('provider_connection_failed'), 'local_provider_failed'),
            (ProviderTimeoutError(), 'local_provider_timeout'),
            (RouteError('invalid_provider_response'), 'invalid_provider_response'),
            (UnsafeTextError('SYNTHETIC_RAW_CONTENT'), 'local_discovery_failed'),
            (ValueError('invalid_discovery_result'), 'local_discovery_failed'),
            (RouteError('provider_connection_failed SYNTHETIC_RAW_CONTENT'), 'local_discovery_failed'),
            (TaskError('SYNTHETIC_RAW_CONTENT'), 'local_discovery_failed'),
            (PermissionError('invalid_discovery_receipt'), 'local_discovery_failed'),
        ]
        for error, code in cases:
            with self.subTest(kind=type(error).__name__, code=code):
                source = self.source(QUOTE)
                with patch.object(self.provider, 'extract', side_effect=error):
                    result = self.assert_failed(source, code)
                exposed = json.dumps({'error': result.code, 'settings': self.service.settings(),
                    'receipts': self.sql('SELECT * FROM work_extraction_receipts')})
                self.assertNotIn('SYNTHETIC_RAW_CONTENT', exposed)
                self.assertEqual(self.service.process_observation(source['id'])['reason'], 'extraction_retry_required')

    def test_mapping_is_a_fixed_allowlist_not_an_exception_message_passthrough(self):
        groups = [
            (PermissionError, ('authorization_revoked', 'privacy_mode_unavailable', 'authorization_required',
                'redaction_required', 'strict_mode_forbidden', 'model_unavailable'), 'discovery_authorization_changed'),
            (RouteError, ('model_unavailable', 'route_not_ready', 'local_provider_unsupported',
                'local_model_unverified', 'local_model_remote', 'unsafe_endpoint'), 'local_model_unavailable'),
            (RouteError, ('provider_connection_failed', 'provider_http_error', 'provider_response_too_large',
                'endpoint_resolution_failed'), 'local_provider_failed'),
        ]
        for kind, values, expected in groups:
            for value in values:
                with self.subTest(kind=kind.__name__, value=value):
                    self.assertEqual(_discovery_failure(kind(value)).code, expected)
        for error in (TaskError([]), PermissionError('discovery_commit_guard_required'),
                      ValueError('invalid_discovery_context'), RouteError('unrecognized'),
                      DiscoveryResultError('unrecognized'), RuntimeError('local_provider_timeout')):
            self.assertEqual(_discovery_failure(error).code, 'local_discovery_failed')
        self.assertEqual(len(DISCOVERY_ERROR_CODES), 9)

    def test_publication_guard_failure_uses_same_fixed_taxonomy(self):
        for error, code in ((PermissionError('authorization_revoked'), 'discovery_authorization_changed'),
                            (PermissionError('invalid_discovery_receipt'), 'local_discovery_failed'),
                            (RuntimeError('SYNTHETIC_RAW_CONTENT'), 'local_discovery_failed'),
                            (TaskError('SYNTHETIC_RAW_CONTENT'), 'local_discovery_failed')):
            @contextmanager
            def denied(_batch):
                raise error
                yield
            with self.subTest(code=code), patch.object(self.provider, 'commit_guard', denied):
                self.assert_failed(self.source(QUOTE), code)

    def test_sync_router_receipt_preserves_fixed_failure_and_version_conflict_stays_distinct(self):
        self.addCleanup(self.service.close)
        self.source(QUOTE)
        self.transport.content = json.dumps({'proposals': [{**ITEM, 'title': 'invented task'}]})
        router = create_task_router(self.service)
        sync = next(route.endpoint for route in router.routes if route.path == '/api/task-activity/sync')
        request = models.SyncStart(command_id=uuid4(), expected_version=self.service.settings()['version'])
        response = Response()
        sync(request, response)
        self.assertEqual(response.status_code, 202)
        deadline = monotonic() + 3
        while monotonic() < deadline:
            result = self.service.sync_operation(request.command_id)['operation']
            if result['settled']:
                break
            Event().wait(.005)
        self.assertEqual((result['state'], result['reason']), ('error', 'discovery_source_mismatch'))
        task = self.task()
        with self.assertRaises(TaskError) as conflict:
            self.service.edit_task(task['id'], models.TaskEdit(expected_version=task['version'] + 1,
                                                             title='Public edit'))
        self.assertEqual((conflict.exception.code, conflict.exception.status), ('version_conflict', 409))
        self.assertEqual(self.service.settings()['last_error'], 'discovery_source_mismatch')

    def test_old_attempt_cannot_overwrite_new_settings_error(self):
        source = self.source(QUOTE)
        def change_settings(*_args, **_kwargs):
            self.service.set_settings(models.SettingsEdit(expected_version=self.service.settings()['version'],
                auto_discovery=False, confirmed=True, provider='local_model_v1'))
            self.sql("UPDATE work_task_settings SET last_error='local_provider_failed' WHERE id=1")
            raise PermissionError('authorization_revoked')
        with patch.object(self.provider, 'extract', change_settings), self.assertRaises(TaskError) as raised:
            self.service.process_observation(source['id'])
        self.assertEqual(raised.exception.code, 'discovery_authorization_changed')
        self.assertEqual(self.service.settings()['last_error'], 'local_provider_failed')
        self.assertEqual(self.sql('SELECT state FROM work_extraction_receipts'), [{'state': 'failed'}])


if __name__ == '__main__':
    unittest.main()
