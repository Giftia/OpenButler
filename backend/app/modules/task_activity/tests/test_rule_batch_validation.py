"""Offline regression fences and scaling bounds for explicit deterministic batches."""
from collections import Counter
from contextlib import contextmanager
from datetime import timedelta
import os
import unittest
from unittest.mock import patch

from app.modules.task_activity import models
from app.modules.task_activity.tests.fixture import TaskFixture
from app.modules.task_activity.tests import test_sync_operations as sync_tests


class BatchFixture(TaskFixture):
    request = sync_tests.SyncOperationTests.request
    start = sync_tests.SyncOperationTests.start
    wait = sync_tests.SyncOperationTests.wait

    def setUp(self):
        TaskFixture.setUp(self)
        self.addCleanup(lambda: self.service.close(timeout=3))
        def blocked(*args, **kwargs):
            raise AssertionError('Rule batch tests are offline and synthetic')
        for name in ('socket.create_connection', 'socket.socket.connect'):
            blocker = patch(name, blocked)
            blocker.start()
            self.addCleanup(blocker.stop)

class DependencyRaceTests(BatchFixture, unittest.TestCase):
    # Run only explicit tests built below, not the inherited test methods.
    def mutate_old(self, source, mutation):
        if mutation == 'expiry':
            self.now += timedelta(seconds=2)
        elif mutation == 'content':
            self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed synthetic text' WHERE id=?", (source['id'],))
        elif mutation == 'media':
            path = self.root / 'context_engine' / 'media' / (source['evidence_id'] + '.png')
            before = path.stat()
            data = path.read_bytes()
            path.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
            os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
            self.assertEqual(path.stat().st_size, before.st_size)
            self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertNotEqual(path.stat().st_ctime_ns, before.st_ctime_ns)

    def run_dedupe_race(self, mutation, owned):
        self.enable()
        old = self.source('TODO(me): Shared synthetic task', expires_at=self.now + timedelta(seconds=1))
        self.service.process_observation(old['id'])
        task = self.service.list_tasks()['items'][0]
        if owned:
            self.service.edit_task(task['id'], models.TaskEdit(expected_version=task['version'], confirmed=True))
        fresh = self.source('TODO(me): Shared synthetic task')
        self.source('TODO(me): Unrelated fresh task')
        version = self.service.settings()['version']
        original = self.service._process_observation
        mutated=[]
        def process(*args, **kwargs):
            if not mutated:
                self.mutate_old(old, mutation)
                mutated.append(True)
            return original(*args, **kwargs)
        with patch.object(self.service, '_process_observation', process):
            request, _ = self.start()
            final=self.wait(request)
        self.assertEqual((final['state'], final['processed']), ('complete', 2))
        self.assertEqual(self.service.settings()['version'], version)
        raw = self.sql('SELECT * FROM work_tasks WHERE id=?', (task['id'],))[0]
        self.assertEqual(raw['evidence_unavailable'], 1)
        self.assertEqual(raw['title'], 'Shared synthetic task' if owned else '来源已不可用')
        discovery = self.sql('SELECT d.* FROM work_discoveries d JOIN work_activities a ON a.id=d.activity_id WHERE a.source_record_id=?', (fresh['id'],))[0]
        self.assertEqual((discovery['state'], discovery['task_id']), ('accepted', task['id']) if owned else ('pending', None))

    def test_cross_source_same_topic_media_replacement_after_selection(self):
        self.enable()
        prior_quote='TODO(me): Prior linked synthetic task'
        old=self.source(prior_quote)
        self.service.process_observation(old['id'])
        task=self.service.list_tasks()['items'][0]
        quote='Public current synthetic context'
        fresh=self.source(quote, temporal_context={'relations':[{'relation':'same_topic',
            'prior_observation_id':old['id'], 'prior_quote':prior_quote, 'current_quote':quote}]})
        original=self.service._process_observation
        def process(*args,**kwargs):
            self.mutate_old(old,'media')
            return original(*args,**kwargs)
        with patch.object(self.service,'_process_observation',process):
            request,_=self.start()
            self.assertEqual(self.wait(request)['state'],'complete')
        self.assertEqual(self.sql('SELECT l.* FROM work_task_links l JOIN work_activities a ON a.id=l.activity_id WHERE a.source_record_id=?',(fresh['id'],)),[])
        self.assertEqual(self.sql('SELECT evidence_unavailable FROM work_tasks WHERE id=?',(task['id'],)),[{'evidence_unavailable':1}])

