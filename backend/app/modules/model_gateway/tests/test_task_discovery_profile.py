"""Task-only CPU profile payloads, without transport/provider calls."""
from dataclasses import replace
import unittest

from app.modules.model_gateway.gateway import (
    ModelRoute, RouteError, TASK_DISCOVERY_JSON_SCHEMA, OBSERVATION_JSON_SCHEMA,
    LOCAL_TASK_PROMPT_BYTES, _payload, synthetic_probe_png,
)


class TaskDiscoveryProfileTests(unittest.TestCase):
    def setUp(self):
        self.route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')

    def payload(self, prompt='fixture', **changes):
        args = dict(route=self.route, prompt=prompt, image=None,
                    json_schema=TASK_DISCOVERY_JSON_SCHEMA, local_cpu_profile='task_discovery')
        args.update(changes)
        return _payload(**args)

    def test_native_task_context_override_does_not_change_observation_or_legacy_calls(self):
        task = self.payload()
        self.assertEqual(task['options']['num_ctx'], 4096)
        self.assertEqual(task['options']['num_predict'], 768)
        self.assertFalse(task['think'])
        observation = self.payload(json_schema=OBSERVATION_JSON_SCHEMA, local_cpu_profile='observation')
        self.assertEqual(observation['options']['num_ctx'], 2048)
        self.assertEqual(observation['options']['num_predict'], 768)
        self.assertNotIn('options', self.payload(local_cpu_profile=None))

    def test_compatible_route_retains_protocol_without_invented_context_fields(self):
        route = replace(self.route, protocol='openai_compatible', endpoint='http://127.0.0.1:11434/v1')
        payload = self.payload(route=route)
        self.assertEqual(payload['max_tokens'], 768)
        self.assertNotIn('num_ctx', payload)
        self.assertNotIn('options', payload)
        self.assertNotIn('extra_body', payload)
        self.assertNotIn('num_predict', payload)

    def test_task_profile_cannot_be_used_with_other_schema_image_or_external_route(self):
        for change in ({'json_schema': OBSERVATION_JSON_SCHEMA}, {'json_schema': None},
                       {'image': synthetic_probe_png()},
                       {'route': replace(self.route, mode='custom', endpoint='https://example.invalid')}):
            with self.subTest(change=change), self.assertRaisesRegex(RouteError, '^invalid_local_cpu_profile$'):
                self.payload(**change)

    def test_task_profile_defensively_caps_utf8_prompt_bytes(self):
        self.payload('x' * LOCAL_TASK_PROMPT_BYTES)
        for prompt in ('x' * (LOCAL_TASK_PROMPT_BYTES + 1), '文' * (LOCAL_TASK_PROMPT_BYTES // 3 + 1)):
            with self.assertRaisesRegex(RouteError, '^task_context_incomplete$'):
                self.payload(prompt)
        self.payload('x' * (LOCAL_TASK_PROMPT_BYTES + 1), local_cpu_profile='observation')


if __name__ == '__main__':
    unittest.main()
