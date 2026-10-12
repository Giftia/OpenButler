"""Regression of post-extraction publication races with the real task service.

All source rows, model responses and route mutations are isolated fixtures;
there is no network, live model, capture or application settings mutation.
"""
from dataclasses import replace
import unittest

from app.modules.model_gateway.gateway import CallAuthorization, Gateway, ModelRoute
from app.modules.task_activity.model_discovery import LocalModelDiscovery
from app.modules.task_activity.service import TaskError
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests.test_model_discovery import Guard, Transport, QUOTE


class ModelCommitIntegrationTests(TaskFixture, unittest.TestCase):
    def provider(self):
        transport = Transport()
        gateway = Gateway(Guard(), transport)
        route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')
        gateway._configuration = (7, {'text': route})
        state = {'auth': CallAuthorization(authorized=True, redacted=True)}
        provider = LocalModelDiscovery(gateway, lambda: state['auth'])
        self.service.model_provider = provider
        self.enable('local_model_v1')
        return provider, gateway, route, state, transport

    def assert_not_published(self, source):
        with self.assertRaises(TaskError) as raised:
            self.service.process_observation(source['id'])
        self.assertEqual(raised.exception.code, 'discovery_authorization_changed')
        self.assertEqual(self.service.settings()['last_error'], 'discovery_authorization_changed')
        for table in ('work_tasks', 'work_discoveries', 'work_task_links'):
            self.assertEqual(self.sql('SELECT * FROM ' + table), [])
        self.assertEqual(self.sql('SELECT valid FROM work_activities'), [{'valid': 1}])
        self.assertTrue(self.service.list_activities()['items'][0]['evidence_available'])

    def test_revision_changes_after_provider_returns_create_no_derived_records(self):
        provider, gateway, route, _state, transport = self.provider()
        original = provider.extract
        def extract(*args, **kwargs):
            result = original(*args, **kwargs)
            gateway._restore_validated_text_route(replace(route, model='replacement-synthetic'))
            return result
        provider.extract = extract
        self.assert_not_published(self.source(text=QUOTE))
        self.assertEqual(gateway.configuration_revision, 8)
        self.assertEqual(len(transport.calls), 1)

    def test_authorization_revoked_after_provider_returns_creates_no_derived_records(self):
        provider, gateway, _route, state, transport = self.provider()
        original = provider.extract
        def extract(*args, **kwargs):
            result = original(*args, **kwargs)
            with gateway._dispatch_lock:
                state['auth'] = replace(state['auth'], authorized=False)
            return result
        provider.extract = extract
        self.assert_not_published(self.source(text=QUOTE))
        self.assertEqual(gateway.configuration_revision, 7)
        self.assertEqual(len(transport.calls), 1)

    def test_valid_receipt_commits_one_pending_proposal_without_automatic_task(self):
        _provider, _gateway, _route, _state, transport = self.provider()
        source = self.source(text=QUOTE)
        self.process(source)
        self.process(source)
        self.assertEqual(self.sql('SELECT * FROM work_tasks'), [])
        self.assertEqual(self.sql('SELECT * FROM work_task_links'), [])
        self.assertEqual(len(self.sql('SELECT * FROM work_activities')), 1)
        self.assertEqual(len(self.sql('SELECT * FROM work_discoveries')), 1)
        self.assertEqual(self.sql('SELECT state,task_id FROM work_discoveries'),
                         [{'state': 'pending', 'task_id': None}])
        self.assertEqual(len(transport.calls), 1)


if __name__ == '__main__':
    unittest.main()
