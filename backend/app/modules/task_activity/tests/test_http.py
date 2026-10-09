"""Real native HTTP authentication/composition plus desktop IPC route contracts.

Only loopback servers, temporary empty databases, synthetic local tokens, and a
mocked desktop fetch are used. No captures, provider calls, or external writes.
"""

import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler
from uuid import uuid4


class NativeServer:
    def __init__(self, mode="native"):
        self.tmp = tempfile.TemporaryDirectory(prefix="openbutler-tasks-http-")
        self.token = secrets.token_hex(32)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        backend = Path(__file__).resolve().parents[4]
        self.opener = build_opener(ProxyHandler({}))
        env = dict(os.environ, PYTHONPATH=str(backend), OPENBUTLER_DATA_DIR=self.tmp.name,
            OPENBUTLER_SESSION_TOKEN=self.token, OPENBUTLER_DISABLE_SEED_EVENTS="1",
            OPENBUTLER_DEFAULT_PRIVACY_MODE="strict", OPENBUTLER_ALLOWED_ORIGINS="",
            OPENBUTLER_ENABLE_DEMO_DATA="0", OPENBUTLER_DESKTOP="1" if mode == "native" else "0",
            OPENBUTLER_DEPLOY_TARGET="vercel" if mode == "demo" else "local",
            OPENBUTLER_PREVIEW_BUILTIN="1" if mode == "native" else "0")
        self.child = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app",
            "--host", "127.0.0.1", "--port", str(port), "--no-proxy-headers",
            "--no-access-log", "--log-level", "error"], cwd=backend, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if self.fetch("/health")[0] == 200:
                    return
            except (URLError, TimeoutError):
                pass
            if self.child.poll() is not None:
                break
            time.sleep(.05)
        self.close()
        raise RuntimeError("Isolated native task API failed to start")

    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
        self.child.wait(timeout=5)
        self.tmp.cleanup()

    def fetch(self, path, *, method="GET", payload=None, auth=False, headers=None):
        request_headers = dict(headers or {})
        if auth:
            request_headers["X-OpenButler-Session"] = self.token
        data = None
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        request = Request(self.base + path, headers=request_headers, method=method, data=data)
        try:
            with self.opener.open(request, timeout=3) as response:
                return response.status, json.loads(response.read()), {key.lower(): value for key, value in response.headers.items()}
        except HTTPError as error:
            return error.code, json.loads(error.read()), {key.lower(): value for key, value in error.headers.items()}

    def rows(self, sql):
        conn = sqlite3.connect(Path(self.tmp.name) / "openbutler.sqlite3")
        try:
            return conn.execute(sql).fetchall()
        finally:
            conn.close()


class NativeTaskHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = NativeServer()
        cls.addClassCleanup(cls.server.close)

    def test_private_task_reads_and_mutations_require_local_session(self):
        routes = [("GET", "/api/tasks"), ("GET", "/api/task-activity/settings"),
            ("GET", "/api/task-activity/activities"), ("GET", "/api/task-activity/discoveries"),
            ("POST", "/api/tasks"), ("POST", "/api/task-activity/sync"),
            ("PUT", "/api/task-activity/settings")]
        for method, route in routes:
            with self.subTest(method=method, route=route):
                status, body, headers = self.server.fetch(route, method=method,
                                                        payload={} if method != "GET" else None)
                self.assertEqual((status, body["detail"]), (401, "local_session_required"))
                self.assertIn("no-store", headers["cache-control"])
        status, body, _ = self.server.fetch("/api/tasks", headers={"X-OpenButler-Session": "0" * 64})
        self.assertEqual((status, body["detail"]), (401, "local_session_required"))

    def test_valid_token_does_not_override_untrusted_origin(self):
        status, body, _ = self.server.fetch("/api/tasks", auth=True,
                                          headers={"Origin": "https://untrusted.invalid"})
        self.assertEqual((status, body["detail"]), (403, "origin_not_allowed"))

    def test_manual_http_create_idempotency_conflict_detail_and_completion(self):
        request = {"command_id": str(uuid4()), "title": "Public HTTP task", "priority": "high",
                   "due_at": "2026-10-20T12:00:00+00:00"}
        status, created, headers = self.server.fetch("/api/tasks", method="POST", payload=request, auth=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers["cache-control"], "private, no-store")
        self.assertEqual(created["status"], "todo")
        self.assertEqual(self.server.fetch("/api/tasks", method="POST", payload=request, auth=True)[1], created)
        status, body, _ = self.server.fetch("/api/tasks", method="POST", auth=True,
                                           payload={**request, "title": "Conflicting HTTP task"})
        self.assertEqual((status, body["detail"]), (409, "command_conflict"))
        route = "/api/tasks/" + created["id"]
        status, detail, headers = self.server.fetch(route, auth=True)
        self.assertEqual(status, 200)
        self.assertEqual(detail["task"], created)
        self.assertEqual(detail["time"]["total_seconds"], 0)
        self.assertEqual(headers["cache-control"], "private, no-store")
        status, done, _ = self.server.fetch(route, method="PATCH", auth=True,
            payload={"expected_version": created["version"], "status": "done"})
        self.assertEqual((status, done["status"]), (200, "done"))
        self.assertIsNotNone(done["completed_at"])
        status, body, _ = self.server.fetch(route, method="PATCH", auth=True,
            payload={"expected_version": created["version"], "title": "Stale write"})
        self.assertEqual((status, body["detail"]), (409, "version_conflict"))

    def test_http_rejects_untrusted_fields_uuid_and_naive_date(self):
        base = {"command_id": str(uuid4()), "title": "Public rejected request"}
        for changes in ({"command_id": "not-uuid"}, {"created_by": "assistant"}, {"status": "done"},
                        {"due_at": "2026-10-20T12:00:00"}, {"source_record_id": str(uuid4())}):
            with self.subTest(changes=changes):
                self.assertEqual(self.server.fetch("/api/tasks", method="POST", auth=True,
                                                  payload={**base, **changes})[0], 422)
        self.assertEqual(self.server.fetch("/api/tasks/task_" + "a" * 32, method="DELETE", auth=True)[0], 405)

    def test_discovery_is_off_without_capture_side_effects(self):
        before = self.server.rows("SELECT * FROM context_capture_settings")
        status, settings, _ = self.server.fetch("/api/task-activity/settings", auth=True)
        self.assertEqual(status, 200)
        self.assertFalse(settings["auto_discovery"])
        self.assertIn("model_discovery_available", settings)
        status, result, _ = self.server.fetch("/api/task-activity/sync", method="POST", auth=True,
            payload={"command_id": str(uuid4()), "expected_version": settings['version']})
        self.assertEqual(status, 200)
        self.assertEqual((result['operation']['state'], result['operation']['reason'],
                          result['operation']['processed']), ('complete', 'disabled', 0))
        status, body, _ = self.server.fetch("/api/task-activity/settings", method="PUT", auth=True,
            payload={"expected_version": settings["version"], "auto_discovery": True, "confirmed": False})
        self.assertEqual((status, body["detail"]), (403, "discovery_consent_required"))
        self.assertEqual(self.server.rows("SELECT * FROM context_capture_settings"), before)
        self.assertEqual(self.server.rows("SELECT * FROM context_observations"), [])

    def test_fresh_native_composition_installs_source_invalidation_triggers(self):
        triggers = {row[0] for row in self.server.rows("SELECT name FROM sqlite_master WHERE type='trigger'")}
        self.assertTrue({"work_source_delete", "work_source_revoke"} <= triggers)

    def test_http_manual_activity_link_resource_checkpoint_and_archive(self):
        task = self.server.fetch("/api/tasks", method="POST", auth=True,
            payload={"command_id": str(uuid4()), "title": "HTTP linked public work"})[1]
        route = "/api/tasks/" + task["id"]
        activity = self.server.fetch("/api/task-activity/activities", method="POST", auth=True,
            payload={"command_id": str(uuid4()), "title": "Past manual public activity",
                     "start_at": "2026-01-01T00:00:00+00:00", "end_at": "2026-01-01T00:05:00+00:00"})[1]
        status, task, _ = self.server.fetch(route + "/activities/" + activity["id"], method="PUT", auth=True,
            payload={"expected_version": task["version"], "relation": "work", "decision": "accepted", "primary": True})
        self.assertEqual(status, 200)
        status, task, _ = self.server.fetch(route + "/resources", method="POST", auth=True,
            payload={"command_id": str(uuid4()), "expected_version": task["version"], "kind": "url",
                     "label": "Public reference", "reference": "https://example.invalid/public"})
        self.assertEqual(status, 200)
        status, task, _ = self.server.fetch(route + "/checkpoint", method="PUT", auth=True,
            payload={"expected_version": task["version"], "next_step": "Resume public notes"})
        self.assertEqual(status, 200)
        detail = self.server.fetch(route, auth=True)[1]
        self.assertEqual(detail["time"]["total_seconds"], 300)
        self.assertEqual(detail["checkpoint"]["next_step"], "Resume public notes")
        self.assertEqual(detail["resources"][0]["reference"], "https://example.invalid/public")
        status, _, _ = self.server.fetch(route, method="PATCH", auth=True,
            payload={"expected_version": task["version"], "archived": True})
        self.assertEqual(status, 200)
        self.assertNotIn(task["id"], [t["id"] for t in self.server.fetch("/api/tasks", auth=True)[1]["items"]])
        self.assertIn(task["id"], [t["id"] for t in self.server.fetch("/api/tasks?include_archived=true", auth=True)[1]["items"]])


