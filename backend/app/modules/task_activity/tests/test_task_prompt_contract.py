"""Prompt intent and strict ancestry contracts, not model-quality evaluation."""
from hashlib import sha256
import json
import unittest

from app.modules.task_activity.discovery import DiscoveryResultError
from app.modules.task_activity.model_discovery import _PROMPT, _parse, task_model_prompt
from app.modules.task_activity.tests.test_model_discovery import model_source


class TaskPromptContractTests(unittest.TestCase):
    def test_frozen_prompt_places_disclaimer_and_completion_rules_before_copying(self):
        self.assertEqual(len(_PROMPT.encode('utf-8')), 1349)
        self.assertEqual(sha256(_PROMPT.encode('utf-8')).hexdigest(),
                         '2b75b72eef0e6cd563446d8127a95e2ef5b02cc1c3f5182cd413c03ef324bb51')
        ordered = ('1. Document-wide', '2. Exclude completed', '3. Copy quote FIRST',
                   '4. Copy title from that SAME quote')
        self.assertEqual([_PROMPT.index(value) for value in ordered],
                         sorted(_PROMPT.index(value) for value in ordered))
        self.assertIn('disclaimers override first-person sentences', _PROMPT)
        self.assertIn('I or my alone is insufficient', _PROMPT)
        self.assertIn('exact case-sensitive contiguous substring', _PROMPT)
        self.assertIn('Never capitalize, rewrite, join or translate', _PROMPT)

    def test_full_source_disclaimer_survives_and_serialized_budget_still_applies(self):
        text = 'I need to review the export format.\r\nThis is simulated content, not real user work.'
        prompt = task_model_prompt(model_source(text))
        self.assertEqual(json.loads(prompt.split('\n', 1)[1])['source_record']['span']['quote'], text)
        self.assertLessEqual(len(prompt.encode('utf-8')), 2560)

    def test_validator_still_rejects_case_change_and_title_borrowed_from_another_quote(self):
        action = 'I need to review the export format.'
        qualification = 'This is my unfinished task in the fictional example.'
        source = action + '\n' + qualification
        for title, quote in (('Review the export format', action),
                             ('review the export format', qualification)):
            item = {'quote': quote, 'title': title, 'self_assigned': True,
                    'unfinished': True, 'confidence': .85}
            with self.subTest(title=title, quote=quote), self.assertRaisesRegex(
                    DiscoveryResultError, '^discovery_source_mismatch$'):
                _parse(json.dumps({'proposals': [item]}), (source,))

    def test_validator_accepts_exact_same_quote_substring_without_requiring_key_order(self):
        quote = 'Alice needs to review the export format.'
        item = {'title': 'review the export format', 'confidence': .85,
                'unfinished': True, 'quote': quote, 'self_assigned': False}
        proposals = _parse(json.dumps({'proposals': [item]}), (quote,))
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].title, 'review the export format')
        self.assertFalse(proposals[0].self_assigned)


if __name__ == '__main__':
    unittest.main()
