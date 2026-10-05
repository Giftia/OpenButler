"""Real ASGI/HTTP boundary on an isolated synthetic desktop store."""

import json
import base64
from datetime import datetime, timezone
from io import BytesIO
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler

from PIL import Image

from app.modules.context_engine.tests.capture_fixture import (
    public_window_provenance, seed_historical_observation, seed_legacy_capture_settings,
)
from app.modules.context_engine.tests.test_capture import ClosingConnection


class LocalHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="openbutler-auth-test-")
        cls.token = secrets.token_hex(32)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{port}"
        backend = Path(__file__).resolve().parents[4]
        env = dict(os.environ, PYTHONPATH=str(backend), OPENBUTLER_DESKTOP="1",
                   OPENBUTLER_DATA_DIR=cls.tmp.name, OPENBUTLER_SESSION_TOKEN=cls.token,
                   OPENBUTLER_DISABLE_SEED_EVENTS="1", OPENBUTLER_DEFAULT_PRIVACY_MODE="strict",
                   OPENBUTLER_DEPLOY_TARGET="local", OPENBUTLER_ALLOWED_ORIGINS="",
                   OPENBUTLER_ENABLE_DEMO_DATA="0", OPENBUTLER_PREVIEW_BUILTIN="1")
        cls.child = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
             "--port", str(port), "--no-proxy-headers", "--no-access-log", "--log-level", "error"],
            cwd=backend, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cls.opener = build_opener(ProxyHandler({}))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if cls.fetch("/health")[0] == 200:
                    return
            except (URLError, TimeoutError):
                pass
            if cls.child.poll() is not None:
                break
            time.sleep(0.1)
        cls.child.terminate()
        cls.child.wait(timeout=5)
        cls.tmp.cleanup()
        raise RuntimeError("Isolated local API did not start")

    @classmethod
    def tearDownClass(cls):
        cls.child.terminate()
        cls.child.wait(timeout=5)
        cls.tmp.cleanup()

    @classmethod
    def fetch(cls, path, headers=None, data=None):
        try:
            with cls.opener.open(Request(cls.base + path, headers=headers or {}, data=data), timeout=2) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_private_route_and_write_require_token(self):
        self.assertEqual(self.fetch("/api/events")[0], 401)
        self.assertEqual(self.fetch("/api/events/simulate", data=b"{}")[0], 401)
        code, body = self.fetch("/api/events", {"X-OpenButler-Session": self.token})
        self.assertEqual(code, 200)
        self.assertEqual(body["count"], 0)

    def test_preview_cannot_query_or_import_legacy_minecontext(self):
        headers = {"X-OpenButler-Session": self.token}
        for path in ("/api/pc-activity/minecontext/status",
                     "/api/pc-activity/minecontext/search",
                     "/api/butler/import/pc-activity/preview"):
            code, body = self.fetch(path, headers, b"{}" if not path.endswith("status") else None)
            self.assertEqual((code, body["detail"]), (403, "legacy_source_disabled"))

    def test_origin_rejected_before_endpoint_even_with_valid_token(self):
        code, body = self.fetch("/api/events", {
            "X-OpenButler-Session": self.token, "Origin": "https://untrusted.example"})
        self.assertEqual(code, 403)
        self.assertEqual(body["detail"], "origin_not_allowed")

    def test_health_and_desktop_status_remain_redacted(self):
        code, health = self.fetch("/health")
        self.assertEqual((code, health["privacy_mode"]), (200, "strict"))
        code, status = self.fetch("/api/desktop/status", {"X-OpenButler-Session": self.token})
        self.assertEqual(code, 200)
        self.assertNotIn(self.token, json.dumps(status))
        self.assertNotIn(self.tmp.name, json.dumps(status))

    def test_engine_status_and_audit_are_private_and_metadata_only(self):
        for route in ("/api/context-engine/status", "/api/privacy/activity"):
            self.assertEqual(self.fetch(route)[0], 401)
            code, body = self.fetch(route, {"X-OpenButler-Session": self.token})
            self.assertEqual(code, 200)
            serialized = json.dumps(body)
            for forbidden in (self.token, self.tmp.name, "screenshot_path", "raw_ref", "apiKey", "payload"):
                self.assertNotIn(forbidden, serialized)
        self.assertEqual(body["entries"], [])
        code, status = self.fetch("/api/context-engine/status", {"X-OpenButler-Session": self.token})
        self.assertEqual(status["state"], "foundation_only")
        self.assertTrue(status["capture_available"])
        self.assertFalse(status["full_desktop_available"])
        self.assertEqual(status["full_desktop_reason"], "full_desktop_unavailable")
        self.assertEqual(status["supported_capture_scopes"], ["dedicated_public_window"])
        self.assertFalse(status["recording"]["configured"])
        self.assertTrue(status["model_routes_available"])

    def test_full_desktop_requests_are_rejected_even_with_valid_session(self):
        headers = {"X-OpenButler-Session": self.token, "Content-Type": "application/json"}
        before = self.fetch("/api/context-engine/status", headers)[1]["recording"]
        for source in ({}, {"source_kind": "full_screen", "capture_scope": "full_screen"}):
            settings = {"display_id": "synthetic_display", "excluded_apps": ["password-manager"],
                        "confirmed": True, **source}
            code, body = self.fetch("/api/context-engine/capture/configure", headers, json.dumps(settings).encode())
            self.assertEqual((code, body["detail"]), (403, "full_desktop_unavailable"))
            output = BytesIO()
            Image.new("RGB", (24, 24), "black").save(output, format="PNG")
            event = {"display_id": "synthetic_display", "captured_at": datetime.now(timezone.utc).isoformat(),
                     "masked_png_base64": base64.b64encode(output.getvalue()).decode(),
                     "local_ocr_complete": True, "masks_applied": True,
                     "source_verified_before": True, "source_verified_after": True, **source}
            code, body = self.fetch("/api/context-engine/observations", headers, json.dumps(event).encode())
            self.assertEqual((code, body["detail"]), (403, "full_desktop_unavailable"))
        self.assertEqual(self.fetch("/api/context-engine/status", headers)[1]["recording"], before)

    def test_synthetic_capture_requires_session_consent_and_keeps_unready_state(self):
        headers = {"X-OpenButler-Session": self.token, "Content-Type": "application/json"}
        metadata = public_window_provenance(datetime.now(timezone.utc), width=24, height=24)
        settings = {**metadata, "display_id": "x11:100", "excluded_apps": ["password-manager"],
                    "masks": [], "confirmed": True}
        payload = json.dumps(settings).encode()
        self.assertEqual(self.fetch("/api/context-engine/capture/configure", data=payload)[0], 401)
        code, configured = self.fetch("/api/context-engine/capture/configure", headers, payload)
        self.assertEqual(code, 200)
        self.assertEqual(self.fetch("/api/context-engine/capture/start", headers, b"{}")[0], 200)
        self.assertTrue(self.fetch("/api/context-engine/status", headers)[1]["recording"]["active"])
        output = BytesIO()
        Image.new("RGB", (24, 24), "black").save(output, format="PNG")
        event = {**metadata, "display_id": "x11:100", "captured_at": datetime.now(timezone.utc).isoformat(),
                 "consent_revision": configured["consent_revision"], "source_verified_before": True,
                 "source_verified_after": True, "sampling_sequence": 1, "sampling_gap_ms": 0,
                 "masked_png_base64": base64.b64encode(output.getvalue()).decode(),
                 "local_ocr_complete": False, "masks_applied": True}
        code, body = self.fetch("/api/context-engine/observations", headers, json.dumps(event).encode())
        self.assertEqual(code, 403, body)
        event["local_ocr_complete"] = True
        code, saved = self.fetch("/api/context-engine/observations", headers, json.dumps(event).encode())
        self.assertEqual(code, 200)
        self.assertTrue(saved["recorded"])
        self.assertFalse(saved["organized"])
        # Ingestion returns before model work. Wait only for this bounded test's terminal record.
        import time
        deadline = time.monotonic() + 3
        while True:
            record = self.fetch("/api/context-engine/observations", headers)[1]["items"][0]
            if record["state"] == "model_unavailable" or time.monotonic() >= deadline:
                break
            time.sleep(.01)
        self.assertEqual(record["state"], "model_unavailable")
        self.assertEqual(record["processing_reason"], "model_unavailable")
        self.assertNotIn(self.tmp.name, json.dumps(record))
        initial = self.fetch("/api/context-engine/observations", headers)[1]
        self.assertEqual(initial["coverage_events"][0]["kind"], "started")
        self.assertEqual(initial["coverage_events"][0]["first_sample_at"], event["captured_at"])
        self.assertEqual(self.fetch("/api/context-engine/capture/pause", headers,
            b'{"reason":"unbounded native window error"}')[0], 422)
        self.assertTrue(self.fetch("/api/context-engine/status", headers)[1]["recording"]["active"])
        self.assertEqual(self.fetch("/api/context-engine/capture/pause", headers, b"{}")[0], 200)
        self.assertEqual(self.fetch("/api/context-engine/capture/pause", headers, b"{}")[0], 200)
        self.assertFalse(self.fetch("/api/context-engine/status", headers)[1]["recording"]["active"])
        paused = self.fetch("/api/context-engine/observations", headers)[1]
        self.assertEqual(paused["count"], 1)
        self.assertEqual([item["kind"] for item in paused["coverage_events"]], ["paused", "started"])
        self.assertEqual(paused["coverage_events"][0]["reason"], "user_paused")
        self.assertIsNone(paused["coverage_events"][0]["gap_end_at"])
        self.assertEqual(self.fetch("/api/context-engine/observations")[0], 401)

    def test_z_stale_desktop_consent_cannot_restart_through_authenticated_api(self):
        headers = {"X-OpenButler-Session": self.token, "Content-Type": "application/json"}
        connect = lambda: sqlite3.connect(Path(self.tmp.name) / "openbutler.sqlite3", factory=ClosingConnection)
        with connect() as conn:
            previous = conn.execute("SELECT * FROM context_capture_settings WHERE id=1").fetchone()
        try:
            for active in (False, True):
                seed_legacy_capture_settings(connect, active=active)
                event = seed_historical_observation(connect, datetime.now(timezone.utc))
                with connect() as conn:
                    before = conn.execute("SELECT * FROM context_capture_settings WHERE id=1").fetchone()
                    history = conn.execute("SELECT * FROM context_observations").fetchall()
                    coverage = conn.execute("SELECT * FROM context_capture_coverage").fetchall()
                code, body = self.fetch("/api/context-engine/capture/start", headers, b"{}")
                self.assertEqual((code, body["detail"]), (403, "full_desktop_unavailable"))
                code, body = self.fetch(f"/api/context-engine/observations/{event}/retry", headers, b"{}")
                self.assertEqual((code, body), (200,
                    {"ok": False, "queued": False, "reason": "full_desktop_unavailable"}))
                self.assertFalse(self.fetch("/api/context-engine/status", headers)[1]["recording"]["active"])
                with connect() as conn:
                    self.assertEqual(conn.execute("SELECT * FROM context_capture_settings WHERE id=1").fetchone(), before)
                    self.assertEqual(conn.execute("SELECT * FROM context_observations").fetchall(), history)
                    self.assertEqual(conn.execute("SELECT * FROM context_capture_coverage").fetchall(), coverage)
        finally:
            with connect() as conn:
                if previous is None:
                    conn.execute("DELETE FROM context_capture_settings WHERE id=1")
                else:
                    conn.execute("INSERT OR REPLACE INTO context_capture_settings VALUES (" +
                                 ",".join("?" for _ in previous) + ")", previous)


if __name__ == "__main__":
    unittest.main()
