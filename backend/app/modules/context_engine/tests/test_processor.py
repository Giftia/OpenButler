import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
from threading import Event, Thread
import unittest

from PIL import Image

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.context_engine.capture import CaptureSettings, CaptureStore, MaskedObservation, init_capture_store
from app.modules.context_engine.processor import ObservationProcessor
from app.modules.model_gateway.gateway import CallAuthorization, RouteStatus


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class FakeGateway:
    def __init__(self, *, ready=True, text='{"title":"工作记录","summary":"画面显示正在编辑文档。","boundary":"只能说明截图时刻。"}'):
        self.ready = ready
        self.text = text
        self.calls = []

    def status(self):
        return type("Status", (), {"ready": self.ready})()

    def call_image(self, prompt, image, auth):
        self.calls.append(("image", image, auth))
        return "画面显示正在编辑文档。"

    def call_text(self, prompt, auth):
        self.calls.append(("text", prompt, auth))
        return self.text


class ProcessorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = lambda: sqlite3.connect(self.root / "owned.sqlite3", factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            init_capture_store(conn)
        self.now = datetime(2026, 9, 23, tzinfo=timezone.utc)
        self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        self.store.configure(CaptureSettings(display_id="display_1", excluded_apps=["password-manager"], confirmed=True))
        self.store.start()
        output = BytesIO()
        Image.new("RGB", (32, 20), "black").save(output, format="PNG")
        self.image = output.getvalue()
        event = self.store.ingest(MaskedObservation(
            display_id="display_1", captured_at=self.now,
            masked_png_base64=base64.b64encode(self.image).decode(),
            local_ocr_complete=True, masks_applied=True))
        self.event_id = event["id"]

    def test_complete_result_uses_only_masked_image(self):
        gateway = FakeGateway()
        processor = ObservationProcessor(self.store, gateway, lambda: CallAuthorization(
            privacy_mode="strict", authorized=True, redacted=True))
        self.assertTrue(processor.process(self.event_id, self.image))
        self.assertEqual(self.store.list_records()[0]["state"], "ready")
        self.assertEqual(gateway.calls[0][1], self.image)
        self.assertEqual([call[0] for call in gateway.calls], ["image", "text"])

    def test_unready_or_unapproved_model_preserves_record_without_call(self):
        gateway = FakeGateway(ready=False)
        processor = ObservationProcessor(self.store, gateway, lambda: CallAuthorization(authorized=False))
        self.assertFalse(processor.process(self.event_id, self.image))
        self.assertEqual(gateway.calls, [])
        record = self.store.list_records()[0]
        self.assertEqual(record["state"], "model_unavailable")
        self.assertIsNone(record["title"])

    def test_invalid_model_result_cannot_be_reported_ready(self):
        gateway = FakeGateway(text='{"title":"<think>secret</think>","summary":"x","boundary":"y"}')
        processor = ObservationProcessor(self.store, gateway, lambda: CallAuthorization(
            privacy_mode="strict", authorized=True, redacted=True))
        self.assertFalse(processor.process(self.event_id, self.image))
        self.assertEqual(self.store.list_records()[0]["state"], "model_unavailable")

    def test_failed_record_can_retry_only_with_unexpired_evidence(self):
        self.store.set_result(self.event_id, state="model_unavailable")
        image = self.store.prepare_retry(self.event_id)
        self.assertEqual(image, self.image)
        self.assertIsNone(self.store.prepare_retry(self.event_id))
        gateway = FakeGateway()
        processor = ObservationProcessor(self.store, gateway, lambda: CallAuthorization(
            privacy_mode="strict", authorized=True, redacted=True))
        self.assertTrue(processor.process(self.event_id, image))
        self.assertEqual(self.store.list_records()[0]["state"], "ready")

    def test_revoke_waits_for_inflight_request_and_prevents_next_route(self):
        entered = Event()
        release = Event()
        revoked = Event()

        class BlockingGateway(FakeGateway):
            def call_image(self, prompt, image, auth):
                self.calls.append(("image", image, auth))
                entered.set()
                if not release.wait(3):
                    raise TimeoutError("synthetic request did not finish")
                return "画面显示正在编辑文档。"

        gateway = BlockingGateway()
        processor = ObservationProcessor(self.store, gateway, lambda: CallAuthorization(
            privacy_mode="strict", authorized=True, redacted=True))
        process_thread = Thread(target=lambda: processor.process(self.event_id, self.image))
        revoke_thread = Thread(target=lambda: (self.store.revoke(), revoked.set()))
        process_thread.start()
        self.assertTrue(entered.wait(3))
        revoke_thread.start()
        try:
            self.assertFalse(revoked.wait(0.05))
        finally:
            release.set()
            process_thread.join(3)
            revoke_thread.join(3)
        self.assertFalse(process_thread.is_alive())
        self.assertFalse(revoke_thread.is_alive())
        self.assertTrue(revoked.is_set())
        self.assertEqual([call[0] for call in gateway.calls], ["image"])

    def test_synthetic_thirty_minute_recording_has_only_observed_results(self):
        gateway = FakeGateway()
        processor = ObservationProcessor(self.store, gateway, lambda: CallAuthorization(
            privacy_mode="strict", authorized=True, redacted=True))
        self.assertTrue(processor.process(self.event_id, self.image))
        for minute in range(1, 31):
            self.now += timedelta(minutes=1)
            output = BytesIO()
            Image.new("RGB", (32, 20), (minute, 0, 0)).save(output, format="PNG")
            frame = output.getvalue()
            event = self.store.ingest(MaskedObservation(
                display_id="display_1", captured_at=self.now,
                masked_png_base64=base64.b64encode(frame).decode(),
                local_ocr_complete=True, masks_applied=True))
            self.assertTrue(event["recorded"])
            self.assertTrue(processor.process(event["id"], frame))
        records = self.store.list_records()
        self.assertEqual(len(records), 31)
        self.assertTrue(all(item["state"] == "ready" and item["evidence_id"] for item in records))
        self.assertEqual(datetime.fromisoformat(records[0]["captured_at"]) -
                         datetime.fromisoformat(records[-1]["captured_at"]), timedelta(minutes=30))


if __name__ == "__main__":
    unittest.main()