def _register_DependencyRaceTests():
    names=[]
    for mutation in ('expiry','content','media'):
        for owned in (False,True):
            name='test_dedupe_' + mutation + ('_owned' if owned else '_unowned')
            setattr(DependencyRaceTests,name,lambda self,m=mutation,o=owned:self.run_dedupe_race(m,o))
            names.append(name)
    names.append('test_cross_source_same_topic_media_replacement_after_selection')
    return unittest.TestSuite(DependencyRaceTests(name) for name in names)

_register_DependencyRaceTests()

class EarlyExitScrub(BatchFixture, unittest.TestCase):
    def check_scrub(self, mode, abort):
        self.enable()
        old=self.source('TODO(me): Old synthetic privacy evidence')
        self.service.process_observation(old['id'])
        task=self.sql('SELECT * FROM work_tasks')[0]
        self.source('TODO(me): Fresh synthetic A')
        self.source('TODO(me): Fresh synthetic B')
        original=self.service._process_observation
        invocations=[]
        def process(observation_id, **kwargs):
            invocations.append(observation_id)
            if len(invocations)==2:
                self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed original synthetic text' WHERE id=?",(old['id'],))
                if abort=='source':
                    self.sql('UPDATE context_observations SET expires_at=? WHERE id=?',(self.now.isoformat(),observation_id))
                else:
                    settings=self.service.settings()
                    self.service.set_settings(models.SettingsEdit(expected_version=settings['version'],auto_discovery=False,confirmed=True))
            return original(observation_id,**kwargs)
        with patch.object(self.service,'_process_observation',process):
            if mode=='async':
                request,_=self.start()
                result=self.wait(request)
                self.assertEqual(result['state'],'error')
                self.assertEqual(result['processed'],1)
            else:
                result=self.service.sync()
                self.assertEqual(result['processed'],1)
        row=self.sql('SELECT * FROM work_tasks WHERE id=?',(task['id'],))[0]
        self.assertEqual((row['evidence_unavailable'],row['title']),(1,'来源已不可用'),result)
        discovery=self.sql('SELECT * FROM work_discoveries WHERE task_id=?',(task['id'],))[0]
        self.assertEqual((discovery['state'],discovery['title'],discovery['quote']),('invalidated','',''))

def _register_EarlyExitScrub():
    names=[]
    for mode in ('sync','async'):
        for abort in ('source','settings'):
            name='test_'+mode+'_early_'+abort+'_fence_scrubs_stale_history'
            setattr(EarlyExitScrub,name,lambda self,m=mode,a=abort:self.check_scrub(m,a))
            names.append(name)
    return unittest.TestSuite(EarlyExitScrub(n) for n in names)

_register_EarlyExitScrub()

