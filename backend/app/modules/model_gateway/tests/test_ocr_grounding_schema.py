"""Fixed OCR citation schema transport tests, without model or network calls."""
from copy import deepcopy
import unittest
from app.modules.model_gateway.gateway import (ModelRoute, RouteError, OCR_OBSERVATION_JSON_SCHEMA,
    _observation_schema, _payload)


class OcrGroundingSchemaTests(unittest.TestCase):
    def test_actual_schema_allowlist_and_both_wires_preserve_existing_resource_caps(self):
        for protocol in ("ollama_native", "openai_compatible"):
            route = ModelRoute(protocol, "local", "http://127.0.0.1:11434" + ("/v1" if protocol == "openai_compatible" else ""), "synthetic")
            payload = _payload(route, "synthetic OCR input", None, json_schema=OCR_OBSERVATION_JSON_SCHEMA,
                               local_cpu_profile="observation")
            schema = payload["format"] if protocol == "ollama_native" else payload["response_format"]["json_schema"]["schema"]
            self.assertEqual(schema, OCR_OBSERVATION_JSON_SCHEMA)
            self.assertIn("source_quotes", schema["required"])
            self.assertFalse(schema["additionalProperties"])
            self.assertEqual(schema["properties"]["source_quotes"]["maxItems"], 3)
            if protocol == "ollama_native":
                self.assertEqual(payload["options"]["num_ctx"], 2048)
                self.assertEqual(payload["options"]["num_predict"], 768)
            else:
                self.assertEqual(payload["max_tokens"], 768)

    def test_mutation_cannot_expand_frozen_allowlist(self):
        original = deepcopy(OCR_OBSERVATION_JSON_SCHEMA)
        modified = deepcopy(original)
        modified["properties"]["source_quotes"]["maxItems"] = 100
        with self.assertRaisesRegex(RouteError, "invalid_json_schema"):
            _observation_schema(modified)
        try:
            OCR_OBSERVATION_JSON_SCHEMA["additionalProperties"] = True
            with self.assertRaisesRegex(RouteError, "invalid_json_schema"):
                _observation_schema(OCR_OBSERVATION_JSON_SCHEMA)
            self.assertEqual(_observation_schema(original), original)
        finally:
            OCR_OBSERVATION_JSON_SCHEMA.clear()
            OCR_OBSERVATION_JSON_SCHEMA.update(original)
