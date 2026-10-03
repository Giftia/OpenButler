"""Current-only extraction isolation and independent association, mocked models only."""
from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
from threading import Event, Thread
from uuid import uuid4
import unittest

from app.modules.context_engine.capture import CaptureStore, init_capture_store
from app.modules.context_engine.organization_queue import ObservationQueue
from app.modules.context_engine.processor import ObservationProcessor
from app.modules.context_engine.tests import test_public_window as window
from app.modules.model_gateway.gateway import OBSERVATION_NO_PRIOR_JSON_SCHEMA, TEMPORAL_ASSOCIATION_JSON_SCHEMA, OCR_OBSERVATION_JSON_SCHEMA

GUITAR_OCR = "qwen35-evaluation. txt @\nguitar notes\nstandard tuning e a d g b e\n"
OLD_SUMMARY = "显示本地小模型评估界面，包含问题与来源信息，工作清单提及检查测量文本和图像结果，当前处于审查进行中状态。"
CURRENT_REPLY = json.dumps({"title": "吉他调弦笔记", "summary": "文档记载吉他标准调弦e a d g b e。", "boundary": "仅当前截图。",
    "source_quotes": ["guitar notes", "standard tuning e a d g b e"],
    "comparison": {"performed": False, "prior_observation_ids": [], "current_quote": "", "prior_quote": ""}}, ensure_ascii=False)