class RuleFences(BatchFixture, unittest.TestCase):
    def check_fence(self, mutation):
        self.enable()
        source=self.source('TODO(me): Current synthetic fence source')
        self.source('TODO(me): Another synthetic source')
        transaction=self.service.store.transaction
        applied=[]
        selected=[]
        process=self.service._process_observation
        def track(source_id,**kwargs):
            selected.append(source_id)
            return process(source_id,**kwargs)
        @contextmanager
        def wrapper(**kwargs):
            with transaction(**kwargs) as conn:
                yield conn
                should_mutate=(not applied and bool(conn.execute("SELECT 1 FROM work_extraction_receipts WHERE state='pending'").fetchone()))
            # After the first evidence-only prep transaction has committed.
            if should_mutate:
                applied.append(mutation)
                target=selected[0]
                if mutation=='ocr':
                    self.sql("UPDATE context_observations SET post_mask_ocr_text='Mutated synthetic current source' WHERE id=?",(target,))
                elif mutation=='media':
                    row=self.sql('SELECT evidence_id FROM context_observations WHERE id=?',(target,))[0]
                    path=self.root/'context_engine'/'media'/(row['evidence_id']+'.png')
                    path.unlink()
                elif mutation=='expiry':
                    self.sql('UPDATE context_observations SET expires_at=? WHERE id=?',(self.now.isoformat(),target))
                elif mutation=='receipt_attempt':
                    self.sql('UPDATE work_extraction_receipts SET attempt=attempt+1 WHERE source_record_id=?',(target,))
                elif mutation=='receipt_state':
                    self.sql("UPDATE work_extraction_receipts SET state='failed' WHERE source_record_id=?",(target,))
                elif mutation=='activity_valid':
                    self.sql('UPDATE work_activities SET valid=0 WHERE source_record_id=?',(target,))
                elif mutation=='settings':
                    self.sql('UPDATE work_task_settings SET version=version+1 WHERE id=1')
                elif mutation=='consent':
                    self.sql('UPDATE context_capture_settings SET consented=0 WHERE id=1')
                elif mutation=='cancel':
                    self.service._sync_coordinator.active.cancelled.set()
                elif mutation=='shutdown':
                    self.service._closed.set()
        with patch.object(self.service,'_process_observation',track),patch.object(self.service.store,'transaction',wrapper):
            request,_=self.start()
            result=self.wait(request)
        self.assertEqual(applied,[mutation])
        self.assertEqual(result['processed'],0)
        self.assertIn(result['state'],('error','interrupted'))
        self.assertEqual(self.sql('SELECT * FROM work_discoveries'),[])
        self.assertEqual(self.sql('SELECT * FROM work_tasks'),[])

def _register_RuleFences():
    names=[]
    for mutation in ('ocr','media','expiry','receipt_attempt','receipt_state','activity_valid','settings','consent','cancel','shutdown'):
        name='test_rule_publication_rechecks_'+mutation
        setattr(RuleFences,name,lambda self,m=mutation:self.check_fence(m))
        names.append(name)
    return unittest.TestSuite(RuleFences(n) for n in names)

_register_RuleFences()

