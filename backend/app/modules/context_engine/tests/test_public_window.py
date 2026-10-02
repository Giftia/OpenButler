"""Synthetic window-only provenance, cancellation and temporal-context regressions."""
import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Event, Thread
import unittest
from uuid import uuid4
from unittest.mock import patch

from PIL import Image
from pydantic import ValidationError

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.context_engine.capture import CaptureSettings, CaptureStore, MaskedObservation, init_capture_store
from app.modules.context_engine.processor import ObservationProcessor, MAX_PROMPT_CHARS
from app.modules.context_engine.daily_review import DailyReviewService, DailyReviewRequest
from app.modules.model_gateway.gateway import CallAuthorization


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Gateway:
    def __init__(self):
        self.calls = []
        self.configuration_revision = 1
        self.on_image = self.on_text = None
        self.response = '{"title":"公开文档观察","summary":"窗口显示公开测试文档。","boundary":"离散观察","comparison":{"performed":false,"prior_observation_ids":[],"current_quote":"","prior_quote":""}}'

    def status(self):
        return type("Status", (), {"ready": True})()

    def call_image(self, prompt, image, auth, **options):
        options["dispatch_precondition"]()
        self.calls.append(("image", prompt))
        if self.on_image:
            self.on_image()
        return "画面显示公开测试文档。"

    def call_text(self, prompt, auth, **options):
        options["dispatch_precondition"]()
        self.calls.append(("text", prompt))
        if self.on_text:
            self.on_text()
        if "relations" in options.get("json_schema", {}).get("properties", {}):
            data = json.loads(prompt.split("\n", 1)[1])
            return json.dumps({"relations": [{"prior_observation_id": row["observation_id"],
                "relation": "uncertain", "current_quote": data["current"]["title"], "prior_quote": row["title"]}
                for row in data["prior_records"]]})
        return self.response


class PublicWindowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = lambda: sqlite3.connect(self.root / "owned.sqlite3", factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            init_capture_store(conn)
        self.now = datetime(2026, 10, 2, 10, tzinfo=timezone.utc)
        self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        self.metadata = {
            "source_kind": "public_window", "capture_scope": "dedicated_public_window",
            "session_id": str(uuid4()), "source_revision": "a" * 64,
            "source_identity": {"window_id": "x11:100", "owner_pid": 123, "owner_process_start": "999",
                "owner_process_name": "mousepad", "wm_class": "Mousepad", "window_title": "Public test",
                "content_bounds": {"x": 0, "y": 0, "width": 40, "height": 20}},
            "session_expires_at": (self.now + timedelta(minutes=30)).isoformat(),
            "lock_state": "unknown", "lock_protection_supported": False,
            "capture_method": "xcomposite_named_window_pixmap", "sampling_interval_ms": 60000,
        }
        self.configure()
        self.auth = CallAuthorization(privacy_mode="strict", authorized=True, redacted=True)
        self.gateway = Gateway()
        self.processor = ObservationProcessor(self.store, self.gateway, lambda: self.auth)
        self.sequence = 0

    def configure(self, **changes):
        self.metadata.update(changes)
        result = self.store.configure(CaptureSettings(display_id="x11:100", excluded_apps=["password-manager"],
            confirmed=True, **self.metadata))
        self.revision = result["consent_revision"]
        self.store.start()

    @staticmethod
    def png(color=1):
        stream = BytesIO()
        Image.new("RGB", (40, 20), (color % 255, 0, 0)).save(stream, format="PNG")
        return stream.getvalue()

    def frame(self, **changes):
        self.sequence += 1
        image = self.png(self.sequence)
        values = {**self.metadata, "display_id": "x11:100", "captured_at": self.now,
            "masked_png_base64": base64.b64encode(image).decode(), "local_ocr_complete": True,
            "masks_applied": True, "consent_revision": self.revision,
            "source_verified_before": True, "source_verified_after": True,
            "sampling_sequence": self.sequence, "sampling_gap_ms": 0}
        values.update(changes)
        return MaskedObservation(**values), image

    def ingest(self):
        frame, image = self.frame()
        return self.store.ingest(frame)["id"], image

    def ready(self):
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        self.now += timedelta(seconds=61)
        return event

    def test_record_provenance_evidence_and_recorded_time_are_truthful(self):
        frame, image = self.frame(captured_at=self.now - timedelta(seconds=2), sampling_gap_ms=1234)
        event = self.store.ingest(frame)
        self.assertTrue(self.processor.process(event["id"], image))
        row = self.store.list_records()[0]
        self.assertEqual(row["source_kind"], "public_window")
        self.assertEqual(row["source_label"], "专用公开窗口")
        self.assertEqual(row["recorded_at"], self.now.isoformat())
        self.assertNotEqual(row["recorded_at"], row["captured_at"])
        self.assertEqual(row["provenance"]["sampling_gap_ms"], 1234)
        self.assertFalse(row["provenance"]["lock_protection_supported"])
        self.assertEqual(row["provenance"]["lock_state"], "unknown")
        self.assertEqual(row["evidence_kind"], "privacy_masked_captured_pixels")
        self.assertEqual(self.store.evidence(row["evidence_id"]), image)
        self.assertTrue(row["temporal_context"]["inference"])
        self.assertIn("不覆盖每次点击", row["boundary"])

    def test_malformed_identity_or_unverified_or_manual_source_rejected(self):
        for changes in ({"source_verified_after": False}, {"source_verified_before": "true"},
                        {"source_kind": "manual_work_test"}, {"sampling_sequence": True},
                        {"lock_state": "unlocked"}, {"lock_protection_supported": True},
                        {"source_identity": {**self.metadata["source_identity"], "owner_pid": "123"}},
                        {"source_identity": {**self.metadata["source_identity"], "window_title": "x\ny"}}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.frame(**changes)

    def test_extra_raw_ocr_is_not_accepted_or_persisted(self):
        with self.assertRaises(ValidationError):
            self.frame(local_ocr_text="Raw or incorrectly filtered text")
        self.ready()
        self.assertNotIn("ocr_text", json.dumps(self.store.list_records()))

    def test_pixels_must_match_selected_window_dimensions(self):
        stream = BytesIO()
        Image.new("RGB", (80, 40), "black").save(stream, format="PNG")
        frame, _ = self.frame(masked_png_base64=base64.b64encode(stream.getvalue()).decode())
        with self.assertRaisesRegex(ValueError, "public_window_frame_dimensions_mismatch"):
            self.store.ingest(frame)
        self.assertEqual(self.store.list_records(), [])

    def test_wrong_consent_revision_or_identity_never_records(self):
        for changes in ({"consent_revision": str(uuid4())}, {"source_revision": "b" * 64},
                        {"session_id": str(uuid4())}, {"source_identity": {
                            **self.metadata["source_identity"], "owner_process_start": "1000"}}):
            frame, _ = self.frame(**changes)
            with self.assertRaises(PermissionError):
                self.store.ingest(frame)
        self.assertEqual(self.store.list_records(), [])

    def test_out_of_order_late_and_duplicate_frame_cannot_roll_back_highwater(self):
        frame1, _ = self.frame()
        self.store.ingest(frame1)
        self.now += timedelta(seconds=61)
        frame2, _ = self.frame(masked_png_base64=frame1.masked_png_base64)
        self.assertTrue(self.store.ingest(frame2)["duplicate"])
        frame3, _ = self.frame(captured_at=self.now - timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "late_public_window_frame"):
            self.store.ingest(frame3)
        frame4, _ = self.frame(captured_at=self.now + timedelta(seconds=1), sampling_sequence=2)
        with self.assertRaisesRegex(ValueError, "late_public_window_frame"):
            self.store.ingest(frame4)

    def test_pause_revoke_reconfigure_prevents_pending_processing(self):
        for action in (self.store.pause, self.store.revoke, lambda: self.configure(source_revision="b" * 64)):
            self.configure(source_revision="a" * 64)
            event, image = self.ingest()
            action()
            self.assertFalse(self.processor.process(event, image))
        self.assertEqual(self.gateway.calls, [])
        self.assertTrue(all(row["title"] is None for row in self.store.list_records()))

    def test_stop_revoke_source_change_during_image_or_text_discards_output(self):
        for hook in ("on_image", "on_text"):
            for action in (self.store.pause, self.store.revoke, lambda: self.configure(source_revision="b" * 64)):
                self.configure(source_revision="a" * 64)
                event, image = self.ingest()
                setattr(self.gateway, hook, action)
                self.assertFalse(self.processor.process(event, image))
                setattr(self.gateway, hook, None)
                row = next(row for row in self.store.list_records() if row["id"] == event)
                self.assertEqual(row["state"], "model_unavailable")
                self.assertIsNone(row["title"])
                self.assertIsNone(row["summary"])

    def test_changed_current_evidence_during_model_cannot_publish(self):
        event, image = self.ingest()
        evidence = self.store.list_records()[0]["evidence_id"]
        self.gateway.on_image = lambda: (self.store._media / f"{evidence}.png").write_bytes(self.png(222))
        self.assertFalse(self.processor.process(event, image))
        self.assertEqual([call[0] for call in self.gateway.calls], ["image"])
        self.assertIsNone(self.store.list_records()[0]["summary"])

    def test_image_argument_must_match_owned_evidence_digest(self):
        event, image = self.ingest()
        self.assertFalse(self.processor.process(event, self.png(55)))
        self.assertEqual(self.gateway.calls, [])

    def test_temporal_context_bounded_to_three_current_source_records(self):
        old = self.ready()
        self.configure(source_revision="b" * 64, session_id=str(uuid4()))
        ids = [self.ready() for _ in range(5)]
        row = self.store.list_records()[0]
        self.assertEqual(row["temporal_context"]["prior_observation_ids"], ids[-4:-1])
        text = [call[1] for call in self.gateway.calls if call[0] == "text"][-1]
        self.assertLessEqual(len(text), MAX_PROMPT_CHARS)
        self.assertNotIn(old, text)
        self.assertNotIn(ids[0], text)
        self.assertEqual(len(json.loads(text.split("\n", 1)[1])["prior_records"]), 3)

    def test_invalid_prior_text_is_not_sent_to_model(self):
        previous = self.ready()
        with self.db() as conn:
            conn.execute("UPDATE context_observations SET summary=? WHERE id=?", ("<think>private</think>", previous))
        self.ready()
        self.assertNotIn("private", [call[1] for call in self.gateway.calls if call[0] == "text"][-1])
        self.assertEqual(self.store.list_records()[0]["temporal_context"]["prior_observation_ids"], [])

    def test_prior_mutation_during_current_extraction_does_not_discard_current(self):
        for mutation in ("delete", "text", "media"):
            self.configure(session_id=str(uuid4()))
            previous = self.ready()
            event, image = self.ingest()
            def change():
                if mutation == "delete":
                    self.store.delete_owned(previous)
                elif mutation == "text":
                    with self.db() as conn:
                        conn.execute("UPDATE context_observations SET summary='changed' WHERE id=?", (previous,))
                else:
                    row = next(row for row in self.store.list_records() if row["id"] == previous)
                    (self.store._media / f"{row['evidence_id']}.png").write_bytes(self.png(222))
            self.gateway.on_image = change
            self.assertTrue(self.processor.process(event, image))
            self.gateway.on_image = None
            row = next(row for row in self.store.list_records() if row["id"] == event)
            self.assertEqual(row["current_facts"]["input_scope"], "current_observation_only")
            self.assertEqual(row["temporal_context"]["association_state"], "skipped")
            self.assertIsNotNone(row["summary"])

    def test_session_expiry_blocks_ingest_start_and_processing(self):
        event, image = self.ingest()
        self.now += timedelta(minutes=31)
        frame, _ = self.frame()
        with self.assertRaises(PermissionError):
            self.store.ingest(frame)
        with self.assertRaises(PermissionError):
            self.store.start()
        self.assertFalse(self.processor.process(event, image))
        self.assertEqual(self.gateway.calls, [])

    def test_configure_expiry_bounded_to_one_hour(self):
        with self.assertRaises(ValueError):
            self.configure(session_expires_at=(self.now + timedelta(hours=2)).isoformat())

    def test_pause_intent_during_png_validation_prevents_persistence(self):
        frame, _ = self.frame()
        entered, release = Event(), Event()
        original = self.store._validate_png
        errors = []
        def blocked(encoded):
            entered.set()
            release.wait(3)
            return original(encoded)
        def run():
            try:
                self.store.ingest(frame)
            except Exception as error:
                errors.append(error)
        with patch.object(self.store, "_validate_png", blocked):
            process = Thread(target=run)
            process.start()
            self.assertTrue(entered.wait(3))
            stop = Thread(target=self.store.pause)
            stop.start()
            # Wait for cancellation intent without relying on capture-lock completion.
            for _ in range(1000):
                if self.store._generation > 1:
                    break
                Event().wait(0.001)
            release.set()
            process.join(3)
            stop.join(3)
        self.assertTrue(any(isinstance(error, PermissionError) for error in errors))
        self.assertEqual(self.store.list_records(), [])

    def test_dispatch_precondition_does_not_reverse_model_settings_lock_order(self):
        inside_dispatch = False
        class LockAwareGateway(Gateway):
            def call_image(self, prompt, image, auth, **options):
                nonlocal inside_dispatch
                inside_dispatch = True
                try:
                    return super().call_image(prompt, image, auth, **options)
                finally:
                    inside_dispatch = False
            def call_text(self, prompt, auth, **options):
                nonlocal inside_dispatch
                inside_dispatch = True
                try:
                    return super().call_text(prompt, auth, **options)
                finally:
                    inside_dispatch = False
        def authorization():
            self.assertFalse(inside_dispatch, "model state lock acquired under dispatch policy lock")
            return self.auth
        event, image = self.ingest()
        processor = ObservationProcessor(self.store, LockAwareGateway(), authorization)
        self.assertTrue(processor.process(event, image))

    def test_duplicate_or_invalid_model_json_does_not_publish(self):
        event, image = self.ingest()
        self.gateway.response = '{"title":"x","title":"y","summary":"z","boundary":"q"}'
        self.assertFalse(self.processor.process(event, image))
        self.assertIsNone(self.store.list_records()[0]["title"])

    def test_daily_review_uses_current_public_source_with_typed_provenance(self):
        self.ready()
        self.configure(session_id=str(uuid4()), source_revision="b" * 64)
        expected = self.ready()
        class ReviewGateway:
            configuration_revision = 1
            def status(self): return type("Status", (), {"ready": True})()
            def call_text(self, prompt, auth, **kwargs):
                kwargs["dispatch_precondition"]()
                data = json.loads(prompt.split("\n", 1)[1])
                assert len(data["records"]) == 1
                assert data["records"][0]["source_kind"] == "public_window"
                return json.dumps({"conclusions": [{"text": "本次公开窗口的离散采样。", "observation_ids": [expected]}]})
        service = DailyReviewService(self.store, ReviewGateway(), lambda: self.auth, lambda: self.now)
        result = service.generate(DailyReviewRequest(day="2026-10-02", timezone="UTC", confirmed=True))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["counts"]["outside_scope"], 1)
        self.assertEqual(result["counts"]["total"], 1)
        self.assertEqual(result["coverage"]["observation_count"], 1)
        self.assertEqual(result["coverage"]["observed_start"], self.store.list_records()[0]["captured_at"])
        ref = result["conclusions"][0]["evidence_refs"][0]
        self.assertEqual(ref["source_kind"], "public_window")
        self.assertEqual(ref["evidence_kind"], "privacy_masked_captured_pixels")
        self.assertEqual(result["coverage"]["sources"][0]["coverage"], "discrete_samples_only")


if __name__ == "__main__":
    unittest.main()
