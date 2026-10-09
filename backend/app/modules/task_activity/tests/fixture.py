"""Offline, public synthetic records; never invokes capture, OCR, or a model."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import tempfile
from uuid import uuid4

from app.modules.context_engine.capture import init_capture_store
from app.modules.context_engine.processor import ObservationProcessor
from app.modules.task_activity import models
from app.modules.task_activity.service import TaskService

# A literal synthetic 1x1 PNG, not a capture or copied user image.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
    "0000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082"
)
FIXED_NOW = datetime(2026, 10, 9, 3, 0, tzinfo=timezone.utc)


@contextmanager
def synthetic_commit_guard(proposals):
    """Explicit trusted test adapter guard; no production authorization fallback."""
    yield


class TaskFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="openbutler-task-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "openbutler.sqlite3"
        self.now = FIXED_NOW
        self.revision = str(uuid4())
        with self.connect() as conn:
            init_capture_store(conn)
            conn.execute("""INSERT INTO context_capture_settings
                (id,display_id,excluded_apps,masks,consented,active,source_kind,consent_revision,provenance)
                VALUES(1,'synthetic-public','[]','[]',1,0,'public_window',?,'{}')""", (self.revision,))
        self.service = TaskService(self.path, clock=lambda: self.now)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def enable(self, provider="evidence_rules_v1"):
        return self.service.set_settings(models.SettingsEdit(
            expected_version=self.service.settings()["version"], auto_discovery=True,
            confirmed=True, provider=provider))

    def task(self, title="Public synthetic task", **fields):
        return self.service.create_task(models.TaskCreate(command_id=uuid4(), title=title, **fields))

    def current(self, task):
        return self.service.detail(task["id"])["task"]

    def edit(self, task, **fields):
        return self.service.edit_task(task["id"], models.TaskEdit(
            expected_version=self.current(task)["version"], **fields))

    def activity(self, start_minutes=-60, end_minutes=-30, title="Public manual activity"):
        return self.service.create_activity(models.ActivityCreate(command_id=uuid4(), title=title,
            start_at=self.now + timedelta(minutes=start_minutes),
            end_at=self.now + timedelta(minutes=end_minutes)))

    def link(self, task, activity, *, relation="work", decision="accepted", primary=True):
        return self.service.link_activity(task["id"], activity["id"], models.LinkEdit(
            expected_version=self.current(task)["version"], relation=relation,
            decision=decision, primary=primary))

    def source(self, text="TODO(me): Review public example", *, captured_at=None,
               expires_at=None, source_kind="public_window", state="ready",
               consent_revision=None, media=True, grounded=True, temporal_context=None):
        observation_id, evidence_id = str(uuid4()), str(uuid4())
        image_digest = sha256(PNG).hexdigest()
        quotes = text.splitlines()
        assert 1 <= len(quotes) <= 3 and all(0 < len(q) <= 120 for q in quotes)
        title, summary = ObservationProcessor.source_content(quotes)
        boundary = "Synthetic public OCR excerpt; no continuous observation."
        facts = {"title": title, "summary": summary, "boundary": boundary,
            "observation_route": "post_mask_ocr_to_text_model",
            "source_grounding": {
                "version": 1, "source_kind": "post_mask_ocr_text",
                "source_text_digest": sha256(text.encode()).hexdigest(),
                "observation_id": observation_id, "evidence_id": evidence_id,
                "image_digest": image_digest, "offset_unit": "unicode_codepoints",
                "verification": "exact_source_spans_only", "semantic_verified": False,
                "excerpts": [{"quote": q, "start": text.index(q), "end": text.index(q) + len(q)} for q in quotes],
            }}
        if not grounded:
            facts["source_grounding"]["source_text_digest"] = "0" * 64
        provenance = {"source_kind": source_kind, "capture_scope": "dedicated_public_window",
                      "observation_mode": "masked_ocr_text",
                      "source_verified_before": True, "source_verified_after": True}
        row = {"id": observation_id, "captured_at": (captured_at or self.now).isoformat(),
            "display_id": "synthetic-public", "image_digest": image_digest, "evidence_id": evidence_id,
            "expires_at": (expires_at or self.now + timedelta(days=1)).isoformat(),
            "state": state, "title": title, "summary": summary, "boundary": boundary,
            "source_kind": source_kind, "consent_revision": consent_revision or self.revision,
            "provenance": json.dumps(provenance), "temporal_context": json.dumps(temporal_context or {}),
            "post_mask_ocr_text": text, "post_mask_ocr_image_digest": image_digest,
            "post_mask_ocr_engine": "tesseract.js", "extraction_version": 2,
            "current_facts": json.dumps(facts)}
        with self.connect() as conn:
            conn.execute("INSERT INTO context_observations (" + ",".join(row) + ") VALUES (" +
                         ",".join("?" for _ in row) + ")", tuple(row.values()))
        if media:
            folder = self.root / "context_engine" / "media"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / (evidence_id + ".png")).write_bytes(PNG)
        return row

    def process(self, source):
        result = self.service.process_observation(source["id"])
        self.assertTrue(result["processed"], result)
        return next(a for a in self.service.list_activities()["items"] if a["id"] == result["activity_id"])

    def sql(self, statement, parameters=()):
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(statement, parameters)]