class ClosureTests(BatchFixture, unittest.TestCase):
    def tasks_from_sources(self, count=3):
        records=[]
        for i in range(count):
            source=self.source(f'TODO(me): Synthetic closure task {i}')
            result=self.service.process_observation(source['id'])
            task=self.sql('SELECT * FROM work_tasks WHERE origin_activity_id=?',(result['activity_id'],))[0]
            records.append((source,task))
        return records

    def merge_into(self, child, root):
        self.service.merge(child['id'],models.MergeRequest(
            expected_version=self.current(child)['version'],target_id=root['id'],target_version=self.current(root)['version']))

    def add_later_source(self):
        self.now+=timedelta(seconds=1)
        return self.source('TODO(me): Later independent source')

    def test_three_level_merged_member_origin_scrubbed_before_dedupe_and_correction(self):
        self.enable()
        (root_source,root),(child_source,child),(leaf_source,leaf)=self.tasks_from_sources()
        fresh=self.source(root_source['post_mask_ocr_text'])
        # Evidence-only failed attempt makes a correction possible before retry.
        with patch.object(self.service.provider,'extract',side_effect=RuntimeError('synthetic failure')):
            with self.assertRaises(Exception):
                self.service.process_observation(fresh['id'])
        activity=self.sql('SELECT * FROM work_activities WHERE source_record_id=?',(fresh['id'],))[0]
        self.link(leaf,activity,relation='possible',decision='rejected',primary=False)
        self.merge_into(leaf,child)
        self.merge_into(child,root)
        self.add_later_source()
        process=self.service._process_observation
        auto_link=self.service._auto_link
        checked=[]
        def mutate(source_id,**kwargs):
            if source_id==fresh['id']:
                self.sql("UPDATE context_observations SET post_mask_ocr_text='Replaced synthetic leaf evidence' WHERE id=?",(leaf_source['id'],))
            return process(source_id,**kwargs)
        def inspect(conn,task_id,activity_id,**kwargs):
            if activity_id==activity['id']:
                leaf_now=conn.execute('SELECT * FROM work_tasks WHERE id=?',(leaf['id'],)).fetchone()
                self.assertEqual((leaf_now['evidence_unavailable'],leaf_now['title']),(1,'来源已不可用'))
                checked.append(True)
            return auto_link(conn,task_id,activity_id,**kwargs)
        with patch.object(self.service,'_process_observation',mutate),patch.object(self.service,'_auto_link',inspect):
            request,_=self.start()
            self.assertEqual(self.wait(request)['processed'],2)
        self.assertEqual(checked,[True])
        self.assertEqual(self.sql('SELECT task_id,decision,origin FROM work_task_links WHERE activity_id=?',(activity['id'],)),[
            {'task_id':leaf['id'],'decision':'rejected','origin':'user'}])

    def test_same_topic_prior_receipt_hash_is_live_before_association(self):
        self.enable()
        (old,task),=self.tasks_from_sources(1)
        current_quote='Synthetic public same topic reference'
        fresh=self.source(current_quote,temporal_context={'relations':[
            {'relation':'same_topic','prior_observation_id':old['id'],
             'prior_quote':old['post_mask_ocr_text'],'current_quote':current_quote}]})
        self.add_later_source()
        process=self.service._process_observation
        reconcile=self.service._reconcile_associations
        checked=[]
        def mutate(source_id,**kwargs):
            if source_id==fresh['id']:
                self.sql("UPDATE work_extraction_receipts SET evidence_fingerprint=? WHERE source_record_id=?",('f'*64,old['id']))
            return process(source_id,**kwargs)
        def inspect(conn,activity_id,source,excerpts):
            if source['id']==fresh['id']:
                prior=conn.execute('SELECT valid FROM work_activities WHERE source_record_id=?',(old['id'],)).fetchone()
                self.assertEqual(prior['valid'],0)
                checked.append(True)
            return reconcile(conn,activity_id,source,excerpts)
        with patch.object(self.service,'_process_observation',mutate),patch.object(self.service,'_reconcile_associations',inspect):
            request,_=self.start()
            self.assertEqual(self.wait(request)['processed'],2)
        self.assertEqual(checked,[True])
        self.assertEqual(self.sql('SELECT l.* FROM work_task_links l JOIN work_activities a ON l.activity_id=a.id WHERE a.source_record_id=?',(fresh['id'],)),[])

    def test_suppression_remains_after_origin_scrub_at_nonfinal_publication(self):
        self.enable()
        old=self.source('TODO: Suppressed synthetic task')
        self.service.process_observation(old['id'])
        discovery=self.sql('SELECT * FROM work_discoveries')[0]
        self.service.resolve(discovery['id'],models.DiscoveryResolution(expected_version=discovery['version'],decision='dismiss'))
        fresh=self.source('TODO(me): Suppressed synthetic task')
        self.add_later_source()
        process=self.service._process_observation
        snapshots=[]
        def mutate(source_id,**kwargs):
            if source_id==fresh['id']:
                self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed dismissed synthetic evidence' WHERE id=?",(old['id'],))
            result=process(source_id,**kwargs)
            if source_id==fresh['id']:
                snapshots.extend(self.sql('SELECT d.state,d.task_id FROM work_discoveries d JOIN work_activities a ON a.id=d.activity_id WHERE a.source_record_id=?',(fresh['id'],)))
            return result
        with patch.object(self.service,'_process_observation',mutate):
            request,_=self.start()
            self.assertEqual(self.wait(request)['processed'],2)
        self.assertEqual(snapshots,[{'state':'dismissed','task_id':None}])

def _register_ClosureTests():
    return unittest.TestSuite(ClosureTests(n) for n in (
        'test_three_level_merged_member_origin_scrubbed_before_dedupe_and_correction',
        'test_same_topic_prior_receipt_hash_is_live_before_association',
        'test_suppression_remains_after_origin_scrub_at_nonfinal_publication'))

_register_ClosureTests()


