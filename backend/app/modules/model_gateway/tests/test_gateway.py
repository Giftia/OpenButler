"""Synthetic wire tests; never contact a model or read source data."""

import base64
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import threading
import unittest
from unittest.mock import patch
import zlib

from app.modules.model_gateway import CallAuthorization, Gateway, ModelRoute, RouteError
from app.modules.model_gateway.gateway import synthetic_probe_png, _pinned_address
from app.modules.context_engine.privacy import AuditedPrivacyGuard
from app.security.privacy_guard import PrivacyGuard

class MockHandler(BaseHTTPRequestHandler):
    requests = []
    redirect = False
    bad_text = False
    bad_image = False

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append((self.path, body, dict(self.headers)))
        if self.redirect:
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/steal")
            self.end_headers()
            return
        is_openai = self.path.endswith("/chat/completions")
        is_image = (isinstance(body["messages"][0]["content"], list) if is_openai
                    else "images" in body["messages"][0])
        answer = "TEST 42" if is_image else "READY"
        if self.bad_image and is_image:
            answer = "cannot read"
        if self.bad_text and not is_image:
            answer = ""
        result = ({"choices": [{"message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}]} if is_openai
                  else {"message": {"role": "assistant", "content": answer}, "done": True, "done_reason": "stop"})
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        MockHandler.requests = []
        MockHandler.redirect = False
        MockHandler.bad_text = False
        MockHandler.bad_image = False
        self.auth = CallAuthorization(authorized=True)
        self.png = synthetic_probe_png()

    def route(self, protocol, model="synthetic"):
        endpoint = self.base + ("/v1" if protocol == "openai_compatible" else "")
        return ModelRoute(protocol, "local", endpoint, model)

    def test_independent_text_probe_preserves_image_route_and_exact_revision(self):
        gateway = Gateway(PrivacyGuard())
        image, first = self.route("openai_compatible", "image"), self.route("openai_compatible", "text")
        gateway.configure(image=image, text=first, auth=self.auth)
        revision = gateway.configure_text(text=self.route("ollama_native", "replacement"), auth=self.auth)
        self.assertEqual(revision, 2)
        self.assertIs(gateway._routes["image"], image)
        self.assertEqual(gateway._routes["text"].model, "replacement")
        self.assertTrue(gateway.text_ready)
        self.assertTrue(gateway.status().ready)
        self.assertEqual(len(MockHandler.requests), 3)
        self.assertNotIn("images", MockHandler.requests[-1][1]["messages"][0])
        MockHandler.bad_text = True
        with self.assertRaises(RouteError):
            gateway.configure_text(text=first, auth=self.auth)
        self.assertEqual(gateway.configuration_revision, revision)
        self.assertEqual(gateway._routes["text"].model, "replacement")
        self.assertIs(gateway._routes["image"], image)

    def test_configuration_revision_changes_only_when_pair_activates(self):
        gateway = Gateway(PrivacyGuard())
        self.assertEqual(gateway.configuration_revision, 0)
        route = self.route("openai_compatible")
        gateway.configure(image=route, text=route, auth=self.auth)
        self.assertEqual(gateway.configuration_revision, 1)
        with self.assertRaises(AttributeError):
            gateway.configuration_revision = 99
        MockHandler.bad_text = True
        with self.assertRaises(RouteError):
            gateway.configure(image=route, text=route, auth=self.auth)
        self.assertEqual(gateway.configuration_revision, 1)
        MockHandler.bad_text = False
        gateway.configure(image=route, text=self.route("openai_compatible", "replacement"), auth=self.auth)
        self.assertEqual(gateway.configuration_revision, 2)

    def test_runtime_dispatch_serializes_mode_commit_and_rechecks_stale_auth(self):
        lock = threading.RLock()
        mode = {"value": "basic"}
        entered, release, committed = threading.Event(), threading.Event(), threading.Event()
        sends = []
        errors = []
        class BlockingGuard(PrivacyGuard):
            def require(self, request):
                if request.mode == "basic":
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("synthetic guard timed out")
                return super().require(request)
        class SyntheticTransport:
            def post(self, route, payload):
                sends.append(committed.is_set())
                return {"choices": [{"message": {"content": "READY"}}]}
        gateway = Gateway(BlockingGuard(), SyntheticTransport(),
                          privacy_mode_getter=lambda: mode["value"], dispatch_lock=lock)
        route = ModelRoute("openai_compatible", "custom", "https://example.com/v1", "synthetic")
        gateway._configuration = (1, {"image": route, "text": route})
        auth = CallAuthorization(privacy_mode="basic", authorized=True, redacted=True)
        def call():
            try:
                gateway.call_text("synthetic", auth)
            except Exception as error:
                errors.append(error)
        def switch():
            with lock:
                mode["value"] = "strict"
                committed.set()
        caller = threading.Thread(target=call)
        changer = threading.Thread(target=switch)
        caller.start()
        self.assertTrue(entered.wait(3))
        changer.start()
        try:
            self.assertFalse(committed.wait(.05))
        finally:
            release.set()
            caller.join(3)
            changer.join(3)
        self.assertFalse(caller.is_alive())
        self.assertFalse(changer.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(committed.is_set())
        self.assertEqual(sends, [False])
        with self.assertRaisesRegex(PermissionError, "strict_mode_forbidden"):
            gateway.call_text("synthetic after commit", auth)
        with self.assertRaisesRegex(PermissionError, "strict_mode_forbidden"):
            gateway.call_image("synthetic after commit", self.png, auth)
        self.assertEqual(sends, [False])

    def test_waiting_runtime_selects_current_route_and_bound_review_never_posts(self):
        waiting = {"bound-review": threading.Event(), "ordinary-call": threading.Event()}
        class ObservedRLock:
            def __init__(self):
                self.lock = threading.RLock()
            def __enter__(self):
                event = waiting.get(threading.current_thread().name)
                if event is not None:
                    event.set()
                return self.lock.__enter__()
            def __exit__(self, *args):
                return self.lock.__exit__(*args)
        lock = ObservedRLock()
        posts = []
        outcomes = {}
        class SyntheticTransport:
            def post(self, route, payload):
                posts.append(route.model)
                return {"choices": [{"message": {"content": "READY"}}]}
        gateway = Gateway(PrivacyGuard(), SyntheticTransport(),
                          privacy_mode_getter=lambda: "basic", dispatch_lock=lock)
        old = ModelRoute("openai_compatible", "custom", "https://example.com/v1", "recipient-a")
        new = ModelRoute("openai_compatible", "custom", "https://example.net/v1", "recipient-b")
        gateway._configuration = (1, {"image": old, "text": old})
        auth = CallAuthorization(privacy_mode="basic", authorized=True, redacted=True)
        def call(name, revision):
            try:
                outcomes[name] = gateway.call_text("synthetic", auth,
                    expected_configuration_revision=revision)
            except PermissionError as error:
                outcomes[name] = str(error)
        bound = threading.Thread(target=call, name="bound-review", args=("bound", 1))
        ordinary = threading.Thread(target=call, name="ordinary-call", args=("ordinary", None))
        with lock:
            bound.start()
            ordinary.start()
            self.assertTrue(waiting["bound-review"].wait(3))
            self.assertTrue(waiting["ordinary-call"].wait(3))
            # Pure synthetic successful probes, followed by real atomic publish.
            with patch.object(gateway, "validate_route"):
                gateway.configure(image=new, text=new, auth=auth)
            self.assertEqual(posts, [])
        bound.join(3)
        ordinary.join(3)
        self.assertFalse(bound.is_alive())
        self.assertFalse(ordinary.is_alive())
        self.assertEqual(outcomes, {"bound": "authorization_revoked", "ordinary": "READY"})
        self.assertEqual(posts, ["recipient-b"])
        with self.assertRaisesRegex(PermissionError, "authorization_revoked"):
            gateway.call_image("synthetic stale image", self.png, auth, expected_configuration_revision=1)
        self.assertEqual(posts, ["recipient-b"])

    def test_synthetic_probe_keeps_explicit_proposed_mode(self):
        class SyntheticTransport:
            def post(self, route, payload):
                return {"choices": [{"message": {"content": "READY"}}]}
        gateway = Gateway(PrivacyGuard(), SyntheticTransport(), privacy_mode_getter=lambda: "strict")
        route = ModelRoute("openai_compatible", "custom", "https://example.com/v1", "synthetic")
        gateway.validate_route(target="text", route=route,
            auth=CallAuthorization(privacy_mode="basic", authorized=True, redacted=True))

    def test_png_is_actual_legible_raster_not_text_substitute(self):
        self.assertEqual(self.png[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", self.png[16:24])
        self.assertGreaterEqual(width, 200)
        self.assertEqual(height, 45)
        pixels = zlib.decompress(self.png[41:-16])
        self.assertEqual(len(pixels), height * (1 + width * 3))
        self.assertEqual(pixels[5 * (1 + width * 3) + 5 * 3 + 1:][:3], b"\x00\x00\x00")
        self.assertEqual(pixels[0:4], b"\x00\xff\xff\xff")

    def test_openai_compatible_image_and_text_wire_shapes(self):
        gateway = Gateway(PrivacyGuard())
        gateway.configure(image=self.route("openai_compatible"), text=self.route("openai_compatible"),
                          auth=self.auth)
        self.assertTrue(gateway.status().ready)
        self.assertEqual(gateway.call_image("Read it", self.png, self.auth), "TEST 42")
        self.assertEqual(gateway.call_text("Reply", self.auth), "READY")
        path, body, _ = MockHandler.requests[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertFalse(body["stream"])
        self.assertNotIn("think", body)
        data_url = body["messages"][0]["content"][1]["image_url"]["url"]
        self.assertEqual(base64.b64decode(data_url.split(",", 1)[1]), self.png)

    def test_ollama_native_image_and_text_wire_shapes(self):
        gateway = Gateway(PrivacyGuard())
        gateway.configure(image=self.route("ollama_native"), text=self.route("ollama_native"),
                          auth=self.auth)
        self.assertTrue(gateway.status().ready)
        path, body, _ = MockHandler.requests[0]
        self.assertEqual(path, "/api/chat")
        self.assertEqual((body["stream"], body["think"]), (False, False))
        self.assertEqual(base64.b64decode(body["messages"][0]["images"][0]), self.png)
        self.assertNotIn("images", MockHandler.requests[1][1]["messages"][0])

    def test_failed_second_probe_does_not_publish_partial_routes(self):
        MockHandler.bad_text = True
        gateway = Gateway(PrivacyGuard())
        with self.assertRaises(RouteError):
            gateway.configure(image=self.route("ollama_native"), text=self.route("ollama_native"),
                              auth=self.auth)
        status = gateway.status()
        self.assertFalse(status.ready)
        self.assertFalse(status.image_configured)
        self.assertEqual(status.last_attempt, "failed")
        self.assertEqual(status.error_code, "invalid_provider_response")
        with self.assertRaises(RouteError):
            gateway.call_image("Read", self.png, self.auth)

    def test_failed_replacement_keeps_previous_pair(self):
        gateway = Gateway(PrivacyGuard())
        old = self.route("ollama_native", "old-model")
        gateway.configure(image=old, text=old, auth=self.auth)
        MockHandler.bad_text = True
        replacement = self.route("openai_compatible", "new-model")
        with self.assertRaises(RouteError):
            gateway.configure(image=replacement, text=replacement, auth=self.auth)
        self.assertEqual(gateway.status().last_attempt, "failed")
        self.assertTrue(gateway.status().ready)
        MockHandler.bad_text = False
        gateway.call_text("Reply", self.auth)
        self.assertEqual(MockHandler.requests[-1][1]["model"], "old-model")

    def test_incorrect_image_probe_does_not_activate(self):
        MockHandler.bad_image = True
        gateway = Gateway(PrivacyGuard())
        with self.assertRaisesRegex(RouteError, "image_probe_failed"):
            gateway.configure(image=self.route("ollama_native"), text=self.route("ollama_native"),
                              auth=self.auth)
        self.assertEqual(len(MockHandler.requests), 1)
        self.assertFalse(gateway.status().ready)

    def test_redirect_is_not_followed(self):
        MockHandler.redirect = True
        gateway = Gateway(PrivacyGuard())
        with self.assertRaisesRegex(RouteError, "provider_http_error"):
            gateway.configure(image=self.route("ollama_native"), text=self.route("ollama_native"),
                              auth=self.auth)
        self.assertEqual(len(MockHandler.requests), 1)
        self.assertFalse(gateway.status().ready)

    def test_authorization_fails_closed_before_network(self):
        gateway = Gateway(PrivacyGuard())
        with self.assertRaisesRegex(PermissionError, "authorization_required"):
            gateway.configure(image=self.route("ollama_native"), text=self.route("ollama_native"),
                              auth=CallAuthorization())
        self.assertEqual(MockHandler.requests, [])
        self.assertFalse(gateway.status().ready)

    def test_failed_privacy_audit_prevents_network(self):
        class BrokenLedger:
            def append(self, _decision):
                raise OSError("private audit failure")

        gateway = Gateway(AuditedPrivacyGuard(BrokenLedger()))
        with self.assertRaisesRegex(PermissionError, "privacy_audit_unavailable"):
            gateway.configure(image=self.route("ollama_native"), text=self.route("ollama_native"),
                              auth=self.auth)
        self.assertEqual(MockHandler.requests, [])
        self.assertEqual(gateway.status().error_code, "privacy_audit_unavailable")

    def test_endpoint_rejections(self):
        self.assertEqual(ModelRoute("openai_compatible", "custom", "https://example.com/v1", "m").mode,
                         "custom")
        bad_local = ["http://192.168.1.1:11434", "http://localhost.evil.test:11434",
                     "http://127.0.0.1:11434@evil.test:11434", "http://127.0.0.1:11434/path",
                     "http://127.0.0.1:11434?x=1", "http://127.0.0.1:11434/#x"]
        for endpoint in bad_local:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                ModelRoute("ollama_native", "local", endpoint, "m")
        for endpoint in ["http://example.com:443/v1", "https://127.0.0.1:443/v1",
                         "https://10.1.2.3:443/v1", "https://user:secret@example.com:443/v1",
                         "https://example.com:443/v1/%2e%2e"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                ModelRoute("openai_compatible", "custom", endpoint, "m")

    def test_dns_mixed_public_private_answers_are_rejected(self):
        route = ModelRoute("openai_compatible", "custom", "https://example.com:443/v1", "m")
        answers = [(None, None, None, None, ("93.184.215.14", 443)),
                   (None, None, None, None, ("127.0.0.1", 443))]
        with patch("socket.getaddrinfo", return_value=answers):
            with self.assertRaisesRegex(RouteError, "unsafe_endpoint"):
                _pinned_address(route, "example.com", 443)

    def test_external_privacy_and_secret_free_status(self):
        class FakeTransport:
            calls = []

            def post(self, route, payload):
                self.calls.append(payload)
                return {"choices": [{"message": {"content": "TEST 42" if isinstance(
                    payload["messages"][0]["content"], list) else "READY"}}]}

        transport = FakeTransport()
        route = ModelRoute("openai_compatible", "custom", "https://example.com:443/v1", "m",
                           api_key="top-secret")
        gateway = Gateway(PrivacyGuard(), transport)
        for auth, reason in [(CallAuthorization(authorized=True, redacted=True), "strict_mode_forbidden"),
                             (CallAuthorization("basic", True, False), "redaction_required")]:
            with self.assertRaisesRegex(PermissionError, reason):
                gateway.configure(image=route, text=route, auth=auth)
        self.assertEqual(transport.calls, [])
        gateway.configure(image=route, text=route,
                          auth=CallAuthorization("basic", True, True))
        status = asdict(gateway.status())
        self.assertTrue(status["ready"])
        self.assertTrue(status["image_key_present"])
        self.assertNotIn("top-secret", json.dumps(status))
        self.assertNotIn("top-secret", repr(route))


if __name__ == "__main__":
    unittest.main()
