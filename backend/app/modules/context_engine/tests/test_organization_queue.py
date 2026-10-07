"""Only synthetic pixels and mocked models; no desktop, real service or model."""
from datetime import timedelta
import json
from threading import Event, Thread
import unittest

from app.modules.context_engine.tests import test_public_window as window
from app.modules.context_engine.capture import CaptureStore, init_capture_store
from app.modules.context_engine.organization_queue import ObservationQueue
from app.modules.context_engine.processor import ObservationProcessor, MAX_PROMPT_BYTES


class QueueTests(unittest.TestCase):
    configure = window.PublicWindowTests.configure
    png = staticmethod(window.PublicWindowTests.png)
    frame = window.PublicWindowTests.frame
    ingest = window.PublicWindowTests.ingest

    def setUp(self):
        window.PublicWindowTests.setUp(self)
        self.release, self.entered = Event(), Event()
        self.gateway.on_image = self.block_image
        self.queue = ObservationQueue(self.store, self.processor, capacity=2)
        self.addCleanup(self.queue.close)
        self.addCleanup(self.release.set)

    def block_image(self):
        self.entered.set()
        if not self.release.wait(3):
            raise TimeoutError("synthetic model wait expired")

    def submit_frame(self):
        event, image = self.ingest()
        self.now += timedelta(seconds=1)
        return event, self.queue.submit(event)

    def rows(self):
        return {row["id"]: row for row in self.store.list_records()}

    def test_capture_is_fast_while_model_waits_and_queue_is_bounded(self):
        first, result = self.submit_frame()
        self.assertTrue(result["accepted"])
        self.assertTrue(self.entered.wait(1))
        completed, results = Event(), []
        def capture_more():
            results.extend(self.submit_frame() for _ in range(3))
            completed.set()
        thread = Thread(target=capture_more)
        thread.start()
        self.assertTrue(completed.wait(1), "capture blocked behind model HTTP")
        thread.join(1)
        self.assertEqual([item[1]["reason"] for item in results], ["queued", "queued", "queue_full"])
        state = self.queue.state()
        self.assertEqual((state["capacity"], state["queued"], state["running"], state["backpressured"]), (2, 2, 1, 1))
        overflow = results[-1][0]
        self.assertEqual(self.rows()[overflow]["state"], "recorded_pending")
        self.assertTrue(self.rows()[overflow]["evidence_available"])
        self.release.set()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(self.rows()[first]["state"], "ready")
        self.assertEqual(self.rows()[overflow]["processing_reason"], "queue_full")
        self.assertEqual(len(self.gateway.calls), 8)  # extraction plus separate association; no overflow replay
        self.assertTrue(self.queue.submit(overflow, retry=True)["accepted"])
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(self.rows()[overflow]["state"], "ready")
        self.assertEqual(self.queue.state()["backpressured"], 0)

    def test_real_gateway_adapter_requests_schema_and_observation_profile(self):
        from app.modules.model_gateway.gateway import Gateway, ModelRoute, OBSERVATION_NO_PRIOR_JSON_SCHEMA
        from app.security.privacy_guard import PrivacyGuard
        payloads = []
        text = self.gateway.response
        class SyntheticTransport:
            def post(self, route, payload, *, cancel_event=None):
                payloads.append(payload)
                self_cancel = cancel_event
                assert self_cancel is not None and not self_cancel.is_set()
                is_image = bool(payload["messages"][0].get("images"))
                return {"done": True, "done_reason": "stop", "message": {
                    "role": "assistant", "content": "窗口显示测试文档。" if is_image else text}}
        gateway = Gateway(PrivacyGuard(), SyntheticTransport())
        route = ModelRoute("ollama_native", "local", "http://127.0.0.1:11434", "synthetic")
        gateway._configuration = (1, {"image": route, "text": route})
        self.processor.gateway = gateway
        event, _ = self.submit_frame()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(self.rows()[event]["state"], "ready")
        self.assertEqual(payloads[1]["format"], OBSERVATION_NO_PRIOR_JSON_SCHEMA)
        self.assertEqual([p["options"]["num_ctx"] for p in payloads], [2048, 2048])
        self.assertEqual([p["options"]["num_predict"] for p in payloads], [512, 768])

    def test_schema_selection_uses_actual_budgeted_prior_records(self):
        from app.modules.model_gateway.gateway import TEMPORAL_ASSOCIATION_JSON_SCHEMA, OBSERVATION_NO_PRIOR_JSON_SCHEMA
        schemas = []
        original_text = self.gateway.call_text
        def text_call(*args, **options):
            schemas.append(options["json_schema"])
            return original_text(*args, **options)
        self.gateway.call_text = text_call
        self.gateway.on_image = None
        first, _ = self.submit_frame()
        self.assertTrue(self.queue.wait_idle())
        second, _ = self.submit_frame()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(schemas, [OBSERVATION_NO_PRIOR_JSON_SCHEMA, OBSERVATION_NO_PRIOR_JSON_SCHEMA, TEMPORAL_ASSOCIATION_JSON_SCHEMA])
        self.assertEqual(self.rows()[second]["temporal_context"]["prior_observation_ids"], [first])

    def test_concurrent_daily_review_and_image_dispatch_do_not_invert_locks(self):
        from app.modules.context_engine.daily_review import DailyReviewService, DailyReviewRequest
        from app.modules.model_gateway.gateway import Gateway, ModelRoute
        from app.security.privacy_guard import PrivacyGuard
        self.gateway.on_image = None
        previous, image = self.ingest()
        self.assertTrue(self.processor.process(previous, image))
        self.now += timedelta(seconds=1)
        waiting, outputs = Event(), []
        entered, release = self.entered, self.release
        valid_observation = self.gateway.response
        class SyntheticTransport:
            def post(self, route, payload, *, cancel_event=None):
                if payload["messages"][0].get("images"):
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("synthetic model wait")
                    content = "窗口显示测试文档。"
                elif "format" in payload:
                    content = valid_observation
                else:
                    content = json.dumps({"conclusions": [{"text": "窗口显示测试文档。", "observation_ids": [previous]}]})
                return {"done": True, "done_reason": "stop", "message": {"role": "assistant", "content": content}}
        gateway = Gateway(PrivacyGuard(), SyntheticTransport())
        route = ModelRoute("ollama_native", "local", "http://127.0.0.1:11434", "synthetic")
        gateway._configuration = (1, {"image": route, "text": route})
        original_text = gateway.call_text
        def text_call(*args, **kwargs):
            waiting.set()
            return original_text(*args, **kwargs)
        gateway.call_text = text_call
        self.processor.gateway = gateway
        def authorization():
            self.assertFalse(self.store._lock._is_owned(), "authorization acquired under capture lock")
            return self.auth
        self.processor.authorization = authorization
        service = DailyReviewService(self.store, gateway, authorization, lambda: self.now)
        current, _ = self.submit_frame()
        self.assertTrue(entered.wait(1))
        thread = Thread(target=lambda: outputs.append(service.generate(DailyReviewRequest(
            day="2026-10-02", timezone="UTC", confirmed=True))))
        thread.start()
        try:
            self.assertTrue(waiting.wait(1))
            self.assertTrue(self.store._lock.acquire(timeout=.2), "review retained capture lock awaiting policy")
            self.store._lock.release()
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(outputs[0]["status"], "ready")
        self.assertEqual(self.rows()[current]["state"], "ready")

    def test_duplicate_submission_and_identical_capture_do_not_spawn_work(self):
        frame, _ = self.frame()
        event = self.store.ingest(frame)
        self.queue.submit(event["id"], generation=event["_generation"])
        self.assertTrue(self.entered.wait(1))
        self.assertEqual(self.queue.submit(event["id"])["reason"], "already_queued")
        self.now += timedelta(seconds=1)
        repeated, _ = self.frame(masked_png_base64=frame.masked_png_base64)
        self.assertTrue(self.store.ingest(repeated)["duplicate"])
        self.release.set()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(len(self.gateway.calls), 2)
        self.assertEqual(len(self.rows()), 1)

    def test_pause_returns_promptly_and_resume_does_not_replay(self):
        first, _ = self.submit_frame()
        self.assertTrue(self.entered.wait(1))
        second, _ = self.submit_frame()
        done = Event()
        thread = Thread(target=lambda: (self.store.pause(), done.set()))
        thread.start()
        self.assertTrue(done.wait(.5))
        self.store.start()
        self.release.set()
        thread.join(1)
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(len(self.gateway.calls), 1)
        self.assertTrue(all(self.rows()[key]["processing_reason"] == "capture_paused" for key in (first, second)))
        self.assertTrue(all(self.rows()[key]["summary"] is None for key in (first, second)))

    def test_revoke_and_source_reconfigure_cancel_running_and_waiting(self):
        for action, reason in ((self.store.revoke, "authorization_revoked"),
                (lambda: self.configure(source_revision="b" * 64), "source_reconfigured")):
            with self.subTest(reason=reason):
                self.configure(source_revision="a" * 64)
                self.entered.clear(); self.release.clear(); self.gateway.calls.clear()
                first, _ = self.submit_frame()
                self.assertTrue(self.entered.wait(1))
                second, _ = self.submit_frame()
                action()
                self.release.set()
                self.assertTrue(self.queue.wait_idle())
                self.assertEqual(len(self.gateway.calls), 1)
                for event in (first, second):
                    self.assertEqual(self.rows()[event]["processing_reason"], reason)
                    self.assertIsNone(self.rows()[event]["summary"])

    def test_deleted_current_evidence_cannot_publish_or_dispatch_text(self):
        event, _ = self.submit_frame()
        self.assertTrue(self.entered.wait(1))
        self.assertTrue(self.store.delete_owned(event))
        self.release.set()
        self.assertTrue(self.queue.wait_idle())
        self.assertNotIn(event, self.rows())
        self.assertEqual(len(self.gateway.calls), 1)

    def test_expired_session_stops_running_and_waiting_dispatch(self):
        first, _ = self.submit_frame()
        self.assertTrue(self.entered.wait(1))
        second, _ = self.submit_frame()
        self.now += timedelta(minutes=31)
        self.release.set()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(len(self.gateway.calls), 1)
        for event in (first, second):
            self.assertEqual(self.rows()[event]["processing_reason"], "session_expired")
            self.assertIsNone(self.rows()[event]["summary"])

    def test_deleted_or_expired_source_signals_active_transport_cancellation(self):
        for mutation in ("delete", "expire"):
            with self.subTest(mutation=mutation):
                self.configure(session_expires_at=(self.now + timedelta(minutes=30)).isoformat())
                self.release.clear(); self.entered.clear(); self.gateway.calls.clear()
                event, _ = self.submit_frame()
                self.assertTrue(self.entered.wait(1))
                lease = self.store._processing_lease
                self.assertIsNotNone(lease)
                if mutation == "delete":
                    self.store.delete_owned(event)
                else:
                    self.now += timedelta(minutes=31)
                self.assertTrue(lease.is_set())
                self.assertEqual(lease.reason, "evidence_changed" if mutation == "delete" else "session_expired")
                self.release.set()
                self.assertTrue(self.queue.wait_idle())
                self.assertEqual(len(self.gateway.calls), 1)
                self.assertIsNone(self.store._processing_lease)

    def test_deleting_queued_record_frees_capacity_without_discarding_other_pixels(self):
        first, _ = self.submit_frame()
        self.assertTrue(self.entered.wait(1))
        deleted, _ = self.submit_frame()
        preserved, _ = self.submit_frame()
        self.store.delete_owned(deleted)
        added, result = self.submit_frame()
        self.assertTrue(result["accepted"])
        self.assertEqual(self.queue.state()["queued"], 2)
        self.release.set()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(set(self.rows()), {first, preserved, added})
        self.assertTrue(all(row["state"] == "ready" for row in self.rows().values()))

    def test_large_prior_is_omitted_whole_with_explicit_coverage_counts(self):
        previous, _ = self.ingest()
        self.store.set_result(previous, state="ready", title="旧记录", summary="文档记载" + "字" * 350,
                              boundary="仅公开窗口截图。")
        self.now += timedelta(seconds=1)
        from app.modules.model_gateway.gateway import OBSERVATION_NO_PRIOR_JSON_SCHEMA
        self.gateway.on_image = None
        schemas = []
        original_text = self.gateway.call_text
        def text_call(*args, **options):
            schemas.append(options["json_schema"])
            return original_text(*args, **options)
        self.gateway.call_text = text_call
        event, _ = self.submit_frame()
        self.assertTrue(self.queue.wait_idle())
        row = self.rows()[event]
        self.assertEqual(row["state"], "ready")
        self.assertEqual(schemas, [OBSERVATION_NO_PRIOR_JSON_SCHEMA])
        context = row["temporal_context"]
        self.assertEqual((context["prior_candidate_count"], context["prior_selected_count"],
                          context["prior_omitted_count"]), (1, 0, 1))
        self.assertEqual(context["prior_observation_ids"], [])
        prompt = [call[1] for call in self.gateway.calls if call[0] == "text"][-1]
        self.assertLessEqual(len(prompt.encode("utf-8")), MAX_PROMPT_BYTES)
        self.assertNotIn("prior_records", json.loads(prompt.split("\n", 1)[1]))
        self.assertNotIn(previous, prompt)

    def test_oversized_description_fails_explicitly_without_text_call(self):
        def oversized(prompt, image, auth, **options):
            self.gateway.calls.append(("image", prompt))
            return "字" * 121
        self.gateway.call_image = oversized
        event, _ = self.submit_frame()
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(self.rows()[event]["processing_reason"], "description_limit_exceeded")
        self.assertEqual(len(self.gateway.calls), 1)
        self.assertTrue(self.rows()[event]["evidence_available"])

    def test_stale_generation_submission_after_pause_restart_is_rejected(self):
        frame, _ = self.frame()
        event = self.store.ingest(frame)
        self.store.pause(); self.store.start()
        result = self.queue.submit(event["id"], generation=event["_generation"])
        self.assertEqual(result["reason"], "authorization_revoked")
        self.assertEqual(self.gateway.calls, [])

    def test_process_restart_does_not_restore_analysis_or_capture(self):
        event, _ = self.ingest()
        with self.db() as conn:
            init_capture_store(conn, reset_active=True)
        restarted = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        queue = ObservationQueue(restarted, ObservationProcessor(restarted, self.gateway, lambda: self.auth))
        self.addCleanup(queue.close)
        self.assertFalse(restarted.state()["active"])
        self.assertIsNone(queue._worker)
        self.assertEqual(self.rows()[event]["processing_reason"], "process_restarted")
        self.assertEqual(self.gateway.calls, [])
        self.assertFalse(queue.submit(event, retry=True)["accepted"])

    def test_outage_preserves_owned_evidence_until_explicit_retry(self):
        def unavailable():
            raise OSError("synthetic outage secret must not be shown")
        self.gateway.on_image = unavailable
        event, _ = self.submit_frame()
        self.assertTrue(self.queue.wait_idle())
        row = self.rows()[event]
        self.assertEqual(row["state"], "model_unavailable")
        self.assertEqual(row["processing_reason"], "model_unavailable")
        self.assertTrue(row["evidence_available"])
        self.gateway.on_image = None
        self.assertEqual(len(self.gateway.calls), 1)
        self.assertTrue(self.queue.submit(event, retry=True)["accepted"])
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(self.rows()[event]["state"], "ready")

    def test_shutdown_cancels_pending_and_never_publishes_late_result(self):
        event, _ = self.submit_frame()
        self.assertTrue(self.entered.wait(1))
        self.assertFalse(self.queue.close(timeout=.01))
        self.release.set()
        self.assertTrue(self.queue.close(timeout=1))
        self.assertEqual(self.rows()[event]["state"], "model_unavailable")
        self.assertEqual(len(self.gateway.calls), 1)
        self.assertEqual(self.queue.submit(event, retry=True)["reason"], "queue_closed")


