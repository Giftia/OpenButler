"""Durable explicit sync receipts and a single owned runner per local database.

No constructor/read dispatches work. Operation rows contain only safe identities,
revisions, counters and fixed outcomes. The existing extraction receipts remain
source execution authority. Multiple OS processes sharing a DB are unsupported.
"""
from contextlib import contextmanager
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from time import monotonic
from threading import Event, Lock, RLock, Thread, current_thread
from weakref import WeakValueDictionary

_COORDINATORS = WeakValueDictionary()
_REGISTRY_LOCK = Lock()
ADMISSION_TIMEOUT = 1.0
_PUBLIC_FIELDS = ('command_id', 'version', 'state', 'settled', 'provider',
    'settings_version', 'bounded_to', 'selected', 'attempted', 'processed',
    'activities_created', 'skipped_invalid', 'has_more', 'reason', 'created_at', 'updated_at')


def _error(code, status=409):
    # Avoid a module cycle: the service owns the existing public error contract.
    from .service import TaskError
    return TaskError(code, status)


def _remaining(deadline):
    return max(0.0, deadline - monotonic())


@contextmanager
def _locked(lock, deadline=None):
    acquired = lock.acquire() if deadline is None else lock.acquire(timeout=_remaining(deadline))
    if not acquired:
        raise _error('task_sync_unavailable', 503)
    try:
        yield
    finally:
        lock.release()


def public(row):
    value = {key: row[key] for key in _PUBLIC_FIELDS}
    value['settled'] = bool(value['settled'])
    value['has_more'] = None if value['has_more'] is None else bool(value['has_more'])
    return value


def envelope(row=None, *, busy=False):
    return {'operation': public(row) if row is not None else None,
            'reason': 'extraction_in_progress' if busy else None}


def coordinator(service):
    key = str(Path(service.store.path).resolve())
    with _REGISTRY_LOCK:
        existing = _COORDINATORS.get(key)
        if existing is not None:
            return existing
        result = SyncCoordinator(service.store, service._extraction_lock, service.now)
        _COORDINATORS[key] = result
        return result


class Execution:
    def __init__(self, owner, command_id, settings, gateway_revision):
        self.owner, self.command_id = owner, command_id
        self.settings, self.gateway_revision = settings, gateway_revision
        self.cancelled = Event()
        self.finished = Event()
        self.settlement_failed = Event()
        self.outcome = None
        self.gate = RLock()
        self.thread = None

    def check(self, conn):
        row = conn.execute('SELECT state,settled FROM work_sync_operations WHERE command_id=?',
                           (self.command_id,)).fetchone()
        if self.cancelled.is_set() or self.owner._closed.is_set() or not row or row['state'] != 'pending' or row['settled']:
            raise _error('discovery_authorization_changed')

    def check_provider(self):
        if self.settings['provider'] == 'local_model_v1':
            gateway = getattr(self.owner.model_provider, 'gateway', None)
            revision = getattr(gateway, 'configuration_revision', None)
            if revision != self.gateway_revision:
                raise _error('discovery_authorization_changed')

    @contextmanager
    def transaction(self):
        # Only one individual DB transaction, never the provider or whole batch.
        with self.gate, self.owner.store.transaction() as conn:
            self.check(conn)
            yield conn

    def update(self, conn, **values):
        columns = ','.join(key + '=?' for key in values)
        conn.execute('UPDATE work_sync_operations SET ' + columns +
            ',version=version+1,updated_at=? WHERE command_id=? AND settled=0',
            (*values.values(), self.owner.now(), self.command_id))

    def attempted(self, conn, source_id, attempt, created):
        self.check(conn)
        conn.execute('''UPDATE work_sync_operations SET attempted=attempted+1,
            activities_created=activities_created+?,current_source_id=?,current_attempt=?,
            version=version+1,updated_at=? WHERE command_id=? AND settled=0''',
            (int(created), source_id, attempt, self.owner.now(), self.command_id))

    def completed(self, conn):
        self.check(conn)
        conn.execute('''UPDATE work_sync_operations SET processed=processed+1,
            current_source_id=NULL,current_attempt=NULL,version=version+1,updated_at=?
            WHERE command_id=? AND settled=0''', (self.owner.now(), self.command_id))
        # The last source's receipt/proposals and terminal outcome are one
        # commit. A Stop arriving in the runner's return/finalization gap must
        # not relabel already completed work as interrupted.
        conn.execute("""UPDATE work_sync_operations SET state='complete',settled=1,reason=NULL
            WHERE command_id=? AND processed=selected AND selected>0 AND settled=0""",
            (self.command_id,))

    def failed(self, conn, reason):
        row = conn.execute('SELECT state,settled FROM work_sync_operations WHERE command_id=?',
                           (self.command_id,)).fetchone()
        if (row and not row['settled'] and row['state'] == 'pending'
                and not self.cancelled.is_set() and not self.owner._closed.is_set()):
            self.update(conn, state='error', settled=1, reason=reason,
                        current_source_id=None, current_attempt=None)

    def fail(self, reason):
        with self.gate, self.owner.store.transaction() as conn:
            self.failed(conn, reason)


