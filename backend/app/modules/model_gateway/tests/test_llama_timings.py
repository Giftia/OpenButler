"""Synthetic envelopes matching documented llama.cpp timing metadata; no model calls."""
from copy import deepcopy
import unittest

from app.modules.model_gateway.gateway import ModelRoute, RouteError, _content


def synthetic_timings():
    # The nine non-speculative fields emitted by llama.cpp b11232, which the
    # official Ollama v0.35.1 embedded server pins. Values are synthetic.
    return {'cache_n': 0, 'prompt_n': 16, 'prompt_ms': 8.0,
            'prompt_per_token_ms': 0.5, 'prompt_per_second': 2000.0,
            'predicted_n': 4, 'predicted_ms': 10.0,
            'predicted_per_token_ms': 2.5, 'predicted_per_second': 400.0}


class LlamaTimingsTests(unittest.TestCase):
    def setUp(self):
        self.route = ModelRoute('openai_compatible', 'local', 'http://127.0.0.1:8080/v1', 'synthetic')
        self.response = {'id': 'chatcmpl-synthetic', 'object': 'chat.completion',
            'created': 1, 'model': 'synthetic', 'system_fingerprint': 'synthetic',
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'READY'},
                         'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 16, 'completion_tokens': 4, 'total_tokens': 20,
                      'prompt_tokens_details': {'cached_tokens': 0}},
            'timings': synthetic_timings()}

    def parse(self, response, route=None):
        return _content(route or self.route, response, strict_text_response=True)

    def assert_invalid(self, response, route=None):
        with self.assertRaisesRegex(RouteError, '^invalid_provider_response$'):
            self.parse(response, route)

    def test_optional_metadata_preserves_content_and_response(self):
        original = deepcopy(self.response)
        self.assertEqual(self.parse(self.response), 'READY')
        self.assertEqual(self.response, original)
        del self.response['timings']
        self.assertEqual(self.parse(self.response), 'READY')

    def test_numeric_boundaries_and_zero_are_allowed(self):
        for value in [0, 2**63 - 1]:
            response = deepcopy(self.response)
            response['timings'] = dict.fromkeys(synthetic_timings(), value)
            with self.subTest(value=value):
                self.assertEqual(self.parse(response), 'READY')
        for key in ['prompt_ms', 'prompt_per_token_ms', 'prompt_per_second',
                    'predicted_ms', 'predicted_per_token_ms', 'predicted_per_second']:
            self.response['timings'][key] = 0.0
        self.assertEqual(self.parse(self.response), 'READY')

    def test_timing_object_requires_exact_shape(self):
        variants = [None, True, 1, 1.0, '', [], {}, [synthetic_timings()]]
        for key in synthetic_timings():
            missing = synthetic_timings()
            del missing[key]
            variants.append(missing)
        for key in ['unknown', 'reasoning', 'tool_calls', 'content', 'draft_n', 'draft_n_accepted']:
            variants.append({**synthetic_timings(), key: 0})
        for timings in variants:
            with self.subTest(timings=timings):
                self.assert_invalid({**self.response, 'timings': timings})

    def test_all_fields_reject_invalid_types_ranges_and_nonfinite_numbers(self):
        invalid = [True, False, -1, -0.5, '1', None, {}, [], 2**63, 2**4096,
                   float('nan'), float('inf'), -float('inf')]
        for key in synthetic_timings():
            for value in invalid:
                response = deepcopy(self.response)
                response['timings'][key] = value
                with self.subTest(key=key, value=value):
                    self.assert_invalid(response)

    def test_counts_require_integers(self):
        for key in ['cache_n', 'prompt_n', 'predicted_n']:
            for value in [0.0, 1.0, 1.5]:
                response = deepcopy(self.response)
                response['timings'][key] = value
                with self.subTest(key=key, value=value):
                    self.assert_invalid(response)

    def test_custom_openai_route_does_not_gain_timing_allowance(self):
        custom = ModelRoute('openai_compatible', 'custom', 'https://example.com/v1', 'synthetic')
        self.assert_invalid(self.response, custom)
        del self.response['timings']
        self.assertEqual(self.parse(self.response, custom), 'READY')

    def test_non_strict_parsing_keeps_existing_metadata_behavior(self):
        custom = ModelRoute('openai_compatible', 'custom', 'https://example.com/v1', 'synthetic')
        for route in [self.route, custom]:
            for timings in [None, {}, {'unknown': 'not numeric'}]:
                response = {**self.response, 'timings': timings}
                with self.subTest(mode=route.mode, timings=timings):
                    self.assertEqual(_content(route, response, strict_text_response=False), 'READY')

    def test_ollama_native_route_does_not_gain_timing_allowance(self):
        route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')
        response = {'message': {'role': 'assistant', 'content': 'READY'},
                    'done': True, 'done_reason': 'stop', 'timings': synthetic_timings()}
        self.assert_invalid(response, route)

    def test_other_envelope_and_choice_fields_remain_rejected(self):
        for key in ['unknown', '__verbose', 'reasoning', 'tool_calls', 'refusal']:
            with self.subTest(envelope=key):
                self.assert_invalid({**self.response, key: {}})
            response = deepcopy(self.response)
            response['choices'][0][key] = None
            with self.subTest(choice=key):
                self.assert_invalid(response)

    def test_reasoning_tool_refusal_and_other_message_channels_remain_rejected(self):
        for key in ['thinking', 'reasoning', 'reasoning_content', 'tool_calls', 'function_call',
                    'refusal', 'unknown']:
            for value in ['', None, [], {}]:
                response = deepcopy(self.response)
                response['choices'][0]['message'][key] = value
                with self.subTest(key=key, value=value):
                    self.assert_invalid(response)

    def test_extra_choices_and_nonstop_finish_remain_rejected(self):
        for choices in [[], [deepcopy(self.response['choices'][0])] * 2, {}, None]:
            with self.subTest(choices=choices):
                self.assert_invalid({**self.response, 'choices': choices})
        for finish in ['length', 'tool_calls', 'content_filter', '', None]:
            response = deepcopy(self.response)
            response['choices'][0]['finish_reason'] = finish
            with self.subTest(finish=finish):
                self.assert_invalid(response)
        del self.response['choices'][0]['finish_reason']
        self.assert_invalid(self.response)

    def test_invalid_role_empty_nonstring_and_oversized_content_remain_rejected(self):
        for message in [{'role': 'user', 'content': 'READY'}, {'role': 'tool', 'content': 'READY'},
                        {'content': None}, {'content': ''}, {'content': ' '},
                        {'content': []}, {'content': 'x' * 4097}]:
            response = deepcopy(self.response)
            response['choices'][0]['message'] = message
            with self.subTest(message_type=type(message.get('content'))):
                self.assert_invalid(response)


if __name__ == '__main__':
    unittest.main()
