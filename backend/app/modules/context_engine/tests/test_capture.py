from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
import base64
import sqlite3
import tempfile
import unittest

from PIL import Image
from uuid import uuid4

from app.modules.context_engine.tests.capture_fixture import public_window_provenance

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.context_engine.capture import (
    CaptureSettings, CaptureStore, MaskedObservation, init_capture_store,
)


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = lambda: sqlite3.connect(self.root / "owned.sqlite3", factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            init_capture_store(conn, reset_active=True)
        self.now = datetime(2026, 9, 22, tzinfo=timezone.utc)
        self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        image = Image.new("RGB", (40, 20), color=(10, 10, 10))
        output = BytesIO()
        image.save(output, format="PNG")
        self.encoded = base64.b64encode(output.getvalue()).decode("ascii")
        self.metadata = public_window_provenance(self.now)
        self.revision = str(uuid4())
        self.sequence = 0

    def observation(self, **changes):
        self.sequence += 1
        values = {**self.metadata, "display_id": "x11:100", "captured_at": self.now,
            "masked_png_base64": self.encoded, "local_ocr_complete": True, "masks_applied": True,
            "consent_revision": self.revision, "source_verified_before": True, "source_verified_after": True,
            "sampling_sequence": self.sequence, "sampling_gap_ms": 0}
        values.update(changes)
        return MaskedObservation(**values)

    def activate(self):
        result = self.store.configure(CaptureSettings(display_id="x11:100",
            excluded_apps=["password-manager"], confirmed=True, **self.metadata))
        self.revision = result["consent_revision"]
        self.store.start()

    def test_consent_and_masks_are_required_and_pause_denies(self):
        with self.assertRaises(PermissionError):
            self.store.start()
        with self.assertRaises(PermissionError):
            self.store.ingest(self.observation())
        self.activate()
        with self.assertRaises(PermissionError):
            self.store.ingest(self.observation(local_ocr_complete=False))
        first = self.store.ingest(self.observation())
        self.assertTrue(first["recorded"])
        self.store.pause()
        with self.assertRaises(PermissionError):
            self.store.ingest(self.observation())
        self.assertEqual(self.store.state()["record_count"], 1)

    def test_restart_never_resumes_and_identical_masked_frame_deduplicates(self):
        self.activate()
        first = self.store.ingest(self.observation())
        self.now += timedelta(seconds=1)
        second = self.store.ingest(self.observation())
        self.assertEqual(second, {"recorded": False, "duplicate": True, "id": first["id"]})
        with self.db() as conn:
            init_capture_store(conn, reset_active=True)
        self.assertFalse(self.store.state()["active"])
        with self.assertRaises(PermissionError):
            self.store.ingest(self.observation())

    def test_opaque_evidence_expires_and_unrelated_data_untouched(self):
        self.activate()
        self.store.ingest(self.observation())
        record = self.store.list_records()[0]
        self.assertEqual(record["source_label"], "专用公开窗口")
        self.assertEqual(self.store.evidence(record["evidence_id"]), base64.b64decode(self.encoded))
        self.assertIsNone(self.store.evidence("../owned.sqlite3"))
        self.now += timedelta(days=7)
        self.assertIsNone(self.store.evidence(record["evidence_id"]))
        self.assertFalse(self.store.list_records()[0]["evidence_available"])
        self.assertEqual(self.store.expire_owned(), 1)
        self.assertEqual(self.store.list_records(), [])
        self.assertTrue((self.root / "owned.sqlite3").exists())

    def test_invalid_or_stale_png_never_persists(self):
        self.activate()
        with self.assertRaises(ValueError):
            self.store.ingest(self.observation(masked_png_base64=base64.b64encode(b"bad" * 20).decode()))
        self.now += timedelta(minutes=6)
        with self.assertRaises(ValueError):
            self.store.ingest(self.observation(captured_at=self.now - timedelta(minutes=6)))
        self.assertEqual(self.store.list_records(), [])

    def test_early_delete_only_removes_owned_record_and_media(self):
        self.activate()
        event = self.store.ingest(self.observation())
        source = self.root / "unrelated-source.txt"
        source.write_text("preserve", encoding="utf-8")
        evidence_id = self.store.list_records()[0]["evidence_id"]
        self.assertFalse(self.store.delete_owned("../unrelated-source.txt"))
        self.assertTrue(self.store.delete_owned(event["id"]))
        self.assertFalse(self.store.delete_owned(event["id"]))
        self.assertIsNone(self.store.evidence(evidence_id))
        self.assertEqual(source.read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