class TaskMountBoundaryTests(unittest.TestCase):
    def test_nonpreview_local_mode_does_not_mount_task_routes_or_initialize_task_tables(self):
        server = NativeServer("local")
        self.addCleanup(server.close)
        for route in ("/api/tasks", "/api/task-activity/settings", "/api/task-activity/activities"):
            self.assertEqual(server.fetch(route, auth=True)[0], 404)
        self.assertEqual(server.rows("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'work_*'"), [])

    def test_demo_mode_denies_private_task_reads_and_writes_and_has_no_task_tables(self):
        server = NativeServer("demo")
        self.addCleanup(server.close)
        for method, route in (("GET", "/api/tasks"), ("POST", "/api/tasks"),
                              ("GET", "/api/task-activity/settings"), ("POST", "/api/task-activity/sync")):
            status, body, _ = server.fetch(route, method=method, auth=True)
            self.assertEqual((status, body["detail"]), (403, "demo_read_only"))
        self.assertEqual(server.rows("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'work_*'"), [])


class DesktopTaskIpcTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is required for desktop IPC contract")
    def test_trusted_ipc_exposes_only_bounded_task_routes_and_owns_session_header(self):
        repo = Path(__file__).resolve().parents[5]
        script = r'''
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {createLocalApiRequest} = require(path.resolve("desktop/src/local-api.cjs"));
const indexPath = path.resolve("synthetic-index.html");
const frame = {url: pathToFileURL(indexPath).href};
const contents = {mainFrame: frame, isDestroyed: () => false};
const window = {webContents: contents, isDestroyed: () => false};
const event = {sender: contents, senderFrame: frame};
const calls = [];
const request = createLocalApiRequest({getWindow: () => window,
  getFrontendIndexPath: () => indexPath, getBackendState: () => ({apiBase: "http://127.0.0.1:8123", running: true}),
  getSessionToken: () => "a".repeat(64), fetchImpl: async (...args) => {
    calls.push(args); return {ok: true, status: 200, redirected: false, text: async () => "{}"};
  }});
const task = "task_" + "a".repeat(32), activity = "activity_" + "b".repeat(32), discovery = "discovery_" + "c".repeat(32);
(async () => {
  for (const [method, route] of [["GET", "/api/tasks"], ["POST", "/api/tasks"],
    ["GET", `/api/tasks/${task}`], ["PATCH", `/api/tasks/${task}`],
    ["PUT", `/api/tasks/${task}/activities/${activity}`], ["PUT", `/api/tasks/${task}/checkpoint`],
    ["PUT", `/api/tasks/${task}/runtime-goal`], ["POST", `/api/tasks/${task}/resources`],
    ["POST", `/api/tasks/${task}/merge`], ["POST", `/api/tasks/${task}/unmerge`],
    ["GET", "/api/task-activity/settings"], ["PUT", "/api/task-activity/settings"],
    ["GET", "/api/task-activity/activities"], ["POST", "/api/task-activity/activities"],
    ["GET", "/api/task-activity/discoveries"], ["POST", `/api/task-activity/discoveries/${discovery}/resolve`],
    ["POST", "/api/task-activity/sync"]]) {
    assert.equal((await request(event, route, {method})).ok, true, method + " " + route);
  }
  const admitted = calls.length;
  assert.ok(admitted > 0);
  assert.equal(calls[0][1].headers["X-OpenButler-Session"], "a".repeat(64));
  for (const [method, route] of [["DELETE", `/api/tasks/${task}`], ["POST", `/api/tasks/${task}/execute`],
    ["POST", "/api/task-activity/capture"], ["GET", "/api/task-activity/evidence"],
    ["POST", "/api/task-activity/admin"], ["POST", `/api/tasks/${task}/checkpoint`],
    ["PUT", `/api/tasks/${task}/priority`], ["GET", "/api/tasks/arbitrary-id"],
    ["POST", `/api/task-activity/discoveries/${discovery}/resolve/extra`]]) {
    assert.equal((await request(event, route, {method})).status, 400, method + " " + route);
  }
  assert.equal((await request(event, "/api/tasks", {headers: {"X-OpenButler-Session": "injected"}})).status, 400);
  frame.url = "https://untrusted.invalid";
  assert.equal((await request(event, "/api/tasks")).status, 403);
  assert.equal(calls.length, admitted);
})().catch(error => {console.error(error); process.exitCode = 1;});
'''
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=repo,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
