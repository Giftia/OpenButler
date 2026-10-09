"""Complete-record serialization contracts; no live OCR/model or semantic score."""
from dataclasses import replace
from hashlib import sha256
import json
from threading import Event
import unittest

from app.modules.model_gateway.gateway import CallAuthorization, Gateway, ModelRoute
from app.modules.task_activity.evidence import complete_task_model_source, TaskContextIncomplete
from app.modules.task_activity.model_discovery import LocalModelDiscovery, MAX_TASK_PROMPT_BYTES, _PROMPT, task_model_prompt
from app.modules.task_activity.tests.test_model_discovery import Guard, Transport, model_source


def verified_record(text):
    value = model_source(text)
    return {'id': value.observation_id, 'evidence_id': value.evidence_id,
        'source_kind': 'public_window', 'image_digest': value.image_digest,
        'post_mask_ocr_image_digest': value.image_digest, 'post_mask_ocr_engine': 'tesseract.js',
        'post_mask_ocr_text': text,
        'provenance': json.dumps({'source_kind': 'public_window',
            'capture_scope': 'dedicated_public_window', 'observation_mode': 'masked_ocr_text',
            'source_verified_before': True, 'source_verified_after': True})}


class CompleteOCRSourceTests(unittest.TestCase):
    def setUp(self):
        self.transport = Transport()
        self.transport.content = '{"proposals":[]}'
        self.gateway = Gateway(Guard(), self.transport)
        self.gateway._configuration = (7, {'text': ModelRoute(
            'ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')})
        self.provider = LocalModelDiscovery(self.gateway, lambda: CallAuthorization(authorized=True, redacted=True))

    def extract(self, source):
        return self.provider.extract(source, validate=lambda: None, cancel_event=Event())

    def assert_complete(self, text):
        source = complete_task_model_source(verified_record(text))
        self.assertEqual(self.extract(source), [])
        prompt = self.transport.calls[-1][1]['messages'][0]['content']
        descriptor = json.loads(prompt.split('\n', 1)[1])['source_record']
        self.assertEqual(descriptor, source.payload())
        self.assertTrue(descriptor['complete_record'])
        self.assertFalse(descriptor['semantic_verified'])
        self.assertEqual(descriptor['offset_unit'], 'unicode_codepoints')
        self.assertEqual(descriptor['source_text_digest'], sha256(text.encode('utf-8')).hexdigest())
        self.assertEqual(descriptor['span'], {'quote': text, 'start': 0, 'end': len(text)})
        self.assertLessEqual(len(prompt.encode('utf-8')), MAX_TASK_PROMPT_BYTES)
        return descriptor

    def test_complete_510_byte_ten_line_record_retains_every_line_in_source_order(self):
        lines = [
            'File Edit Search View Help',
            'PUBLIC GENERATED RESEARCH NOTES',
            'This is simulated work, not a personal commitment.',
            'I need to compare supported archive formats.',
            'This is unfinished work in the generated example.',
            'Next I will read the format reference documentation.',
            'Someone may want to inspect the sample chart.',
            'The owner and due date are unknown.',
            'I have finished publishing the previous example.',
            'None of these first-person statements identifies the real user.',
        ]
        text = '\n'.join(lines)
        self.assertLessEqual(len(text.encode('utf-8')), 510)
        text += ' ' * (510 - len(text.encode('utf-8')))
        self.assertEqual(len(text.encode('utf-8')), 510)
        self.assertEqual(len(text.splitlines()), 10)
        self.assert_complete(text)

    def test_crlf_unicode_combining_marks_indentation_and_repeats_are_unchanged(self):
        text = '  Example:\r\nI do not\r\nNeed to send 🦉 cafe\u0301 字段.\r\n\tAlready complete.  \r\nExample:\r\n'
        descriptor = self.assert_complete(text)
        self.assertNotEqual(descriptor['span']['end'], len(text.encode('utf-8')))

    def test_wrapped_subject_negation_qualified_marker_list_and_final_disclaimer_survive(self):
        for text in (
            'File\nEdit\nView\nAlice\nNeeds to send the report.',
            'File\nEdit\nView\nI do not\nNeed to send the report.',
            'Not my task:\n\nTODO(me): Send the report\nTODO(me): Publish the appendix',
            'I need to send the report.\nI have already sent it.\nThis is a fictional example.',
            '这是示例，不是本人的工作。\n我不需要\n发送报告。\n其他人已经完成。',
        ):
            with self.subTest(text=text):
                self.assert_complete(text)

    def test_long_line_is_neither_split_nor_truncated(self):
        text = 'I need to review ' + 'format details ' * 15 + 'only if the owner approves.'
        self.assertGreater(len(text), 120)
        self.assert_complete(text)

    def test_exact_rendered_prompt_cap_and_one_byte_over_including_metadata(self):
        def rendered(size):
            source = model_source('x' * size)
            return _PROMPT + json.dumps({'source_record': source.payload()}, ensure_ascii=False, separators=(',', ':'))
        size = next(n for n in range(1, 2001) if len(rendered(n).encode('utf-8')) == MAX_TASK_PROMPT_BYTES)
        self.assertEqual(len(task_model_prompt(model_source('x' * size)).encode('utf-8')), MAX_TASK_PROMPT_BYTES)
        self.assertEqual(self.extract(model_source('x' * size)), [])
        before = len(self.transport.calls)
        with self.assertRaisesRegex(TaskContextIncomplete, '^task_context_incomplete$'):
            self.extract(model_source('x' * (size + 1)))
        self.assertEqual(len(self.transport.calls), before)

    def test_overbudget_record_never_crops_a_disqualifying_tail_or_dispatches(self):
        text = 'I need to send the report.\n' + 'Details ' * 200 + '\nNot my task; this is already completed.'
        source = complete_task_model_source(verified_record(text))
        with self.assertRaisesRegex(TaskContextIncomplete, '^task_context_incomplete$'):
            self.extract(source)
        self.assertEqual(self.transport.calls, [])

    def test_source_verification_digest_identity_and_offset_fail_closed(self):
        record = verified_record('I need to read the reference.')
        for change in ({'source_kind': 'full_screen'}, {'post_mask_ocr_engine': 'unverified'},
                       {'post_mask_ocr_image_digest': 'b' * 64}, {'id': 'unowned-source'},
                       {'evidence_id': 'unowned-evidence'}, {'provenance': '{}'}):
            with self.subTest(change=change), self.assertRaises(TaskContextIncomplete):
                complete_task_model_source({**record, **change})
        valid = complete_task_model_source(record)
        for change in ({'source_text_digest': '0' * 64}, {'start': 1}, {'end': len(valid.text) - 1},
                       {'end': True}, {'text': valid.text + ' changed'}, {'image_digest': 'bad'}):
            with self.subTest(change=change), self.assertRaises(TaskContextIncomplete):
                self.extract(replace(valid, **change))
        self.assertEqual(self.transport.calls, [])

    def test_output_quote_must_be_contiguous_in_complete_record(self):
        text = 'I do not\nNeed to send the report.'
        self.transport.content = json.dumps({'proposals': [{'title': 'send the report',
            'quote': 'I Need to send the report.', 'self_assigned': True, 'unfinished': True, 'confidence': .95}]})
        with self.assertRaisesRegex(ValueError, '^discovery_source_mismatch$'):
            self.extract(complete_task_model_source(verified_record(text)))
        self.assertEqual(len(self.transport.calls), 1)


if __name__ == '__main__':
    unittest.main()
