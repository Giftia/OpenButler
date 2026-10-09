"""Authoritative user-work records, with reversible evidence relationships.

No activity resource is opened. No reminder, capture, runtime goal activation or
external action is performed. Observation text is projected from its owned source.
"""
from contextlib import contextmanager, nullcontext
import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4, UUID
from pathlib import Path
import stat
from threading import Event, Lock
from weakref import WeakValueDictionary

from .store import Store
from app.modules.model_gateway.gateway import ProviderTimeoutError, RouteError
from .discovery import DiscoveryResultError, EvidenceRules, valid_proposal
from .evidence import usable_unorganized_ocr, unorganized_ocr_excerpts, OCR_BOUNDARY, OCR_ORGANIZATION_FAILURES, retained_ocr
from .evidence import complete_task_model_source, TaskContextIncomplete
from . import models

BOUNDARY = '采样点不等于连续工作。未观察、后台、空闲、锁屏及断档均不补计；手动时间是用户记录。'

# Serialize extraction and explicit retry selection across service instances in
# this backend process. No worker or redispatch runs when a service is opened.
_EXTRACTION_LOCKS = WeakValueDictionary()
_EXTRACTION_LOCKS_GUARD = Lock()


def extraction_lock(path):
    with _EXTRACTION_LOCKS_GUARD:
        return _EXTRACTION_LOCKS.setdefault(str(Path(path).resolve()), Lock())


class TaskError(ValueError):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


DISCOVERY_ERROR_CODES = frozenset({
    'task_context_incomplete', 'invalid_discovery_result', 'discovery_source_mismatch',
    'discovery_authorization_changed', 'local_model_unavailable', 'local_provider_failed',
    'local_provider_timeout', 'invalid_provider_response', 'local_discovery_failed',
})


