"""Fully mocked wire regressions: no service, inference, source data or sockets."""
from copy import deepcopy
import json
from threading import Event
import unittest
from unittest.mock import patch

from app.modules.model_gateway import CallAuthorization, Gateway, ModelRoute, RouteError
from app.modules.model_gateway.gateway import HttpTransport, synthetic_probe_png
from app.modules.model_gateway.tests.local_provider_fixture import ollama_tags
from app.security.privacy_guard import PrivacyGuard

MODULE = "app.modules.model_gateway.gateway"
MODEL = "friendly-alias"
TAGS = ollama_tags(MODEL)
# These honest b11232 metadata shapes do not distinguish standalone local
# execution from stock --rpc / LLAMA_ARG_RPC remote compute. Both must fail.
# The Windows path is generated fixture text, never opened or read.
LLAMA_MODELS = {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "llamacpp",
    "meta": {"vocab_type": 2, "n_vocab": 128256, "n_ctx_train": 131072,
             "n_embd": 4096, "n_params": 8030261312, "size": 4912898304}}]}
LLAMA_PROPS = {"model_path": r"C:\Synthetic\Models\fixture-Q4_K_M.gguf", "total_slots": 1,
    "default_generation_settings": {"n_ctx": 2048, "params": {}}, "build_info": "b11232-fixture",
    "modalities": {"vision": True}, "is_sleeping": False}