class BatchBoundaryTests(BatchFixture, unittest.TestCase):
    mutate_old = DependencyRaceTests.mutate_old
    run_dedupe_race = DependencyRaceTests.run_dedupe_race

    def check_dedupe_after_preparation(self, mutation, owned):
        original = self.service._publication_guard
        pending = []
        @contextmanager
        def gap(proposals, prepared):
            # The baseline race helper installs its mutation at item entry.
            # Move it to this evidence-committed/publication-not-started gap.
            if pending:
                source, kind = pending.pop()
                DependencyRaceTests.mutate_old(self, source, kind)
            with original(proposals, prepared):
                yield
        with patch.object(self, 'mutate_old', lambda source, kind: pending.append((source, kind))), \
                patch.object(self.service, '_publication_guard', gap):
            self.run_dedupe_race(mutation, owned)

    def test_same_size_current_media_replacement_after_preparation(self):
        self.enable()
        self.source('TODO(me): Current media fence')
        self.source('TODO(me): Later media fence')
        guard = self.service._publication_guard
        mutations = []
        @contextmanager
        def gap(proposals, prepared):
            if not mutations:
                source = self.sql("SELECT o.* FROM context_observations o JOIN work_extraction_receipts r "
                    "ON r.source_record_id=o.id WHERE r.state='pending'")[0]
                self.mutate_old(source, 'media')
                mutations.append(True)
            with guard(proposals, prepared):
                yield
        with patch.object(self.service, '_publication_guard', gap):
            request, _ = self.start()
            final = self.wait(request)
        self.assertEqual((final['state'], final['processed']), ('error', 0))
        self.assertEqual(self.sql('SELECT * FROM work_tasks'), [])
        self.assertEqual(self.sql('SELECT * FROM work_discoveries'), [])
        self.assertEqual(self.sql('SELECT valid FROM work_activities'), [{'valid': 0}])

    def check_terminal_scrub(self, mutation, public_read=None):
        self.enable()
        old = self.source('TODO(me): Unrelated earlier task', expires_at=self.now + timedelta(seconds=1))
        self.service.process_observation(old['id'])
        task = self.sql('SELECT * FROM work_tasks')[0]
        self.source('TODO(me): First independent task')
        self.source('TODO(me): Final independent task')
        process = self.service._process_observation
        count = []
        def gap(*args, **kwargs):
            if count:
                self.mutate_old(old, mutation)
                if public_read is not None:
                    getattr(self.service, public_read)(task['id']) if public_read == 'detail' else getattr(self.service, public_read)()
                    row = self.sql('SELECT evidence_unavailable FROM work_tasks WHERE id=?', (task['id'],))[0]
                    self.assertEqual(row['evidence_unavailable'], 1)
            result = process(*args, **kwargs)
            count.append(True)
            return result
        with patch.object(self.service, '_process_observation', gap):
            request, _ = self.start()
            final = self.wait(request)
        self.assertEqual((final['state'], final['processed']), ('complete', 2))
        row = self.sql('SELECT title,evidence_unavailable FROM work_tasks WHERE id=?', (task['id'],))[0]
        self.assertEqual(row, {'title': '来源已不可用', 'evidence_unavailable': 1})
        row = self.sql('SELECT state,title,quote FROM work_discoveries WHERE task_id=?', (task['id'],))[0]
        self.assertEqual(row, {'state': 'invalidated', 'title': '', 'quote': ''})


for _mutation in ('expiry', 'content', 'media'):
    for _owned in (False, True):
        setattr(BatchBoundaryTests, 'test_dedupe_after_preparation_' + _mutation + ('_owned' if _owned else '_unowned'),
            lambda self, m=_mutation, o=_owned: self.check_dedupe_after_preparation(m, o))
    setattr(BatchBoundaryTests, 'test_terminal_sweep_scrubs_unrelated_' + _mutation,
        lambda self, m=_mutation: self.check_terminal_scrub(m))
for _read in ('list_tasks', 'list_activities', 'discoveries', 'detail'):
    setattr(BatchBoundaryTests, 'test_public_read_scrubs_during_batch_' + _read,
        lambda self, r=_read: self.check_terminal_scrub('media', r))


