"""Synthetic coverage-control regressions; no desktop or model access."""

import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from PIL import Image

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.context_engine.capture import CaptureSettings, CaptureStore, MaskedObservation, init_capture_store
from app.modules.context_engine.tests.test_capture import ClosingConnection


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = lambda: sqlite3.connect(self.root / "owned.sqlite3", factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            init_capture_store(conn)
        self.now = datetime(2026, 10, 3, tzinfo=timezone.utc)
        self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        self.sequence = 0
        self.metadata = {
            "source_kind": "public_window", "capture_scope": "dedicated_public_window",
            "source_revision": "a" * 64,
            "source_identity": {"window_id": "x11:123", "owner_pid": 1, "owner_process_start": "999",
                "owner_process_name": "editor", "wm_class": "Editor", "window_title": "Public fixture",
                "content_bounds": {"x": 0, "y": 0, "width": 40, "height": 20}},
            "lock_state": "unknown", "lock_protection_supported": False,
            "capture_method": "xcomposite_named_window_pixmap", "sampling_interval_ms": 10000,
        }

    def configure(self):
        self.metadata.update(session_id=str(uuid4()), session_expires_at=(self.now + timedelta(minutes=30)).isoformat())
        result = self.store.configure(CaptureSettings(display_id="x11:123", excluded_apps=["password-manager"],
            confirmed=True, **self.metadata))
        self.revision = result["consent_revision"]
        self.sequence = 0

    def sample(self, color=1, **changes):
        self.sequence += 1
        output = BytesIO()
        Image.new("RGB", (40, 20), (color, 0, 0)).save(output, format="PNG")
        values = {**self.metadata, "display_id": "x11:123", "captured_at": self.now,
            "masked_png_base64": base64.b64encode(output.getvalue()).decode(),
            "local_ocr_complete": True, "masks_applied": True, "consent_revision": self.revision,
            "source_verified_before": True, "source_verified_after": True,
            "sampling_sequence": self.sequence, "sampling_gap_ms": 0}
        values.update(changes)
        return self.store.ingest(MaskedObservation(**values))

    def events(self, kind=None):
        events = self.store.list_coverage_events()
        return [event for event in events if kind is None or event["kind"] == kind]

    def test_pause_to_new_session_closes_only_on_first_accepted_sample(self):
        self.configure()
        self.store.start()
        self.sample()
        first_revision = self.revision
        for _ in range(2):
            self.now += timedelta(seconds=10)
            self.assertTrue(self.sample()["duplicate"])
        self.now += timedelta(seconds=2)
        paused_at = self.now
        self.store.pause()
        self.store.pause()
        self.assertEqual(len(self.events("paused")), 1)
        self.assertIsNone(self.events("paused")[0]["gap_end_at"])
        with self.assertRaises(PermissionError):
            self.sample()
        self.now += timedelta(seconds=58.669)
        self.configure()
        self.store.start()
        self.store.start()
        self.assertIsNone(self.events("paused")[0]["gap_end_at"])
        self.assertIsNone(self.events("started")[0]["first_sample_at"])
        self.now += timedelta(seconds=3)
        self.sample()
        event = self.events("paused")[0]
        self.assertEqual(event["consent_revision"], first_revision)
        self.assertEqual(event["gap_started_at"], paused_at.isoformat())
        self.assertEqual(event["gap_end_at"], self.now.isoformat())
        self.assertTrue(event["gap_start_known"] and event["gap_end_known"])
        self.assertEqual(len(self.events("started")), 2)
        self.assertEqual(len(self.store.list_records()), 2)
        self.assertEqual([row["provenance"]["sampling_sequence"] for row in self.store.list_records()], [1, 1])
        self.assertEqual([row["provenance"]["sampling_gap_ms"] for row in self.store.list_records()], [0, 0])

    def test_recovery_anchors_to_latest_duplicate_not_old_observation(self):
        self.configure()
        self.store.start()
        self.sample()
        self.now += timedelta(seconds=10)
        self.assertTrue(self.sample()["duplicate"])
        last_sample = self.now
        self.now += timedelta(seconds=25)
        with self.db() as conn:
            init_capture_store(conn, reset_active=True, recovered_at=self.now)
        self.assertFalse(self.store.state()["active"])
        event = self.events("process_restarted")[0]
        self.assertEqual(event["last_sample_at"], last_sample.isoformat())
        self.assertEqual(event["gap_started_at"], last_sample.isoformat())
        self.assertFalse(event["gap_start_known"])
        self.assertFalse(event["gap_end_known"])
        self.assertEqual(event["occurred_at"], self.now.isoformat())
        with self.db() as conn:
            init_capture_store(conn, reset_active=True, recovered_at=self.now)
        self.assertEqual(len(self.events("process_restarted")), 1)
        with self.assertRaises(PermissionError):
            self.sample()
        self.configure()
        self.store.start()
        self.assertIsNone(self.events("process_restarted")[0]["gap_end_at"])
        self.now += timedelta(seconds=1)
        self.sample()
        self.assertTrue(self.events("process_restarted")[0]["gap_end_known"])
        self.assertFalse(self.events("process_restarted")[0]["gap_start_known"])

    def test_failed_sample_cannot_close_gap_or_change_latest_sample(self):
        self.configure()
        self.store.start()
        self.sample()
        self.now += timedelta(seconds=1)
        self.store.pause()
        self.configure()
        self.store.start()
        self.now += timedelta(seconds=1)
        with patch("app.modules.context_engine.capture.os.replace", side_effect=OSError("fixture")):
            with self.assertRaises(OSError):
                self.sample()
        self.assertIsNone(self.events("started")[0]["first_sample_at"])
        self.assertIsNone(self.events("paused")[0]["gap_end_at"])
        with self.db() as conn:
            self.assertEqual(conn.execute("SELECT last_capture_at,last_sampling_sequence FROM context_capture_settings").fetchone(), (None, 0))

    def test_no_sample_and_failed_startup_leave_open_gap(self):
        self.configure()
        self.store.start()
        self.store.pause("source_unavailable")
        self.configure()
        self.store.start()
        self.store.pause("capture_error")
        self.assertEqual(self.store.list_records(), [])
        self.assertEqual(len(self.events("started")), 2)
        self.assertTrue(all(event["gap_end_at"] is None for event in self.events()))

    def test_late_accepted_start_after_stop_recovers_unknown_without_closing_gap(self):
        self.configure()
        self.store.start()
        self.sample()
        self.now += timedelta(seconds=1)
        self.store.pause("shutdown")
        # Simulate an already dispatched start accepted after the stop. Desktop
        # cancellation prevents pixels, but cannot pretend the control call vanished.
        self.store.start()
        with self.db() as conn:
            init_capture_store(conn, reset_active=True, recovered_at=self.now + timedelta(seconds=2))
        self.assertFalse(self.store.state()["active"])
        self.assertEqual(len(self.events("process_restarted")), 1)
        self.assertFalse(self.events("process_restarted")[0]["gap_start_known"])
        self.assertIsNone(self.events("stopped")[0]["gap_end_at"])
        self.assertIsNone(self.events("process_restarted")[0]["gap_end_at"])
        self.assertEqual(len(self.store.list_records()), 1)

    def test_backwards_clock_does_not_close_gap_until_accepted_time_is_consistent(self):
        self.configure()
        self.store.start()
        self.sample()
        self.now += timedelta(seconds=20)
        paused_at = self.now
        self.store.pause()
        self.now -= timedelta(seconds=10)
        self.configure()
        self.store.start()
        self.sample()
        self.assertIsNone(self.events("paused")[0]["gap_end_at"])
        self.now = paused_at + timedelta(seconds=1)
        self.assertTrue(self.sample()["duplicate"])
        self.assertEqual(self.events("paused")[0]["gap_end_at"], self.now.isoformat())
        with self.assertRaisesRegex(ValueError, "late_public_window_frame"):
            self.sample(sampling_sequence=1)
        self.assertEqual(len(self.events()), 3)

    def test_exact_stops_reconfigure_revoke_and_graceful_shutdown_survive_restart(self):
        self.configure()
        self.store.start()
        self.configure()
        self.assertEqual(len(self.events("reconfigured")), 1)
        self.store.start()
        self.store.revoke()
        self.store.revoke()
        self.assertEqual(len(self.events("revoked")), 1)
        with self.assertRaises(PermissionError):
            self.store.start()
        self.configure()
        self.store.start()
        self.store.pause("shutdown")
        self.store.pause("shutdown")
        self.assertEqual(len(self.events("stopped")), 1)
        with self.db() as conn:
            init_capture_store(conn, reset_active=True, recovered_at=self.now + timedelta(seconds=20))
        self.assertEqual(self.events("process_restarted"), [])
        reopened = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        self.assertEqual(reopened.list_coverage_events(), self.events())

    def test_legacy_migration_does_not_invent_history_or_change_observations(self):
        with self.db() as conn:
            conn.execute("DROP TABLE context_capture_coverage")
            conn.execute("ALTER TABLE context_capture_settings DROP COLUMN coverage_event_id")
            init_capture_store(conn)
            init_capture_store(conn)
        self.assertEqual(self.events(), [])
        self.configure()
        self.store.start()
        self.sample()
        before = self.store.list_records()[0]
        # A legacy active settings row has no recorded start/sample metadata.
        with self.db() as conn:
            conn.execute("DELETE FROM context_capture_coverage")
            conn.execute("UPDATE context_capture_settings SET coverage_event_id=NULL,last_capture_at=NULL")
            init_capture_store(conn, reset_active=True, recovered_at=self.now)
        event = self.events()[0]
        self.assertEqual(event["kind"], "process_restarted")
        self.assertIsNone(event["gap_started_at"])
        self.assertFalse(event["gap_start_known"])
        after = self.store.list_records()[0]
        for key in ("id", "captured_at", "evidence_id", "provenance", "consent_revision"):
            self.assertEqual(before[key], after[key])

    def test_full_screen_duplicate_can_end_gap_without_extra_observation(self):
        self.store.configure(CaptureSettings(display_id="screen_1", excluded_apps=["password-manager"], confirmed=True))
        self.store.start()
        image = BytesIO()
        Image.new("RGB", (40, 20)).save(image, format="PNG")
        def sample():
            return self.store.ingest(MaskedObservation(display_id="screen_1", captured_at=self.now,
                masked_png_base64=base64.b64encode(image.getvalue()).decode(), local_ocr_complete=True, masks_applied=True))
        sample()
        self.store.pause()
        self.now += timedelta(seconds=10)
        self.store.start()
        self.assertIsNone(self.events("paused")[0]["gap_end_at"])
        self.assertTrue(sample()["duplicate"])
        self.assertEqual(len(self.store.list_records()), 1)
        self.assertEqual(self.events("paused")[0]["gap_end_at"], self.now.isoformat())


if __name__ == "__main__":
    unittest.main()
