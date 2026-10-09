"""Experimental model proposals require confirmation; all fixtures are offline."""
import json
import unittest

from app.modules.model_gateway.gateway import CallAuthorization, Gateway, ModelRoute
from app.modules.task_activity import models
from app.modules.task_activity.model_discovery import LocalModelDiscovery
from app.modules.task_activity.service import TaskError
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests.test_model_discovery import Guard, ITEM, QUOTE, Transport


class ModelConfirmationGateTests(TaskFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.transport = Transport()
        self.gateway = Gateway(Guard(), self.transport)
        self.gateway._configuration = (7, {'text': ModelRoute(
            'ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')})
        self.provider = LocalModelDiscovery(self.gateway,
            lambda: CallAuthorization(authorized=True, redacted=True))
        self.service.model_provider = self.provider

    def offer(self, *, item=None, temporal_context=None):
        item = {**ITEM, 'confidence': 1.0, **(item or {})}
        self.transport.content = json.dumps({'proposals': [item]})
        source = self.source(item['quote'], temporal_context=temporal_context)
        activity = self.process(source)
        candidate = next(row for row in self.service.discoveries()['items']
                         if row['activity_id'] == activity['id'])
        return source, activity, candidate

    def resolve(self, candidate, decision='accept'):
        return self.service.resolve(candidate['id'], models.DiscoveryResolution(
            expected_version=candidate['version'], decision=decision))

    def test_high_confidence_self_assigned_proposal_waits_then_explicit_accept_creates_link(self):
        self.enable('local_model_v1')
        source, activity, candidate = self.offer()
        self.assertEqual((candidate['state'], candidate['task_id'], candidate['confidence']),
                         ('pending', None, 1.0))
        self.assertEqual(self.service.list_tasks()['items'], [])
        self.assertEqual(self.sql('SELECT * FROM work_task_links'), [])
        self.assertEqual(self.sql('SELECT state,attempt FROM work_extraction_receipts'),
                         [{'state': 'completed', 'attempt': 1}])
        self.assertIsNone(self.service.settings()['last_error'])
        self.process(source)
        self.assertEqual(self.service.sync()['processed'], 0)
        self.assertEqual(len(self.transport.calls), 1)
        task = self.resolve(candidate)['task']
        self.assertTrue(task['confirmed'])
        self.assertEqual(task['discovery_provider'], 'local_model_v1')
        self.assertEqual(self.sql('SELECT task_id,activity_id,decision FROM work_task_links'),
                         [{'task_id': task['id'], 'activity_id': activity['id'], 'decision': 'accepted'}])
        self.process(source)
        self.assertEqual(len(self.sql('SELECT * FROM work_task_links')), 1)
        with self.assertRaisesRegex(TaskError, '^version_conflict$'):
            self.resolve(candidate)

    def test_exact_manual_and_rule_task_matches_wait_without_mutating_existing_data(self):
        manual = self.task('Existing manual task')
        self.enable('evidence_rules_v1')
        self.process(self.source('TODO(me): Existing rule task'))
        rules = next(task for task in self.service.list_tasks()['items']
                     if task['title'] == 'Existing rule task')
        self.enable('local_model_v1')
        for task in (manual, rules):
            before_task = self.sql('SELECT * FROM work_tasks WHERE id=?', (task['id'],))
            before_links = self.sql('SELECT * FROM work_task_links ORDER BY task_id,activity_id')
            source, activity, candidate = self.offer(item={
                'title': task['title'], 'quote': 'TODO(me): ' + task['title']})
            self.assertEqual((candidate['state'], candidate['task_id']), ('pending', None))
            self.assertEqual(self.sql('SELECT * FROM work_tasks WHERE id=?', (task['id'],)), before_task)
            self.assertEqual(self.sql('SELECT * FROM work_task_links ORDER BY task_id,activity_id'), before_links)
            accepted = self.resolve(candidate)['task']
            self.assertEqual(accepted['id'], task['id'])
            self.assertEqual(accepted['discovery_provider'], task['discovery_provider'])
            self.assertTrue(accepted['confirmed'])
            self.assertEqual(self.sql('SELECT task_id,decision FROM work_task_links WHERE activity_id=?',
                                     (activity['id'],)), [{'task_id': task['id'], 'decision': 'accepted'}])
            # Confirmation of one source is not permission to accept later
            # model associations to the same user-confirmed task.
            _later_source, later_activity, later = self.offer(item={
                'title': task['title'], 'quote': 'TODO(me): ' + task['title']})
            self.assertEqual((later['state'], later['task_id']), ('pending', None))
            self.assertEqual(self.sql('SELECT * FROM work_task_links WHERE activity_id=?',
                                     (later_activity['id'],)), [])
            self.assertEqual(len(self.service.list_tasks()['items']), 2)

    def test_two_model_candidates_dedupe_only_when_each_is_explicitly_accepted(self):
        self.enable('local_model_v1')
        candidates = [self.offer()[2] for _ in range(2)]
        self.assertTrue(all(row['state'] == 'pending' and row['task_id'] is None for row in candidates))
        self.assertEqual(self.sql('SELECT * FROM work_tasks'), [])
        first = self.resolve(candidates[0])['task']
        self.assertEqual(len(self.sql('SELECT * FROM work_task_links')), 1)
        remaining = next(row for row in self.service.discoveries()['items'] if row['id'] == candidates[1]['id'])
        self.assertEqual((remaining['state'], remaining['task_id']), ('pending', None))
        second = self.resolve(candidates[1])['task']
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(len(self.sql('SELECT * FROM work_tasks')), 1)
        self.assertEqual(len(self.sql('SELECT * FROM work_task_links')), 2)

    def test_explicit_dismissal_suppression_still_blocks_later_model_proposals(self):
        self.enable('local_model_v1')
        candidate = self.offer()[2]
        self.assertIsNone(self.resolve(candidate, 'dismiss')['task'])
        _source, _activity, later = self.offer()
        self.assertEqual((later['state'], later['task_id']), ('dismissed', None))
        self.assertEqual(self.sql('SELECT * FROM work_tasks'), [])
        self.assertEqual(self.sql('SELECT * FROM work_task_links'), [])

    def test_model_mode_blocks_initial_optional_same_topic_association(self):
        self.enable('evidence_rules_v1')
        prior = self.source('TODO(me): Prior public task')
        self.process(prior)
        task = self.service.list_tasks()['items'][0]
        before = self.sql('SELECT * FROM work_task_links')
        self.enable('local_model_v1')
        self.transport.content = '{"proposals":[]}'
        text = 'Public reference to a prior task.'
        context = {'relations': [{'relation': 'same_topic', 'prior_observation_id': prior['id'],
            'current_quote': text, 'prior_quote': prior['post_mask_ocr_text']}]}
        source = self.source(text, temporal_context=context)
        activity = self.process(source)
        self.assertEqual(self.sql('SELECT * FROM work_task_links'), before)
        self.assertEqual(self.sql('SELECT * FROM work_task_links WHERE activity_id=?', (activity['id'],)), [])
        self.assertEqual(len(self.service.detail(task['id'])['activities']), 1)
        self.assertEqual(self.sql('SELECT state FROM work_extraction_receipts WHERE source_record_id=?',
                                 (source['id'],)), [{'state': 'completed'}])

    def test_selected_model_mode_also_blocks_associations_on_preexisting_completed_receipt(self):
        self.enable('evidence_rules_v1')
        prior = self.source('TODO(me): Prior public task')
        self.process(prior)
        text = 'Later public reference.'
        source = self.source(text)
        activity = self.process(source)
        before = self.sql('SELECT * FROM work_task_links')
        context = {'relations': [{'relation': 'same_topic', 'prior_observation_id': prior['id'],
            'current_quote': text, 'prior_quote': prior['post_mask_ocr_text']}]}
        self.sql('UPDATE context_observations SET temporal_context=? WHERE id=?', (json.dumps(context), source['id']))
        self.enable('local_model_v1')
        self.process(source)
        self.assertEqual(self.sql('SELECT * FROM work_task_links'), before)
        self.assertEqual(self.sql('SELECT * FROM work_task_links WHERE activity_id=?', (activity['id'],)), [])
        self.assertEqual(self.transport.calls, [])

    def test_rules_keep_automatic_creation_exact_matches_and_later_associations(self):
        self.enable('evidence_rules_v1')
        prior = self.source('TODO(me): Deterministic public task')
        self.process(prior)
        task = self.service.list_tasks()['items'][0]
        self.assertEqual(task['discovery_provider'], 'evidence_rules_v1')
        self.process(self.source('TODO(me): Deterministic public task'))
        self.assertEqual(len(self.service.list_tasks()['items']), 1)
        self.assertEqual(len(self.sql('SELECT * FROM work_task_links')), 2)
        text = 'A later deterministic reference.'
        source = self.source(text)
        activity = self.process(source)
        context = {'relations': [{'relation': 'same_topic', 'prior_observation_id': prior['id'],
            'current_quote': text, 'prior_quote': prior['post_mask_ocr_text']}]}
        self.sql('UPDATE context_observations SET temporal_context=? WHERE id=?', (json.dumps(context), source['id']))
        self.process(source)
        self.assertEqual(self.sql('SELECT task_id,relation,decision FROM work_task_links WHERE activity_id=?',
            (activity['id'],)), [{'task_id': task['id'], 'relation': 'possible', 'decision': 'accepted'}])
        self.assertEqual(self.transport.calls, [])


if __name__ == '__main__':
    unittest.main()