def _discovery_failure(error):
    """Translate only trusted exception types and fixed codes, never raw text."""
    code = 'local_discovery_failed'
    # An arbitrary exception's __str__ or args must never become an API/DB value.
    value = error.args[0] if len(error.args) == 1 and type(error.args[0]) is str else None
    if (type(error) is TaskError and type(error.code) is str
            and error.code in DISCOVERY_ERROR_CODES):
        code = error.code
    elif type(error) is TaskContextIncomplete:
        code = 'task_context_incomplete'
    elif type(error) is DiscoveryResultError and value in {
            'invalid_discovery_result', 'discovery_source_mismatch'}:
        code = value
    elif type(error) is ProviderTimeoutError:
        code = 'local_provider_timeout'
    elif type(error) is PermissionError and value in {
            'authorization_revoked', 'privacy_mode_unavailable', 'authorization_required',
            'redaction_required', 'strict_mode_forbidden', 'model_unavailable'}:
        code = 'discovery_authorization_changed'
    elif type(error) is RouteError:
        if value in {'model_unavailable', 'route_not_ready', 'local_provider_unsupported',
                     'local_model_unverified', 'local_model_remote', 'unsafe_endpoint'}:
            code = 'local_model_unavailable'
        elif value == 'invalid_provider_response':
            code = value
        elif value in {'provider_connection_failed', 'provider_http_error',
                       'provider_response_too_large', 'endpoint_resolution_failed'}:
            code = 'local_provider_failed'
    return TaskError(code, 409)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def parse_time(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None or result.utcoffset() is None:
        raise TaskError('timezone_required')
    return result.astimezone(timezone.utc)


def task_key(title):
    # Only exact normalized titles deduplicate; no vector/topic auto-merge.
    return hashlib.sha256(' '.join(title.casefold().split()).encode()).hexdigest()


def public_task(row):
    value = dict(row)
    for key in ('archived', 'confirmed', 'evidence_unavailable'):
        value[key] = bool(value[key])
    for key in ('title_owned', 'description_owned', 'dedupe_key', 'checkpoint', 'origin_activity_id'):
        value.pop(key, None)
    return value


class TaskService:
    def __init__(self, db_path, *, clock=None, provider=None, runtime=None, model_provider=None):
        self.store = Store(db_path)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.provider = provider or EvidenceRules()
        self.runtime = runtime
        self.model_provider = model_provider
        self._extraction_lock = extraction_lock(db_path)
        self._closed = Event()
        self._media = Path(db_path).parent / "context_engine" / "media"
        from .sync_operations import coordinator
        self._sync_coordinator = coordinator(self)

    def close(self, *, timeout=2.0):
        self._closed.set()
        return self._sync_coordinator.close(self, timeout=timeout)

    def start_sync(self, request):
        return self._sync_coordinator.start(self, request)

    def sync_operation(self, command_id=None):
        return self._sync_coordinator.get(command_id)

    def stop_sync(self, command_id):
        return self._sync_coordinator.stop(command_id)

    def now(self):
        return self.clock().astimezone(timezone.utc).isoformat()

    @staticmethod
    def _task(conn, task_id, version=None):
        row = conn.execute('SELECT * FROM work_tasks WHERE id=?', (task_id,)).fetchone()
        if row is None:
            raise TaskError('task_not_found', 404)
        if version is not None and row['version'] != version:
            raise TaskError('version_conflict', 409)
        return row

    @staticmethod
    def _touch(conn, task_id, now):
        conn.execute('UPDATE work_tasks SET version=version+1,updated_at=? WHERE id=?', (now, task_id))

    @staticmethod
    def _root(conn, task_id):
        seen = set()
        while task_id:
            if task_id in seen:
                raise TaskError('merge_cycle', 409)
            seen.add(task_id)
            row = TaskService._task(conn, task_id)
            if not row['merged_into']:
                return task_id
            task_id = row['merged_into']

    @staticmethod
    def _members(conn, task_id):
        return [row[0] for row in conn.execute('''WITH RECURSIVE members(id) AS
            (SELECT id FROM work_tasks WHERE id=? UNION ALL
             SELECT t.id FROM work_tasks t JOIN members m ON t.merged_into=m.id)
             SELECT id FROM members''', (task_id,))]

    @staticmethod
    def _purge_invalid(conn):
        conn.execute('''UPDATE work_tasks SET title=CASE WHEN title_owned=0 THEN '来源已不可用' ELSE title END,
            description=CASE WHEN description_owned=0 THEN '' ELSE description END,
            evidence_unavailable=1,version=version+1 WHERE evidence_unavailable=0
            AND origin_activity_id IN (SELECT id FROM work_activities WHERE valid=0)''')
        conn.execute('''UPDATE work_discoveries SET title='',quote='',state='invalidated',version=version+1
            WHERE state!='invalidated' AND activity_id IN (SELECT id FROM work_activities WHERE valid=0)''')

    def _source(self, conn, record_id, *, existing=False):
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'context_observations', 'context_capture_settings'} <= tables:
            return None
        source = conn.execute('''SELECT o.* FROM context_observations o JOIN context_capture_settings c
            ON c.id=1 AND c.consented=1 AND c.consent_revision=o.consent_revision
            WHERE o.id=? AND o.state IN ('ready','model_unavailable','recorded_pending','processing') AND o.source_kind='public_window' ''', (record_id,)).fetchone()
        if (source is None or parse_time(source['expires_at']) <= self.clock() or parse_time(source['captured_at']) > self.clock()
                or source['state'] != 'ready' and not (usable_unorganized_ocr(dict(source))
                    or existing and retained_ocr(dict(source)))):
            return None
        try:
            evidence_id = source['evidence_id']
            if str(UUID(evidence_id)) != evidence_id:
                return None
            info = (self._media / (evidence_id + '.png')).lstat()
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 5 * 1024 * 1024:
                return None
        except (ValueError, TypeError, OSError):
            return None
        result = dict(source)
        result['_media_fingerprint'] = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        return result

    @staticmethod
    def _evidence_fingerprint(source):
        # Only a digest is durable. Optional organization state/results are not
        # evidence identity: retained OCR stays readable during those retries.
        fields = ('captured_at', 'source_kind', 'consent_revision', 'provenance',
                  'image_digest', 'evidence_id', 'post_mask_ocr_text',
                  'post_mask_ocr_image_digest', 'post_mask_ocr_engine', '_media_fingerprint')
        return hashlib.sha256(encode({key: source.get(key) for key in fields}).encode()).hexdigest()

    def _maintenance(self, conn):
        for row in conn.execute('''SELECT a.id,a.source_record_id,r.evidence_fingerprint
                FROM work_activities a LEFT JOIN work_extraction_receipts r
                ON r.source_record_id=a.source_record_id
                WHERE a.source='observation' AND a.valid=1''').fetchall():
            source = self._source(conn, row['source_record_id'], existing=True)
            if (source is None or row['evidence_fingerprint'] is not None
                    and self._evidence_fingerprint(source) != row['evidence_fingerprint']):
                conn.execute('UPDATE work_activities SET valid=0 WHERE id=?', (row['id'],))
        self._purge_invalid(conn)

    def _command(self, conn, request, kind):
        content = request.model_dump(mode='json')
        # Version is a precondition, not the identity of an already committed command.
        content.pop('expected_version', None)
        digest = hashlib.sha256(encode(content).encode()).hexdigest()
        row = conn.execute('SELECT * FROM work_commands WHERE id=?', (str(request.command_id),)).fetchone()
        if row and (row['kind'] != kind or row['request_hash'] != digest):
            raise TaskError('command_conflict', 409)
        return (row['result_id'] if row else None), digest

    @staticmethod
    def _save_command(conn, request, kind, digest, result_id):
        conn.execute('INSERT INTO work_commands VALUES(?,?,?,?)', (str(request.command_id), kind, digest, result_id))

    def _insert_task(self, conn, *, title, description='', priority='normal', due_at=None,
                     origin='user', activity_id=None, confirmed=None, discovery_provider=None):
        task_id, now = 'task_' + uuid4().hex, self.now()
        owned = origin == 'user'
        conn.execute('''INSERT INTO work_tasks(id,title,description,priority,due_at,created_by,
            confirmed,title_owned,description_owned,origin_activity_id,dedupe_key,created_at,updated_at,discovery_provider)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (task_id, title.strip(), description, priority, due_at, origin,
             int(owned if confirmed is None else confirmed), int(owned), int(owned),
             activity_id, task_key(title), now, now, None if owned else discovery_provider or 'unknown'))
        return task_id

    def create_task(self, request: models.TaskCreate):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            existing, digest = self._command(conn, request, 'task')
            if existing:
                return public_task(self._task(conn, existing))
            task_id = self._insert_task(conn, title=request.title, description=request.description,
                priority=request.priority, due_at=request.due_at.isoformat() if request.due_at else None)
            self._save_command(conn, request, 'task', digest, task_id)
            return public_task(self._task(conn, task_id))

    def list_tasks(self, include_archived=False):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            rows = conn.execute('SELECT * FROM work_tasks' + ('' if include_archived else ' WHERE archived=0 AND merged_into IS NULL')
                + ' ORDER BY created_at DESC,id').fetchall()
            return {'items': [public_task(row) for row in rows]}

    def edit_task(self, task_id, request: models.TaskEdit):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            row = self._task(conn, task_id, request.expected_version)
            fields = request.model_dump(exclude_unset=True, mode='json')
            fields.pop('expected_version')
            if not fields:
                return public_task(row)
            if row['merged_into']:
                raise TaskError('task_is_merged', 409)
            if 'title' in fields:
                fields['title'] = fields['title'].strip()
                fields['title_owned'] = 1
                fields['dedupe_key'] = task_key(fields['title'])
            if 'description' in fields:
                fields['description_owned'] = 1
            if fields.get('confirmed'):
                if row['evidence_unavailable']:
                    raise TaskError('evidence_unavailable', 409)
                fields.update(title_owned=1, description_owned=1)
            if 'status' in fields:
                fields['completed_at'] = self.now() if fields['status'] == 'done' else None
            for key, value in fields.items():
                conn.execute(f'UPDATE work_tasks SET {key}=? WHERE id=?', (value, task_id))
            self._touch(conn, task_id, self.now())
            return public_task(self._task(conn, task_id))

    def create_activity(self, request: models.ActivityCreate):
        if request.end_at > self.clock():
            raise TaskError('future_activity_not_allowed')
        with self.store.transaction() as conn:
            existing, digest = self._command(conn, request, 'activity')
            if existing:
                return self._activity(conn, existing)
            activity_id = 'activity_' + uuid4().hex
            conn.execute('''INSERT INTO work_activities(id,source,title,summary,start_at,end_at,time_kind,created_at)
                VALUES(?,'manual',?,?,?,?,'manual',?)''', (activity_id, request.title.strip(), request.summary,
                request.start_at.isoformat(), request.end_at.isoformat(), self.now()))
            self._save_command(conn, request, 'activity', digest, activity_id)
            return self._activity(conn, activity_id)

    def _activity(self, conn, activity_id):
        row = conn.execute('SELECT * FROM work_activities WHERE id=?', (activity_id,)).fetchone()
        if row is None:
            raise TaskError('activity_not_found', 404)
        value = dict(row)
        value.update(evidence_available=bool(row['valid']), resources=[], boundary=BOUNDARY)
        if row['source'] == 'observation':
            source = self._source(conn, row['source_record_id'], existing=True) if row['valid'] else None
            unorganized = bool(source and source['state'] != 'ready' and retained_ocr(source))
            quotes = unorganized_ocr_excerpts(source, existing=True) if unorganized else ()
            value.update(title=('本机 OCR 原文（尚未模型整理）' if unorganized else source['title']) if source else '来源已不可用',
                         summary=('OCR 摘录：“' + '”；“'.join(quotes) + '”。' if quotes else '暂无可展示的短片段。')
                         if unorganized else source['summary'] if source else '', evidence_available=bool(source))
            if source:
                value['source_stage'] = 'verified_post_mask_ocr' if unorganized else 'organized_observation'
                value['organization_state'] = source['state']
                value['boundary'] = (OCR_BOUNDARY if unorganized else source['boundary']) + ' ' + BOUNDARY
                value['resources'] = [{'id': source['evidence_id'], 'kind': 'evidence', 'label': '授权观察证据',
                    'reference': source['evidence_id'], 'source': 'activity', 'evidence_available': True}]
        value.pop('source_revision', None)
        value.pop('valid', None)
        return value

    def list_activities(self):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            ids = [row[0] for row in conn.execute('SELECT id FROM work_activities ORDER BY start_at DESC,id LIMIT 500')]
            return {'items': [self._activity(conn, value) for value in ids]}

    def link_activity(self, task_id, activity_id, request: models.LinkEdit):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            task = self._task(conn, task_id, request.expected_version)
            if task['merged_into'] or task['archived']:
                raise TaskError('task_not_active', 409)
            activity = self._activity(conn, activity_id)
            if not activity['evidence_available']:
                raise TaskError('evidence_unavailable', 409)
            if request.primary:
                owners = conn.execute('SELECT task_id FROM work_task_links WHERE activity_id=? AND is_primary=1', (activity_id,)).fetchall()
                for owner in owners:
                    if owner[0] != task_id:
                        self._touch(conn, owner[0], self.now())
                conn.execute('UPDATE work_task_links SET is_primary=0 WHERE activity_id=?', (activity_id,))
            conn.execute('''INSERT INTO work_task_links VALUES(?,?,?,?,?,1,?)
                ON CONFLICT(task_id,activity_id) DO UPDATE SET relation=excluded.relation,decision=excluded.decision,
                origin='user',confidence=1,is_primary=excluded.is_primary''',
                (task_id, activity_id, request.relation, request.decision, 'user', int(request.primary)))
            self._touch(conn, task_id, self.now())
            return public_task(self._task(conn, task_id))

    def checkpoint(self, task_id, request: models.CheckpointEdit):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            self._task(conn, task_id, request.expected_version)
            value = {'next_step': request.next_step.strip(), 'resource_ref': request.resource_ref,
                     'source': 'user', 'observed_at': self.now(), 'evidence_available': True}
            conn.execute('UPDATE work_tasks SET checkpoint=? WHERE id=?', (encode(value) if request.next_step.strip() else None, task_id))
            self._touch(conn, task_id, self.now())
            return public_task(self._task(conn, task_id))

    def resource(self, task_id, request: models.ResourceCreate):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            existing, digest = self._command(conn, request, 'resource:' + task_id)
            if existing:
                return public_task(self._task(conn, task_id))
            self._task(conn, task_id, request.expected_version)
            resource_id = 'resource_' + uuid4().hex
            if not request.label.strip() or not request.reference.strip():
                raise TaskError('empty_resource')
            conn.execute('INSERT INTO work_task_resources VALUES(?,?,?,?,?)',
                (resource_id, task_id, request.kind, request.label.strip(), request.reference.strip()))
            self._save_command(conn, request, 'resource:' + task_id, digest, resource_id)
            self._touch(conn, task_id, self.now())
            return public_task(self._task(conn, task_id))

    def merge(self, task_id, request: models.MergeRequest):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            source = self._task(conn, task_id, request.expected_version)
            target = self._task(conn, request.target_id, request.target_version)
            if (task_id == request.target_id or source['merged_into'] or target['merged_into']
                    or source['archived'] or target['archived']):
                raise TaskError('merge_conflict', 409)
            conn.execute('UPDATE work_tasks SET merged_into=? WHERE id=?', (target['id'], task_id))
            self._touch(conn, task_id, self.now())
            self._touch(conn, target['id'], self.now())
            return public_task(self._task(conn, task_id))

    def unmerge(self, task_id, request: models.Versioned):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            source = self._task(conn, task_id, request.expected_version)
            if not source['merged_into']:
                raise TaskError('task_not_merged', 409)
            self._touch(conn, source['merged_into'], self.now())
            conn.execute('UPDATE work_tasks SET merged_into=NULL WHERE id=?', (task_id,))
            self._touch(conn, task_id, self.now())
            return public_task(self._task(conn, task_id))

    def _time(self, conn, task_id, activities):
        # Half-open sweep partitions wall time globally; cross-source overlaps
        # and merged tasks cannot multiply the same second. User logs outrank
        # estimates, then the earliest entered interval wins deterministically.
        intervals = []
        for row in conn.execute('''SELECT a.*,l.task_id FROM work_activities a JOIN work_task_links l
             ON l.activity_id=a.id AND l.is_primary=1 AND l.decision='accepted'
             WHERE a.valid=1 AND a.time_kind IN ('manual','estimated')'''):
            root = self._root(conn, row['task_id'])
            members = self._members(conn, root)
            slots = ','.join('?' for _ in members)
            correction = conn.execute(f'''SELECT * FROM work_task_links
                WHERE task_id IN ({slots}) AND activity_id=? AND origin='user'
                ORDER BY (task_id=?) DESC,is_primary DESC,task_id LIMIT 1''',
                (*members, row['id'], root)).fetchone()
            if correction and (correction['decision'] != 'accepted' or not correction['is_primary']
                    or correction['relation'] not in {'work', 'preparation'}):
                continue
            start, end = parse_time(row['start_at']), parse_time(row['end_at'])
            if start < end:
                intervals.append((start, end, row['time_kind'], root, row['created_at'], row['id']))
        points = sorted({point for item in intervals for point in item[:2]})
        totals = {'manual_seconds': 0., 'estimated_seconds': 0.}
        for start, end in zip(points, points[1:]):
            eligible = [item for item in intervals if item[0] <= start and item[1] >= end]
            if not eligible:
                continue
            winner = min(eligible, key=lambda item: (item[2] != 'manual', item[4], item[5]))
            if winner[3] == task_id:
                totals[winner[2] + '_seconds'] += (end - start).total_seconds()
        observed = [parse_time(value[key]) for value in activities if value['evidence_available']
                    and value['link']['decision'] == 'accepted' for key in ('start_at', 'end_at')]
        return {**totals, 'total_seconds': sum(totals.values()),
                'observed_span_seconds': (max(observed) - min(observed)).total_seconds() if observed else 0,
                'boundary': BOUNDARY + ' 跨任务重叠采用手动优先、较早录入优先；主归属可纠正。'}

    def detail(self, task_id):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            task = self._task(conn, task_id)
            ids = self._members(conn, task_id)
            slots = ','.join('?' for _ in ids)
            activities = []
            # A merged detail shows each physical activity once, with user
            # corrections preferred. Source records remain intact for undo.
            links = conn.execute(f'''SELECT * FROM work_task_links WHERE task_id IN ({slots})
                ORDER BY (origin='user') DESC, (task_id=?) DESC, is_primary DESC,task_id''', (*ids, task_id)).fetchall()
            seen = set()
            for link in links:
                if link['activity_id'] in seen:
                    continue
                seen.add(link['activity_id'])
                value = self._activity(conn, link['activity_id'])
                value['link'] = {**dict(link), 'primary': bool(link['is_primary'])}
                value['link'].pop('is_primary')
                activities.append(value)
            activities.sort(key=lambda value: (value['start_at'], value['id']), reverse=True)
            resources = [{**dict(row), 'source': 'user', 'evidence_available': True} for row in conn.execute(
                f'SELECT * FROM work_task_resources WHERE task_id IN ({slots})', ids)]
            seen_resources = {(value['kind'], value['reference']) for value in resources}
            for activity in activities:
                if activity['link']['decision'] == 'accepted':
                    for resource in activity['resources']:
                        key = (resource['kind'], resource['reference'])
                        if key not in seen_resources:
                            resources.append(resource)
                            seen_resources.add(key)
            checkpoint = json.loads(task['checkpoint']) if task['checkpoint'] else None
            if checkpoint is None:
                recent = next((value for value in activities if value['evidence_available']
                    and value['link']['decision'] == 'accepted'), None)
                if recent:
                    checkpoint = {'next_step': '查看最近关联活动，确认下一步。', 'resource_ref': recent['id'],
                        'source': 'activity', 'observed_at': recent['start_at'], 'evidence_available': True}
            return {'task': public_task(task), 'activities': activities, 'resources': resources,
                    'time': self._time(conn, task_id, activities), 'checkpoint': checkpoint,
                    'merged_tasks': [public_task(self._task(conn, value)) for value in ids if value != task_id]}

    def settings(self):
        with self.store.transaction() as conn:
            row = dict(conn.execute('SELECT * FROM work_task_settings WHERE id=1').fetchone())
            row.update(auto_discovery=bool(row['auto_discovery']), provider=row['provider'],
                       model_discovery_available=bool(self.model_provider and self.model_provider.available()),
                       boundary='仅分析启用后已授权的本机观察摘录；规则或已配置的本地模型可生成未核实任务，不会启用采集或执行任务。')
            row.pop('id')
            return row

    def set_settings(self, request: models.SettingsEdit):
        if not request.confirmed:
            raise TaskError('discovery_consent_required', 403)
        if request.auto_discovery and request.provider == 'local_model_v1' and not (self.model_provider and self.model_provider.available()):
            raise TaskError('local_model_unavailable', 409)
        with self.store.transaction() as conn:
            row = conn.execute('SELECT * FROM work_task_settings WHERE id=1').fetchone()
            if row['version'] != request.expected_version:
                raise TaskError('version_conflict', 409)
            conn.execute('''UPDATE work_task_settings SET auto_discovery=?,version=version+1,
                enabled_at=?,last_error=NULL,provider=? WHERE id=1''', (int(request.auto_discovery),
                self.now() if request.auto_discovery and (not row['auto_discovery'] or row['provider'] != request.provider) else row['enabled_at'], request.provider))
        return self.settings()

    def _excerpts(self, source):
        if usable_unorganized_ocr(source):
            return unorganized_ocr_excerpts(source)
        from app.modules.context_engine.processor import ObservationProcessor
        row = dict(source)
        row['provenance'] = json.loads(row.get('provenance') or '{}')
        row['current_facts'] = json.loads(row.get('current_facts') or '{}')
        row['observation_mode'] = row['provenance'].get('observation_mode')
        if not ObservationProcessor.grounded_prior(row):
            return ()
        return tuple(span['quote'] for span in ObservationProcessor.source_excerpts(row['current_facts']))

    def _auto_link(self, conn, task_id, activity_id, *, relation='possible', confidence=.7):
        task_id = self._root(conn, task_id)
        task = self._task(conn, task_id)
        if task['archived'] or task['status'] == 'done':
            return
        # A correction on any constituent task overrides all new automatic links.
        members = self._members(conn, task_id)
        slots = ','.join('?' for _ in members)
        if conn.execute(f"SELECT 1 FROM work_task_links WHERE task_id IN ({slots}) AND activity_id=? AND origin='user'", (*members, activity_id)).fetchone():
            return
        cursor = conn.execute('INSERT OR IGNORE INTO work_task_links VALUES(?,?,?,?,?,?,0)',
            (task_id, activity_id, relation, 'accepted', 'assistant', confidence))
        if cursor.rowcount:
            self._touch(conn, task_id, self.now())

    def _reconcile_associations(self, conn, activity_id, source, excerpts):
        # The existing structured same-topic result is a possible relation,
        # never action evidence, task completion, duration or a resume cursor.
        context = json.loads(source.get('temporal_context') or '{}')
        for relation in context.get('relations', []):
            if not isinstance(relation, dict) or relation.get('relation') != 'same_topic':
                continue
            prior_id = relation.get('prior_observation_id')
            prior = self._source(conn, prior_id) if isinstance(prior_id, str) else None
            if not prior or not excerpts or not any(relation.get('current_quote', '') and relation['current_quote'] in quote for quote in excerpts):
                continue
            prior_excerpts = self._excerpts(prior)
            if not any(relation.get('prior_quote', '') and relation['prior_quote'] in quote for quote in prior_excerpts):
                continue
            for row in conn.execute('''SELECT l.task_id FROM work_task_links l JOIN work_activities a
                ON a.id=l.activity_id WHERE a.source_record_id=? AND a.valid=1 AND l.decision='accepted' ''', (prior_id,)).fetchall():
                self._auto_link(conn, row[0], activity_id)

    @contextmanager
    def _publication_guard(self, proposals, prepared):
        try:
            guard = self.model_provider.commit_guard(proposals) if prepared else nullcontext()
            with guard:
                yield
        except TaskError as error:
            # Ordinary optimistic-version conflicts remain a different API
            # contract. Other task errors here must belong to discovery's
            # fixed vocabulary before they can leave a model publication path.
            if not prepared or error.code == 'version_conflict':
                raise
            raise _discovery_failure(error) from None
        except Exception as error:
            # The enclosing failure path owns the version-qualified status
            # write and receipt transition after the publication rollback.
            raise _discovery_failure(error) from None

    def process_observation(self, observation_id, *, cancel_event=None):
        # Never hold SQLite's write transaction during a model call. A separate
        # extraction mutex bounds duplicate work; revision/fingerprint checks
        # reject opt-out, expiry, source replacement and configuration races.
        with self._extraction_lock:
            return self._process_observation(observation_id, cancel_event=cancel_event)

    def _process_observation(self, observation_id, *, cancel_event=None, retry_incomplete=False,
                             expected_settings_version=None, operation=None):
        def cancelled():
            return self._closed.is_set() or bool(cancel_event is not None and cancel_event.is_set())
        if cancelled():
            return {'processed': False, 'reason': 'cancelled'}
        prepared = None
        with (operation.transaction() if operation else self.store.transaction()) as conn:
            self._maintenance(conn)
            settings = dict(conn.execute('SELECT * FROM work_task_settings WHERE id=1').fetchone())
            if expected_settings_version is not None and settings['version'] != expected_settings_version:
                return {'processed': False, 'reason': 'discovery_authorization_changed'}
            if not settings['auto_discovery']:
                return {'processed': False, 'reason': 'disabled'}
            source = self._source(conn, observation_id)
            if source is None or parse_time(source['captured_at']) < parse_time(settings['enabled_at']):
                return {'processed': False, 'reason': 'source_outside_scope'}
            previous = conn.execute('SELECT id,valid FROM work_activities WHERE source_record_id=?', (observation_id,)).fetchone()
            if previous and not previous['valid']:
                return {'processed': False, 'reason': 'source_invalidated'}
            receipt = conn.execute('SELECT * FROM work_extraction_receipts WHERE source_record_id=?', (observation_id,)).fetchone()
            if receipt and receipt['state'] == 'completed':
                # Organization can add exact same-topic evidence later. Reconcile
                # only in deterministic-rule mode; experimental model mode
                # cannot turn optional associations into accepted task links.
                # A completed receipt never reruns extraction.
                if settings['provider'] == 'evidence_rules_v1':
                    self._reconcile_associations(conn, previous['id'], source, self._excerpts(source))
                if cancelled():
                    raise TaskError('discovery_authorization_changed', 409)
                return {'processed': True, 'activity_id': previous['id']}
            if receipt and not retry_incomplete:
                return {'processed': False, 'reason': 'extraction_retry_required'}
            activity_id = previous['id'] if previous else 'activity_' + uuid4().hex
            excerpts = self._excerpts(source)
            revision, fingerprint = settings['version'], encode(source)
            attempt = receipt['attempt'] + 1 if receipt else 1
            # Evidence is independently authorized and durable before optional
            # extraction. No OCR or model text is copied into either receipt.
            created = conn.execute('''INSERT OR IGNORE INTO work_activities
                (id,source,source_record_id,start_at,end_at,time_kind,source_revision,created_at)
                VALUES(?,'observation',?,?,?,'sample',?,?)''', (activity_id, observation_id,
                source['captured_at'], source['captured_at'], source['consent_revision'], self.now()))
            conn.execute('''INSERT INTO work_extraction_receipts VALUES(?,'pending',?,?)
                ON CONFLICT(source_record_id) DO UPDATE SET state='pending',attempt=excluded.attempt
                ''', (observation_id, attempt, self._evidence_fingerprint(source)))
            if operation:
                operation.attempted(conn, observation_id, attempt, created.rowcount)
            if settings['provider'] == 'local_model_v1':
                prepared = (revision, fingerprint)

        def validate():
            if cancelled():
                raise TaskError('discovery_authorization_changed', 409)
            if operation:
                operation.check_provider()
            with self.store.transaction() as conn:
                if operation:
                    operation.check(conn)
                current = conn.execute('SELECT * FROM work_task_settings WHERE id=1').fetchone()
                source_now = self._source(conn, observation_id)
                receipt_now = conn.execute('SELECT state,attempt FROM work_extraction_receipts WHERE source_record_id=?', (observation_id,)).fetchone()
                activity = conn.execute('SELECT valid FROM work_activities WHERE id=?', (activity_id,)).fetchone()
                if (not current['auto_discovery'] or current['version'] != revision
                        or source_now is None or encode(source_now) != fingerprint
                        or not activity or not activity['valid'] or not receipt_now
                        or receipt_now['state'] != 'pending' or receipt_now['attempt'] != attempt):
                    raise TaskError('discovery_authorization_changed', 409)

        class Cancellation(Event):
            def is_set(self):
                if super().is_set():
                    return True
                try:
                    validate()
                    return False
                except Exception:
                    return True

        proposals = None
        try:
            if prepared:
                try:
                    # Source/budget abstention must not roll back the already
                    # committed evidence-only Activity or complete its receipt.
                    model_source = complete_task_model_source(source)
                    excerpts = (model_source.text,)
                    if self.model_provider is None:
                        raise TaskError('local_model_unavailable', 409)
                    proposals = self.model_provider.extract(model_source, validate=validate, cancel_event=Cancellation())
                    validate()
                except Exception as error:
                    raise _discovery_failure(error) from None

            # Model authorization and route remain sealed through publication;
            # the earlier evidence-only transaction needs no model authority.
            with self._publication_guard(proposals, prepared):
                with (operation.transaction() if operation else self.store.transaction()) as conn:
                    if operation:
                        operation.check_provider()
                    self._maintenance(conn)
                    settings = conn.execute('SELECT * FROM work_task_settings WHERE id=1').fetchone()
                    source = self._source(conn, observation_id)
                    current = conn.execute('SELECT state,attempt FROM work_extraction_receipts WHERE source_record_id=?', (observation_id,)).fetchone()
                    activity = conn.execute('SELECT valid FROM work_activities WHERE id=?', (activity_id,)).fetchone()
                    if (cancelled() or not settings['auto_discovery'] or settings['version'] != revision
                            or source is None or encode(source) != fingerprint or not activity or not activity['valid']
                            or not current or current['state'] != 'pending' or current['attempt'] != attempt):
                        raise TaskError('discovery_authorization_changed', 409)
                    if proposals is None:
                        proposals = self.provider.extract(excerpts) if excerpts and settings['provider'] == 'evidence_rules_v1' else []
                    if not isinstance(proposals, list) or len(proposals) > 8 or any(not valid_proposal(p, excerpts) for p in proposals):
                        raise TaskError('invalid_discovery_result')
                    automatic = settings['provider'] == 'evidence_rules_v1'
                    for proposal in proposals:
                        key = task_key(proposal.title)
                        discovery = conn.execute('SELECT * FROM work_discoveries WHERE activity_id=? AND dedupe_key=?', (activity_id, key)).fetchone()
                        if discovery:
                            continue
                        # Dismissed/archived work stays suppressed across future sources.
                        suppressed = conn.execute("SELECT 1 FROM work_discovery_suppressions WHERE dedupe_key=?", (key,)).fetchone()
                        matches = conn.execute('SELECT * FROM work_tasks WHERE dedupe_key=? ORDER BY created_at,id', (key,)).fetchall()
                        eligible = [row for row in matches if row['archived'] or not row['evidence_unavailable'] or row['title_owned']]
                        # Local-model confidence/assignment and exact title
                        # matches never authorize task creation or association.
                        # Only explicit resolve(accept) may promote that data.
                        task_id = eligible[0]['id'] if automatic and len(eligible) == 1 else None
                        clear = automatic and proposal.self_assigned and proposal.unfinished and proposal.confidence >= .9
                        state = 'dismissed' if suppressed else 'pending'
                        if task_id and not suppressed:
                            state = 'accepted'
                            self._auto_link(conn, task_id, activity_id, confidence=proposal.confidence)
                        elif clear and not suppressed and not matches:
                            task_id = self._insert_task(conn, title=proposal.title, origin='assistant', activity_id=activity_id, discovery_provider=settings['provider'])
                            state = 'accepted'
                            self._auto_link(conn, task_id, activity_id, confidence=proposal.confidence)
                        conn.execute('''INSERT INTO work_discoveries
                            (id,version,activity_id,title,quote,state,confidence,dedupe_key,task_id,provider)
                            VALUES(?,1,?,?,?,?,?,?,?,?)''',
                            ('discovery_' + uuid4().hex, activity_id, proposal.title, proposal.quote, state,
                             proposal.confidence, key, task_id, settings['provider']))
                    if automatic:
                        self._reconcile_associations(conn, activity_id, source, excerpts)
                    if cancelled():
                        raise TaskError('discovery_authorization_changed', 409)
                    # Zero proposals is a successful, durable completion too.
                    conn.execute("UPDATE work_extraction_receipts SET state='completed' WHERE source_record_id=? AND attempt=?", (observation_id, attempt))
                    conn.execute('UPDATE work_task_settings SET last_error=NULL WHERE id=1')
                    if operation:
                        operation.completed(conn)
                    return {'processed': True, 'activity_id': activity_id}
        except Exception as error:
            # The proposal transaction rolls back, while valid evidence remains.
            # Reconcile source/media replacement and expiry durably even when
            # the failed call would otherwise roll back its maintenance work.
            with (operation.gate if operation else nullcontext()), self.store.transaction() as conn:
                self._maintenance(conn)
                conn.execute("UPDATE work_extraction_receipts SET state='failed' WHERE source_record_id=? AND attempt=? AND state='pending'", (observation_id, attempt))
                if prepared:
                    reason = _discovery_failure(error).code
                    conn.execute('UPDATE work_task_settings SET last_error=? WHERE id=1 AND version=?', (reason, revision))
                if operation:
                    reason = error.code if (type(error) is TaskError and type(error.code) is str
                        and error.code in DISCOVERY_ERROR_CODES) else 'sync_failed'
                    operation.failed(conn, reason)
            raise

    def sync(self):
        # A concurrent click is not a new retry after the active attempt fails.
        # Don't queue a sync which could silently redispatch that failed call.
        if not self._extraction_lock.acquire(blocking=False):
            return {'processed': 0, 'reason': 'extraction_in_progress'}
        try:
            return self._sync()
        finally:
            self._extraction_lock.release()

    def _sync(self, *, operation=None):
        settings = operation.settings if operation else self.settings()
        if not settings['auto_discovery']:
            return {'processed': 0, 'reason': 'disabled'}
        batch_limit = 1 if settings['provider'] == 'local_model_v1' else 200
        with (operation.transaction() if operation else self.store.transaction()) as conn:
            if operation:
                current = conn.execute('SELECT version FROM work_task_settings WHERE id=1').fetchone()
                if current['version'] != settings['version']:
                    raise TaskError('discovery_authorization_changed', 409)
            self._maintenance(conn)
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'context_observations' not in tables:
                if operation:
                    operation.update(conn, selected=0, has_more=0, state='complete',
                                     settled=1, reason='no_authorized_observations')
                return {'processed': 0, 'reason': 'no_authorized_observations'}
            failure_slots = ','.join('?' for _ in OCR_ORGANIZATION_FAILURES)
            candidates = conn.execute(f'''SELECT o.* FROM context_observations o
                JOIN context_capture_settings c ON c.id=1 AND c.consented=1 AND c.consent_revision=o.consent_revision
                WHERE (o.state='ready' OR (o.state='model_unavailable'
                    AND o.processing_reason IN ({failure_slots}) AND o.post_mask_ocr_engine='tesseract.js'
                    AND o.post_mask_ocr_image_digest=o.image_digest)) AND o.source_kind='public_window'
                AND julianday(o.captured_at)>=julianday(?) AND julianday(o.captured_at)<=julianday(?)
                AND julianday(o.expires_at)>julianday(?)
                AND NOT EXISTS (SELECT 1 FROM work_activities a WHERE a.source_record_id=o.id AND a.valid=0)
                AND NOT EXISTS (SELECT 1 FROM work_extraction_receipts r WHERE r.source_record_id=o.id AND r.state='completed')
                AND NOT EXISTS (SELECT 1 FROM work_source_rejections r WHERE r.source_record_id=o.id
                    AND r.state=o.state AND r.reason=COALESCE(o.processing_reason,''))
                ORDER BY o.captured_at,o.id LIMIT 201''', (*sorted(OCR_ORGANIZATION_FAILURES), settings['enabled_at'], self.now(), self.now())).fetchall()
            ids, skipped_invalid = [], 0
            for row in candidates:
                if row['state'] != 'ready' and not usable_unorganized_ocr(dict(row)):
                    conn.execute('INSERT OR REPLACE INTO work_source_rejections VALUES(?,?,?)',
                        (row['id'], row['state'], row['processing_reason'] or ''))
                    skipped_invalid += 1
                    continue
                if self._source(conn, row['id']) is None:
                    # Missing owned media is a durable invalid receipt; it must
                    # neither create a task nor starve newer valid records.
                    conn.execute('''INSERT OR IGNORE INTO work_activities
                        (id,source,source_record_id,start_at,end_at,time_kind,valid,source_revision,created_at)
                        VALUES(?,'observation',?,?,?,'sample',0,?,?)''', ('activity_' + uuid4().hex,
                        row['id'], row['captured_at'], row['captured_at'], row['consent_revision'], self.now()))
                    skipped_invalid += 1
                else:
                    ids.append(row['id'])
                    if len(ids) > batch_limit:
                        break
            has_more = len(ids) > batch_limit or len(candidates) > 200
            if operation:
                operation.update(conn, selected=min(len(ids), batch_limit),
                                 skipped_invalid=skipped_invalid, has_more=int(has_more))
                if not ids:
                    operation.update(conn, state='complete', settled=1,
                                     reason=None if skipped_invalid else 'no_authorized_observations')
        results = []
        for value in ids[:batch_limit]:
            result = self._process_observation(value, retry_incomplete=True,
                expected_settings_version=settings['version'],
                **({'operation': operation, 'cancel_event': operation.cancelled} if operation else {}))
            if operation and not result['processed']:
                # A source/consent/settings fence is not a successful empty
                # extraction and must not let a stale batch continue.
                reason = result.get('reason')
                reason = ('source_outside_scope' if reason in {'source_outside_scope', 'source_invalidated'}
                          else 'discovery_authorization_changed')
                operation.fail(reason)
                raise TaskError(reason, 409)
            results.append(result)
        if operation and not ids and not skipped_invalid:
            return {'processed': 0, 'reason': 'no_authorized_observations'}
        return {'processed': sum(result['processed'] for result in results), 'bounded_to': batch_limit, 'has_more': len(ids) > batch_limit or len(candidates) > 200, 'skipped_invalid': skipped_invalid}

    def discoveries(self):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            pending_count = conn.execute("SELECT count(*) FROM work_discoveries WHERE state='pending'").fetchone()[0]
            return {'items': [dict(row) for row in conn.execute("SELECT * FROM work_discoveries ORDER BY (state='pending') DESC,rowid DESC LIMIT 500")],
                    'pending_count': pending_count, 'has_more_pending': pending_count > 500}

    def resolve(self, discovery_id, request: models.DiscoveryResolution):
        with self.store.transaction() as conn:
            self._maintenance(conn)
            row = conn.execute('SELECT * FROM work_discoveries WHERE id=?', (discovery_id,)).fetchone()
            if row is None:
                raise TaskError('discovery_not_found', 404)
            if row['version'] != request.expected_version or row['state'] != 'pending':
                raise TaskError('version_conflict', 409)
            if not self._activity(conn, row['activity_id'])['evidence_available']:
                raise TaskError('evidence_unavailable', 409)
            task_id = None
            if request.decision == 'accept':
                matches = conn.execute('SELECT id FROM work_tasks WHERE dedupe_key=? AND archived=0 AND merged_into IS NULL AND (evidence_unavailable=0 OR title_owned=1)', (row['dedupe_key'],)).fetchall()
                task_id = matches[0][0] if len(matches) == 1 else self._insert_task(conn, title=row['title'], origin='assistant', activity_id=row['activity_id'], confirmed=True, discovery_provider=row['provider'])
                conn.execute('UPDATE work_tasks SET confirmed=1,title_owned=1,description_owned=1 WHERE id=?', (task_id,))
                if len(matches) == 1:
                    self._touch(conn, task_id, self.now())
                self._auto_link(conn, task_id, row['activity_id'], confidence=row['confidence'])
            if request.decision == 'dismiss':
                conn.execute("INSERT OR IGNORE INTO work_discovery_suppressions VALUES(?,'user_dismissed')", (row['dedupe_key'],))
            conn.execute('UPDATE work_discoveries SET state=?,task_id=?,version=version+1 WHERE id=?',
                ('accepted' if task_id else 'dismissed', task_id, discovery_id))
            return {'task': public_task(self._task(conn, task_id)) if task_id else None}

    def runtime_bridge(self, task_id, request: models.RuntimeBridge):
        # Source cleanup is independently durable even when the requested bridge
        # later fails its optimistic version or runtime-reference precondition.
        with self.store.transaction() as conn:
            self._maintenance(conn)
        # A reference only. Never creates/activates an executable runtime goal,
        # changes source scopes, grants approval, or derives user completion.
        if request.goal_id:
            if self.runtime is None:
                raise TaskError('runtime_unavailable', 409)
            try:
                with self.runtime.store.transaction() as runtime_conn:
                    exists = runtime_conn.execute('SELECT 1 FROM goals WHERE id=?', (request.goal_id,)).fetchone()
            except Exception:
                raise TaskError('runtime_unavailable', 409) from None
            if not exists:
                raise TaskError('runtime_goal_not_found', 404)
        with self.store.transaction() as conn:
            self._maintenance(conn)
            self._task(conn, task_id, request.expected_version)
            conn.execute('UPDATE work_tasks SET runtime_goal_id=? WHERE id=?', (request.goal_id, task_id))
            self._touch(conn, task_id, self.now())
            return public_task(self._task(conn, task_id))
