import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from app.modules.model_gateway.gateway import HttpTransport
from app.modules.model_gateway.tests.test_locality import Wire

from app.modules.context_engine.audit import init_privacy_audit
from app.modules.model_gateway.router import (
    ModelSettingsInput, RouteInput, create_model_settings_router,
)


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class SyntheticTransport:
    def __init__(self):
        self.requests = []
        self.fail_text = False

    def post(self, route, payload):
        self.requests.append((route, payload))
        is_image = "images" in payload["messages"][0] or isinstance(payload["messages"][0]["content"], list)
        value = "TEST 42" if is_image else ("WRONG" if self.fail_text else "READY")
        return ({"message": {"content": value}} if route.protocol == "ollama_native"
                else {"choices": [{"message": {"content": value}}]})


class ModelRouterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "audit.sqlite3"
        self.connect = lambda: sqlite3.connect(self.path, factory=ClosingConnection)
        with self.connect() as conn:
            init_privacy_audit(conn)
        self.mode = "strict"
        self.router = create_model_settings_router(
            self.connect, lambda: self.mode, lambda value: setattr(self, "mode", value))
        self.transport = SyntheticTransport()
        self.router.gateway._transport = self.transport
        self.endpoints = {route.path: route.endpoint for route in self.router.routes}

    def pair(self, *, custom=False):
        props = {"protocol": "ollama_native", "mode": "local",
                 "endpoint": "http://127.0.0.1:11434", "model": "synthetic"}
        if custom:
            props = {"protocol": "openai_compatible", "mode": "custom",
                     "endpoint": "https://example.com/v1", "model": "synthetic", "api_key": "secret-synthetic"}
        return ModelSettingsInput(image=RouteInput(**props), text=RouteInput(**props),
                                  external_consent=custom, masked_data_consent=custom)

    def test_local_pair_publishes_atomically_and_never_returns_key(self):
        result = self.endpoints["/api/model_settings/update"](self.pair())
        self.assertTrue(result["ok"])
        self.assertEqual(self.mode, "strict")
        self.assertTrue(result["ready"])
        self.assertEqual(["images" in req[1]["messages"][0] for req in self.transport.requests], [True, False])

    def test_bad_second_probe_does_not_publish_and_external_needs_consent(self):
        self.transport.fail_text = True
        failed = self.endpoints["/api/model_settings/update"](self.pair())
        self.assertFalse(failed["ok"])
        self.assertFalse(self.endpoints["/api/model_settings/get"]()["ready"])
        self.transport.fail_text = False
        proposal = self.pair(custom=True)
        proposal.masked_data_consent = False
        rejected = self.endpoints["/api/model_settings/update"](proposal)
        self.assertFalse(rejected["ok"])
        self.assertEqual(self.transport.requests[-1][0].mode, "local")
        proposal.masked_data_consent = True
        accepted = self.endpoints["/api/model_settings/update"](proposal)
        self.assertTrue(accepted["ok"])
        self.assertEqual(self.mode, "basic")
        self.assertNotIn("secret-synthetic", json.dumps(accepted))
        self.assertNotIn("secret-synthetic", json.dumps(self.endpoints["/api/model_settings/get"]()))


    def test_paired_locality_failure_preserves_exact_safe_code_and_sends_no_probe(self):
        for code in ("local_model_remote", "local_model_unverified", "local_provider_unsupported"):
            with self.subTest(code=code):
                wire = Wire()
                wire.tags["models"][0].update(name="synthetic", model="synthetic")
                proposal = self.pair()
                if code == "local_model_remote":
                    wire.tags["models"][0]["remote_host"] = "https://synthetic.example"
                elif code == "local_model_unverified":
                    wire.tags["models"][0].pop("size")
                else:
                    route = RouteInput(protocol="openai_compatible", mode="local",
                                       endpoint="http://127.0.0.1:11434/unsupported-prefix", model="synthetic")
                    proposal = ModelSettingsInput(image=route, text=route)
                self.router.gateway._transport = HttpTransport()
                with patch("app.modules.model_gateway.gateway._PinnedHTTP", side_effect=wire.connect):
                    failed = self.endpoints["/api/model_settings/update"](proposal)
                self.assertFalse(failed["ok"])
                self.assertEqual(failed["error_code"], code)
                self.assertEqual(self.endpoints["/api/model_settings/get"]()["error_code"], code)
                self.assertFalse(wire.inferences)
                self.assertFalse(failed["ready"])
                self.assertEqual(self.mode, "strict")

    def test_current_pair_error_is_not_overwritten_by_previous_gateway_status(self):
        self.transport.fail_text = True
        self.endpoints["/api/model_settings/update"](self.pair())
        proposal = self.pair(custom=True)
        proposal.masked_data_consent = False
        rejected = self.endpoints["/api/model_settings/update"](proposal)
        self.assertEqual(rejected["error_code"], "external_consent_required")


if __name__ == "__main__":
    unittest.main()
