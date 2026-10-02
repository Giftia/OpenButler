"""Post-mask OCR routing with synthetic pixels; no OCR/model/native calls here."""
from datetime import timedelta
from hashlib import sha256
import json
from pathlib import Path
from threading import Event, Thread
import unittest

from pydantic import ValidationError
from app.modules.context_engine.capture import CaptureSettings, MaskedObservation
from app.modules.context_engine.organization_queue import ObservationQueue
from app.modules.context_engine.processor import ObservationProcessor, MAX_PROMPT_BYTES, _TEMPORAL_CLAIM
from app.modules.context_engine.tests import test_public_window as window

PUBLIC_OCR = Path(__file__).with_name("fixtures").joinpath("public-window-post-mask-ocr.txt").read_text()


class MaskedOcrTests(unittest.TestCase):
    configure = window.PublicWindowTests.configure
    png = staticmethod(window.PublicWindowTests.png)
    ingest = window.PublicWindowTests.ingest

    def setUp(self):
        window.PublicWindowTests.setUp(self)
        self.configure(observation_mode="masked_ocr_text")

    def frame(self, **changes):
        image = self.png(self.sequence + 1)
        values = {"post_mask_ocr_complete": True, "post_mask_ocr_text": PUBLIC_OCR,
                  "post_mask_ocr_image_digest": sha256(image).hexdigest(), "post_mask_ocr_engine": "tesseract.js"}
        values.update(changes)
        return window.PublicWindowTests.frame(self, **values)

    def test_text_route_uses_exact_owned_postmask_text_and_preserves_image(self):
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        self.assertEqual([call[0] for call in self.gateway.calls], ["text"])
        prompt = self.gateway.calls[0][1]
        data = json.loads(prompt.split("\n", 1)[1])
        self.assertEqual(data["current_observation"], PUBLIC_OCR)
        self.assertEqual(len(PUBLIC_OCR), 424)
        self.assertLessEqual(len(prompt.encode("utf-8")), MAX_PROMPT_BYTES)
        row = self.store.list_records()[0]
        self.assertEqual(row["observation_mode"], "masked_ocr_text")
        self.assertEqual(row["observation_route"], "post_mask_ocr_to_text_model")
        self.assertEqual(row["evidence_kind"], "privacy_masked_captured_pixels")
        self.assertEqual(row["ocr_provenance"], {"engine": "tesseract.js", "stage": "post_mask",
            "image_digest": sha256(image).hexdigest(), "layout": "text_only_no_layout_guarantee"})
        self.assertEqual(self.store.evidence(row["evidence_id"]), image)
        self.assertNotIn("post_mask_ocr_text", row)
        self.assertNotIn(PUBLIC_OCR, json.dumps(row))
        self.assertIn("OCR可能缺漏或错序", row["boundary"])
        review = self.store.review_records(self.now - timedelta(seconds=1), self.now + timedelta(seconds=1))
        self.assertNotIn("post_mask_ocr_text", review[0])
        self.assertEqual(review[0]["ocr_provenance"], row["ocr_provenance"])

    def test_authorized_text_only_gateway_does_not_require_image_route(self):
        from app.modules.model_gateway.gateway import Gateway, ModelRoute
        from app.security.privacy_guard import PrivacyGuard
        payloads = []
        content = self.gateway.response
        class TextTransport:
            def post(self, route, payload, *, cancel_event=None):
                payloads.append(payload)
                return {"done": True, "done_reason": "stop", "message": {"role": "assistant", "content": content}}
        gateway = Gateway(PrivacyGuard(), TextTransport())
        route = ModelRoute("ollama_native", "local", "http://127.0.0.1:11434", "synthetic-text")
        gateway._configuration = (1, {"text": route})
        self.assertFalse(gateway.status().ready)
        self.processor.gateway = gateway
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        self.assertEqual(len(payloads), 1)
        self.assertNotIn("images", payloads[0]["messages"][0])
        self.assertEqual(self.store.list_records()[0]["observation_route"], "post_mask_ocr_to_text_model")

    def test_digest_must_match_exact_masked_png(self):
        frame, _ = self.frame(post_mask_ocr_image_digest="b" * 64)
        with self.assertRaisesRegex(ValueError, "post_mask_ocr_evidence_mismatch"):
            self.store.ingest(frame)
        self.assertEqual(self.store.list_records(), [])
        self.assertEqual(self.gateway.calls, [])

    def test_missing_incomplete_empty_or_oversized_text_fails_without_fallback(self):
        for changes in ({"post_mask_ocr_complete": False}, {"post_mask_ocr_complete": "true"},
                        {"post_mask_ocr_text": None}, {"post_mask_ocr_text": " \n"},
                        {"post_mask_ocr_text": "x" * 2001}, {"post_mask_ocr_text": "🦉" * 1600},
                        {"post_mask_ocr_text": "x\x00y"}, {"post_mask_ocr_engine": None},
                        {"post_mask_ocr_engine": "native-cli"}, {"post_mask_ocr_image_digest": None}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.frame(**changes)
        self.assertEqual(self.gateway.calls, [])

    def test_mode_requires_explicit_public_window_scope_and_consent_match(self):
        with self.assertRaises(ValidationError):
            CaptureSettings(display_id="full_screen", observation_mode="masked_ocr_text",
                            excluded_apps=["password-manager"], confirmed=True)
        self.configure(observation_mode="vision")
        frame, _ = self.frame(observation_mode="masked_ocr_text")
        with self.assertRaises(PermissionError):
            self.store.ingest(frame)
        with self.assertRaises(ValidationError):
            self.frame(observation_mode="vision")

    def test_prompt_overflow_is_persisted_failure_without_model_or_truncation(self):
        frame, image = self.frame(post_mask_ocr_text="字" * 600)
        event = self.store.ingest(frame)["id"]
        self.assertFalse(self.processor.process(event, image))
        row = self.store.list_records()[0]
        self.assertEqual(row["processing_reason"], "prompt_limit_exceeded")
        self.assertTrue(row["evidence_available"])
        self.assertEqual(self.gateway.calls, [])
        with self.db() as conn:
            self.assertEqual(conn.execute("SELECT post_mask_ocr_text FROM context_observations WHERE id=?",
                                          (event,)).fetchone()[0], "字" * 600)

    def test_ocr_fields_changed_in_flight_cannot_publish(self):
        for key, value in (("post_mask_ocr_text", "changed"), ("post_mask_ocr_image_digest", "c" * 64),
                           ("post_mask_ocr_engine", "changed")):
            with self.subTest(key=key):
                self.configure(observation_mode="masked_ocr_text")
                event, image = self.ingest()
                def change():
                    with self.db() as conn:
                        conn.execute(f"UPDATE context_observations SET {key}=? WHERE id=?", (value, event))
                self.gateway.on_text = change
                self.assertFalse(self.processor.process(event, image))
                self.assertIsNone(next(row for row in self.store.list_records() if row["id"] == event)["summary"])
                self.gateway.on_text = None

    def test_cancel_delete_expire_and_reconfigure_stop_ocr_publication(self):
        for action in (self.store.pause, self.store.revoke,
                       lambda: self.configure(observation_mode="vision"),
                       lambda: setattr(self, "now", self.now + timedelta(minutes=31))):
            with self.subTest(action=action):
                self.configure(observation_mode="masked_ocr_text", session_expires_at=(self.now + timedelta(minutes=30)).isoformat())
                event, image = self.ingest()
                self.gateway.on_text = action
                self.assertFalse(self.processor.process(event, image))
                self.assertIsNone(next(row for row in self.store.list_records() if row["id"] == event)["summary"])
                self.gateway.on_text = None
        self.assertTrue(all(kind == "text" for kind, _ in self.gateway.calls))

    def test_queue_handles_ocr_without_blocking_capture_or_dispatching_image(self):
        entered, release = Event(), Event()
        def block():
            entered.set()
            if not release.wait(3):
                raise TimeoutError("synthetic wait")
        self.gateway.on_text = block
        queue = ObservationQueue(self.store, self.processor, capacity=1)
        self.addCleanup(queue.close); self.addCleanup(release.set)
        event, _ = self.ingest()
        self.assertTrue(queue.submit(event)["accepted"])
        self.assertTrue(entered.wait(1))
        self.now += timedelta(seconds=1)
        next_event, _ = self.ingest()
        self.assertTrue(queue.submit(next_event)["accepted"])
        self.now += timedelta(seconds=1)
        overflow, _ = self.ingest()
        self.assertEqual(queue.submit(overflow)["reason"], "queue_full")
        self.store.delete_owned(event)
        self.assertTrue(self.store._processing_lease.is_set())
        release.set()
        self.assertTrue(queue.wait_idle())
        self.assertTrue(all(kind == "text" for kind, _ in self.gateway.calls))
        rows = {row["id"]: row for row in self.store.list_records()}
        self.assertNotIn(event, rows)
        self.assertEqual(rows[next_event]["state"], "ready")
        self.assertEqual(rows[overflow]["processing_reason"], "queue_full")
        self.assertEqual(rows[overflow]["observation_route"], "post_mask_ocr_to_text_model")


class TemporalLexicalRegressionTests(unittest.TestCase):
    def parse_summary(self, summary):
        return ObservationProcessor._parse(json.dumps({"title": "文档观察", "summary": summary,
            "boundary": "仅当前截图。", "comparison": {"performed": False, "prior_observation_ids": [],
                "current_quote": "", "prior_quote": ""}}, ensure_ascii=False), prior=[], description="文档记载测试清单。")

    def test_conjunction_does_not_match_current_as_previous(self):
        for text in ("文档记载为小本地模型评估清单，包含检查项与图像测试结果，当前处于审查阶段。",
                     "文档记载检查项与截图内容，当前显示测试清单。", "文档显示前端截图说明。"):
            with self.subTest(text=text):
                self.assertIsNone(_TEMPORAL_CLAIM.search(text))
                self.parse_summary(text)

    def test_positive_prior_claims_still_rejected_without_references(self):
        for text in ("与先前采样相比，可能增加一行。", "前一帧显示甲，这一帧显示乙。",
                     "与之前不同，窗口内容变化。", "上一张截图显示了另一段文字。", "相较前帧文本变化。"):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "invalid_temporal_comparison"):
                self.parse_summary(text)
