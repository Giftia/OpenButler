"""Additive local tables; no source migration and no worker on construction.

All operations take BEGIN IMMEDIATE so edits, corrections, merges and source
invalidation cannot overwrite each other. Capture source triggers remove derived
text in the same transaction as deletion/revocation, even when no task UI is open.
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = '''
CREATE TABLE IF NOT EXISTS work_task_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1,
 auto_discovery INTEGER NOT NULL DEFAULT 0, enabled_at TEXT,
 last_error TEXT, provider TEXT NOT NULL DEFAULT 'evidence_rules_v1'
);
INSERT OR IGNORE INTO work_task_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS work_tasks (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'normal',
 due_at TEXT, completed_at TEXT, archived INTEGER NOT NULL DEFAULT 0,
 merged_into TEXT REFERENCES work_tasks(id), created_by TEXT NOT NULL,
 confirmed INTEGER NOT NULL DEFAULT 0, title_owned INTEGER NOT NULL DEFAULT 0,
 description_owned INTEGER NOT NULL DEFAULT 0, origin_activity_id TEXT,
 evidence_unavailable INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT,
 checkpoint TEXT, runtime_goal_id TEXT, discovery_provider TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_tasks_key ON work_tasks(dedupe_key);
CREATE TABLE IF NOT EXISTS work_activities (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, source_record_id TEXT UNIQUE,
 title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, time_kind TEXT NOT NULL,
 valid INTEGER NOT NULL DEFAULT 1, source_revision TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_task_links (
 task_id TEXT NOT NULL REFERENCES work_tasks(id),
 activity_id TEXT NOT NULL REFERENCES work_activities(id),
 relation TEXT NOT NULL, decision TEXT NOT NULL, origin TEXT NOT NULL,
 confidence REAL NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(task_id,activity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_activity_primary ON work_task_links(activity_id)
 WHERE is_primary=1 AND decision='accepted';
CREATE TABLE IF NOT EXISTS work_task_resources (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id),
 kind TEXT NOT NULL, label TEXT NOT NULL, reference TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_discoveries (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
 activity_id TEXT NOT NULL REFERENCES work_activities(id),
 title TEXT NOT NULL, quote TEXT NOT NULL, state TEXT NOT NULL,
 confidence REAL NOT NULL, dedupe_key TEXT NOT NULL,
 task_id TEXT REFERENCES work_tasks(id), provider TEXT NOT NULL DEFAULT 'unknown', UNIQUE(activity_id,dedupe_key)
);
CREATE TABLE IF NOT EXISTS work_source_rejections (
 source_record_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_extraction_receipts (
 source_record_id TEXT PRIMARY KEY,
 state TEXT NOT NULL CHECK(state IN ('pending','failed','completed')),
 attempt INTEGER NOT NULL DEFAULT 0,
 evidence_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS work_discovery_suppressions (
 dedupe_key TEXT PRIMARY KEY, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_commands (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, request_hash TEXT NOT NULL, result_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_sync_operations (
 command_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN ('pending','stopping','complete','error','interrupted')),
 settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
 provider TEXT NOT NULL, settings_version INTEGER NOT NULL, gateway_revision INTEGER,
 bounded_to INTEGER NOT NULL CHECK(bounded_to IN (1,200)),
 selected INTEGER NOT NULL DEFAULT 0, attempted INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, activities_created INTEGER NOT NULL DEFAULT 0,
 skipped_invalid INTEGER NOT NULL DEFAULT 0, has_more INTEGER, reason TEXT,
 current_source_id TEXT, current_attempt INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((settled=0 AND state IN ('pending','stopping')) OR
       (settled=1 AND state IN ('complete','error','interrupted')))
);
CREATE UNIQUE INDEX IF NOT EXISTS work_sync_single_unsettled
 ON work_sync_operations((1)) WHERE settled=0;
'''

# No raw source text is kept on an activity; only user-written activity content.
# The only copied source text lives in an unconfirmed task/discovery. Wipe it.
INVALIDATE_SQL = '''
UPDATE work_activities SET valid=0 WHERE source='observation' AND ({condition});
UPDATE work_tasks SET title=CASE WHEN title_owned=0 THEN '来源已不可用' ELSE title END,
 description=CASE WHEN description_owned=0 THEN '' ELSE description END,
 evidence_unavailable=1,version=version+1
 WHERE evidence_unavailable=0 AND origin_activity_id IN (SELECT id FROM work_activities WHERE valid=0);
UPDATE work_discoveries SET title='',quote='',state='invalidated',version=version+1
 WHERE state!='invalidated' AND activity_id IN (SELECT id FROM work_activities WHERE valid=0);
'''


def init_task_store(conn):
    # Keep legacy receipt creation inside the caller's write transaction.
    for statement in SCHEMA.split(';'):
        if statement.strip():
            conn.execute(statement)
    # New activities and pending receipts are atomic. A missing receipt is
    # therefore legacy work, including rows written after a code rollback while
    # this additive table remained. Never change existing incomplete receipts.
    conn.execute('''INSERT OR IGNORE INTO work_extraction_receipts(source_record_id,state)
        SELECT source_record_id,'completed' FROM work_activities
        WHERE source='observation' AND source_record_id IS NOT NULL''')
    columns = {row[1] for row in conn.execute('PRAGMA table_info(work_task_settings)')}
    if 'provider' not in columns:
        conn.execute("ALTER TABLE work_task_settings ADD COLUMN provider TEXT NOT NULL DEFAULT 'evidence_rules_v1'")
    task_columns = {row[1] for row in conn.execute('PRAGMA table_info(work_tasks)')}
    if 'discovery_provider' not in task_columns:
        conn.execute('ALTER TABLE work_tasks ADD COLUMN discovery_provider TEXT')
        conn.execute("UPDATE work_tasks SET discovery_provider='unknown' WHERE created_by='assistant'")
    discovery_columns = {row[1] for row in conn.execute('PRAGMA table_info(work_discoveries)')}
    if 'provider' not in discovery_columns:
        conn.execute("ALTER TABLE work_discoveries ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'")
    # Source schema is owned by context_engine; never create or change it here.
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if {'context_observations', 'context_capture_settings'} <= tables:
        conn.executescript('''CREATE TRIGGER IF NOT EXISTS work_source_delete
            AFTER DELETE ON context_observations BEGIN
            ''' + INVALIDATE_SQL.format(condition='source_record_id=OLD.id') + ''' END;
            CREATE TRIGGER IF NOT EXISTS work_source_revoke
            AFTER UPDATE OF consented,consent_revision ON context_capture_settings
            WHEN NEW.consented=0 OR NEW.consent_revision!=OLD.consent_revision BEGIN
            ''' + INVALIDATE_SQL.format(condition='1=1') + ' END;')


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.transaction() as conn:
            init_task_store(conn)

    @contextmanager
    def transaction(self, *, timeout=15):
        conn = sqlite3.connect(self.path, timeout=timeout)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('PRAGMA busy_timeout=' + str(int(timeout * 1000)))
        try:
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @contextmanager
    def read(self, *, timeout=1):
        """Operation status only: no write transaction, maintenance or model lock."""
        conn = sqlite3.connect(self.path, timeout=timeout)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA query_only=ON')
        try:
            yield conn
        finally:
            conn.close()