class StructuredObservationTests(unittest.TestCase):
    def result(self, **changes):
        result = {"title": "窗口观察", "summary": "窗口显示测试文档。", "boundary": "仅当前截图。",
                  "comparison": {"performed": False, "prior_observation_ids": [], "current_quote": "", "prior_quote": ""}}
        result.update(changes)
        return json.dumps(result, ensure_ascii=False)

    def test_fences_duplicate_keys_and_extra_fields_are_strictly_rejected(self):
        for response in ("```json\n" + self.result() + "\n```", self.result(extra="x"),
                         self.result().replace('"title":', '"title":"duplicate","title":')):
            with self.subTest(response=response), self.assertRaises(ValueError):
                ObservationProcessor._parse(response, prior=[], description="窗口显示测试文档。")

    def test_first_frame_cannot_claim_comparison_even_with_false_flag(self):
        for summary in ("相较前帧文本变化，文档增加一行。", "与先前采样相比，可能增加一行。", "Compared with the previous frame, changed.",
                        "窗口内容发生了变化，新增一行文字。", "文本已从甲改为乙。",
                        "The document has changed and now includes another line."):
            with self.subTest(summary=summary), self.assertRaisesRegex(ValueError, "invalid_temporal_comparison"):
                ObservationProcessor._parse(self.result(summary=summary), prior=[], description="窗口显示测试文档。")
        with self.assertRaisesRegex(ValueError, "invalid_temporal_comparison"):
            ObservationProcessor._parse(self.result(comparison={"performed": True, "prior_observation_ids": [],
                "current_quote": "测试", "prior_quote": "测试"}), prior=[], description="测试")

    def test_reproduced_false_flag_nonempty_current_quote_still_rejected(self):
        # Exact category of the public-only replay. It is intentionally invalid;
        # no quote erasure, relabeling, or repair is allowed to make it pass.
        description = "评估界面显示Qwen3.5模型本地运行状态，当前为问答环节，提示“review in progress”，图像识别结果已返回但回答未完全匹配，表明任务仍在进行中。"
        result = self.result(title="current_observation", boundary="<80", summary=description,
            comparison={"performed": False, "prior_observation_ids": [],
                        "current_quote": description, "prior_quote": ""})
        with self.assertRaisesRegex(ValueError, "invalid_temporal_comparison"):
            ObservationProcessor._parse(result, prior=[], description=description)

    def test_no_prior_schema_forces_no_comparison_and_fixed_boundary(self):
        from app.modules.model_gateway.gateway import OBSERVATION_NO_PRIOR_JSON_SCHEMA, OBSERVATION_CURRENT_FRAME_BOUNDARY
        properties = OBSERVATION_NO_PRIOR_JSON_SCHEMA["properties"]
        comparison = properties["comparison"]["properties"]
        self.assertEqual(comparison["performed"]["enum"], [False])
        self.assertEqual(comparison["prior_observation_ids"]["maxItems"], 0)
        self.assertEqual(comparison["current_quote"]["enum"], [""])
        self.assertEqual(comparison["prior_quote"]["enum"], [""])
        self.assertEqual(properties["boundary"]["enum"], [OBSERVATION_CURRENT_FRAME_BOUNDARY])
        fields, compared = ObservationProcessor._parse(self.result(boundary=OBSERVATION_CURRENT_FRAME_BOUNDARY),
                                                      prior=[], description="窗口显示测试文档。")
        self.assertFalse(compared["performed"])

    def test_prompt_field_semantics_and_public_note_budget(self):
        from app.modules.context_engine.processor import _IMAGE_PROMPT, _TEXT_PROMPT
        self.assertIn("文档内容归因", _IMAGE_PROMPT)
        self.assertIn("不得把这些文字解读成正在运行", _IMAGE_PROMPT)
        self.assertIn("title为中文短主题", _TEXT_PROMPT)
        self.assertIn("boundary说明证据局限，不写字数", _TEXT_PROMPT)
        # A maximum-length all-Chinese description fits without truncation.
        prompt = _TEXT_PROMPT + json.dumps({"current_observation": "字" * 120, "prior_records": []},
                                          ensure_ascii=False, separators=(",", ":"))
        self.assertLessEqual(len(prompt.encode("utf-8")), MAX_PROMPT_BYTES)
        # Preserve useful temporal input within the same conservative budget.
        normal_prior = {"observation_id": "a" * 36, "title": "字" * 8, "summary": "字" * 80}
        with_prior = _TEXT_PROMPT + json.dumps({"current_observation": "字" * 80, "prior_records": [normal_prior]},
                                              ensure_ascii=False, separators=(",", ":"))
        self.assertLessEqual(len(with_prior.encode("utf-8")), MAX_PROMPT_BYTES)

    def test_current_frame_boundary_does_not_false_match_previous_frame(self):
        fields, comparison = ObservationProcessor._parse(self.result(boundary="仅当前截图。"),
                                                         prior=[], description="窗口显示测试文档。")
        self.assertFalse(comparison["performed"])

    def test_comparison_needs_known_ids_exact_quotes_and_uncertainty(self):
        prior = [{"id": "a", "title": "旧文档", "summary": "窗口显示甲内容。"}]
        comparison = {"performed": True, "prior_observation_ids": ["a"], "current_quote": "乙内容", "prior_quote": "甲内容"}
        fields, parsed = ObservationProcessor._parse(self.result(summary="与先前采样相比，可能换成乙内容。", comparison=comparison),
                                                     prior=prior, description="窗口显示乙内容。")
        self.assertTrue(parsed["performed"])
        for changes in ({"prior_observation_ids": ["unknown"]}, {"current_quote": "无依据"}, {"prior_quote": "无依据"}, {"performed": 1}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "invalid_temporal_comparison"):
                ObservationProcessor._parse(self.result(summary="可能改变", comparison={**comparison, **changes}),
                                             prior=prior, description="窗口显示乙内容。")

    def test_current_description_is_not_silently_truncated(self):
        self.assertLessEqual(MAX_PROMPT_BYTES, 1200)
