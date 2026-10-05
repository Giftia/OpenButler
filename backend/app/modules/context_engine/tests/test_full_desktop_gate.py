"""Fail-closed capture regressions using generated pixels and isolated databases."""

import base64
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from pydantic import ValidationError

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.context_engine.capture import CaptureSettings, CaptureStore, MaskedObservation, init_capture_store
from app.modules.context_engine.organization_queue import ObservationQueue
from app.modules.context_engine.tests.capture_fixture import (
    public_window_provenance, seed_historical_observation, seed_legacy_capture_settings,
)
from app.modules.context_engine.tests.test_capture import ClosingConnection
from app.modules.model_gateway.gateway import synthetic_probe_png


class FullDesktopGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = lambda: sqlite3.connect(self.root / "owned.sqlite3", factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            init_capture_store(conn)
        self.now = datetime(2026, 10, 5, tzinfo=timezone.utc)
        self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        self.png = synthetic_probe_png()

    def snapshot(self):
        with self.db() as conn:
            return list(conn.iterdump())

    def settings(self, **changes):
        return CaptureSettings(**{"display_id": "synthetic_display", "confirmed": True,
            "excluded_apps": ["password-manager"], **changes})

    def frame(self, **changes):
        return MaskedObservation(**{"display_id": "synthetic_display", "captured_at": self.now,
            "masked_png_base64": base64.b64encode(self.png).decode(), "local_ocr_complete": True,
            "masks_applied": True, "source_verified_before": True, "source_verified_after": True,
            "consent_revision": str(uuid4()), **changes})

    def assert_blocked_without_changes(self, operation):
        before, generation = self.snapshot(), self.store._generation
        with patch.object(self.store, "_validate_png", side_effect=AssertionError("must not decode pixels")):
            with self.assertRaisesRegex(PermissionError, "^full_desktop_unavailable$"):
                operation()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.store._generation, generation)
        self.assertFalse(self.store._media.exists())

    def test_default_and_explicit_full_screen_configuration_never_mutate(self):
        for values in ({}, {"source_kind": "full_screen", "capture_scope": "full_screen"},
                       {"confirmed": False}):
            with self.subTest(values=values):
                self.assert_blocked_without_changes(lambda: self.store.configure(self.settings(**values)))
        self.assertFalse(self.store.state()["configured"])

    def test_basic_mode_and_client_verified_flags_cannot_enable_desktop(self):
        for mode in ("strict", "basic"):
            with self.subTest(mode=mode):
                self.store = CaptureStore(self.db, self.root, lambda: mode, lambda: self.now)
                self.assert_blocked_without_changes(lambda: self.store.configure(self.settings()))
                self.assert_blocked_without_changes(lambda: self.store.ingest(self.frame()))

    def test_persisted_full_screen_consent_cannot_start_resume_or_ingest(self):
        for active in (False, True):
            for provenance in ({}, {"source_kind": "full_screen", "capture_scope": "full_screen"}):
                with self.subTest(active=active, provenance=provenance):
                    seed_legacy_capture_settings(self.db, active=active, provenance=provenance)
                    self.assert_blocked_without_changes(self.store.start)
                    self.assert_blocked_without_changes(lambda: self.store.ingest(self.frame()))
                    self.assertFalse(self.store.state()["active"])
                    self.store.pause()
                    self.assert_blocked_without_changes(self.store.start)

    def test_stale_mixed_or_unknown_stored_source_cannot_resume(self):
        public = public_window_provenance(self.now)
        for kind, provenance in (("full_screen", public), ("full_desktop", public),
                                 ("public_window", {}),
                                 ("public_window", {**public, "capture_scope": "full_screen"}),
                                 ("public_window", {**public, "source_kind": "full_screen"})):
            with self.subTest(kind=kind, provenance=provenance):
                seed_legacy_capture_settings(self.db, active=True, source_kind=kind, provenance=provenance)
                self.assert_blocked_without_changes(self.store.start)
                self.assertFalse(self.store.state()["active"])

    def test_public_frame_cannot_cross_stale_full_screen_settings(self):
        seed_legacy_capture_settings(self.db, active=True)
        frame = self.frame(**public_window_provenance(self.now), sampling_sequence=1, sampling_gap_ms=0)
        self.assert_blocked_without_changes(lambda: self.store.ingest(frame))

    def test_failed_full_screen_configuration_preserves_public_window_session(self):
        metadata = public_window_provenance(self.now)
        configured = self.store.configure(self.settings(**metadata))
        self.store.start()
        self.assert_blocked_without_changes(lambda: self.store.configure(self.settings()))
        self.assert_blocked_without_changes(lambda: self.store.ingest(self.frame()))
        self.assertTrue(self.store.state()["active"])
        self.assertEqual(self.store.state()["consent_revision"], configured["consent_revision"])

    def test_unsupported_aliases_and_mixed_source_scopes_remain_rejected(self):
        for field in ("source_kind", "capture_scope"):
            with self.subTest(field=field):
                with self.assertRaises(ValidationError):
                    self.settings(**{field: "full_desktop"})
                # Service boundary also rejects stale internal objects that did
                # not pass request validation; no hidden opt-in can open it.
                forged = self.settings().model_copy(update={field: "full_desktop"})
                self.assert_blocked_without_changes(lambda: self.store.configure(forged))
        with self.assertRaises(ValidationError):
            self.settings(**{**public_window_provenance(self.now), "capture_scope": "full_screen"})

    def test_legacy_retry_never_reads_queues_dispatches_or_mutates(self):
        for active in (False, True):
            for state in ("model_unavailable", "recorded_pending"):
                with self.subTest(active=active, state=state):
                    seed_legacy_capture_settings(self.db, active=active)
                    event = seed_historical_observation(self.db, self.now, state=state)
                    before, processor, operation = self.snapshot(), Mock(), Mock()
                    queue = ObservationQueue(self.store, processor)
                    self.addCleanup(queue.close)
                    with patch.object(self.store, "evidence", side_effect=AssertionError("must not read image")), \
                            patch.object(self.store, "owned_evidence_fingerprint", side_effect=AssertionError("must not open image")):
                        self.assertEqual(queue.submit(event, retry=True),
                                         {"accepted": False, "reason": "full_desktop_unavailable"})
                        for attempt in (lambda: self.store.prepare_retry(event),
                                        lambda: self.store.mark_queued(event, self.store._generation, retry=True),
                                        lambda: self.store.with_processing_consent(operation, require_active=True)):
                            with self.assertRaisesRegex(PermissionError, "^full_desktop_unavailable$"):
                                attempt()
                    self.assertIsNone(queue._worker)
                    processor.process.assert_not_called()
                    operation.assert_not_called()
                    self.assertFalse(queue.state()["accepting"])
                    self.assertEqual(self.snapshot(), before)

    def test_retry_requires_both_available_settings_and_available_observation(self):
        metadata = public_window_provenance(self.now)
        for legacy_settings in (True, False):
            with self.subTest(legacy_settings=legacy_settings):
                if legacy_settings:
                    seed_legacy_capture_settings(self.db, active=True)
                    event = seed_historical_observation(self.db, self.now,
                        source_kind="public_window", provenance=metadata)
                else:
                    self.store.configure(self.settings(**metadata))
                    self.store.start()
                    event = seed_historical_observation(self.db, self.now)
                before, processor = self.snapshot(), Mock()
                queue = ObservationQueue(self.store, processor)
                self.addCleanup(queue.close)
                with patch.object(self.store, "owned_evidence_fingerprint", side_effect=AssertionError("must not open image")):
                    self.assertEqual(queue.submit(event, retry=True),
                                     {"accepted": False, "reason": "full_desktop_unavailable"})
                processor.process.assert_not_called()
                self.assertIsNone(queue._worker)
                self.assertEqual(self.snapshot(), before)

    def test_legacy_processing_snapshot_is_blocked_before_evidence_access(self):
        seed_legacy_capture_settings(self.db, active=True)
        event = seed_historical_observation(self.db, self.now, state="recorded_pending")
        before = self.snapshot()
        original = self.store.list_records()[0]
        with patch.object(self.store, "owned_evidence_fingerprint", side_effect=AssertionError("must not open image")):
            for attempt in (lambda: self.store.processing_snapshot(event, self.png),
                            lambda: self.store.verify_processing_snapshot(original)):
                with self.assertRaisesRegex(PermissionError, "^full_desktop_unavailable$"):
                    attempt()
        self.assertEqual(self.snapshot(), before)

    def test_existing_full_screen_history_and_evidence_remain_unchanged(self):
        seed_legacy_capture_settings(self.db, active=True)
        event, evidence = str(uuid4()), str(uuid4())
        with self.db() as conn:
            conn.execute("""INSERT INTO context_observations
                (id,captured_at,display_id,image_digest,evidence_id,expires_at,state,title,summary,boundary)
                VALUES(?,?,?,?,?,?,'ready','Legacy synthetic title','Legacy synthetic summary','Historic evidence')""",
                (event, self.now.isoformat(), "synthetic_display", sha256(self.png).hexdigest(), evidence,
                 (self.now + timedelta(days=1)).isoformat()))
        self.store._media.mkdir(parents=True)
        (self.store._media / f"{evidence}.png").write_bytes(self.png)
        before, records = self.snapshot(), self.store.list_records()
        for operation in (self.store.start, lambda: self.store.configure(self.settings()),
                          lambda: self.store.ingest(self.frame())):
            with self.assertRaisesRegex(PermissionError, "^full_desktop_unavailable$"):
                operation()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.store.list_records(), records)
        self.assertEqual(records[0]["source_kind"], "full_screen")
        self.assertEqual(self.store.evidence(evidence), self.png)
        self.assertEqual(self.store.state()["record_count"], 1)


if __name__ == "__main__":
    unittest.main()
