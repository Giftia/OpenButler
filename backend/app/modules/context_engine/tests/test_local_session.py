import asyncio
import json
import unittest

from app.security.local_session import LocalSessionMiddleware, LocalSessionPolicy
from app.security.origin_policy import OriginPolicy

TOKEN = "a" * 64


def request(policy, path="/api/events", method="GET", token=None, origin=None,
            host="127.0.0.1:8000", peer="127.0.0.1", extra=()):
    headers = [(b"host", host.encode())]
    if token is not None:
        headers.append((b"x-openbutler-session", token.encode()))
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    headers.extend(extra)
    messages, called = [], []

    async def downstream(scope, receive, send):
        called.append(True)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    async def send(message):
        messages.append(message)

    scope = dict(type="http", path=path, method=method, headers=headers,
                 client=(peer, 1234), server=("127.0.0.1", 8000), scheme="http",
                 query_string=b"", http_version="1.1")
    asyncio.run(LocalSessionMiddleware(downstream, policy)(scope, None, send))
    return messages[0]["status"], bool(called), str(messages)


class LocalSessionTests(unittest.TestCase):
    def setUp(self):
        self.policy = LocalSessionPolicy("local", TOKEN, OriginPolicy.local())

    def test_missing_invalid_valid_and_missing_server_token(self):
        for token in (None, "bad", "b" * 64):
            self.assertEqual(request(self.policy, token=token)[:2], (401, False))
        self.assertEqual(request(self.policy, token=TOKEN)[:2], (200, True))
        empty = LocalSessionPolicy("local", None, OriginPolicy.local())
        self.assertEqual(request(empty, token=TOKEN)[:2], (503, False))

    def test_origin_host_and_peer_fail_closed_even_with_token(self):
        for changes in ({"origin": "https://evil.example"}, {"origin": "null"},
                        {"origin": "http://localhost:9999"}, {"host": "evil.example"},
                        {"peer": "192.0.2.1"}, {"host": "localhost.evil.example"}):
            with self.subTest(changes=changes):
                self.assertEqual(request(self.policy, token=TOKEN, **changes)[:2], (403, False))
        self.assertEqual(request(self.policy, token=TOKEN, origin="http://localhost:5175")[0], 200)

    def test_sensitive_gets_writes_and_docs_are_protected(self):
        for path in ("/api/desktop/status", "/api/pc-activity/minecontext/status",
                     "/api/context-engine/status", "/openapi.json", "/docs"):
            self.assertEqual(request(self.policy, path=path)[0], 401)
        self.assertEqual(request(self.policy, method="POST")[0], 401)
        self.assertEqual(request(self.policy, path="/health")[0], 200)
        self.assertEqual(request(self.policy, path="/health", method="POST")[0], 401)

    def test_preflight_only_allowed_origin_and_no_duplicate_credentials(self):
        self.assertEqual(request(self.policy, method="OPTIONS", origin="http://localhost:5175")[0], 200)
        self.assertEqual(request(self.policy, method="OPTIONS", origin="https://evil.example")[0], 403)
        self.assertEqual(request(self.policy, token=TOKEN,
                                 extra=[(b"x-openbutler-session", TOKEN.encode())])[0], 403)

    def test_old_token_rejected_and_no_token_in_failure_or_repr(self):
        rotated = LocalSessionPolicy("local", "b" * 64, OriginPolicy.local())
        code, _, output = request(rotated, token=TOKEN)
        self.assertEqual(code, 401)
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(TOKEN, repr(self.policy))

    def test_demo_read_allowlist_never_opens_local_sources_or_writes(self):
        policy = LocalSessionPolicy.from_environ({"OPENBUTLER_DEPLOY_TARGET": "vercel"})
        self.assertEqual(request(policy, path="/api/butler/home", host="openbutler.vercel.app", peer="192.0.2.1")[0], 200)
        for path in ("/api/context-engine/status", "/api/pc-activity/minecontext/status", "/api/vision/cameras"):
            self.assertEqual(request(policy, path=path, host="openbutler.vercel.app")[0], 403)
        self.assertEqual(request(policy, path="/api/events/simulate", method="POST", host="openbutler.vercel.app")[0], 403)

    def test_desktop_overrides_inherited_cloud_mode(self):
        policy = LocalSessionPolicy.from_environ({"OPENBUTLER_DEPLOY_TARGET": "vercel", "OPENBUTLER_DESKTOP": "1"})
        self.assertEqual(policy.mode, "local")
        self.assertEqual(request(policy)[0], 503)

    def test_origin_config_cannot_enable_wildcards_or_remote_local_origins(self):
        for value in ("*", "https://evil.example", "http://localhost:5175/path"):
            with self.assertRaises(ValueError):
                OriginPolicy.local(value)


if __name__ == "__main__":
    unittest.main()
