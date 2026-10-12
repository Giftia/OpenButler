"""New fixed task schema leaves the existing schema admission bounds intact."""
from copy import deepcopy
import unittest

from app.modules.model_gateway.gateway import (
    TASK_DISCOVERY_JSON_SCHEMA, OBSERVATION_JSON_SCHEMA, OCR_SELECTION_JSON_SCHEMA,
    ModelRoute, RouteError, _observation_schema, _payload,
)


class TaskDiscoverySchemaTests(unittest.TestCase):
    def test_fixed_schema_and_existing_schemas_are_admitted_without_widening(self):
        for schema in (TASK_DISCOVERY_JSON_SCHEMA, OBSERVATION_JSON_SCHEMA, OCR_SELECTION_JSON_SCHEMA):
            self.assertEqual(_observation_schema(schema), schema)
        schema = _observation_schema(TASK_DISCOVERY_JSON_SCHEMA)
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(schema['required'], ['proposals'])
        proposals = schema['properties']['proposals']
        self.assertEqual(proposals['maxItems'], 4)
        self.assertFalse(proposals['items']['additionalProperties'])
        self.assertEqual(set(proposals['items']['required']),
                         {'title', 'quote', 'self_assigned', 'unfinished', 'confidence'})

    def test_only_original_frozen_task_schema_is_admitted(self):
        variants = []
        for key, value in (('additionalProperties', True), ('required', [])):
            schema = deepcopy(TASK_DISCOVERY_JSON_SCHEMA)
            schema[key] = value
            variants.append(schema)
        for key, value in (('maxItems', 5), ('minItems', False)):
            schema = deepcopy(TASK_DISCOVERY_JSON_SCHEMA)
            schema['properties']['proposals'][key] = value
            variants.append(schema)
        schema = deepcopy(TASK_DISCOVERY_JSON_SCHEMA)
        schema['properties']['proposals']['items']['properties']['confidence']['maximum'] = 2
        variants.append(schema)
        schema = deepcopy(TASK_DISCOVERY_JSON_SCHEMA)
        schema['properties']['proposals']['items']['properties']['execute'] = {'type': 'string'}
        variants.append(schema)
        recursive = {}; recursive['recursive'] = recursive
        variants.extend([recursive, {'many': ['x'] * 129}])
        for schema in variants:
            with self.assertRaisesRegex(RouteError, '^invalid_json_schema$'):
                _observation_schema(schema)
        original = deepcopy(TASK_DISCOVERY_JSON_SCHEMA)
        try:
            TASK_DISCOVERY_JSON_SCHEMA['properties']['proposals']['maxItems'] = 40
            with self.assertRaisesRegex(RouteError, '^invalid_json_schema$'):
                _observation_schema(TASK_DISCOVERY_JSON_SCHEMA)
            self.assertEqual(_observation_schema(original), original)
        finally:
            TASK_DISCOVERY_JSON_SCHEMA.clear()
            TASK_DISCOVERY_JSON_SCHEMA.update(original)

    def test_task_schema_is_text_only_for_both_protocols(self):
        for protocol in ('ollama_native', 'openai_compatible'):
            suffix = '/v1' if protocol == 'openai_compatible' else ''
            route = ModelRoute(protocol, 'local', 'http://127.0.0.1:11434' + suffix, 'synthetic')
            with self.assertRaisesRegex(RouteError, '^invalid_json_schema$'):
                _payload(route, 'synthetic', b'\x89PNG\r\n\x1a\n', json_schema=TASK_DISCOVERY_JSON_SCHEMA)


if __name__ == '__main__':
    unittest.main()