class CurrentIsolationTests(unittest.TestCase):
    configure = window.PublicWindowTests.configure
    png = staticmethod(window.PublicWindowTests.png)

    def setUp(self):
        window.PublicWindowTests.setUp(self)
        self.configure(observation_mode="masked_ocr_text")
        self.requests = []
        self.hook = None
        self.association_reply = None
        self.extract_reply = CURRENT_REPLY
        self.gateway.call_text = self.call_text

    def call_text(self, prompt, auth, **options):
        options["dispatch_precondition"]()
        schema = options["json_schema"]
        stage = "current" if schema in (OBSERVATION_NO_PRIOR_JSON_SCHEMA, OCR_OBSERVATION_JSON_SCHEMA) else "association"
        self.requests.append((stage, prompt, deepcopy(schema)))
        data = json.loads(prompt.split("\n", 1)[1])
        if self.hook:
            self.hook(stage, options)
        if stage == "current":
            self.assertEqual(set(data), {"current_observation"})
            return self.extract_reply
        self.assertEqual(schema, TEMPORAL_ASSOCIATION_JSON_SCHEMA)
        if self.association_reply is not None:
            return self.association_reply
        return json.dumps({"relations": [{"prior_observation_id": row["observation_id"],
            "relation": "uncertain", "current_quote": data["current"]["source_quotes"][0], "prior_quote": row["source_quotes"][0]}
            for row in data["prior_records"]]}, ensure_ascii=False)

    def ingest(self, text=GUITAR_OCR):
        image = self.png(self.sequence + 1)
        frame, image = window.PublicWindowTests.frame(self, post_mask_ocr_complete=True,
            post_mask_ocr_text=text, post_mask_ocr_image_digest=sha256(image).hexdigest(), post_mask_ocr_engine="tesseract.js")
        event = self.store.ingest(frame)["id"]
        self.now += timedelta(seconds=1)
        return event, image

    def seed_prior(self, summary=OLD_SUMMARY):
        event, image = self.ingest("Public historical note")
        snapshot = self.store.processing_snapshot(event, image)
        grounding = ObservationProcessor.source_grounding(snapshot, ["Public historical note"], ["旧Qwen评估", summary])
        facts = {"version": 2, "inference": True, "input_scope": "current_observation_only",
            "observation_id": event, "evidence_id": snapshot["evidence_id"], "image_digest": snapshot["image_digest"],
            "captured_at": snapshot["captured_at"], "observation_route": snapshot["observation_route"],
            "title": "文档 OCR 摘录", "summary": "屏幕文档 OCR 文字：“Public historical note”。", "boundary": "历史未验证观察。",
            "source_grounding": grounding}
        self.store.set_result(event, state="ready", title=facts["title"], summary=facts["summary"],
            boundary=facts["boundary"], current_facts=facts, temporal_context={"association_state": "skipped"})
        return event

    def row(self, event):
        return next(row for row in self.store.list_records() if row["id"] == event)

    def test_same_guitar_input_has_identical_extraction_for_varying_history(self):
        current_requests, extracted = [], []
        for history in (None, OLD_SUMMARY, "文档记载另一个完全不同的历史主题。"):
            self.configure(session_id=str(uuid4()), observation_mode="masked_ocr_text")
            if history:
                self.seed_prior(history)
            event, image = self.ingest()
            before = len(self.requests)
            self.assertTrue(self.processor.process(event, image))
            calls = self.requests[before:]
            self.assertEqual(calls[0][0], "current")
            self.assertNotIn(OLD_SUMMARY, calls[0][1])
            self.assertNotIn("prior_records", json.loads(calls[0][1].split("\n", 1)[1]))
            current_requests.append(json.dumps(calls[0][1:], ensure_ascii=False, sort_keys=True))
            row = self.row(event)
            facts = row["current_facts"]
            self.assertEqual(row["extraction_version"], 2)
            self.assertEqual(facts["input_scope"], "current_observation_only")
            self.assertTrue(facts["inference"])
            self.assertEqual((facts["observation_id"], facts["evidence_id"], facts["image_digest"]),
                             (event, row["evidence_id"], sha256(image).hexdigest()))
            self.assertNotIn("先前观察", facts["boundary"])
            extracted.append((facts["title"], facts["summary"]))
            self.assertEqual([item[0] for item in calls], ["current", "association"] if history else ["current"])
        self.assertEqual(len(set(current_requests)), 1)
        self.assertEqual(len(set(extracted)), 1)

    def test_association_overwrite_attempts_fail_without_mutating_current(self):
        for payload in ({"title": "历史污染", "relations": []}, {"summary": OLD_SUMMARY, "relations": []},
                        {"current_facts": {"summary": OLD_SUMMARY}, "relations": []}, {"relations": [{"title": "污染"}]}):
            self.configure(session_id=str(uuid4()), observation_mode="masked_ocr_text")
            self.seed_prior()
            self.association_reply = json.dumps(payload, ensure_ascii=False)
            event, image = self.ingest()
            self.assertTrue(self.processor.process(event, image))  # current extraction still succeeded
            row = self.row(event)
            self.assertEqual(row["state"], "ready")
            self.assertEqual(row["current_facts"]["summary"], "屏幕文档 OCR 文字：“guitar notes”；“standard tuning e a d g b e”。")
            self.assertEqual(row["summary"], row["current_facts"]["summary"])
            self.assertEqual(row["temporal_context"]["association_state"], "failed")
            self.assertEqual(row["temporal_context"]["association_reason"], "invalid_association_result")
            self.assertEqual(row["temporal_context"]["relations"], [])
            self.assertEqual(self.store.evidence(row["evidence_id"]), image)

    def test_no_history_skips_association_and_ready_cannot_be_reprocessed(self):
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual(row["temporal_context"]["association_state"], "skipped")
        self.assertEqual(row["temporal_context"]["association_reason"], "no_prior_records")
        before = len(self.requests)
        self.assertFalse(self.processor.process(event, image))
        self.assertEqual(len(self.requests), before)
        self.assertEqual(self.row(event)["current_facts"], row["current_facts"])

    def test_deleting_prior_during_current_call_does_not_cancel_extraction(self):
        prior = self.seed_prior()
        def hook(stage, options):
            if stage == "current":
                self.store.delete_owned(prior)
                self.assertFalse(options["cancel_event"].is_set())
        self.hook = hook
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        self.assertEqual([call[0] for call in self.requests], ["current"])
        self.assertEqual(self.row(event)["temporal_context"]["association_state"], "skipped")

    def test_both_stage_cancellation_and_deletion_never_publish_late_relations(self):
        for stage in ("current", "association"):
            for action in ("pause", "revoke", "reconfigure", "delete", "expire"):
                with self.subTest(stage=stage, action=action):
                    self.configure(session_id=str(uuid4()), observation_mode="masked_ocr_text",
                                   session_expires_at=(self.now + timedelta(minutes=30)).isoformat())
                    self.seed_prior()
                    event, image = self.ingest()
                    entered, release = Event(), Event()
                    outputs = []
                    def hook(actual, options):
                        if actual == stage:
                            entered.set()
                            if not release.wait(3):
                                raise TimeoutError("synthetic model wait")
                    self.hook = hook
                    worker = Thread(target=lambda: outputs.append(self.processor.process(event, image)))
                    worker.start()
                    self.assertTrue(entered.wait(1))
                    committed = deepcopy(self.row(event)["current_facts"])
                    try:
                        if action == "pause": self.store.pause()
                        elif action == "revoke": self.store.revoke()
                        elif action == "reconfigure": self.configure(session_id=str(uuid4()))
                        elif action == "delete": self.store.delete_owned(event)
                        else: self.now += timedelta(minutes=31)
                        self.assertTrue(self.store._processing_lease.is_set())
                    finally:
                        release.set(); worker.join(2)
                    self.assertFalse(worker.is_alive())
                    if action == "delete":
                        self.assertFalse(any(row["id"] == event for row in self.store.list_records()))
                        self.assertEqual(outputs, [False])
                    elif stage == "current":
                        self.assertIsNone(self.row(event)["current_facts"])
                        self.assertIsNone(self.row(event)["summary"])
                        self.assertEqual(outputs, [False])
                    else:
                        row = self.row(event)
                        self.assertEqual(row["current_facts"], committed)
                        self.assertEqual(row["state"], "ready")
                        self.assertEqual(row["temporal_context"]["association_state"], "failed")
                        self.assertEqual(row["temporal_context"]["relations"], [])
                        self.assertEqual(outputs, [True])
                    self.hook = None

    def test_pause_between_committed_extraction_and_association_prevents_second_call(self):
        self.seed_prior()
        original = self.store.temporal_records
        def pause_before_association(snapshot):
            self.store.pause()
            return original(snapshot)
        self.store.temporal_records = pause_before_association
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual([call[0] for call in self.requests], ["current"])
        self.assertEqual(row["state"], "ready")
        self.assertIsNotNone(row["current_facts"])
        self.assertEqual(row["temporal_context"]["association_state"], "failed")
        self.assertEqual(row["temporal_context"]["association_reason"], "capture_paused")

    def test_deleted_prior_during_association_keeps_current_facts_only(self):
        previous = self.seed_prior()
        def hook(stage, options):
            if stage == "association":
                self.store.delete_owned(previous)
                self.assertTrue(options["cancel_event"].is_set())
        self.hook = hook
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual(row["state"], "ready")
        self.assertEqual(row["temporal_context"]["association_state"], "failed")
        self.assertEqual(row["temporal_context"]["association_reason"], "evidence_changed")
        self.assertIsNotNone(row["current_facts"])

    def test_restart_interrupts_association_without_relabeling_or_replaying(self):
        legacy_id, _ = self.ingest("legacy source")
        self.store.set_result(legacy_id, state="ready", title="旧Qwen评估", summary=OLD_SUMMARY, boundary="未验证")
        legacy = deepcopy(self.row(legacy_id))
        previous = self.seed_prior()
        grounded = deepcopy(self.row(previous))
        def hook(stage, options):
            if stage == "association":
                with self.db() as conn:
                    init_capture_store(conn, reset_active=True)
        self.hook = hook
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual(row["state"], "ready")
        self.assertEqual(row["temporal_context"]["association_state"], "failed")
        self.assertEqual(row["temporal_context"]["association_reason"], "process_restarted")
        self.assertEqual(self.row(legacy_id), legacy)
        self.assertEqual(self.row(previous), grounded)
        self.assertEqual(legacy["extraction_version"], 1)
        self.assertIsNone(legacy["current_facts"])
        restarted = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        queue = ObservationQueue(restarted, ObservationProcessor(restarted, self.gateway, lambda: self.auth))
        self.addCleanup(queue.close)
        self.assertIsNone(queue._worker)
        self.assertFalse(queue.submit(event, retry=True)["accepted"])
        self.assertFalse(restarted.state()["active"])

    def test_failed_extraction_cannot_be_rescued_by_history(self):
        self.seed_prior()
        self.extract_reply = json.dumps({"title": "相较前帧", "summary": "与先前相比发生变化。", "boundary": "仅截图。",
            "source_quotes": ["guitar notes"], "comparison": {"performed": False, "prior_observation_ids": [], "current_quote": "", "prior_quote": ""}})
        event, image = self.ingest()
        self.assertFalse(self.processor.process(event, image))
        self.assertEqual([call[0] for call in self.requests], ["current"])
        self.assertIsNone(self.row(event)["current_facts"])
        self.assertEqual(self.row(event)["processing_reason"], "invalid_temporal_comparison")

    def test_exact_association_references_quotes_and_shape_are_enforced(self):
        facts = {"title": "吉他笔记", "summary": "标准调弦"}
        prior = [{"id": str(uuid4()), "title": "历史Qwen", "summary": "未验证的评估记载"}]
        valid = {"prior_observation_id": prior[0]["id"], "relation": "different_topic",
                 "current_quote": "吉他笔记", "prior_quote": "历史Qwen"}
        self.assertEqual(ObservationProcessor.parse_association(json.dumps({"relations": [valid]}), facts=facts, prior=prior), [valid])
        for bad in ({**valid, "prior_observation_id": str(uuid4())}, {**valid, "current_quote": "不存在"},
                    {**valid, "prior_quote": "不存在"}, {**valid, "title": "覆盖当前"}, {**valid, "relation": "verified_action"}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "invalid_association_result"):
                ObservationProcessor.parse_association(json.dumps({"relations": [bad]}), facts=facts, prior=prior)
        for text in ("```json\n{}\n```", '{"relations":[],"relations":[]}', json.dumps({"relations": [valid, valid]})):
            with self.assertRaisesRegex(ValueError, "invalid_association_result"):
                ObservationProcessor.parse_association(text, facts=facts, prior=prior)