class BatchScalingTests(BatchFixture, unittest.TestCase):
    def check_counts(self, n, history):
        self.enable()
        for i in range(history):
            self.service.process_observation(self.source('TODO(me): Prior ' + str(i))['id'])
        for i in range(n + (2 if n == 200 else 0)):
            self.source('TODO(me): Independent fresh ' + str(i))
        counts = Counter()
        source = self.service._source
        transaction = self.service.store.transaction
        maintenance = self.service._maintenance
        def checked_source(*args, **kwargs):
            counts['sources'] += 1
            return source(*args, **kwargs)
        def full_maintenance(*args, **kwargs):
            counts['full_sweeps'] += 1
            return maintenance(*args, **kwargs)
        @contextmanager
        def counted_transaction(**kwargs):
            counts['transactions'] += 1
            with transaction(**kwargs) as conn:
                yield conn
        with patch.object(self.service, '_source', checked_source), \
                patch.object(self.service, '_maintenance', full_maintenance), \
                patch.object(self.service.store, 'transaction', counted_transaction):
            request, _ = self.start()
            result = self.wait(request, timeout=20)
            execution = self.service._sync_coordinator.active
            if execution:
                execution.thread.join(5)
                self.assertFalse(execution.thread.is_alive())
        self.assertEqual((result['state'], result['selected'], result['processed'], result['attempted'],
            result['activities_created'], result['has_more']), ('complete', n, n, n, n, n == 200))
        self.assertEqual(counts['transactions'], 2 * n + 4)
        self.assertEqual(counts['full_sweeps'], 2)
        self.assertLessEqual(counts['sources'], 6 * n + 2 * history + 1)
        self.assertEqual(counts['sources'], 5 * n - 1 + 2 * history + int(n == 200))


for _n, _history in ((1, 0), (10, 0), (50, 0), (10, 50), (200, 0)):
    setattr(BatchScalingTests, f'test_linear_source_checks_n{_n}_m{_history}',
        lambda self, n=_n, m=_history: self.check_counts(n, m))

from app.modules.task_activity.sync_operations import Execution

class TerminalScrub(BatchFixture, unittest.TestCase):
    def check_scrub(self, empty):
        self.enable()
        old=self.source('TODO(me): Earlier synthetic history')
        self.service.process_observation(old['id'])
        first=self.source('TODO(me): First fresh synthetic source')
        self.now+=timedelta(seconds=1)
        last=self.source('Plain synthetic reference' if empty else 'TODO(me): Last fresh synthetic source')
        process=self.service._process_observation
        completed=Execution.completed
        inspected=[]
        def mutate(source_id,**kwargs):
            if source_id==last['id']:
                self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed unrelated old evidence' WHERE id=?",(old['id'],))
            return process(source_id,**kwargs)
        def before_terminal(execution,conn):
            row=conn.execute('SELECT processed FROM work_sync_operations WHERE command_id=?',(execution.command_id,)).fetchone()
            if row['processed']==1:
                prior=conn.execute('SELECT valid FROM work_activities WHERE source_record_id=?',(old['id'],)).fetchone()
                discovery=conn.execute('SELECT d.state,d.title,d.quote FROM work_discoveries d JOIN work_activities a ON a.id=d.activity_id WHERE a.source_record_id=?',(old['id'],)).fetchone()
                last_receipt=conn.execute('SELECT state FROM work_extraction_receipts WHERE source_record_id=?',(last['id'],)).fetchone()
                self.assertEqual(prior['valid'],0)
                self.assertEqual(tuple(discovery),('invalidated','',''))
                self.assertEqual(last_receipt['state'],'completed')
                inspected.append(True)
            return completed(execution,conn)
        with patch.object(self.service,'_process_observation',mutate),patch.object(Execution,'completed',before_terminal):
            request,_=self.start()
            result=self.wait(request)
        self.assertEqual((result['state'],result['processed']),('complete',2))
        self.assertEqual(inspected,[True])

def _register_terminal_scrub():
    names=[]
    for empty in (False,True):
        name='test_terminal_scrub_with_'+('zero_proposals' if empty else 'proposals')
        setattr(TerminalScrub,name,lambda self,e=empty:self.check_scrub(e))
        names.append(name)
    return unittest.TestSuite(TerminalScrub(n) for n in names)

