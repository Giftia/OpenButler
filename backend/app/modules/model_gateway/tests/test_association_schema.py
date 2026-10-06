"""Fixed relation-only schema; synthetic adapters, no network or model calls."""
from copy import deepcopy
import unittest
from app.modules.model_gateway.gateway import (Gateway, ModelRoute, CallAuthorization, RouteError,
    TEMPORAL_ASSOCIATION_JSON_SCHEMA, _payload)
from app.security.privacy_guard import PrivacyGuard


class AssociationSchemaTests(unittest.TestCase):
    def route(self, protocol):
        suffix = "/v1" if protocol == "openai_compatible" else ""
        return ModelRoute(protocol, "local", "http://127.0.0.1:11434" + suffix, "synthetic")

    def test_exact_schema_sent_for_both_protocols_with_same_resource_profile(self):
        for protocol in ("ollama_native", "openai_compatible"):
            payload = _payload(self.route(protocol), "synthetic association", None,
                               json_schema=TEMPORAL_ASSOCIATION_JSON_SCHEMA, local_cpu_profile="observation")
            schema = payload.get("format") if protocol == "ollama_native" else payload["response_format"]["json_schema"]["schema"]
            self.assertEqual(schema, TEMPORAL_ASSOCIATION_JSON_SCHEMA)
            self.assertEqual(set(schema["properties"]), {"relations"})
            self.assertFalse(schema["additionalProperties"])
            self.assertFalse(schema["properties"]["relations"]["items"]["additionalProperties"])
            if protocol == "ollama_native":
                self.assertEqual(payload["options"]["num_ctx"], 2048)
                self.assertEqual(payload["options"]["num_predict"], 768)

    def test_mutating_fields_or_enum_never_reaches_transport(self):
        class Transport:
            calls = []
            def post(self, *args, **kwargs):
                self.calls.append(args)
                raise AssertionError("invalid schema reached transport")
        transport = Transport()
        gateway = Gateway(PrivacyGuard(), transport)
        route = self.route("ollama_native")
        gateway._configuration = (1, {"text": route})
        changed = []
        schema = deepcopy(TEMPORAL_ASSOCIATION_JSON_SCHEMA)
        schema["properties"]["summary"] = {"type": "string"}; changed.append(schema)
        schema = deepcopy(TEMPORAL_ASSOCIATION_JSON_SCHEMA)
        schema["properties"]["relations"]["items"]["additionalProperties"] = True; changed.append(schema)
        schema = deepcopy(TEMPORAL_ASSOCIATION_JSON_SCHEMA)
        schema["properties"]["relations"]["items"]["properties"]["relation"]["enum"].append("verified_action"); changed.append(schema)
        schema = deepcopy(TEMPORAL_ASSOCIATION_JSON_SCHEMA)
        schema["properties"]["relations"]["minItems"] = True; changed.append(schema)
        for schema in changed:
            with self.subTest(schema=schema), self.assertRaisesRegex(RouteError, "invalid_json_schema"):
                gateway.call_text("synthetic", CallAuthorization(authorized=True, redacted=True), json_schema=schema)
        self.assertEqual(transport.calls, [])