class SyncCoordinator:
    def __init__(self, store, lane, now):
        self.store, self.lane = store, lane
        self.lock = RLock()
        self.active = None
        # Only a newly registered coordinator can establish true orphanhood.
        # A live worker retains this coordinator even if its caller disappears.
        with store.transaction() as conn:
            for row in conn.execute('SELECT * FROM work_sync_operations WHERE settled=0').fetchall():
                self._fail_current(conn, row)
                conn.execute("""UPDATE work_sync_operations SET state='interrupted',settled=1,
                    reason='interrupted',current_source_id=NULL,current_attempt=NULL,
                    version=version+1,updated_at=? WHERE command_id=? AND settled=0""",
                    (now(), row['command_id']))

    @staticmethod
    def _fail_current(conn, row):
        if row['current_source_id'] is not None:
            conn.execute("""UPDATE work_extraction_receipts SET state='failed'
                WHERE source_record_id=? AND attempt=? AND state='pending'""",
                (row['current_source_id'], row['current_attempt']))

    @staticmethod
    def _lookup(conn, command_id):
        command = conn.execute('SELECT * FROM work_commands WHERE id=?', (command_id,)).fetchone()
        if command is None or command['kind'] != 'task_sync':
            raise _error('task_sync_not_found', 404)
        if not command['result_id']:
            return envelope(busy=True)
        row = conn.execute('SELECT * FROM work_sync_operations WHERE command_id=?',
                           (command['result_id'],)).fetchone()
        if row is None:
            raise _error('task_sync_unavailable', 503)
        return envelope(row)

    def get(self, command_id=None):
        try:
            with self.store.read() as conn:
                if command_id is not None:
                    return self._lookup(conn, str(command_id))
                row = conn.execute('SELECT * FROM work_sync_operations ORDER BY rowid DESC LIMIT 1').fetchone()
                if row is not None and not row['settled']:
                    return envelope(row)
                if self.active is None and self.lane.locked():
                    return envelope(busy=True)
                return envelope(row)
        except sqlite3.Error:
            raise _error('task_sync_unavailable', 503) from None

    def start(self, owner, request):
        deadline = monotonic() + ADMISSION_TIMEOUT
        command_id = str(request.command_id)
        # Unlike ordinary CRUD commands, the frozen settings precondition is
        # part of sync request identity. Never use service._command here.
        digest = sha256(json.dumps(request.model_dump(mode='json'), sort_keys=True,
                                   separators=(',', ':')).encode()).hexdigest()
        execution = None
        reserved = False
        try:
            with _locked(self.lock, deadline):
                if owner._closed.is_set():
                    raise _error('task_sync_unavailable', 503)
                self._recover_finished(deadline)
                with self.store.transaction(timeout=_remaining(deadline)) as conn:
                    previous = conn.execute('SELECT * FROM work_commands WHERE id=?', (command_id,)).fetchone()
                    if previous:
                        if previous['kind'] != 'task_sync' or previous['request_hash'] != digest:
                            raise _error('command_conflict')
                        return self._lookup(conn, command_id)
                    # Different UUIDs coalesce before checking current settings:
                    # this does not authorize any fresh work under that version.
                    if self.active is not None:
                        conn.execute('INSERT INTO work_commands VALUES(?,?,?,?)',
                            (command_id, 'task_sync', digest, self.active.command_id))
                        return self._lookup(conn, command_id)
                    settings = dict(conn.execute('SELECT * FROM work_task_settings WHERE id=1').fetchone())
                    if settings['version'] != request.expected_version:
                        raise _error('version_conflict')
                    if not self.lane.acquire(blocking=False):
                        # Persist non-admission: a later replay cannot quietly
                        # turn this click into a retry after capture finishes.
                        conn.execute('INSERT INTO work_commands VALUES(?,?,?,?)',
                                     (command_id, 'task_sync', digest, ''))
                        return envelope(busy=True)
                    reserved = True
                    gateway = getattr(owner.model_provider, 'gateway', None)
                    revision = getattr(gateway, 'configuration_revision', None) if settings['provider'] == 'local_model_v1' else None
                    execution = Execution(owner, command_id, settings, revision)
                    disabled = not settings['auto_discovery']
                    conn.execute('''INSERT INTO work_sync_operations
                        (command_id,state,settled,provider,settings_version,gateway_revision,bounded_to,
                         has_more,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
                        (command_id, 'complete' if disabled else 'pending', int(disabled),
                         settings['provider'], settings['version'], revision,
                         1 if settings['provider'] == 'local_model_v1' else 200,
                         0 if disabled else None, 'disabled' if disabled else None, owner.now(), owner.now()))
                    conn.execute('INSERT INTO work_commands VALUES(?,?,?,?)',
                                 (command_id, 'task_sync', digest, command_id))
                    result = self._lookup(conn, command_id)
                if disabled:
                    self.lane.release()
                    reserved = False
                    return result
                # Register the owner and thread while admission is serialized,
                # before exposing the receipt or allowing Stop to acknowledge it.
                self.active = execution
                try:
                    execution.thread = Thread(target=self._run, args=(execution,),
                                              name='task-sync-worker', daemon=True)
                    execution.thread.start()
                except BaseException:
                    execution.outcome = ('error', 'worker_start_failed')
                    execution.finished.set()
                    self._settle(execution, 'error', 'worker_start_failed', timeout=ADMISSION_TIMEOUT)
                    reserved = False
                    return self.get(command_id)
                return result
        except sqlite3.Error:
            if reserved and self.active is not execution:
                self.lane.release()
            raise _error('task_sync_unavailable', 503) from None
        except BaseException:
            if reserved and self.active is not execution:
                self.lane.release()
            raise

    def stop(self, command_id, *, timeout=ADMISSION_TIMEOUT):
        deadline = monotonic() + timeout
        try:
            with _locked(self.lock, deadline):
                self._recover_finished(deadline)
                with self.store.read(timeout=_remaining(deadline)) as conn:
                    result = self._lookup(conn, str(command_id))
                operation = result['operation']
                if operation is None or operation['settled']:
                    return result
                execution = self.active
                if execution is None or execution.command_id != operation['command_id']:
                    raise _error('task_sync_unavailable', 503)
                # No model-settings/Gateway lock: fence queued and unresponsive
                # providers immediately, then serialize Stop with SQLite commit.
                execution.cancelled.set()
            # Never monopolize admission while a publication or database lock
            # is busy. The event already invalidates future publication. A
            # timed-out fence is uncertain, never an acknowledged Stop.
            with _locked(execution.gate, deadline), self.store.transaction(timeout=_remaining(deadline)) as conn:
                row = conn.execute('SELECT * FROM work_sync_operations WHERE command_id=?',
                                   (execution.command_id,)).fetchone()
                if not row['settled']:
                    self._fail_current(conn, row)
                    if row['state'] != 'stopping':
                        execution.update(conn, state='stopping', reason='interrupted')
                return self._lookup(conn, str(command_id))
        except sqlite3.Error:
            raise _error('task_sync_unavailable', 503) from None

    def _run(self, execution):
        state, reason = 'complete', None
        try:
            result = execution.owner._sync(operation=execution)
            reason = result.get('reason')
        except BaseException as error:
            from .service import TaskError, DISCOVERY_ERROR_CODES
            state = 'error'
            reason = error.code if (type(error) is TaskError and type(error.code) is str
                and error.code in DISCOVERY_ERROR_CODES | {'source_outside_scope'}) else 'sync_failed'
        finally:
            from .service import TaskError
            execution.outcome = (state, reason)
            execution.finished.set()
            while True:
                try:
                    self._settle(execution, state, reason)
                    break
                except (sqlite3.Error, TaskError):
                    # Retry bookkeeping only, never _sync or a provider. The
                    # same owned runner keeps the lane until storage recovers;
                    # close remains bounded and reports an unsettled shutdown.
                    execution.settlement_failed.set()
                    Event().wait(.05)
                except BaseException:
                    # Keep ownership fail-closed. A later explicit control can
                    # reconcile this finished runner without any redispatch.
                    execution.settlement_failed.set()
                    break

    def _recover_finished(self, deadline):
        execution = self.active
        if execution is not None and execution.finished.is_set():
            self._settle(execution, *execution.outcome, timeout=_remaining(deadline))

    def _settle(self, execution, state, reason, *, timeout=ADMISSION_TIMEOUT):
        deadline = monotonic() + timeout
        with _locked(self.lock, deadline):
            if self.active is not execution:
                return
            with _locked(execution.gate, deadline), self.store.transaction(timeout=_remaining(deadline)) as conn:
                row = conn.execute('SELECT * FROM work_sync_operations WHERE command_id=?',
                                   (execution.command_id,)).fetchone()
                if not row['settled']:
                    if execution.cancelled.is_set() or execution.owner._closed.is_set() or row['state'] == 'stopping':
                        state, reason = 'interrupted', 'interrupted'
                    self._fail_current(conn, row)
                    execution.update(conn, state=state, settled=1, reason=reason,
                                     current_source_id=None, current_attempt=None)
            # No more dispatch/publication is possible. Admission observes this
            # release and terminal settlement atomically under the same lock.
            self.lane.release()
            self.active = None

    def close(self, owner, *, timeout=2.0):
        deadline = monotonic() + timeout
        try:
            with _locked(self.lock, deadline):
                execution = self.active
                if execution is None or execution.owner is not owner:
                    return True
                execution.cancelled.set()
                worker = execution.thread
        except Exception:
            return False
        try:
            self.stop(execution.command_id, timeout=_remaining(deadline))
        except Exception:
            pass  # Cancellation still fences publication; no false success.
        # Never join while holding coordinator, operation, DB or model locks.
        if worker is not None and worker is not current_thread() and worker.ident is not None:
            worker.join(_remaining(deadline))
        if worker is not None and worker.is_alive():
            return False
        try:
            self._settle(execution, 'interrupted', 'interrupted', timeout=_remaining(deadline))
        except Exception:
            return False
        return True
