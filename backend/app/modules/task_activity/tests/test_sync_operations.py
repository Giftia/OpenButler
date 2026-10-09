"""Async explicit Sync: isolated fixtures/mocked transports, no model or network."""
from contextlib import contextmanager
from datetime import timedelta
import json
import sqlite3
from threading import Event, Thread
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from app.modules.task_activity import models
from app.modules.task_activity.service import DISCOVERY_ERROR_CODES, TaskError, TaskService
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests import test_extraction_lifecycle as lifecycle
from app.modules.task_activity.sync_operations import Execution


class SyncOperationTests(TaskFixture, unittest.TestCase):
    configure_model = lifecycle.ExtractionLifecycleTests.configure_model
    ocr_source = lifecycle.ExtractionLifecycleTests.ocr_source

    def setUp(self):
        TaskFixture.setUp(self)
        self.addCleanup(lambda: self.service.close(timeout=3))

    def request(self, **changes):
        return models.SyncStart(command_id=changes.get('command_id', uuid4()),
            expected_version=changes.get('expected_version', self.service.settings()['version']))

    def start(self, request=None):
        request = request or self.request()
        result = self.service.start_sync(request)
        self.assertIsNotNone(result['operation'])
        return request, result['operation']

    def wait(self, request):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = self.service.sync_operation(request.command_id)['operation']
            if result and result['settled']:
                return result
            Event().wait(.005)
        self.fail('Synthetic operation did not settle')

    def blocking_model(self, *, empty=True):
        self.configure_model(empty=empty)
        source = self.ocr_source()
        entered, release = Event(), Event()
        def block():
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic provider release missing')
        self.transport.on_post = block
        self.addCleanup(release.set)
        request, operation = self.start()
        self.assertTrue(entered.wait(3))
        return source, request, operation, release

    def test_pending_activity_reads_idempotency_alias_and_true_empty_result(self):
        source, request, operation, release = self.blocking_model()
        self.assertEqual((operation['state'], operation['settled']), ('pending', False))
        self.assertEqual(len(self.transport.calls), 1)
        pending = self.service.sync_operation(request.command_id)['operation']
        self.assertEqual((pending['selected'], pending['attempted'], pending['processed'], pending['activities_created']), (1, 1, 0, 1))
        self.assertTrue(self.service.list_activities()['items'][0]['evidence_available'])
        self.assertEqual(self.service.list_tasks()['items'], [])
        same = self.service.start_sync(request)
        alias = self.request()
        other = self.service.start_sync(alias)
        self.assertEqual(same['operation']['command_id'], other['operation']['command_id'])
        self.assertEqual(self.service.sync_operation(alias.command_id), other)
        with self.assertRaisesRegex(TaskError, '^command_conflict$'):
            self.service.start_sync(self.request(command_id=request.command_id, expected_version=request.expected_version + 1))
        release.set()
        final = self.wait(request)
        self.assertEqual((final['state'], final['processed'], final['attempted'], final['activities_created']), ('complete', 1, 1, 1))
        self.assertEqual(self.service.start_sync(alias)['operation'], final)
        self.assertEqual(self.service.start_sync(request)['operation'], final)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.sql('SELECT state FROM work_extraction_receipts'), [{'state': 'completed'}])
        raw = json.dumps(self.sql('SELECT * FROM work_sync_operations') + self.sql('SELECT * FROM work_commands'))
        self.assertNotIn(source['post_mask_ocr_text'], raw)
        second, _ = self.start()
        self.assertEqual(self.wait(second)['processed'], 0)
        self.assertEqual(len(self.transport.calls), 1)

    def test_auto_lane_busy_is_durable_nonadmission_not_a_delayed_retry(self):
        self.enable()
        self.source()
        request = self.request()
        self.service._extraction_lock.acquire()
        try:
            expected = {'operation': None, 'reason': 'extraction_in_progress'}
            self.assertEqual(self.service.start_sync(request), expected)
            self.assertEqual(self.service.sync_operation(), expected)
            self.assertEqual(self.sql('SELECT * FROM work_sync_operations'), [])
        finally:
            self.service._extraction_lock.release()
        self.assertEqual(self.service.start_sync(request), expected)
        self.assertEqual(self.service.sync_operation(request.command_id), expected)
        self.assertEqual(self.service.sync_operation(), {'operation': None, 'reason': None})
        self.assertEqual(self.service.stop_sync(request.command_id), expected)
        self.assertEqual(self.sql('SELECT * FROM work_extraction_receipts'), [])
        fresh, _ = self.start()
        self.assertEqual(self.wait(fresh)['processed'], 1)

    def test_stop_ignored_provider_stays_unsettled_and_alias_cannot_retry(self):
        _source, request, _operation, release = self.blocking_model(empty=False)
        stopping = self.service.stop_sync(request.command_id)['operation']
        self.assertEqual((stopping['state'], stopping['settled'], stopping['processed']), ('stopping', False, 0))
        self.assertEqual(self.sql('SELECT state FROM work_extraction_receipts'), [{'state': 'failed'}])
        self.assertTrue(self.service.list_activities()['items'][0]['evidence_available'])
        retry = self.request()
        self.assertEqual(self.service.start_sync(retry)['operation']['command_id'], str(request.command_id))
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.service.sync_operation(request.command_id)['operation']['state'], 'stopping')
        release.set()
        final = self.wait(request)
        self.assertEqual((final['state'], final['settled'], final['processed']), ('interrupted', True, 0))
        self.assertEqual(self.service.start_sync(retry)['operation'], final)
        self.assertEqual(self.sql('SELECT * FROM work_discoveries'), [])
        fresh, _ = self.start()
        result = self.wait(fresh)
        self.assertEqual((result['state'], result['processed'], result['activities_created']), ('complete', 1, 0))
        self.assertEqual(len(self.transport.calls), 2)
        self.assertEqual(self.sql('SELECT * FROM work_tasks'), [], 'Model data remains confirmation-only')
        self.assertEqual(self.sql('SELECT * FROM work_task_links'), [])
        self.assertEqual(self.sql('SELECT state FROM work_discoveries'), [{'state': 'pending'}])
        self.assertEqual(self.service.stop_sync(request.command_id)['operation'], final)

    def test_stop_before_worker_preparation_does_not_dispatch(self):
        self.configure_model()
        self.ocr_source()
        entered, release = Event(), Event()
        original = self.service._sync
        def delayed(**kwargs):
            entered.set()
            release.wait(5)
            return original(**kwargs)
        self.service._sync = delayed
        self.addCleanup(release.set)
        request, _ = self.start()
        self.assertTrue(entered.wait(3))
        self.assertEqual(self.service.stop_sync(request.command_id)['operation']['state'], 'stopping')
        release.set()
        self.assertEqual(self.wait(request)['state'], 'interrupted')
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.sql('SELECT * FROM work_extraction_receipts'), [])

    def test_stop_while_gateway_busy_does_not_wait_for_gateway_or_dispatch(self):
        self.configure_model()
        self.ocr_source()
        entered, release = Event(), Event()
        def occupy():
            with self.gateway._dispatch_lock:
                entered.set()
                release.wait(5)
        thread = Thread(target=occupy)
        thread.start()
        self.addCleanup(thread.join, 6)
        self.addCleanup(release.set)
        self.assertTrue(entered.wait(3))
        request, _ = self.start()
        deadline = time.monotonic() + 3
        while not self.sql('SELECT * FROM work_extraction_receipts') and time.monotonic() < deadline:
            Event().wait(.005)
        start = time.monotonic()
        self.assertEqual(self.service.stop_sync(request.command_id)['operation']['state'], 'stopping')
        self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(self.transport.calls, [])
        release.set()
        self.assertEqual(self.wait(request)['state'], 'interrupted')
        self.assertEqual(self.transport.calls, [])

    def test_commit_winning_stop_keeps_count_and_proposals_no_false_undo(self):
        self.enable()
        self.source()
        committed, release = Event(), Event()
        original = self.service._process_observation
        def after_commit(*args, **kwargs):
            result = original(*args, **kwargs)
            committed.set()
            release.wait(5)
            return result
        self.service._process_observation = after_commit
        self.addCleanup(release.set)
        request, _ = self.start()
        self.assertTrue(committed.wait(3))
        stopped = self.service.stop_sync(request.command_id)['operation']
        self.assertEqual((stopped['state'], stopped['processed']), ('complete', 1))
        self.assertEqual(len(self.sql('SELECT * FROM work_tasks')), 1)
        release.set()
        final = self.wait(request)
        self.assertEqual((final['state'], final['processed']), ('complete', 1))
        self.assertEqual(self.service.stop_sync(request.command_id)['operation'], final)

    def test_stop_linearizes_with_commit_transaction_and_preserves_winner(self):
        self.enable()
        self.source()
        in_commit, release = Event(), Event()
        original = Execution.completed
        def during_commit(execution, conn):
            original(execution, conn)
            in_commit.set()
            release.wait(5)
        self.addCleanup(release.set)
        with patch.object(Execution, 'completed', during_commit):
            request, _ = self.start()
            self.assertTrue(in_commit.wait(3))
            replies = []
            stopper = Thread(target=lambda: replies.append(self.service.stop_sync(request.command_id)))
            stopper.start()
            self.addCleanup(stopper.join, 6)
            self.addCleanup(release.set)
            Event().wait(.02)
            self.assertEqual(replies, [], 'Stop cannot acknowledge ahead of a winning commit')
            release.set()
            stopper.join(3)
        self.assertEqual(replies[0]['operation']['processed'], 1)
        final = self.wait(request)
        self.assertEqual(final['processed'], 1)
        self.assertEqual(len(self.sql('SELECT * FROM work_tasks')), 1)

    def test_shutdown_timeout_second_service_does_not_recover_or_detach_worker(self):
        _source, request, _operation, release = self.blocking_model()
        self.assertFalse(self.service.close(timeout=.01))
        other = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.addCleanup(other.close)
        self.assertIs(other._sync_coordinator, self.service._sync_coordinator)
        self.assertEqual(other.sync_operation(request.command_id)['operation']['state'], 'stopping')
        self.assertTrue(other.close(timeout=.01), 'Unrelated service close must not detach the worker')
        third = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.addCleanup(third.close)
        alias = self.request()
        self.assertEqual(third.start_sync(alias)['operation']['command_id'], str(request.command_id))
        release.set()
        final = self.wait(request)
        self.assertEqual(final['state'], 'interrupted')
        self.assertTrue(self.service.close(timeout=1))
        self.assertEqual(len(self.transport.calls), 1)

    def test_restart_marks_true_orphan_interrupted_without_dispatch(self):
        _source, request, _operation, release = self.blocking_model()
        path = self.root / 'restarted.sqlite3'
        with sqlite3.connect(self.path) as source, sqlite3.connect(path) as target:
            source.backup(target)
        restarted = TaskService(path, clock=lambda: self.now, model_provider=self.model)
        self.addCleanup(restarted.close)
        op = restarted.sync_operation(request.command_id)['operation']
        self.assertEqual((op['state'], op['settled'], op['attempted'], op['processed']), ('interrupted', True, 1, 0))
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(restarted.start_sync(request)['operation'], op)
        self.assertTrue(restarted.list_activities()['items'][0]['evidence_available'])
        self.assertEqual(len(self.transport.calls), 1)
        self.service.stop_sync(request.command_id)
        release.set()
        self.wait(request)
        fresh = self.request()
        restarted.start_sync(fresh)
        deadline = time.monotonic() + 5
        while not restarted.sync_operation(fresh.command_id)['operation']['settled'] and time.monotonic() < deadline:
            Event().wait(.005)
        self.assertEqual(restarted.sync_operation(fresh.command_id)['operation']['processed'], 1)
        self.assertEqual(len(self.transport.calls), 2)

    def test_context_abstention_and_all_fixed_discovery_failures_survive(self):
        self.configure_model()
        source = self.source()  # Organized but not full-source verified.
        self.sql("UPDATE context_observations SET post_mask_ocr_engine='synthetic_fixture' WHERE id=?", (source['id'],))
        request, _ = self.start()
        self.assertEqual(self.wait(request)['reason'], 'task_context_incomplete')
        self.assertEqual(self.transport.calls, [])
        self.assertTrue(self.service.list_activities()['items'][0]['evidence_available'])
        self.sql('DELETE FROM context_observations WHERE id=?', (source['id'],))
        self.ocr_source()
        for code in sorted(DISCOVERY_ERROR_CODES):
            with self.subTest(code=code), patch.object(self.model, 'extract', side_effect=TaskError(code, 409)):
                request, _ = self.start()
                final = self.wait(request)
                self.assertEqual((final['state'], final['reason'], final['attempted'], final['processed']), ('error', code, 1, 0))
                self.assertEqual(self.service.start_sync(request)['operation'], final)
        self.assertEqual(self.transport.calls, [])

    def test_expiry_revocation_and_gateway_revision_never_publish(self):
        for mutation in ('expiry', 'consent', 'gateway'):
            with self.subTest(mutation=mutation):
                # Each subtest gets a separate source and a fresh settings epoch.
                self.configure_model()
                source = self.ocr_source()
                entered, release = Event(), Event()
                self.transport.on_post = lambda: (entered.set(), release.wait(5))
                self.addCleanup(release.set)
                request, _ = self.start()
                self.assertTrue(entered.wait(3))
                if mutation == 'expiry':
                    self.sql('UPDATE context_observations SET expires_at=? WHERE id=?', ((self.now - timedelta(seconds=1)).isoformat(), source['id']))
                elif mutation == 'consent':
                    self.sql('UPDATE context_capture_settings SET consent_revision=? WHERE id=1', (str(uuid4()),))
                else:
                    # Synthetic concurrent configuration publication without I/O.
                    self.gateway._configuration = (8, self.gateway._configuration[1])
                release.set()
                final = self.wait(request)
                self.assertEqual((final['state'], final['reason'], final['processed']), ('error', 'discovery_authorization_changed', 0))
                self.assertEqual(self.sql('SELECT * FROM work_discoveries'), [])
                self.sql('DELETE FROM context_observations')
                self.sql('UPDATE context_capture_settings SET consent_revision=? WHERE id=1', (self.revision,))

    def test_partial_rules_batch_stops_on_early_settings_fence(self):
        self.enable()
        for _ in range(3):
            self.source()
        original = self.service._process_observation
        calls = []
        def process(*args, **kwargs):
            if calls:
                self.enable('evidence_rules_v1')
            calls.append(args[0])
            return original(*args, **kwargs)
        self.service._process_observation = process
        request, _ = self.start()
        final = self.wait(request)
        self.assertEqual((final['state'], final['reason']), ('error', 'discovery_authorization_changed'))
        self.assertEqual((final['selected'], final['attempted'], final['processed'], final['activities_created']), (3, 1, 1, 1))
        self.assertEqual(len(calls), 2)

    def test_source_fence_before_attempt_is_error_not_empty_success(self):
        self.enable()
        self.source()
        original = self.service._process_observation
        def expired(source_id, **kwargs):
            self.sql('DELETE FROM context_observations WHERE id=?', (source_id,))
            return original(source_id, **kwargs)
        self.service._process_observation = expired
        request, _ = self.start()
        final = self.wait(request)
        self.assertEqual((final['state'], final['reason'], final['selected'], final['attempted'], final['processed']),
                         ('error', 'source_outside_scope', 1, 0, 0))

    def test_rules_bound_and_skipped_invalid_counts_are_disjoint(self):
        self.enable()
        for i in range(202):
            self.source('TODO(me): Public rule ' + str(i))
        request, _ = self.start()
        final = self.wait(request)
        self.assertEqual((final['selected'], final['attempted'], final['processed'], final['has_more']), (200, 200, 200, True))
        next_request, _ = self.start()
        self.assertEqual(self.wait(next_request)['processed'], 2)
        self.assertEqual(self.service.sync_operation(request.command_id)['operation'], final)

    def test_thread_start_failure_terminal_and_stop_does_not_rewrite(self):
        self.enable()
        self.source()
        with patch('app.modules.task_activity.sync_operations.Thread.start', side_effect=RuntimeError('untrusted error detail')):
            request, result = self.start()
        self.assertEqual((result['state'], result['reason'], result['settled']), ('error', 'worker_start_failed', True))
        self.assertEqual(self.service.stop_sync(request.command_id)['operation'], result)
        self.assertFalse(self.service._extraction_lock.locked())
        fresh, _ = self.start()
        final = self.wait(fresh)
        self.assertEqual(final['state'], 'complete')
        self.assertEqual(self.service.stop_sync(fresh.command_id)['operation'], final)

    def test_get_is_plain_read_and_lost_reply_recovers_exact_receipt(self):
        self.enable()
        self.source()
        request, _ = self.start()
        final = self.wait(request)
        with patch.object(self.service.store, 'transaction', side_effect=AssertionError('GET wrote')), \
                patch.object(self.service, '_maintenance', side_effect=AssertionError('GET maintained')):
            self.assertEqual(self.service.sync_operation(request.command_id)['operation'], final)
            self.assertEqual(self.service.sync_operation()['operation'], final)
            with self.assertRaisesRegex(TaskError, '^task_sync_not_found$'):
                self.service.sync_operation(uuid4())
        self.assertEqual(self.service.start_sync(request)['operation'], final)

    def test_failure_receipt_terminal_reason_cannot_be_overwritten_by_late_stop(self):
        self.configure_model()
        self.ocr_source()
        self.transport.content = 'invalid public synthetic response'
        failed, release = Event(), Event()
        original = self.service._process_observation
        def after_failure(*args, **kwargs):
            try:
                return original(*args, **kwargs)
            except Exception:
                failed.set()
                release.wait(5)
                raise
        self.service._process_observation = after_failure
        self.addCleanup(release.set)
        request, _ = self.start()
        self.assertTrue(failed.wait(3))
        terminal = self.service.sync_operation(request.command_id)['operation']
        self.assertEqual((terminal['state'], terminal['reason'], terminal['settled']),
                         ('error', 'invalid_discovery_result', True))
        self.assertEqual(self.sql('SELECT state FROM work_extraction_receipts'), [{'state': 'failed'}])
        self.assertTrue(self.service._extraction_lock.locked())
        self.assertEqual(self.service.stop_sync(request.command_id)['operation'], terminal)
        alias = self.request()
        self.assertEqual(self.service.start_sync(alias)['operation'], terminal)
        self.assertEqual(len(self.transport.calls), 1)
        release.set()
        self.assertEqual(self.wait(request), terminal)

    def test_no_work_terminal_result_is_immutable_before_runner_release(self):
        self.enable()
        selected, release = Event(), Event()
        original = self.service._sync
        def after_selection(**kwargs):
            result = original(**kwargs)
            selected.set()
            release.wait(5)
            return result
        self.service._sync = after_selection
        self.addCleanup(release.set)
        request, _ = self.start()
        self.assertTrue(selected.wait(3))
        terminal = self.service.sync_operation(request.command_id)['operation']
        self.assertEqual((terminal['state'], terminal['reason'], terminal['selected']),
                         ('complete', 'no_authorized_observations', 0))
        self.assertTrue(self.service._extraction_lock.locked())
        self.assertEqual(self.service.stop_sync(request.command_id)['operation'], terminal)
        alias = self.request()
        self.assertEqual(self.service.start_sync(alias)['operation'], terminal)
        release.set()
        self.assertEqual(self.wait(request), terminal)

    def test_missing_media_is_counted_and_does_not_starve_valid_source(self):
        self.enable()
        self.source('TODO(me): Missing source', media=False)
        self.source('TODO(me): Valid source')
        request, _ = self.start()
        final = self.wait(request)
        self.assertEqual((final['state'], final['selected'], final['processed'],
                          final['activities_created'], final['skipped_invalid']), ('complete', 1, 1, 1, 1))
        self.assertEqual(len(self.sql('SELECT * FROM work_activities WHERE valid=0')), 1)

    def test_simultaneous_same_and_distinct_requests_only_launch_one_worker(self):
        self.configure_model()
        self.ocr_source()
        entered, release = Event(), Event()
        self.transport.on_post = lambda: (entered.set(), release.wait(5))
        self.addCleanup(release.set)
        other = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.addCleanup(other.close)
        requests = [self.request(), self.request()]
        requests.append(requests[0])
        results = []
        launch = Event()
        def call(service, request):
            launch.wait(3)
            results.append(service.start_sync(request))
        threads = [Thread(target=call, args=(self.service if i % 2 else other, request))
                   for i, request in enumerate(requests)]
        for thread in threads:
            thread.start()
            self.addCleanup(thread.join, 6)
        self.addCleanup(release.set)
        launch.set()
        for thread in threads:
            thread.join(3)
            self.assertFalse(thread.is_alive())
        self.assertTrue(entered.wait(3))
        self.assertEqual(len(results), 3)
        self.assertEqual(len({result['operation']['command_id'] for result in results}), 1)
        self.assertEqual(len(self.transport.calls), 1)
        release.set()
        self.wait(requests[0])

    def test_thread_start_registration_and_stop_have_no_exposed_owner_gap(self):
        self.enable()
        self.source()
        registered, release_start = Event(), Event()
        original = Thread.start
        def start(thread):
            if thread.name == 'task-sync-worker':
                registered.set()
                release_start.wait(5)
            return original(thread)
        request = self.request()
        replies, stops = [], []
        with patch('app.modules.task_activity.sync_operations.Thread.start', start):
            caller = Thread(target=lambda: replies.append(self.service.start_sync(request)))
            caller.start()
            self.addCleanup(caller.join, 6)
            self.addCleanup(release_start.set)
            self.assertTrue(registered.wait(3))
            receipt = self.service.sync_operation(request.command_id)['operation']
            self.assertEqual(receipt['state'], 'pending')
            self.assertIsNotNone(self.service._sync_coordinator.active)
            stopper = Thread(target=lambda: stops.append(self.service.stop_sync(request.command_id)))
            stopper.start()
            self.addCleanup(stopper.join, 6)
            self.addCleanup(release_start.set)
            release_start.set()
            caller.join(3)
            stopper.join(3)
        self.assertEqual(len(replies), 1)
        self.assertEqual(len(stops), 1)
        final = self.wait(request)
        self.assertIn(final['state'], ('complete', 'interrupted'))
        self.assertFalse(self.service._extraction_lock.locked())

    def test_close_budget_includes_publication_gate_and_does_not_block_admission(self):
        _source, request, _operation, release_provider = self.blocking_model()
        execution = self.service._sync_coordinator.active
        held, release_gate = Event(), Event()
        def hold_gate():
            with execution.gate:
                held.set()
                release_gate.wait(5)
        holder = Thread(target=hold_gate)
        holder.start()
        self.addCleanup(holder.join, 6)
        self.addCleanup(release_gate.set)
        self.addCleanup(release_provider.set)
        self.assertTrue(held.wait(3))
        started = time.monotonic()
        self.assertFalse(self.service.close(timeout=.01))
        self.assertLess(time.monotonic() - started, .25)
        self.assertTrue(execution.cancelled.is_set())
        other = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        self.addCleanup(other.close)
        started = time.monotonic()
        alias = self.request()
        self.assertEqual(other.start_sync(alias)['operation']['command_id'], str(request.command_id))
        self.assertLess(time.monotonic() - started, .25)
        self.assertEqual(len(self.transport.calls), 1)
        release_gate.set()
        release_provider.set()
        self.assertEqual(self.wait(request)['state'], 'interrupted')
        self.assertTrue(self.service.close(timeout=1))

    def test_close_budget_includes_sqlite_fence_contention(self):
        _source, request, _operation, release = self.blocking_model()
        connection = sqlite3.connect(self.path)
        connection.execute('BEGIN IMMEDIATE')
        self.addCleanup(connection.close)
        started = time.monotonic()
        self.assertFalse(self.service.close(timeout=.01))
        self.assertLess(time.monotonic() - started, .25)
        connection.rollback()
        release.set()
        self.assertEqual(self.wait(request)['state'], 'interrupted')
        self.assertEqual(self.sql('SELECT * FROM work_discoveries'), [])
        self.assertTrue(self.service.close(timeout=1))

    def test_transient_finalization_contention_recovers_terminal_lane_without_dispatch(self):
        self.configure_model(empty=True)
        self.ocr_source()
        ready, release = Event(), Event()
        original = self.service._sync
        def pause_after_commit(**kwargs):
            result = original(**kwargs)
            ready.set()
            release.wait(5)
            return result
        self.service._sync = pause_after_commit
        self.addCleanup(release.set)
        request, _ = self.start()
        self.assertTrue(ready.wait(3))
        execution = self.service._sync_coordinator.active
        terminal = self.service.sync_operation(request.command_id)['operation']
        writer = sqlite3.connect(self.path)
        writer.execute('BEGIN IMMEDIATE')
        self.addCleanup(writer.close)
        release.set()
        self.assertTrue(execution.settlement_failed.wait(3))
        self.assertTrue(execution.thread.is_alive(), 'Bookkeeping retry stays owned')
        self.assertTrue(self.service._extraction_lock.locked())
        self.assertEqual(len(self.transport.calls), 1)
        started = time.monotonic()
        self.assertFalse(self.service.close(timeout=.01))
        self.assertLess(time.monotonic() - started, .25)
        writer.rollback()
        execution.thread.join(3)
        self.assertFalse(execution.thread.is_alive())
        self.assertFalse(self.service._extraction_lock.locked())
        self.assertEqual(self.service.sync_operation(request.command_id)['operation'], terminal)
        self.service = TaskService(self.path, clock=lambda: self.now, model_provider=self.model)
        fresh, _ = self.start()
        self.assertEqual(self.wait(fresh)['processed'], 0)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(len(self.sql('SELECT * FROM work_tasks')), 0)

    def test_transient_finalization_contention_recovers_pending_failed_attempt_without_retry(self):
        self.configure_model()
        self.ocr_source()
        entered, release = Event(), Event()
        class Interrupted(BaseException):
            pass
        def crash():
            entered.set()
            release.wait(5)
            raise Interrupted()
        self.transport.on_post = crash
        self.addCleanup(release.set)
        request, _ = self.start()
        self.assertTrue(entered.wait(3))
        execution = self.service._sync_coordinator.active
        writer = sqlite3.connect(self.path)
        writer.execute('BEGIN IMMEDIATE')
        self.addCleanup(writer.close)
        release.set()
        self.assertTrue(execution.settlement_failed.wait(3))
        self.assertEqual(self.service.sync_operation(request.command_id)['operation']['state'], 'pending')
        writer.rollback()
        final = self.wait(request)
        execution.thread.join(3)
        self.assertEqual((final['state'], final['reason'], final['attempted'], final['processed']),
                         ('error', 'sync_failed', 1, 0))
        self.assertEqual(self.sql('SELECT state FROM work_extraction_receipts'), [{'state': 'failed'}])
        self.assertEqual(len(self.transport.calls), 1)
        self.assertFalse(self.service._extraction_lock.locked())
        self.assertEqual(self.service.start_sync(request)['operation'], final)
        self.assertEqual(len(self.transport.calls), 1)

    def test_bounded_admission_contention_never_accepts_or_dispatches(self):
        self.enable()
        self.source()
        request = self.request()
        connection = sqlite3.connect(self.path)
        connection.execute('BEGIN IMMEDIATE')
        self.addCleanup(connection.close)
        started = time.monotonic()
        with self.assertRaisesRegex(TaskError, '^task_sync_unavailable$'):
            self.service.start_sync(request)
        self.assertLess(time.monotonic() - started, 2)
        connection.rollback()
        with self.assertRaisesRegex(TaskError, '^task_sync_not_found$'):
            self.service.sync_operation(request.command_id)
        self.assertFalse(self.service._extraction_lock.locked())
        self.assertEqual(self.sql('SELECT * FROM work_extraction_receipts'), [])


if __name__ == '__main__':
    unittest.main()
