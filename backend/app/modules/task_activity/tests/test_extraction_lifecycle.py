"""Evidence-first task extraction lifecycle, entirely synthetic and offline.

The real LocalModelDiscovery/Gateway commit guard is exercised with an in-memory
transport. No OCR engine, local model, real capture, user database or network runs.
"""
from dataclasses import replace
from datetime import timedelta
import json
from threading import Event, Thread
import unittest
from unittest.mock import Mock

from app.modules.model_gateway.gateway import CallAuthorization, Gateway, ModelRoute
from app.modules.task_activity.model_discovery import LocalModelDiscovery
from app.modules.task_activity.service import TaskError, TaskService
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests.test_model_discovery import Guard, Transport, QUOTE


class ExtractionLifecycleTests(TaskFixture, unittest.TestCase):
    def configure_model(self, *, empty=False):
        self.transport = Transport()
        if empty:
            self.transport.content = '{"proposals":[]}'
        self.gateway = Gateway(Guard(), self.transport)
        self.route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')
        self.gateway._configuration = (7, {'text': self.route})
        self.auth = CallAuthorization(authorized=True, redacted=True)
        self.model = LocalModelDiscovery(self.gateway, lambda: self.auth)
        self.service.model_provider = self.model
        self.service.provider = Mock(extract=Mock(side_effect=AssertionError('No rule fallback')))
        self.enable('local_model_v1')

    def ocr_source(self, text=QUOTE):
        source = self.source(text)
        provenance = json.loads(source['provenance'])
        provenance.update(source_verified_before=True, source_verified_after=True)
        self.sql('''UPDATE context_observations SET state='model_unavailable',
            processing_reason='model_unavailable',post_mask_ocr_engine='tesseract.js',
            provenance=?,title=NULL,summary=NULL,current_facts='{}' WHERE id=?''',
            (json.dumps(provenance), source['id']))
        return source

    def receipt(self, source):
        row = self.sql('SELECT * FROM work_extraction_receipts WHERE source_record_id=?', (source['id'],))[0]
        self.assertEqual(set(row), {'source_record_id', 'state', 'attempt', 'evidence_fingerprint'})
        self.assertNotIn(QUOTE, json.dumps(row))
        if row['evidence_fingerprint'] is not None:
            self.assertEqual(len(row['evidence_fingerprint']), 64)
        return row

    def assert_no_proposals(self):
        for table in ('work_tasks', 'work_discoveries', 'work_task_links'):
            self.assertEqual(self.sql('SELECT * FROM ' + table), [])

    def assert_evidence(self, source, *, available=True):
        activity = next(a for a in self.service.list_activities()['items'] if a['source_record_id'] == source['id'])
        self.assertEqual(activity['evidence_available'], available)
        self.assertEqual(activity['start_at'], activity['end_at'])
        self.assertEqual(activity['time_kind'], 'sample')
        if available:
            self.assertIn(QUOTE, activity['summary'])
            self.assertIn('OCR', activity['title'])
        else:
            self.assertEqual(activity['summary'], '')
            self.assertEqual(activity['resources'], [])
        raw = self.sql('SELECT title,summary FROM work_activities WHERE id=?', (activity['id'],))[0]
        self.assertEqual(raw, {'title': '', 'summary': ''})
        return activity

    def start_pending(self, operation):
        entered, release = Event(), Event()
        outcomes = []
        def block():
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic transport was not released')
        self.transport.on_post = block
        def run():
            try:
                outcomes.append(operation())
            except BaseException as error:
                outcomes.append(error)
        worker = Thread(target=run, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 6)
        self.addCleanup(release.set)
        self.assertTrue(entered.wait(5), 'Model dispatch did not start')
        return worker, release, outcomes

    def finish_pending(self, worker, release, outcomes, *, failure=False,
                       failure_code='invalid_discovery_result'):
        release.set()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(outcomes), 1)
        if failure:
            self.assertIsInstance(outcomes[0], TaskError)
            self.assertEqual(outcomes[0].code, failure_code)
        else:
            self.assertNotIsInstance(outcomes[0], BaseException)
        return outcomes[0]

    def test_activity_is_visible_while_model_pending_and_zero_proposals_complete_once(self):
        self.configure_model(empty=True)
        source = self.ocr_source()
        before = self.sql('SELECT * FROM context_observations WHERE id=?', (source['id'],))
        worker, release, outcomes = self.start_pending(lambda: self.service.process_observation(source['id']))
        activity = self.assert_evidence(source)
        self.assertEqual(self.receipt(source)['state'], 'pending')
        self.assert_no_proposals()
        result = self.finish_pending(worker, release, outcomes)
        self.assertEqual(result, {'processed': True, 'activity_id': activity['id']})
        self.assertEqual(self.receipt(source)['state'], 'completed')
        self.assert_no_proposals()
        for _ in range(2):
            self.assertEqual(self.service.sync()['processed'], 0)
            self.assertEqual(self.service.process_observation(source['id']), result)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.sql('SELECT * FROM context_observations WHERE id=?', (source['id'],)), before)

    def test_failure_remains_visible_without_fallback_and_only_explicit_sync_retries(self):
        self.configure_model()
        self.transport.content = 'Synthetic invalid response must never persist'
        source = self.ocr_source()
        with self.assertRaisesRegex(TaskError, '^invalid_discovery_result$'):
            self.service.process_observation(source['id'])
        activity = self.assert_evidence(source)
        self.assertEqual(self.receipt(source)['state'], 'failed')
        self.assertEqual(self.service.settings()['last_error'], 'invalid_discovery_result')
        self.assert_no_proposals()
        for _ in range(2):
            self.assertEqual(self.service.process_observation(source['id']),
                             {'processed': False, 'reason': 'extraction_retry_required'})
        self.assertEqual(len(self.transport.calls), 1)
        self.transport.content = Transport().content
        self.assertEqual(self.service.sync()['processed'], 1)
        self.assertEqual(self.receipt(source)['state'], 'completed')
        self.assertEqual(self.receipt(source)['attempt'], 2)
        self.assertIsNone(self.service.settings()['last_error'])
        self.assertEqual(self.assert_evidence(source)['id'], activity['id'])
        self.assertEqual(self.sql('SELECT state,task_id FROM work_discoveries'),
                         [{'state': 'pending', 'task_id': None}])
        for table in ('work_tasks', 'work_task_links'):
            self.assertEqual(self.sql('SELECT * FROM ' + table), [])
        self.assertEqual(self.service.sync()['processed'], 0)
        self.assertEqual(len(self.transport.calls), 2)
        self.service.provider.extract.assert_not_called()

    def concurrent_sync(self, *, failure):
        self.configure_model(empty=not failure)
        if failure:
            self.transport.content = 'invalid synthetic response'
        source = self.ocr_source()
        other = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.addCleanup(other.close)
        worker, release, outcomes = self.start_pending(self.service.sync)
        for service in (self.service, other):
            self.assertEqual(service.sync(), {'processed': 0, 'reason': 'extraction_in_progress'})
        self.assertEqual(len(self.transport.calls), 1)
        self.finish_pending(worker, release, outcomes, failure=failure)
        self.assertEqual(len(self.transport.calls), 1, 'Concurrent sync must not queue a failed-call retry')
        self.assertEqual(self.receipt(source)['state'], 'failed' if failure else 'completed')
        self.assert_evidence(source)
        self.assert_no_proposals()

    def test_duplicate_sync_during_success_never_queues_another_dispatch(self):
        self.concurrent_sync(failure=False)

    def test_duplicate_sync_during_failure_never_becomes_an_automatic_retry(self):
        self.concurrent_sync(failure=True)

    def restart_incomplete(self, *, crash):
        self.configure_model(empty=True)
        source = self.ocr_source()
        class Interrupted(BaseException):
            pass
        def interrupt():
            if crash:
                raise Interrupted()
            raise ValueError('synthetic provider failure')
        self.transport.on_post = interrupt
        with self.assertRaises(Interrupted if crash else TaskError):
            self.service.process_observation(source['id'])
        original = self.receipt(source)
        self.assertEqual(original['state'], 'pending' if crash else 'failed')
        self.service.close()
        self.transport.on_post = lambda: None
        self.service = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.assertEqual(self.receipt(source), original)
        self.assert_evidence(source)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.service.process_observation(source['id'])['reason'], 'extraction_retry_required')
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.service.sync()['processed'], 1)
        self.assertEqual(self.receipt(source)['state'], 'completed')
        self.assertEqual(self.receipt(source)['attempt'], original['attempt'] + 1)
        self.assertEqual(len(self.transport.calls), 2)
        self.assertEqual(self.service.sync()['processed'], 0)
        self.assert_no_proposals()

    def test_restart_preserves_failed_receipt_and_allows_only_manual_retry(self):
        self.restart_incomplete(crash=False)

    def test_restart_preserves_abandoned_pending_receipt_and_allows_only_manual_retry(self):
        self.restart_incomplete(crash=True)

    def test_legacy_activity_migration_never_reextracts_zero_or_nonzero_old_work(self):
        self.enable()
        sources = [self.source('Public reference with no task'), self.source()]
        for source in sources:
            self.process(source)
        self.activity()
        before = {table: self.sql('SELECT * FROM ' + table) for table in
                  ('work_tasks', 'work_discoveries', 'work_task_links', 'context_observations')}
        self.service.close()
        self.sql('DROP TABLE work_extraction_receipts')
        self.service = TaskService(self.path, clock=lambda: self.now)
        self.configure_model()
        for source in sources:
            receipt = self.receipt(source)
            self.assertEqual((receipt['state'], receipt['attempt'], receipt['evidence_fingerprint']),
                             ('completed', 0, None))
            self.assertTrue(self.service.process_observation(source['id'])['processed'])
        self.assertEqual(len(self.sql('SELECT * FROM work_extraction_receipts')), 2)
        self.assertEqual(self.service.sync()['processed'], 0)
        self.assertEqual(self.transport.calls, [])
        for table, rows in before.items():
            self.assertEqual(self.sql('SELECT * FROM ' + table), rows)

    def test_rollback_reupgrade_backfills_only_missing_receipts_without_redispatch(self):
        self.configure_model()
        failed, pending = self.ocr_source(), self.ocr_source()
        self.transport.content = 'invalid synthetic response'
        with self.assertRaises(TaskError):
            self.service.process_observation(failed['id'])
        class Interrupted(BaseException):
            pass
        def interrupt():
            raise Interrupted()
        self.transport.on_post = interrupt
        with self.assertRaises(Interrupted):
            self.service.process_observation(pending['id'])
        incomplete = [self.receipt(source) for source in (failed, pending)]
        self.assertEqual([row['state'] for row in incomplete], ['failed', 'pending'])
        legacy = self.source('Public old-style completed activity')
        # Old application code can write an Activity while the additive receipt
        # table stays on disk through rollback. It knows nothing of that table.
        self.sql("""INSERT INTO work_activities
            (id,source,source_record_id,start_at,end_at,time_kind,source_revision,created_at)
            VALUES('activity_legacy','observation',?,?,?,'sample',?,?)""", (legacy['id'],
            legacy['captured_at'], legacy['captured_at'], legacy['consent_revision'], self.service.now()))
        self.activity()
        self.service.close()
        self.transport.on_post = lambda: None
        self.service = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.assertEqual([self.receipt(source) for source in (failed, pending)], incomplete)
        self.assertEqual(self.receipt(legacy), {'source_record_id': legacy['id'], 'state': 'completed',
                                              'attempt': 0, 'evidence_fingerprint': None})
        self.assertEqual(len(self.sql('SELECT * FROM work_extraction_receipts')), 3)
        self.assertEqual(len(self.transport.calls), 2)
        self.assertTrue(self.service.process_observation(legacy['id'])['processed'])
        for source in (failed, pending):
            self.assertEqual(self.service.process_observation(source['id'])['reason'], 'extraction_retry_required')
        self.assertEqual(len(self.transport.calls), 2)
        self.assert_no_proposals()

    def pending_change(self, action, *, valid_evidence=False):
        self.configure_model()
        source = self.ocr_source()
        worker, release, outcomes = self.start_pending(lambda: self.service.process_observation(source['id']))
        self.assert_evidence(source)
        if action == 'expiry':
            self.now += timedelta(days=2)
        elif action == 'revoke':
            self.sql('UPDATE context_capture_settings SET consented=0 WHERE id=1')
            self.assertEqual(self.sql('SELECT valid FROM work_activities'), [{'valid': 0}])
        elif action == 'source':
            self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed synthetic evidence' WHERE id=?", (source['id'],))
        elif action == 'media':
            media = self.root / 'context_engine' / 'media' / (source['evidence_id'] + '.png')
            media.write_bytes(b'different synthetic image bytes')
        elif action == 'organization':
            self.sql("UPDATE context_observations SET state='processing',processing_reason='running' WHERE id=?", (source['id'],))
        elif action == 'route':
            # Inject the revision edge in this trusted synthetic fixture. The
            # real setter owns the dispatch lock: calling it synchronously
            # here would wait for the blocked transport's test timeout rather
            # than exercise a stale extraction result.
            self.gateway._configuration = (self.gateway.configuration_revision + 1,
                {'text': replace(self.route, model='replacement-synthetic')})
        self.assert_evidence(source, available=valid_evidence)
        self.finish_pending(worker, release, outcomes, failure=True,
                            failure_code='discovery_authorization_changed')
        self.assertEqual(self.service.settings()['last_error'], 'discovery_authorization_changed')
        self.assert_evidence(source, available=valid_evidence)
        self.assert_no_proposals()
        self.assertEqual(self.receipt(source)['state'], 'failed')
        self.assertEqual(len(self.transport.calls), 1)
        self.assertFalse(self.service.process_observation(source['id'])['processed'])
        self.assertEqual(len(self.transport.calls), 1)

    def test_source_expiry_while_pending_invalidates_evidence_and_blocks_proposals(self):
        self.pending_change('expiry')

    def test_consent_revocation_while_pending_invalidates_evidence_and_blocks_proposals(self):
        self.pending_change('revoke')

    def test_source_replacement_while_pending_invalidates_evidence_and_blocks_proposals(self):
        self.pending_change('source')

    def test_media_replacement_while_pending_invalidates_evidence_and_blocks_proposals(self):
        self.pending_change('media')

    def test_organization_progress_while_pending_retains_evidence_but_blocks_stale_proposals(self):
        self.pending_change('organization', valid_evidence=True)

    def test_local_route_switch_while_pending_retains_evidence_but_blocks_proposals(self):
        self.pending_change('route', valid_evidence=True)

    def test_complete_verified_ocr_does_not_depend_on_optional_organization_grounding(self):
        self.configure_model(empty=True)
        source = self.source(QUOTE, grounded=False)
        self.assertTrue(self.service.process_observation(source['id'])['processed'])
        self.assertEqual(self.receipt(source)['state'], 'completed')
        self.assert_no_proposals()
        self.assertEqual(self.service.sync()['processed'], 0)
        self.assertEqual(len(self.transport.calls), 1)
        prompt = self.transport.calls[0][1]['messages'][0]['content']
        self.assertEqual(json.loads(prompt.split('\n', 1)[1])['source_record']['span']['quote'], QUOTE)

    def test_unverified_complete_ocr_retains_activity_but_abstains_without_dispatch(self):
        self.configure_model(empty=True)
        source = self.source(QUOTE)
        self.sql("UPDATE context_observations SET post_mask_ocr_engine='unverified' WHERE id=?", (source['id'],))
        with self.assertRaises(TaskError) as raised:
            self.service.process_observation(source['id'])
        self.assertEqual(raised.exception.code, 'task_context_incomplete')
        self.assertEqual(self.service.settings()['last_error'], 'task_context_incomplete')
        self.assertEqual(self.receipt(source)['state'], 'failed')
        self.assert_evidence(source)
        self.assert_no_proposals()
        self.assertFalse(self.service.process_observation(source['id'])['processed'])
        self.assertEqual(self.transport.calls, [])

    def test_oversized_full_context_keeps_activity_and_failed_receipt_without_fallback(self):
        self.configure_model(empty=True)
        source = self.source(QUOTE)
        text = QUOTE + '\n' + 'Detail ' * 220 + '\nThis is an example, not my task.'
        self.sql('UPDATE context_observations SET post_mask_ocr_text=? WHERE id=?', (text, source['id']))
        with self.assertRaises(TaskError) as raised:
            self.service.process_observation(source['id'])
        self.assertEqual(raised.exception.code, 'task_context_incomplete')
        self.assertEqual(self.service.settings()['last_error'], 'task_context_incomplete')
        self.assertEqual(self.receipt(source)['state'], 'failed')
        self.assert_evidence(source)
        self.assert_no_proposals()
        self.assertFalse(self.service.process_observation(source['id'])['processed'])
        self.assertEqual(self.transport.calls, [])
        self.service.provider.extract.assert_not_called()

    def test_completed_model_receipt_does_not_autoaccept_later_association(self):
        self.enable()
        prior = self.source('TODO(me): Review public relation')
        self.process(prior)
        task = self.service.list_tasks()['items'][0]
        self.configure_model(empty=True)
        source = self.ocr_source()
        activity = self.process(source)
        self.assertEqual(self.service.detail(task['id'])['activities'][0]['source_record_id'], prior['id'])
        relation = {'relations': [{'relation': 'same_topic', 'prior_observation_id': prior['id'],
                    'current_quote': QUOTE, 'prior_quote': prior['post_mask_ocr_text']}]}
        self.sql("""UPDATE context_observations SET state='ready',title=?,summary=?,boundary=?,
            current_facts=?,temporal_context=? WHERE id=?""", (source['title'], source['summary'],
            source['boundary'], source['current_facts'], json.dumps(relation), source['id']))
        self.assertTrue(self.service.process_observation(source['id'])['processed'])
        links = self.sql('SELECT * FROM work_task_links WHERE activity_id=?', (activity['id'],))
        self.assertEqual(links, [])
        self.assertEqual(len(self.transport.calls), 1)
        self.link(task, activity, decision='rejected', primary=False)
        self.service.process_observation(source['id'])
        corrected = self.sql('SELECT decision,origin FROM work_task_links WHERE activity_id=?', (activity['id'],))
        self.assertEqual(corrected, [{'decision': 'rejected', 'origin': 'user'}])
        self.assertEqual(len(self.transport.calls), 1)

    def test_rules_sync_cannot_turn_into_multiple_model_calls_after_provider_switch(self):
        self.configure_model(empty=True)
        self.enable('evidence_rules_v1')
        for _ in range(3):
            self.source()
        original = self.service._process_observation
        changed = False
        def process(*args, **kwargs):
            nonlocal changed
            if not changed:
                changed = True
                self.enable('local_model_v1')
            return original(*args, **kwargs)
        self.service._process_observation = process
        self.assertEqual(self.service.sync()['processed'], 0)
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.sql('SELECT * FROM work_activities'), [])
        self.assertEqual(self.service.sync()['processed'], 1)
        self.assertEqual(len(self.transport.calls), 1)

    def test_changed_receipt_attempt_rejects_stale_publication(self):
        self.configure_model()
        source = self.ocr_source()
        original = self.model.extract
        def extract(*args, **kwargs):
            result = original(*args, **kwargs)
            self.sql('UPDATE work_extraction_receipts SET attempt=attempt+1 WHERE source_record_id=?', (source['id'],))
            return result
        self.model.extract = extract
        with self.assertRaisesRegex(TaskError, '^discovery_authorization_changed$'):
            self.service.process_observation(source['id'])
        self.assert_no_proposals()
        self.assert_evidence(source)
        self.assertEqual((self.receipt(source)['state'], self.receipt(source)['attempt']), ('pending', 2))


if __name__ == '__main__':
    unittest.main()
