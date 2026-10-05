"""Synthetic-only daily recap tests; no network or real user evidence is used."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Event, Thread
import unittest
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError

from app.modules.context_engine.audit import init_privacy_audit, PrivacyAuditLedger
from app.modules.context_engine.capture import CaptureStore, init_capture_store
from app.modules.context_engine.tests.capture_fixture import seed_legacy_capture_settings
from app.modules.context_engine.daily_review import DailyReviewRequest, DailyReviewService, MAX_PROMPT_CHARS
from app.modules.context_engine.privacy import AuditedPrivacyGuard
from app.modules.context_engine.router import create_context_engine_router
from app.modules.model_gateway.gateway import CallAuthorization, Gateway, ModelRoute, RouteError, synthetic_probe_png
from app.security.local_session import DEMO_READS


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class FakeGateway:
    def __init__(self, response=None, ready=True):
        self.response, self.ready, self.calls = response, ready, []
        self.configuration_revision = 1

    def status(self):
        return type("Status", (), {"ready": self.ready})()

    def call_text(self, prompt, auth, *, expected_configuration_revision=None, dispatch_precondition=None):
        if expected_configuration_revision != self.configuration_revision:
            raise PermissionError("authorization_revoked")
        if dispatch_precondition is not None:
            dispatch_precondition()
            dispatch_precondition()
        self.calls.append((prompt, auth))
        data = json.loads(prompt.split("\n", 1)[1])
        if callable(self.response):
            return self.response(data)
        if self.response is not None:
            return self.response
        return json.dumps({"conclusions": [{"text": "两条本机观察显示文档编辑及后续复核。",
            "observation_ids": list(dict.fromkeys([data["records"][0]["observation_id"],
                                                  data["records"][-1]["observation_id"]]))}]})


class DailyReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = lambda: sqlite3.connect(self.root / "owned.sqlite3", factory=ClosingConnection)
        with self.db() as conn:
            init_privacy_audit(conn)
            init_capture_store(conn)
        self.now = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
        self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
        # Existing full-screen history remains reviewable; new capture is disabled.
        seed_legacy_capture_settings(self.db)
        self.auth = CallAuthorization(privacy_mode="strict", authorized=True, redacted=True)
        self.gateway = FakeGateway()
        self.service = DailyReviewService(self.store, self.gateway, lambda: self.auth, lambda: self.now)
        self.request = DailyReviewRequest(day="2026-10-01", timezone="UTC", confirmed=True)

    def row(self, captured="2026-10-01T09:00:00+00:00", *, state="ready", expiry=None,
            missing=False, title="文档编辑", summary="本机画面显示编辑合成测试文档。", boundary="仅限截图时刻。"):
        event, evidence = str(uuid4()), str(uuid4())
        expiry = expiry or (self.now + timedelta(days=1)).isoformat()
        with self.db() as conn:
            conn.execute("""INSERT INTO context_observations
                (id,captured_at,display_id,image_digest,evidence_id,expires_at,state,title,summary,boundary)
                VALUES(?,?,?,?,?,?,?,?,?,?)""", (event, captured, "synthetic_display", "synthetic-digest",
                evidence, expiry, state, title if state == "ready" else None,
                summary if state == "ready" else None, boundary))
        if not missing:
            self.store._media.mkdir(parents=True, exist_ok=True)
            (self.store._media / f"{evidence}.png").write_bytes(synthetic_probe_png())
        return event, evidence

    def test_empty_day_never_calls_model_and_reports_whole_gap(self):
        result = self.service.generate(self.request)
        self.assertEqual((result["status"], result["reason"]), ("empty", "no_records"))
        self.assertEqual(result["counts"]["total"], 0)
        self.assertIsNone(result["coverage"]["observed_start"])
        self.assertEqual(result["coverage"]["gaps"][0]["seconds"], 86400)
        self.assertEqual(self.gateway.calls, [])

    def test_only_pending_and_failed_are_visible_without_model(self):
        for state in ("recorded_pending", "processing", "model_unavailable"):
            self.row(state=state)
        result = self.service.generate(self.request)
        self.assertEqual((result["status"], result["reason"]), ("empty", "no_usable_records"))
        self.assertEqual(result["counts"]["pending"], 2)
        self.assertEqual(result["counts"]["failed"], 1)
        self.assertEqual(result["coverage"]["observation_count"], 3)
        self.assertEqual(self.gateway.calls, [])

    def test_paused_authorized_capture_can_recap_text_without_reading_images(self):
        first = self.row()[0]
        last = self.row("2026-10-01T17:30:00+00:00")[0]
        self.assertFalse(self.store.state()["active"])
        with patch.object(Path, "read_bytes", side_effect=AssertionError("must not read screenshot bytes")):
            result = self.service.generate(self.request)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(self.gateway.calls), 1)
        self.assertLessEqual(len(self.gateway.calls[0][0]), MAX_PROMPT_CHARS)
        refs = result["conclusions"][0]["evidence_refs"]
        self.assertEqual([ref["observation_id"] for ref in refs], [first, last])
        self.assertTrue(all(set(ref) == {"observation_id", "evidence_id", "captured_at"} for ref in refs))
        self.assertNotIn("evidence_id", self.gateway.calls[0][0])
        self.assertNotIn("image_digest", self.gateway.calls[0][0])
        self.assertFalse(self.store.state()["active"])
        with self.db() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM context_observations").fetchone()[0], 2)
            self.assertEqual(conn.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE '%review%'").fetchone()[0], 0)

    def test_timezone_exact_half_open_boundaries_and_non_utc_storage(self):
        self.row("2026-09-30T15:59:59.999999+00:00")
        included = self.row("2026-10-01T00:00:00+08:00")[0]
        final = self.row("2026-10-01T15:59:59.999999+00:00")[0]
        self.row("2026-10-01T16:00:00+00:00")
        request = DailyReviewRequest(day="2026-10-01", timezone="Asia/Shanghai", confirmed=True)
        result = self.service.generate(request)
        self.assertEqual(result["counts"]["total"], 2)
        self.assertEqual(result["coverage"]["requested_start"], "2026-09-30T16:00:00+00:00")
        self.assertEqual(result["coverage"]["requested_end"], "2026-10-01T16:00:00+00:00")
        self.assertEqual([item["observation_id"] for item in result["conclusions"][0]["evidence_refs"]],
                         [included, final])

    def test_dst_windows_have_23_and_25_hours(self):
        self.now = datetime(2026, 11, 2, tzinfo=timezone.utc)
        for day, hours in (("2026-03-08", 23), ("2026-11-01", 25)):
            result = self.service.generate(DailyReviewRequest(day=day, timezone="America/New_York", confirmed=True))
            coverage = result["coverage"]
            duration = datetime.fromisoformat(coverage["requested_end"]) - datetime.fromisoformat(coverage["requested_start"])
            self.assertEqual(duration.total_seconds(), hours * 3600)
        self.assertEqual(self.gateway.calls, [])

    def test_current_day_gaps_stop_at_now_and_are_not_activity_durations(self):
        self.row("2026-10-02T09:00:00+00:00")
        self.row("2026-10-02T09:05:00+00:00")
        result = self.service.generate(DailyReviewRequest(day="2026-10-02", timezone="UTC", confirmed=True))
        coverage = result["coverage"]
        self.assertEqual(coverage["evaluated_until"], self.now.isoformat())
        self.assertEqual(coverage["gap_count"], 2)
        self.assertEqual(coverage["gaps"][-1]["end"], self.now.isoformat())
        self.assertEqual(coverage["observed_end"], "2026-10-02T09:05:00+00:00")
        self.assertIn("不代表持续活动", result["boundary"])
        self.assertNotIn("duration", result)

    def test_request_validation_rejects_bad_dates_zones_types_and_extra_fields(self):
        for changes in ({"day": "2026-02-30"}, {"day": "2026-1-1"}, {"day": "9999-12-31"},
                        {"timezone": "Not/A_Timezone"}, {"timezone": "../../etc/passwd"},
                        {"confirmed": "true"}, {"extra": True}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                DailyReviewRequest(**{**self.request.model_dump(), **changes})

    def test_no_explicit_trigger_never_calls_model(self):
        self.row()
        request = DailyReviewRequest(day="2026-10-01", timezone="UTC")
        result = self.service.generate(request)
        self.assertEqual(result["reason"], "authorization_required")
        self.assertEqual(result["counts"]["ready"], 1)
        self.assertEqual(self.gateway.calls, [])

    def test_revoked_capture_cannot_recap_existing_rows(self):
        self.row()
        self.store.revoke()
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "authorization_required")
        self.assertEqual(result["conclusions"], [])
        self.assertEqual(self.gateway.calls, [])

    def test_gateway_authorization_and_redaction_are_required(self):
        self.row()
        for auth, code in ((CallAuthorization(), "authorization_required"),
                           (CallAuthorization(authorized=True), "redaction_required")):
            self.auth = auth
            result = self.service.generate(self.request)
            self.assertEqual(result["reason"], code)
        self.assertEqual(self.gateway.calls, [])

    def test_unready_gateway_preserves_all_counts(self):
        self.row()
        self.row(state="recorded_pending")
        self.row(state="model_unavailable")
        self.gateway.ready = False
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "model_unavailable")
        self.assertEqual((result["counts"]["ready"], result["counts"]["pending"], result["counts"]["failed"]), (1, 1, 1))
        self.assertEqual(self.gateway.calls, [])

    def test_expired_missing_symlink_and_invalid_text_are_never_sent(self):
        keep = self.row()[0]
        self.row(expiry=self.now.isoformat())
        self.row(missing=True)
        _, linked = self.row()
        path = self.store._media / f"{linked}.png"
        path.unlink()
        path.symlink_to(self.root / "owned.sqlite3")
        self.row(summary="<think>untrusted reasoning</think>")
        result = self.service.generate(self.request)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["counts"]["expired_evidence"], 1)
        self.assertEqual(result["counts"]["missing_evidence"], 2)
        self.assertEqual(result["counts"]["invalid_records"], 1)
        self.assertEqual(result["counts"]["eligible"], 1)
        self.assertEqual(result["conclusions"][0]["evidence_refs"][0]["observation_id"], keep)
        self.assertNotIn("untrusted reasoning", self.gateway.calls[0][0])

    def test_bounded_prompt_discloses_omitted_records_and_spreads_across_day(self):
        events = []
        for minute in range(80):
            when = datetime(2026, 10, 1, 9, tzinfo=timezone.utc) + timedelta(minutes=minute)
            events.append(self.row(when.isoformat(), summary="合成观察内容。" * 60)[0])
        result = self.service.generate(self.request)
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["truncated"])
        self.assertEqual(result["counts"]["eligible"], 80)
        self.assertEqual(result["counts"]["included"] + result["counts"]["omitted"], 80)
        prompt = self.gateway.calls[0][0]
        self.assertLessEqual(len(prompt), MAX_PROMPT_CHARS)
        data = json.loads(prompt.split("\n", 1)[1])
        ids = [row["observation_id"] for row in data["records"]]
        self.assertIn(events[0], ids)
        self.assertIn(events[-1], ids)
        self.assertEqual(data["omitted_records"], result["counts"]["omitted"])

    def test_reference_to_valid_but_omitted_record_is_rejected(self):
        for minute in range(80):
            when = datetime(2026, 10, 1, 9, tzinfo=timezone.utc) + timedelta(minutes=minute)
            self.row(when.isoformat(), summary="合成观察内容。" * 60)
        def reference_omitted(data):
            included = {row["observation_id"] for row in data["records"]}
            with self.db() as conn:
                all_ids = {row[0] for row in conn.execute("SELECT id FROM context_observations")}
            return json.dumps({"conclusions": [{"text": "bad", "observation_ids": [next(iter(all_ids - included))]}]})
        self.gateway.response = reference_omitted
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "invalid_model_result")
        self.assertEqual(result["conclusions"], [])

    def test_invalid_model_shapes_and_refs_never_publish(self):
        event = self.row()[0]
        invalid = ["not json", "[]", '{"conclusions":[],"other":true}', '{"conclusions":[]}',
                   '{"conclusions":[],"conclusions":[]}', "x" * 16001]
        for value in (None, "", "<analysis>secret</analysis>", "x" * 501):
            invalid.append(json.dumps({"conclusions": [{"text": value, "observation_ids": [event]}]}))
        for refs in ([], [str(uuid4())], [event, event], [False], event, [{}]):
            invalid.append(json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": refs}]}))
        for response in invalid:
            with self.subTest(response=response[:80]):
                self.gateway.response = response
                result = self.service.generate(self.request)
                self.assertEqual(result["reason"], "invalid_model_result")
                self.assertEqual(result["conclusions"], [])

    def test_provider_error_details_are_not_exposed(self):
        self.row()
        for error in (RouteError("secret-provider-response"), RuntimeError("secret-api-key"),
                      TimeoutError("secret-endpoint")):
            def fail(_data):
                raise error
            self.gateway.response = fail
            result = self.service.generate(self.request)
            self.assertEqual(result["reason"], "model_unavailable")
            self.assertNotIn("secret", json.dumps(result))
            self.assertEqual(result["counts"]["total"], 1)

    def test_actual_gateway_receives_only_text_and_audits_local_call(self):
        event = self.row()[0]
        class SyntheticTransport:
            def __init__(self):
                self.calls = []
            def post(self, route, payload):
                self.calls.append(payload)
                content = payload["messages"][0]["content"]
                answer = json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [event]}]})
                if isinstance(content, list):
                    answer = "TEST 42"
                elif content == "Reply with the word READY.":
                    answer = "READY"
                return {"choices": [{"message": {"content": answer}}]}
        transport = SyntheticTransport()
        gateway = Gateway(AuditedPrivacyGuard(PrivacyAuditLedger(self.db)), transport)
        route = ModelRoute("openai_compatible", "local", "http://127.0.0.1:11434/v1", "synthetic")
        gateway.configure(image=route, text=route, auth=self.auth)
        transport.calls.clear()
        self.service.gateway = gateway
        result = self.service.generate(self.request)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(transport.calls), 1)
        message = transport.calls[0]["messages"][0]
        self.assertIsInstance(message["content"], str)
        self.assertLessEqual(len(message["content"]), MAX_PROMPT_CHARS)
        self.assertNotIn("images", message)
        self.assertNotIn("data:image", message["content"])
        entries = PrivacyAuditLedger(self.db).recent(10)
        self.assertEqual(len(entries), 3)
        self.assertTrue(all(entry.action == "model_local" for entry in entries))

    def test_revocation_before_dispatch_prevents_gateway_call(self):
        self.row()
        verify = self.service._verify_selected
        def cancel(*args):
            verify(*args)
            self.store._revocation_requested.set()
        with patch.object(self.service, "_verify_selected", side_effect=cancel):
            result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "authorization_required")
        self.assertEqual(self.gateway.calls, [])

    def test_strict_external_route_is_denied_before_transport(self):
        self.row()
        class NeverTransport:
            def post(self, route, payload):
                raise AssertionError("strict mode must prevent transport")
        gateway = Gateway(AuditedPrivacyGuard(PrivacyAuditLedger(self.db)), NeverTransport())
        route = ModelRoute("openai_compatible", "custom", "https://example.com/v1", "synthetic")
        gateway._configuration = (1, {"image": route, "text": route})
        self.service.gateway = gateway
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "strict_mode_forbidden")
        self.assertEqual(result["conclusions"], [])

    def test_audit_failure_prevents_model_transport(self):
        self.row()
        class NeverTransport:
            def post(self, route, payload):
                raise AssertionError("failed audit must prevent transport")
        gateway = Gateway(AuditedPrivacyGuard(PrivacyAuditLedger(self.db)), NeverTransport())
        route = ModelRoute("openai_compatible", "local", "http://127.0.0.1:11434/v1", "synthetic")
        gateway._configuration = (1, {"image": route, "text": route})
        self.service.gateway = gateway
        with self.db() as conn:
            conn.execute("DROP TABLE context_privacy_activity")
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "privacy_audit_unavailable")

    def test_authorization_or_privacy_change_during_call_discards_output(self):
        self.row()
        for new_auth in (CallAuthorization(authorized=False),
                         CallAuthorization(privacy_mode="basic", authorized=True, redacted=True)):
            self.auth = CallAuthorization(privacy_mode="strict", authorized=True, redacted=True)
            def revoke(data):
                self.auth = new_auth
                return json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [data["records"][0]["observation_id"]]}]})
            self.gateway.response = revoke
            result = self.service.generate(self.request)
            self.assertEqual(result["reason"], "authorization_revoked")
            self.assertEqual(result["conclusions"], [])

    def test_future_day_is_rejected_without_model(self):
        with self.assertRaisesRegex(ValueError, "future_review_day"):
            self.service.generate(DailyReviewRequest(day="2026-10-03", timezone="UTC", confirmed=True))
        self.assertEqual(self.gateway.calls, [])

    def test_route_replacement_during_call_discards_output(self):
        self.row()
        def replace_route(data):
            self.gateway.configuration_revision += 1
            return json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [data["records"][0]["observation_id"]]}]})
        self.gateway.response = replace_route
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "authorization_revoked")
        self.assertEqual(result["conclusions"], [])

    def test_revocation_during_final_verification_is_caught(self):
        self.row()
        verify = self.service._verify_selected
        count = 0
        def revoke_during_verify(*args):
            nonlocal count
            count += 1
            verify(*args)
            if count == 4:
                self.store._revocation_requested.set()
        with patch.object(self.service, "_verify_selected", side_effect=revoke_during_verify):
            result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "authorization_revoked")
        self.assertEqual(result["conclusions"], [])

    def test_revoke_during_last_dispatch_metadata_check_prevents_post(self):
        self.row()
        verify = self.service._verify_selected
        checks = 0
        def cancel_inside_check(*args):
            nonlocal checks
            checks += 1
            verify(*args)
            # Initial snapshot check, pre-guard check, then final pre-post check.
            if checks == 3:
                self.store._revocation_requested.set()
        with patch.object(self.service, "_verify_selected", side_effect=cancel_inside_check):
            result = self.service.generate(self.request)
        self.assertEqual(checks, 3)
        self.assertEqual(result["reason"], "authorization_revoked")
        self.assertEqual(self.gateway.calls, [])
        self.assertEqual(result["conclusions"], [])

    def test_guard_wait_revoke_delete_and_expire_prevent_all_provider_posts(self):
        from app.security.privacy_guard import PrivacyGuard
        for change in ("revoke", "delete", "expire"):
            with self.subTest(change=change):
                self.now = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
                seed_legacy_capture_settings(self.db)
                self.store = CaptureStore(self.db, self.root, lambda: "strict", lambda: self.now)
                self.service.captures = self.store
                with self.db() as conn:
                    conn.execute("DELETE FROM context_observations")
                event, _ = self.row(expiry=(self.now + timedelta(seconds=1)).isoformat())
                entered, release = Event(), Event()
                posts, outputs = [], []
                class BlockingGuard(PrivacyGuard):
                    def require(self, request):
                        entered.set()
                        if not release.wait(3):
                            raise TimeoutError("synthetic guard timed out")
                        return super().require(request)
                class SyntheticTransport:
                    def post(self, route, payload):
                        posts.append(payload)
                        text = json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [event]}]})
                        return {"choices": [{"message": {"content": text}}]}
                gateway = Gateway(BlockingGuard(), SyntheticTransport())
                route = ModelRoute("openai_compatible", "local", "http://127.0.0.1:11434/v1", "synthetic")
                gateway._configuration = (1, {"image": route, "text": route})
                self.service.gateway = gateway
                worker = Thread(target=lambda: outputs.append(self.service.generate(self.request)))
                worker.start()
                self.assertTrue(entered.wait(3))
                revoke_thread = None
                try:
                    if change == "revoke":
                        revoke_thread = Thread(target=self.store.revoke)
                        revoke_thread.start()
                        self.assertTrue(self.store._revocation_requested.wait(3))
                    elif change == "delete":
                        self.assertTrue(self.store.delete_owned(event))
                    else:
                        self.now += timedelta(seconds=2)
                finally:
                    release.set()
                    worker.join(3)
                    if revoke_thread:
                        revoke_thread.join(3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(posts, [])
                self.assertEqual(outputs[0]["conclusions"], [])
                self.assertEqual(outputs[0]["reason"], "authorization_revoked" if change == "revoke" else "evidence_changed")

    def test_capture_revocation_during_request_prevents_success(self):
        self.row()
        entered, release, revoked = Event(), Event(), Event()
        def block(data):
            entered.set()
            self.assertTrue(release.wait(3))
            return json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [data["records"][0]["observation_id"]]}]})
        self.gateway.response = block
        outputs = []
        request_thread = Thread(target=lambda: outputs.append(self.service.generate(self.request)))
        revoke_thread = Thread(target=lambda: (self.store.revoke(), revoked.set()))
        request_thread.start()
        self.assertTrue(entered.wait(3))
        revoke_thread.start()
        try:
            self.assertTrue(self.store._revocation_requested.wait(3))
            self.assertTrue(revoked.wait(.5))
        finally:
            release.set()
            request_thread.join(3)
            revoke_thread.join(3)
        self.assertFalse(request_thread.is_alive())
        self.assertFalse(revoke_thread.is_alive())
        self.assertEqual(outputs[0]["reason"], "authorization_revoked")
        self.assertEqual(outputs[0]["conclusions"], [])

    def test_deleted_expired_modified_or_missing_evidence_during_call_discards_output(self):
        event, evidence = self.row()
        original = self.store.review_records(*self.request.window())[0]
        for change in ("delete", "expire", "summary", "missing", "replace"):
            with self.subTest(change=change):
                # Restore this synthetic fixture between variants.
                with self.db() as conn:
                    conn.execute("DELETE FROM context_observations")
                    conn.execute("""INSERT INTO context_observations
                        (id,captured_at,display_id,image_digest,evidence_id,expires_at,state,title,summary,boundary)
                        VALUES(?,?,?,?,?,?,?,?,?,?)""", (event, original["captured_at"], "synthetic_display",
                        original["image_digest"], evidence, original["expires_at"], "ready", original["title"],
                        original["summary"], original["boundary"]))
                path = self.store._media / f"{evidence}.png"
                path.write_bytes(synthetic_probe_png())
                def mutate(data):
                    if change == "delete":
                        self.store.delete_owned(event)
                    elif change == "missing":
                        path.unlink()
                    elif change == "replace":
                        path.write_bytes(b"different synthetic content")
                    else:
                        with self.db() as conn:
                            if change == "expire":
                                conn.execute("UPDATE context_observations SET expires_at=? WHERE id=?", (self.now.isoformat(), event))
                            else:
                                conn.execute("UPDATE context_observations SET summary='changed' WHERE id=?", (event,))
                    return json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [event]}]})
                self.gateway.response = mutate
                result = self.service.generate(self.request)
                self.assertEqual(result["reason"], "evidence_changed")
                self.assertEqual(result["conclusions"], [])

    def test_expiration_by_clock_during_call_discards_output(self):
        event, _ = self.row(expiry=(self.now + timedelta(seconds=1)).isoformat())
        def expire(data):
            self.now += timedelta(seconds=2)
            return json.dumps({"conclusions": [{"text": "合成结论", "observation_ids": [event]}]})
        self.gateway.response = expire
        result = self.service.generate(self.request)
        self.assertEqual(result["reason"], "evidence_changed")
        self.assertEqual(result["conclusions"], [])

    def test_route_is_post_only_and_marks_response_no_store(self):
        from fastapi import Response
        router = create_context_engine_router(self.db, lambda: "strict", self.root, self.gateway, lambda: self.auth)
        routes = [route for route in router.routes if route.path == "/api/context-engine/daily-review"]
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0].methods, {"POST"})
        response = Response()
        result = routes[0].endpoint(self.request, response)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(result["status"], "empty")
        self.assertNotIn("/api/context-engine/daily-review", DEMO_READS)


class DailyReviewHttpTests(unittest.TestCase):
    """Reuse the isolated synthetic HTTP fixture without inheriting its tests."""
    @classmethod
    def setUpClass(cls):
        from app.modules.context_engine.tests.test_local_http import LocalHttpTests
        cls.helper = LocalHttpTests
        LocalHttpTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        cls.helper.tearDownClass.__func__(cls)

    @classmethod
    def fetch(cls, *args, **kwargs):
        return cls.helper.fetch.__func__(cls, *args, **kwargs)

    def test_daily_review_is_session_protected_post_only(self):
        payload = json.dumps({"day": "2000-01-01", "timezone": "UTC", "confirmed": True}).encode()
        path = "/api/context-engine/daily-review"
        self.assertEqual(self.fetch(path, data=payload)[0], 401)
        headers = {"X-OpenButler-Session": self.token, "Content-Type": "application/json"}
        self.assertEqual(self.fetch(path, headers)[0], 405)
        code, body = self.fetch(path, headers, payload)
        self.assertEqual((code, body["status"], body["reason"]), (200, "empty", "no_records"))
        self.assertEqual(body["counts"]["total"], 0)
        self.assertEqual(self.fetch(path, {**headers, "Origin": "https://untrusted.example"}, payload)[0], 403)

    def test_future_bad_day_and_bad_zone_get_422(self):
        headers = {"X-OpenButler-Session": self.token, "Content-Type": "application/json"}
        for payload in ({"day": "9998-01-01", "timezone": "UTC", "confirmed": True},
                        {"day": "2026-02-30", "timezone": "UTC", "confirmed": True},
                        {"day": "2000-01-01", "timezone": "Not/A_Zone", "confirmed": True},
                        {"timezone": "UTC", "confirmed": True}):
            self.assertEqual(self.fetch("/api/context-engine/daily-review", headers,
                                       json.dumps(payload).encode())[0], 422)


if __name__ == "__main__":
    unittest.main()