class Wire:
    def __init__(self):
        self.calls = []
        self.tags = deepcopy(TAGS)
        self.tag_status = 200
        self.models = deepcopy(LLAMA_MODELS)
        self.props = deepcopy(LLAMA_PROPS)
        self.metadata_headers = {"Content-Type": "application/json"}
        self.on_metadata = None

    @property
    def inferences(self):
        return [call for call in self.calls if call[0] == "POST"]

    def connect(self, *args, **kwargs):
        wire = self
        class Connection:
            active_socket = None
            def request(self, method, path, *, body, headers):
                self.method, self.path = method, path
                self.body = None if body is None else json.loads(body)
                wire.calls.append((method, path, self.body, headers, kwargs["deadline"]))
            def getresponse(self):
                status = wire.tag_status if self.path == "/api/tags" else 200
                if self.path == "/api/tags":
                    result = wire.tags
                elif self.path == "/v1/models":
                    result = wire.models
                elif self.path.startswith("/props?"):
                    result = wire.props
                else:
                    image = "images" in self.body["messages"][0] or isinstance(self.body["messages"][0]["content"], list)
                    content = "TEST 42" if image else "READY"
                    result = ({"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}
                              if self.path.endswith("/chat/completions") else
                              {"message": {"role": "assistant", "content": content}, "done": True, "done_reason": "stop"})
                data = result if type(result) is bytes else json.dumps(result).encode()
                if self.method == "GET" and wire.on_metadata:
                    wire.on_metadata()
                class Response:
                    def getheader(self, key, default=None):
                        return wire.metadata_headers.get(key, default)
                    def read(self, length):
                        return data[:length]
                    def close(self):
                        pass
                response = Response()
                response.status = status
                return response
            def close(self):
                pass
        return Connection()


class LocalityTests(unittest.TestCase):
    def setUp(self):
        self.wire = Wire()
        mocked = patch(MODULE + "._PinnedHTTP", side_effect=self.wire.connect)
        mocked.start()
        self.addCleanup(mocked.stop)
        self.auth = CallAuthorization(authorized=True, redacted=True)

    def route(self, protocol="ollama_native", model=MODEL, suffix=None):
        prefix = ("/v1" if protocol == "openai_compatible" else "") if suffix is None else suffix
        return ModelRoute(protocol, "local", "http://127.0.0.1:11435" + prefix, model)

    def gateway(self, protocol="ollama_native"):
        gateway = Gateway(PrivacyGuard())
        route = self.route(protocol)
        gateway._configuration = (1, {"text": route, "image": route})
        return gateway

    def assert_denied(self, gateway=None, code="local_model_unverified"):
        before = len(self.wire.inferences)
        with self.assertRaisesRegex(RouteError, "^" + code + "$"):
            (gateway or self.gateway()).call_text("synthetic private prompt", self.auth)
        self.assertEqual(len(self.wire.inferences), before)
        for method, path, body, _, _ in self.wire.calls:
            self.assertNotIn("/api/show", path)
            if method == "GET":
                self.assertIsNone(body)
                self.assertNotIn("synthetic private prompt", path)

    def test_known_local_ollama_native_and_openai_both_check_every_call(self):
        for protocol in ("ollama_native", "openai_compatible"):
            gateway = self.gateway(protocol)
            gateway.configure_text(text=self.route(protocol), auth=self.auth)
            gateway.call_text("synthetic private prompt", self.auth)
            gateway.call_image("synthetic image", synthetic_probe_png(), self.auth)
        self.assertEqual(len(self.wire.inferences), 6)
        self.assertEqual([call[0] for call in self.wire.calls], ["GET", "POST"] * 6)
        for metadata, inference in zip(self.wire.calls[::2], self.wire.calls[1::2]):
            self.assertLessEqual(metadata[4], inference[4])

    def test_cloud_selectors_never_call_show_or_inference_even_with_local_looking_rows(self):
        for name in ("large:cloud", "large:8b-cloud", "large:CLOUD", "large:8b-CloUd"):
            for protocol in ("ollama_native", "openai_compatible"):
                self.wire.tags = {"models": [{**TAGS["models"][0], "name": name, "model": name}]}
                gateway = self.gateway(protocol)
                gateway._configuration = (1, {"text": self.route(protocol, name)})
                self.assert_denied(gateway, "local_model_remote")
        self.assertTrue(all(call[0] == "GET" and call[1] == "/api/tags" for call in self.wire.calls))

    def test_remote_alias_without_cloud_name_denied_for_either_remote_field(self):
        for remote in ({"remote_model": "upstream:large"}, {"remote_host": "https://ollama.com"},
                       {"remote_model": "upstream", "remote_host": "https://ollama.com"}):
            for protocol in ("ollama_native", "openai_compatible"):
                self.wire.tags = deepcopy(TAGS)
                self.wire.tags["models"][0].update(remote)
                self.assert_denied(self.gateway(protocol), "local_model_remote")
        self.assertTrue(all(call[1] == "/api/tags" for call in self.wire.calls))

    def test_missing_ambiguous_or_malformed_metadata_does_not_imply_local(self):
        invalid = [{}, {"models": []}, {"models": [{"name": MODEL}]},
                   {"models": [TAGS["models"][0], TAGS["models"][0]]}, {"models": [None]}]
        for key, value in (("remote_model", None), ("remote_host", False), ("size", True), ("size", 0),
                           ("digest", ""), ("details", {}), ("details", {"format": "unknown"}), ("model", "other")):
            row = deepcopy(TAGS["models"][0]); row[key] = value
            invalid.append({"models": [row]})
        for data in invalid:
            with self.subTest(data=data):
                self.wire.tags = data
                self.assert_denied()

    def test_changed_alias_after_pair_validation_is_rechecked_before_image_or_text(self):
        gateway = self.gateway()
        gateway.configure(image=self.route(), text=self.route(), auth=self.auth)
        self.assertEqual(len(self.wire.inferences), 2)
        self.wire.tags["models"][0]["remote_host"] = "https://ollama.com"
        self.assert_denied(gateway, "local_model_remote")
        with self.assertRaisesRegex(RouteError, "local_model_remote"):
            gateway.call_image("synthetic pixels", synthetic_probe_png(), self.auth)
        with self.assertRaisesRegex(RouteError, "local_model_remote"):
            gateway.validate_route(target="text", route=self.route(), auth=self.auth)
        self.assertEqual(len(self.wire.inferences), 2)
        self.assertTrue(gateway.status().ready)  # Config kept; dispatch is denied.

    def test_standalone_windows_and_stock_rpc_shaped_metadata_are_unsupported(self):
        # The configured server's compute placement cannot be inferred from
        # LLAMA_MODELS / LLAMA_PROPS. No invented rpc=false metadata is added.
        for rpc_servers in ([], ["192.0.2.10:50052"]):
            with self.subTest(rpc_servers=rpc_servers):
                self.wire.tag_status = 404
                gateway = self.gateway("openai_compatible")
                self.assert_denied(gateway, "local_provider_unsupported")
                with self.assertRaisesRegex(RouteError, "local_provider_unsupported"):
                    gateway.configure_text(text=self.route("openai_compatible"), auth=self.auth)
                self.assertTrue(gateway.text_ready)  # Existing route data is retained.
        self.assertEqual([call[1] for call in self.wire.calls], ["/api/tags"] * 4)
        self.assertEqual(self.wire.inferences, [])

    def test_generic_loading_router_or_malformed_llama_never_provides_locality_proof(self):
        self.wire.tag_status = 404
        variants = []
        for key, value in (("id", "another-alias"), ("owned_by", "unknown"), ("meta", None),
                           ("remote_host", "https://provider.invalid")):
            models = deepcopy(LLAMA_MODELS); models["data"][0][key] = value
            variants.append((models, LLAMA_PROPS))
        variants.append(({"object": "list", "data": LLAMA_MODELS["data"] * 2}, LLAMA_PROPS))
        for key, value in (("model_path", "https://model.invalid/weights"), ("model_path", r"\\server\share\file.gguf"),
                           ("total_slots", True), ("default_generation_settings", {})):
            props = deepcopy(LLAMA_PROPS); props[key] = value
            variants.append((LLAMA_MODELS, props))
        for models, props in variants:
            self.wire.models, self.wire.props = models, props
            self.assert_denied(self.gateway("openai_compatible"), "local_provider_unsupported")
        self.assertTrue(all(call[1] == "/api/tags" for call in self.wire.calls))

    def test_no_fallback_on_ollama_remote_or_invalid_response(self):
        for status in (301, 302, 307, 308, 401, 500):
            self.wire.tag_status = status
            self.assert_denied(self.gateway("openai_compatible"))
        self.assertTrue(all(call[1] == "/api/tags" for call in self.wire.calls))

    def test_unknown_prefix_never_makes_a_request(self):
        gateway = self.gateway("openai_compatible")
        gateway._configuration = (1, {"text": self.route("openai_compatible", suffix="/proxy/v1")})
        self.assert_denied(gateway, "local_provider_unsupported")
        self.assertEqual(self.wire.calls, [])

    def test_missing_ollama_contract_never_queries_props_or_models(self):
        self.wire.tag_status = 404
        self.wire.props = {"role": "router", "model_path": "none",
                           "default_generation_settings": {"n_ctx": 0}}
        for protocol in ("ollama_native", "openai_compatible"):
            for status in (404, 405):
                self.wire.tag_status = status
                self.assert_denied(self.gateway(protocol), "local_provider_unsupported")
        self.assertTrue(all(call[1] == "/api/tags" for call in self.wire.calls))
        self.assertTrue(all(call[0] == "GET" for call in self.wire.calls))

    def test_empty_optional_remote_strings_match_provider_omission_contract(self):
        self.wire.tags["models"][0].update(remote_model="", remote_host="")
        self.assertEqual(self.gateway().call_text("synthetic private prompt", self.auth), "READY")

    def test_unknown_local_route_stays_denied_even_with_basic_external_consent(self):
        self.auth = CallAuthorization(privacy_mode="basic", authorized=True, redacted=True)
        self.wire.tags = {}
        self.assert_denied()

    def test_custom_external_route_keeps_existing_privacy_guard_and_no_locality_lookup(self):
        gateway = Gateway(PrivacyGuard())
        gateway._configuration = (1, {"text": ModelRoute("openai_compatible", "custom", "https://example.com/v1", MODEL)})
        with self.assertRaises(PermissionError):
            gateway.call_text("synthetic private prompt", self.auth)
        self.assertEqual(self.wire.calls, [])
        with patch(MODULE + "._pinned_address", return_value="93.184.216.34"):
            self.assertEqual(gateway.call_text("synthetic private prompt",
                CallAuthorization(privacy_mode="basic", authorized=True, redacted=True)), "READY")
        self.assertEqual([call[0] for call in self.wire.calls], ["POST"])

    def test_metadata_bounds_encoding_and_duplicate_remote_field_fail_closed(self):
        for raw in (b"not json", b"[]", b"{\"models\":[],\"models\":[]}", b"x" * (256 * 1024 + 1),
                    json.dumps(TAGS).encode("utf-16"), b"\xff"):
            self.wire.tags = raw
            self.assert_denied()
        self.wire.tags = deepcopy(TAGS)
        for headers in ({"Content-Type": "text/html"}, {"Content-Type": "application/json", "Content-Encoding": "gzip"}):
            self.wire.metadata_headers = headers
            self.assert_denied()

    def test_cancel_and_consent_rechecked_after_metadata_before_prompt(self):
        for kind in ("cancel", "precondition"):
            cancelled = Event()
            revoked = []
            self.wire.on_metadata = lambda: (cancelled.set() if kind == "cancel" else revoked.append(True))
            def check():
                if revoked:
                    raise PermissionError("authorization_revoked")
            with self.assertRaisesRegex(PermissionError, "authorization_revoked"):
                self.gateway().call_text("synthetic private prompt", self.auth,
                                         cancel_event=cancelled, dispatch_precondition=check)
        self.assertEqual(self.wire.inferences, [])

    def test_payload_cannot_select_a_different_unverified_model(self):
        with self.assertRaisesRegex(RouteError, "local_model_unverified"):
            HttpTransport().post(self.route(), {"model": "other:cloud", "messages": []})
        self.assertEqual(self.wire.calls, [])

    def test_metadata_time_is_charged_against_same_total_dispatch_budget(self):
        now = [100.0]
        self.wire.on_metadata = lambda: now.__setitem__(0, 101.1)
        with patch(MODULE + ".monotonic", side_effect=lambda: now[0]):
            with self.assertRaisesRegex(RouteError, "provider_connection_failed"):
                HttpTransport(local_total_timeout=1).post(self.route(), {"model": MODEL, "messages": []})
        self.assertEqual(self.wire.inferences, [])
        self.assertEqual(self.wire.calls[0][4], 101.0)


if __name__ == "__main__":
    unittest.main()