_register_terminal_scrub()


class BatchCorrectionTests(BatchFixture, unittest.TestCase):
    def check_live_correction(self, action):
        self.enable()
        marker = 'TODO:' if action == 'dismiss' else 'TODO(me):'
        old = self.source(marker + ' Shared corrected task')
        self.service.process_observation(old['id'])
        old_task = next(iter(self.sql('SELECT * FROM work_tasks')), None)
        old_discovery = self.sql('SELECT * FROM work_discoveries')[0]
        root = self.task('Distinct merge target') if action in ('merge', 'unmerge') else None
        if action == 'unmerge':
            self.service.merge(old_task['id'], models.MergeRequest(
                expected_version=self.current(old_task)['version'], target_id=root['id'],
                target_version=self.current(root)['version']))
        self.now += timedelta(seconds=1)
        fresh = self.source('TODO(me): Shared corrected task')
        self.now += timedelta(seconds=1)
        self.source('TODO(me): Last unrelated corrected task')
        guard = self.service._publication_guard
        corrections = []
        @contextmanager
        def gap(proposals, prepared):
            if not corrections:
                corrections.append(action)
                if action == 'dismiss':
                    self.service.resolve(old_discovery['id'], models.DiscoveryResolution(
                        expected_version=old_discovery['version'], decision='dismiss'))
                elif action == 'merge':
                    self.service.merge(old_task['id'], models.MergeRequest(
                        expected_version=self.current(old_task)['version'], target_id=root['id'],
                        target_version=self.current(root)['version']))
                elif action == 'unmerge':
                    self.service.unmerge(old_task['id'], models.Versioned(
                        expected_version=self.current(old_task)['version']))
                elif action == 'reject':
                    activity = self.sql('SELECT * FROM work_activities WHERE source_record_id=?', (fresh['id'],))[0]
                    self.link(old_task, activity, relation='possible', decision='rejected', primary=False)
                else:
                    fields = {'archive': {'archived': True}, 'done': {'status': 'done'},
                        'edit': {'title': 'User owned correction'}, 'confirm': {'confirmed': True}}[action]
                    self.edit(old_task, **fields)
                    if action == 'confirm':
                        self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed adopted origin' WHERE id=?", (old['id'],))
            with guard(proposals, prepared):
                yield
        with patch.object(self.service, '_publication_guard', gap):
            request, _ = self.start()
            result = self.wait(request)
        self.assertEqual((result['state'], result['processed']), ('complete', 2))
        discovery = self.sql('SELECT d.* FROM work_discoveries d JOIN work_activities a ON a.id=d.activity_id '
            'WHERE a.source_record_id=?', (fresh['id'],))[0]
        links = self.sql('SELECT l.* FROM work_task_links l JOIN work_activities a ON a.id=l.activity_id '
            'WHERE a.source_record_id=?', (fresh['id'],))
        if action == 'dismiss':
            self.assertEqual((discovery['state'], discovery['task_id'], links), ('dismissed', None, []))
            return
        row = self.sql('SELECT * FROM work_tasks WHERE id=?', (old_task['id'],))[0]
        self.assertEqual(row['created_at'], old_task['created_at'])
        if action in ('archive', 'done'):
            self.assertEqual((discovery['state'], discovery['task_id'], links), ('accepted', old_task['id'], []))
            self.assertEqual(row['archived'] if action == 'archive' else row['status'], 1 if action == 'archive' else 'done')
            if action == 'done':
                self.assertEqual(row['completed_at'], self.now.isoformat())
        elif action == 'edit':
            self.assertEqual((row['title'], row['title_owned']), ('User owned correction', 1))
            self.assertNotEqual(discovery['task_id'], old_task['id'])
        elif action == 'confirm':
            self.assertEqual((row['title'], row['title_owned'], row['evidence_unavailable']), ('Shared corrected task', 1, 1))
            self.assertEqual(discovery['task_id'], old_task['id'])
        elif action == 'reject':
            self.assertEqual([(l['task_id'], l['origin'], l['decision']) for l in links],
                [(old_task['id'], 'user', 'rejected')])
        else:
            self.assertEqual([l['task_id'] for l in links], [root['id'] if action == 'merge' else old_task['id']])


