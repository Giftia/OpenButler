"""Narrow compatibility with the observed official Ollama 0.35 envelope."""
from copy import deepcopy
import unittest

from app.modules.model_gateway.gateway import ModelRoute, RouteError, _content


class OllamaMetadataTests(unittest.TestCase):
    def setUp(self):
        self.route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11435',
                                'qwen3.5:2b-q4_K_M')
        self.response = {'model': self.route.model, 'created_at': '2026-10-02T06:19:20Z',
            'message': {'role': 'assistant', 'content': 'READY'}, 'done': True,
            'done_reason': 'stop', 'total_duration': 1, 'load_duration': 0,
            'prompt_eval_count': 55, 'prompt_eval_cached_count': 51,
            'prompt_eval_duration': 1, 'eval_count': 1, 'eval_duration': 1}

    def parse(self, response):
        return _content(self.route, response, strict_text_response=True)

    def test_observed_counter_is_optional_and_never_changes_content(self):
        self.assertEqual(self.parse(self.response), 'READY')
        del self.response['prompt_eval_cached_count']
        self.assertEqual(self.parse(self.response), 'READY')

    def test_cached_counter_rejects_boolean_negative_noninteger_or_overflow(self):
        for invalid in [True, False, -1, 1.5, '51', None, {}, [], 2**63]:
            with self.subTest(value=invalid):
                response = deepcopy(self.response)
                response['prompt_eval_cached_count'] = invalid
                with self.assertRaises(RouteError): self.parse(response)

    def test_extra_envelope_fields_remain_rejected(self):
        for field in ['timings', 'tools', 'reasoning', 'unknown']:
            response = deepcopy(self.response); response[field] = {}
            with self.subTest(field=field), self.assertRaises(RouteError):
                self.parse(response)

    def test_reasoning_tool_refusal_and_incomplete_output_remain_rejected(self):
        for field in ['thinking', 'reasoning', 'tool_calls', 'refusal']:
            response = deepcopy(self.response); response['message'][field] = ''
            with self.subTest(field=field), self.assertRaises(RouteError):
                self.parse(response)
        for patch in [{'done': False}, {'done_reason': 'length'}, {'message': {'role': 'user', 'content': 'READY'}}]:
            response = {**self.response, **patch}
            with self.subTest(patch=patch), self.assertRaises(RouteError):
                self.parse(response)


if __name__ == '__main__': unittest.main()
