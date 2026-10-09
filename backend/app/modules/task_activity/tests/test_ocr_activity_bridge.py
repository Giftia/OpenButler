"""Real capture/processor/queue bridge with generated public pixels and OCR text.

The PNGs are constructed in memory. OCR values represent verified Tesseract
output fixtures; no screen, OCR executable, configured model, or network is used.
"""

from datetime import timedelta
from hashlib import sha256
import json
import sqlite3
import unittest
from unittest.mock import Mock

from pydantic import ValidationError

from app.modules.context_engine.organization_queue import ObservationQueue
from app.modules.context_engine.processor import ObservationProcessor
from app.modules.context_engine.tests import test_public_window as window
from app.modules.model_gateway.gateway import Gateway
from app.modules.task_activity import models
from app.modules.task_activity.discovery import Proposal
from app.modules.task_activity.service import TaskService
from app.modules.task_activity.tests.fixture import synthetic_commit_guard
from app.security.privacy_guard import PrivacyGuard


PUBLIC_OCR = "TODO (me) : Review public API\n我的待办 ： 检查公开示例\nTODO : Write public appendix"


class OcrActivityBridgeTests(unittest.TestCase):
    configure = window.PublicWindowTests.configure
    png = staticmethod(window.PublicWindowTests.png)

    def setUp(self):
        # Existing fixture initializes the real capture schema, privacy audit,
        # consent, and a dedicated synthetic 40x20 public-window source.
        window.PublicWindowTests.setUp(self)
        self.configure(observation_mode="masked_ocr_text")
        self.transport = Mock()
        self.transport.post.side_effect = AssertionError("Unconfigured gateway must never dispatch")
        self.gateway = Gateway(PrivacyGuard(), self.transport)
        self.processor = ObservationProcessor(self.store, self.gateway, lambda: self.auth)
        self.service = TaskService(self.root / "owned.sqlite3", clock=lambda: self.now)
        self.callback = Mock(wraps=self.service.process_observation)
        self.queue = ObservationQueue(self.store, self.processor, on_processed=self.callback)
        self.addCleanup(self.queue.close)
        self.addCleanup(self.service.close)

    def enable(self, provider="evidence_rules_v1"):
        return self.service.set_settings(models.SettingsEdit(
            expected_version=self.service.settings()["version"], auto_discovery=True,
            confirmed=True, provider=provider))

    def frame(self, text=PUBLIC_OCR, **changes):
        image = self.png(self.sequence + 1)
        fields = {"post_mask_ocr_complete": True, "post_mask_ocr_text": text,
                  "post_mask_ocr_image_digest": sha256(image).hexdigest(),
                  "post_mask_ocr_engine": "tesseract.js"}
        fields.update(changes)
        return window.PublicWindowTests.frame(self, **fields)

    def ingest(self, text=PUBLIC_OCR):
        frame, image = self.frame(text)
        result = self.store.ingest(frame)
        self.assertTrue(result["recorded"])
        self.now += timedelta(seconds=1)
        return result["id"], image

    def unavailable(self, text=PUBLIC_OCR):
        event, image = self.ingest(text)
        self.assertFalse(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual((row["state"], row["processing_reason"]), ("model_unavailable", "model_unavailable"))
        self.transport.post.assert_not_called()
        return event

    def row(self, event):
        with self.db() as conn:
            conn.row_factory = sqlite3.Row
            return dict(conn.execute("SELECT * FROM context_observations WHERE id=?", (event,)).fetchone())

    def update(self, event, **fields):
        with self.db() as conn:
            conn.execute("UPDATE context_observations SET " + ",".join(key + "=?" for key in fields) + " WHERE id=?",
                         (*fields.values(), event))

    def assert_no_work(self):
        self.assertEqual(self.service.list_tasks()["items"], [])
        self.assertEqual(self.service.discoveries()["items"], [])
        self.assertEqual(self.service.list_activities()["items"], [])

    def test_real_unconfigured_processor_queue_callback_creates_ocr_sample_and_bounded_work(self):
        self.enable()
        event, _image = self.ingest()
        self.assertTrue(self.queue.submit(event)["accepted"])
        self.assertTrue(self.queue.wait_idle())
        self.callback.assert_called_once()
        self.assertEqual(self.callback.call_args.args, (event,))
        self.assertIn("cancel_event", self.callback.call_args.kwargs)
        original = self.row(event)
        self.assertEqual((original["state"], original["processing_reason"]), ("model_unavailable", "model_unavailable"))
        self.assertIsNone(original["title"])
        self.assertIsNone(original["summary"])
        activities = self.service.list_activities()["items"]
        self.assertEqual(len(activities), 1)
        activity = activities[0]
        self.assertTrue(activity["evidence_available"])
        self.assertIn("OCR", activity["title"])
        self.assertIn("OCR", activity["boundary"])
        self.assertEqual((activity["start_at"], activity["end_at"], activity["time_kind"]),
                         (original["captured_at"], original["captured_at"], "sample"))
        tasks = self.service.list_tasks()["items"]
        self.assertEqual({task["title"] for task in tasks}, {"Review public API", "检查公开示例"})
        self.assertTrue(all(not task["confirmed"] and task["status"] == "todo" for task in tasks))
        self.assertTrue(all(self.service.detail(task["id"])["time"]["total_seconds"] == 0 for task in tasks))
        pending = [d for d in self.service.discoveries()["items"] if d["state"] == "pending"]
        self.assertEqual([d["title"] for d in pending], ["Write public appendix"])
        self.assertEqual(pending[0]["quote"], "TODO : Write public appendix")
        self.assertEqual(self.row(event), original, "Task projection must not relabel upstream model failure")
        self.transport.post.assert_not_called()

    def test_task_feature_default_off_prevents_fallback_indexing(self):
        self.assertFalse(self.service.settings()["auto_discovery"])
        event, _image = self.ingest()
        self.assertTrue(self.queue.submit(event)["accepted"])
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual(self.row(event)["state"], "model_unavailable")
        self.assert_no_work()
        self.transport.post.assert_not_called()

    def test_optout_stops_new_ocr_projection_without_changing_capture_consent(self):
        self.enable()
        first = self.unavailable("TODO(me): Existing public task")
        self.assertTrue(self.service.process_observation(first)["processed"])
        self.service.set_settings(models.SettingsEdit(
            expected_version=self.service.settings()["version"], auto_discovery=False, confirmed=True))
        before = self.store.state()
        event, _ = self.ingest("TODO(me): New work after task optout")
        self.assertTrue(self.queue.submit(event)["accepted"])
        self.assertTrue(self.queue.wait_idle())
        self.assertEqual([task["title"] for task in self.service.list_tasks()["items"]], ["Existing public task"])
        self.assertEqual(len(self.service.list_activities()["items"]), 1)
        self.assertEqual(self.store.state()["authorized"], before["authorized"])
        self.assertEqual(self.store.state()["active"], before["active"])
        self.assertEqual(self.row(event)["state"], "model_unavailable")

    def test_ordinary_ocr_creates_sample_without_inventing_task(self):
        self.enable()
        event = self.unavailable("Public API documentation overview")
        self.assertTrue(self.service.process_observation(event)["processed"])
        self.assertEqual(self.service.list_tasks()["items"], [])
        self.assertEqual(self.service.discoveries()["items"], [])
        activity = self.service.list_activities()["items"][0]
        self.assertEqual(activity["start_at"], activity["end_at"])
        self.assertIn("Public API documentation overview", activity["summary"])
        self.assertIn("OCR", activity["title"])

    def test_local_model_gets_complete_fallback_ocr_including_chrome_and_long_lines(self):
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.available.return_value = True
        model.commit_guard.side_effect = synthetic_commit_guard
        model.extract.return_value = []
        self.service.model_provider = model
        self.enable("local_model_v1")
        text = ("Public window chrome\nAnother public heading\nA third public heading\n"
                "TODO ( me ) : Review exact public text\n" + "x" * 121)
        event = self.unavailable(text)
        self.assertTrue(self.service.process_observation(event)["processed"])
        model_source = model.extract.call_args.args[0]
        self.assertEqual(model_source.text, text)
        self.assertEqual(model_source.payload()['span'], {'quote': text, 'start': 0, 'end': len(text)})
        self.assertEqual(model_source.observation_id, event)
        self.assertEqual(model_source.evidence_id, self.row(event)['evidence_id'])
        self.assertEqual(self.service.list_tasks()["items"], [])

    def test_explicit_sync_recovers_eligible_failed_observation_once(self):
        self.enable()
        event = self.unavailable("TODO(me): Recover public example")
        original = self.row(event)
        self.assertEqual(self.service.sync()["processed"], 1)
        self.assertEqual(self.service.sync()["processed"], 0)
        self.assertEqual(len(self.service.list_activities()["items"]), 1)
        self.assertEqual([task["title"] for task in self.service.list_tasks()["items"]], ["Recover public example"])
        self.assertEqual(self.row(event), original)

    def test_each_whitelisted_model_failure_keeps_source_status_and_allows_ocr_only_index(self):
        self.enable()
        allowed = ("model_unavailable", "route_not_ready", "provider_connection_failed",
                   "provider_http_error", "invalid_model_result", "invalid_source_grounding",
                   "invalid_temporal_comparison")
        for index, reason in enumerate(allowed):
            with self.subTest(reason=reason):
                event = self.unavailable("TODO(me): Public allowed failure " + str(index))
                self.update(event, processing_reason=reason)
                before = self.row(event)
                self.assertTrue(self.service.process_observation(event)["processed"])
                self.assertEqual(self.row(event), before)
        self.assertEqual(len(self.service.list_tasks()["items"]), len(allowed))
        self.transport.post.assert_not_called()

    def rejected_temporal_organization(self, provider):
        title = "Review public temporal fixture"
        quote = "TODO(me): " + title
        model = None
        if provider == "local_model_v1":
            model = Mock(spec=("available", "extract", "commit_guard"))
            model.available.return_value = True
            model.commit_guard.side_effect = synthetic_commit_guard
            model.extract.return_value = [Proposal(title, quote, True, True, .95)]
            self.service.model_provider = model
        self.enable(provider)
        # Real processor, queue and owned OCR capture fixture. Only the model's
        # rejected response is synthetic; no provider/network call is made.
        gateway = window.Gateway()
        reply = json.loads(gateway.response)
        reply.update(title="REJECTED_MODEL_TITLE", summary="REJECTED_MODEL_SUMMARY",
                     source_quotes=[quote])
        reply["comparison"]["current_quote"] = "unsupported comparison"
        gateway.response = json.dumps(reply)
        self.processor.gateway = gateway
        event, _image = self.ingest(quote)
        self.assertTrue(self.queue.submit(event)["accepted"])
        self.assertTrue(self.queue.wait_idle())
        self.callback.assert_called_once()
        source = self.row(event)
        self.assertEqual((source["state"], source["processing_reason"]),
                         ("model_unavailable", "invalid_temporal_comparison"))
        self.assertIsNone(source["title"])
        self.assertIsNone(source["summary"])
        self.assertEqual([call[0] for call in gateway.calls], ["text"])
        activities = self.service.list_activities()["items"]
        self.assertEqual(len(activities), 1)
        self.assertTrue(activities[0]["evidence_available"])
        self.assertIn(quote, activities[0]["summary"])
        self.assertIn("OCR", activities[0]["boundary"])
        self.assertNotIn("REJECTED_MODEL", json.dumps(activities))
        tasks = self.service.list_tasks()["items"]
        if provider == 'local_model_v1':
            self.assertEqual(tasks, [])
            candidate = self.service.discoveries()['items'][0]
            self.assertEqual((candidate['title'], candidate['provider'], candidate['state'], candidate['task_id']),
                             (title, provider, 'pending', None))
            with self.service.store.transaction() as conn:
                self.assertEqual(conn.execute('SELECT * FROM work_task_links').fetchall(), [])
        else:
            self.assertEqual([task["title"] for task in tasks], [title])
            self.assertEqual(tasks[0]["discovery_provider"], provider)
            self.assertFalse(tasks[0]["confirmed"])
        self.assertEqual(self.service.sync()["processed"], 0)
        self.assertEqual(self.row(event), source)
        if model:
            model.extract.assert_called_once()
            self.assertEqual(model.extract.call_args.args[0].text, quote)
        self.transport.post.assert_not_called()

    def test_rejected_temporal_model_output_preserves_exact_ocr_for_rules(self):
        self.rejected_temporal_organization("evidence_rules_v1")

    def test_rejected_temporal_model_output_preserves_exact_ocr_for_local_task_model(self):
        self.rejected_temporal_organization("local_model_v1")

    def test_capture_privacy_unknown_and_invalid_failure_reasons_never_fallback(self):
        self.enable()
        forbidden = (None, "", "unknown_failure", "authorization_revoked", "capture_paused",
            "session_expired", "evidence_changed", "full_desktop_unavailable", "strict_mode_forbidden",
            "privacy_audit_unavailable", "record_or_evidence_unavailable", "post_mask_ocr_required",
            "invalid_post_mask_ocr", "post_mask_ocr_evidence_mismatch", "queue_full", "process_restarted")
        for reason in forbidden:
            with self.subTest(reason=reason):
                event = self.unavailable("TODO(me): Must remain unavailable")
                self.update(event, processing_reason=reason)
                self.assertFalse(self.service.process_observation(event)["processed"])
        self.assert_no_work()

    def test_tampered_persisted_provenance_cannot_authorize_fallback(self):
        self.enable()
        for changes in ({"source_verified_before": False}, {"source_verified_after": False},
                        {"source_verified_before": "true"}, {"source_verified_after": 1},
                        {"capture_scope": "full_screen"}, {"observation_mode": "vision"},
                        {"source_kind": "full_screen"}):
            with self.subTest(changes=changes):
                event = self.unavailable()
                provenance = json.loads(self.row(event)["provenance"])
                provenance.update(changes)
                self.update(event, provenance=json.dumps(provenance))
                self.assertFalse(self.service.process_observation(event)["processed"])
        self.assert_no_work()

    def test_digest_engine_and_ocr_bounds_are_revalidated_for_stored_fallback(self):
        self.enable()
        for changes in ({"post_mask_ocr_image_digest": "0" * 64},
                        {"post_mask_ocr_engine": "unverified-engine"}, {"post_mask_ocr_engine": None},
                        {"post_mask_ocr_text": None}, {"post_mask_ocr_text": "   "},
                        {"post_mask_ocr_text": "x" * 2001}, {"post_mask_ocr_text": "🦉" * 1600},
                        {"post_mask_ocr_text": "TODO(me): Invalid\x00text"}):
            with self.subTest(changes=list(changes)):
                event = self.unavailable()
                self.update(event, **changes)
                self.assertFalse(self.service.process_observation(event)["processed"])
        self.assert_no_work()

    def test_unverified_frame_and_invalid_ocr_cannot_enter_real_capture_store(self):
        for changes in ({"source_verified_before": False}, {"source_verified_after": False},
                        {"source_verified_before": "true"}, {"post_mask_ocr_engine": "unverified-engine"}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.frame(**changes)
        frame, _ = self.frame(post_mask_ocr_image_digest="0" * 64)
        with self.assertRaisesRegex(ValueError, "post_mask_ocr_evidence_mismatch"):
            self.store.ingest(frame)
        self.assert_no_work()

    def test_missing_media_expired_evidence_and_future_observation_never_fallback(self):
        self.enable()
        for failure in ("missing", "expired", "future"):
            with self.subTest(failure=failure):
                event = self.unavailable()
                row = self.row(event)
                if failure == "missing":
                    (self.store._media / (row["evidence_id"] + ".png")).unlink()
                elif failure == "expired":
                    self.update(event, expires_at=self.now.isoformat())
                else:
                    self.update(event, captured_at=(self.now + timedelta(seconds=1)).isoformat())
                self.assertFalse(self.service.process_observation(event)["processed"])
        self.assert_no_work()

    def test_capture_revocation_prevents_fallback_and_invalidates_existing_derived_work(self):
        self.enable()
        first = self.unavailable("TODO(me): Public existing OCR task")
        self.assertTrue(self.service.process_observation(first)["processed"])
        second = self.unavailable("TODO(me): Public unindexed OCR task")
        self.store.revoke()
        self.assertFalse(self.service.process_observation(second)["processed"])
        tasks = self.service.list_tasks()["items"]
        self.assertEqual(len(tasks), 1)
        self.assertEqual((tasks[0]["title"], tasks[0]["evidence_unavailable"]), ("来源已不可用", True))
        detail = self.service.detail(tasks[0]["id"])
        self.assertEqual(detail["resources"], [])
        self.assertFalse(detail["activities"][0]["evidence_available"])

    def assert_preserved_ocr_work(self, task, activity_id, title):
        detail = self.service.detail(task["id"])
        self.assertEqual(detail["task"]["title"], title)
        self.assertFalse(detail["task"]["evidence_unavailable"])
        self.assertEqual([activity["id"] for activity in detail["activities"]], [activity_id])
        self.assertTrue(detail["activities"][0]["evidence_available"])
        self.assertEqual(detail["time"]["total_seconds"], 0)
        self.assertEqual(len(detail["resources"]), 1)

    def test_existing_ocr_work_survives_queued_processing_and_repeated_model_unavailable(self):
        self.enable()
        title = "Keep public retry task"
        event = self.unavailable("TODO(me): " + title)
        activity_id = self.service.process_observation(event)["activity_id"]
        task = self.service.list_tasks()["items"][0]
        generation, cancellation = self.store.processing_ticket(event, retry=True)
        self.store.mark_queued(event, generation, retry=True)
        self.assertEqual(self.row(event)["state"], "recorded_pending")
        self.assert_preserved_ocr_work(task, activity_id, title)
        image = self.store.begin_processing(event, generation)
        self.assertEqual(self.row(event)["state"], "processing")
        self.assert_preserved_ocr_work(task, activity_id, title)
        self.assertFalse(self.processor.process(event, image, expected_generation=generation,
                                                cancel_event=cancellation))
        self.assertEqual(self.row(event)["state"], "model_unavailable")
        self.assertTrue(self.service.process_observation(event)["processed"])
        self.assert_preserved_ocr_work(task, activity_id, title)
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)
        self.assertEqual(len(self.service.list_activities()["items"]), 1)
        self.transport.post.assert_not_called()

    def test_existing_ocr_work_survives_real_prepare_retry_and_ready_mock_organization(self):
        self.enable()
        title = "Keep public ready retry task"
        quote = "TODO(me): " + title
        event = self.unavailable(quote)
        activity_id = self.service.process_observation(event)["activity_id"]
        task = self.service.list_tasks()["items"][0]
        image = self.store.prepare_retry(event)
        self.assertIsNotNone(image)
        self.assertEqual(self.row(event)["state"], "processing")
        self.assert_preserved_ocr_work(task, activity_id, title)
        # Real ObservationProcessor, exact source-ID response from an in-process
        # synthetic gateway fixture. No provider/network transport is involved.
        gateway = window.Gateway()
        reply = json.loads(gateway.response)
        reply["source_quotes"] = [quote]
        gateway.response = json.dumps(reply)
        self.processor.gateway = gateway
        self.assertTrue(self.processor.process(event, image))
        ready_source = self.row(event)
        self.assertEqual(ready_source["state"], "ready")
        self.assertTrue(self.service.process_observation(event)["processed"])
        self.assert_preserved_ocr_work(task, activity_id, title)
        self.assertEqual(self.row(event), ready_source)
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)
        self.assertEqual(len(self.service.list_activities()["items"]), 1)
        self.transport.post.assert_not_called()

    def test_transient_or_cancelled_sources_cannot_admit_new_work(self):
        self.enable()
        for state, reason in (("recorded_pending", "queued"), ("processing", "running"),
            ("model_unavailable", "authorization_revoked"), ("model_unavailable", "capture_paused"),
            ("model_unavailable", "strict_mode_forbidden"), ("model_unavailable", "session_expired")):
            with self.subTest(state=state, reason=reason):
                event = self.unavailable("TODO(me): Never admit transient work")
                self.update(event, state=state, processing_reason=reason)
                before = self.row(event)
                self.assertFalse(self.service.process_observation(event)["processed"])
                self.assertEqual(self.row(event), before)
        self.assert_no_work()

    def test_existing_retry_projection_does_not_rerun_discovery_while_transient(self):
        self.enable()
        event = self.unavailable("TODO(me): Existing public projection")
        activity_id = self.service.process_observation(event)["activity_id"]
        task = self.service.list_tasks()["items"][0]
        image = self.store.prepare_retry(event)
        self.assertIsNotNone(image)
        provider = Mock()
        provider.extract.side_effect = AssertionError("Retry projection is not new extraction authority")
        self.service.provider = provider
        self.assertFalse(self.service.process_observation(event)["processed"])
        self.assert_preserved_ocr_work(task, activity_id, "Existing public projection")
        provider.extract.assert_not_called()
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)

    def test_retry_projection_still_invalidates_on_source_delete_expiry_or_media_loss(self):
        self.enable()
        for failure in ("delete", "expiry", "media_loss"):
            with self.subTest(failure=failure):
                title = "Retry invalidation " + failure
                event = self.unavailable("TODO(me): " + title)
                self.assertTrue(self.service.process_observation(event)["processed"])
                task = next(item for item in self.service.list_tasks()["items"] if item["title"] == title)
                self.assertIsNotNone(self.store.prepare_retry(event))
                if failure == "delete":
                    self.store.delete_owned(event)
                elif failure == "expiry":
                    self.update(event, expires_at=self.now.isoformat())
                else:
                    evidence = self.row(event)["evidence_id"]
                    (self.store._media / (evidence + ".png")).unlink()
                detail = self.service.detail(task["id"])
                self.assertEqual(detail["task"]["title"], "来源已不可用")
                self.assertTrue(detail["task"]["evidence_unavailable"])
                self.assertFalse(detail["activities"][0]["evidence_available"])
                self.assertEqual(detail["resources"], [])

    def test_retry_projection_still_invalidates_immediately_on_consent_revocation(self):
        self.enable()
        event = self.unavailable("TODO(me): Revoked retry projection")
        self.assertTrue(self.service.process_observation(event)["processed"])
        task = self.service.list_tasks()["items"][0]
        self.assertIsNotNone(self.store.prepare_retry(event))
        self.store.revoke()
        with self.db() as conn:
            raw = conn.execute("SELECT title,evidence_unavailable FROM work_tasks WHERE id=?", (task["id"],)).fetchone()
        self.assertEqual(raw, ("来源已不可用", 1))
        self.assertFalse(self.service.process_observation(event)["processed"])
        self.assertEqual(self.service.detail(task["id"])["resources"], [])

    def test_sync_skips_201_invalid_ocr_rows_and_reaches_later_valid_source(self):
        self.enable()
        originals = {}
        for index in range(201):
            event = self.unavailable("TODO(me): Rejected public OCR " + str(index))
            provenance = json.loads(self.row(event)["provenance"])
            provenance["source_verified_after"] = False
            self.update(event, provenance=json.dumps(provenance))
            originals[event] = self.row(event)
        valid = self.unavailable("TODO(me): Reach public valid backlog")
        originals[valid] = self.row(valid)
        first = self.service.sync()
        self.assertTrue(first["has_more"], first)
        second = self.service.sync()
        self.assertEqual(first["processed"] + second["processed"], 1, (first, second))
        self.assertFalse(second["has_more"], second)
        self.assertEqual([task["title"] for task in self.service.list_tasks()["items"]], ["Reach public valid backlog"])
        activities = self.service.list_activities()["items"]
        self.assertEqual(len(activities), 1, "Rejected rows must not become synthetic Activity records")
        self.assertEqual(activities[0]["source_record_id"], valid)
        self.assertEqual(self.service.sync()["processed"], 0)
        with self.db() as conn:
            conn.row_factory = sqlite3.Row
            receipts = [dict(row) for row in conn.execute("SELECT * FROM work_source_rejections")]
        self.assertEqual(len(receipts), 201)
        self.assertTrue(all(set(receipt) == {"source_record_id", "state", "reason"} for receipt in receipts))
        self.assertNotIn("Rejected public OCR", json.dumps(receipts))
        for event, original in originals.items():
            self.assertEqual(self.row(event), original)
        self.transport.post.assert_not_called()

    def test_rejected_sync_receipt_is_reconsidered_after_source_state_reason_change(self):
        self.enable()
        event = self.unavailable("TODO(me): Reconsider public rejected OCR")
        original = self.row(event)
        provenance = json.loads(original["provenance"])
        provenance["source_verified_after"] = False
        self.update(event, provenance=json.dumps(provenance))
        self.assertEqual(self.service.sync()["processed"], 0)
        self.assert_no_work()
        # Simulate a later valid source-state publication on this synthetic row.
        self.update(event, provenance=original["provenance"], processing_reason="route_not_ready")
        repaired = self.row(event)
        self.assertEqual(self.service.sync()["processed"], 1)
        self.assertEqual([task["title"] for task in self.service.list_tasks()["items"]], ["Reconsider public rejected OCR"])
        self.assertEqual(self.row(event), repaired)

    def test_local_task_model_can_receive_bounded_exact_fallback_ocr_without_upstream_model(self):
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.available.return_value = True
        model.commit_guard.side_effect = synthetic_commit_guard
        quote = "I need to review the public sample"
        model.extract.return_value = [Proposal("review the public sample", quote, True, True, .95)]
        self.service.model_provider = model
        self.enable("local_model_v1")
        event = self.unavailable(quote)
        original = self.row(event)
        self.assertTrue(self.service.process_observation(event)["processed"])
        model.extract.assert_called_once()
        self.assertEqual(model.extract.call_args.args[0].text, quote)
        self.assertEqual(self.service.list_tasks()["items"], [])
        candidate = self.service.discoveries()['items'][0]
        self.assertEqual((candidate['title'], candidate['provider'], candidate['state'], candidate['task_id']),
                         ('review the public sample', 'local_model_v1', 'pending', None))
        with self.service.store.transaction() as conn:
            self.assertEqual(conn.execute('SELECT * FROM work_task_links').fetchall(), [])
        self.assertEqual(self.row(event), original)
        self.transport.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