for _action in ('merge', 'unmerge', 'archive', 'done', 'dismiss', 'edit', 'confirm', 'reject'):
    setattr(BatchCorrectionTests, 'test_live_' + _action + '_after_preparation',
        lambda self, a=_action: self.check_live_correction(a))


class BatchSourceRaceTests(BatchFixture, unittest.TestCase):
    mutate_old = DependencyRaceTests.mutate_old

    def check_retry_source_mutation(self, mutation, timing):
        self.enable()
        source = self.source('TODO(me): Failed source for explicit retry', expires_at=self.now + timedelta(seconds=1))
        with patch.object(self.service.provider, 'extract', side_effect=RuntimeError('Synthetic extraction failure')):
            with self.assertRaises(Exception):
                self.service.process_observation(source['id'])
        self.source('TODO(me): Independent retry neighbor')
        process = self.service._process_observation
        guard = self.service._publication_guard
        mutated = []
        def before_preparation(source_id, **kwargs):
            if timing == 'selection' and source_id == source['id'] and not mutated:
                self.mutate_old(source, mutation)
                mutated.append(True)
            return process(source_id, **kwargs)
        @contextmanager
        def before_publication(proposals, prepared):
            pending = self.sql('SELECT state FROM work_extraction_receipts WHERE source_record_id=?', (source['id'],))[0]
            if timing == 'preparation' and pending['state'] == 'pending' and not mutated:
                self.mutate_old(source, mutation)
                mutated.append(True)
            with guard(proposals, prepared):
                yield
        with patch.object(self.service, '_process_observation', before_preparation), \
                patch.object(self.service, '_publication_guard', before_publication):
            request, _ = self.start()
            result = self.wait(request)
        self.assertEqual(mutated, [True])
        self.assertEqual(result['state'], 'error')
        self.assertEqual(self.sql('SELECT valid FROM work_activities WHERE source_record_id=?', (source['id'],)), [{'valid': 0}])
        self.assertEqual(self.sql('SELECT d.* FROM work_discoveries d JOIN work_activities a ON a.id=d.activity_id '
            'WHERE a.source_record_id=?', (source['id'],)), [])

    def check_prior_mutation_after_preparation(self, mutation):
        self.enable()
        prior = self.source('TODO(me): Prior same topic ancestor', expires_at=self.now + timedelta(seconds=1))
        self.service.process_observation(prior['id'])
        self.now += timedelta(milliseconds=10)
        quote = 'Public source for related ancestor'
        fresh = self.source(quote, temporal_context={'relations': [{'relation': 'same_topic',
            'prior_observation_id': prior['id'], 'prior_quote': prior['post_mask_ocr_text'], 'current_quote': quote}]})
        self.now += timedelta(milliseconds=10)
        self.source('TODO(me): Later independent ancestor check')
        guard = self.service._publication_guard
        mutated = []
        @contextmanager
        def gap(proposals, prepared):
            if not mutated:
                self.mutate_old(prior, mutation)
                mutated.append(True)
            with guard(proposals, prepared):
                yield
        with patch.object(self.service, '_publication_guard', gap):
            request, _ = self.start()
            result = self.wait(request)
        self.assertEqual((result['state'], result['processed']), ('complete', 2))
        self.assertEqual(self.sql('SELECT l.* FROM work_task_links l JOIN work_activities a ON a.id=l.activity_id '
            'WHERE a.source_record_id=?', (fresh['id'],)), [])
        self.assertEqual(self.sql('SELECT valid FROM work_activities WHERE source_record_id=?', (prior['id'],)), [{'valid': 0}])


for _mutation in ('expiry', 'content', 'media'):
    for _timing in ('selection', 'preparation'):
        setattr(BatchSourceRaceTests, f'test_retry_current_{_mutation}_after_{_timing}',
            lambda self, m=_mutation, t=_timing: self.check_retry_source_mutation(m, t))
    setattr(BatchSourceRaceTests, f'test_same_topic_{_mutation}_after_preparation',
        lambda self, m=_mutation: self.check_prior_mutation_after_preparation(m))
