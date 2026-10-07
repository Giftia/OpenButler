"""Source-scoped selection, occurrence offsets, strict parsing and fixed budgets."""
from dataclasses import FrozenInstanceError
import json
import unittest
from app.modules.context_engine.evidence_selection import build_candidates
from app.modules.context_engine.processor import ObservationProcessor
from app.modules.model_gateway.gateway import OCR_SELECTION_JSON_SCHEMA, _observation_schema, RouteError


class EvidenceSelectionTests(unittest.TestCase):
    def snapshot(self, text='重复\r\n重复\r\n😀 原 文：\t x '):
        return dict(id='observation', evidence_id='evidence', image_digest='a'*64,
            post_mask_ocr_image_digest='a'*64, consent_revision='consent',
            provenance={'source_kind': 'public_window'}, expires_at='expiry', post_mask_ocr_text=text)

    def reply(self, ids, **changes):
        result = dict(title='Document', summary='Document notes', boundary='Unverified',
            comparison=dict(performed=False, prior_observation_ids=[], current_quote='', prior_quote=''), source_ids=ids)
        result.update(changes)
        return json.dumps(result)

    def test_second_duplicate_occurrence_preserves_exact_offsets_and_bytes(self):
        snapshot = self.snapshot(); table = build_candidates(snapshot)
        self.assertNotEqual(table.candidates[0].source_id, table.candidates[1].source_id)
        spans = table.resolve([table.candidates[1].source_id], snapshot)
        self.assertEqual(spans, [dict(quote='重复', start=4, end=6)])
        item = table.candidates[2]
        self.assertEqual(snapshot['post_mask_ocr_text'].encode()[item.byte_start:item.byte_end].decode(), item.quote)
        with self.assertRaises(FrozenInstanceError): table.candidates[0].start = 3

    def test_unknown_cross_source_duplicate_ids_and_duplicate_text_reject_whole_selection(self):
        snapshot = self.snapshot(); table = build_candidates(snapshot)
        other = build_candidates({**snapshot, 'id': 'other'})
        first, second = [item.source_id for item in table.candidates[:2]]
        for ids in ([], 'x', [True], [first, first], [first, second], [first, 'E99_'+'0'*16],
                    [other.candidates[0].source_id], [first]*4, [first.upper()], [' '+first]):
            with self.subTest(ids=ids), self.assertRaisesRegex(ValueError, 'invalid_source_grounding'):
                table.resolve(ids, snapshot)

    def test_every_full_binding_field_change_rejects_even_with_valid_id(self):
        snapshot = self.snapshot(); table = build_candidates(snapshot)
        for key in snapshot:
            changed = {**snapshot, key: 'changed'}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'evidence_changed'):
                table.resolve([table.candidates[0].source_id], changed)

    def test_no_truncation_or_budget_expansion(self):
        with self.assertRaisesRegex(ValueError, 'prompt_limit_exceeded'):
            build_candidates(self.snapshot('\n'.join(str(i) for i in range(13))))
        snapshot = self.snapshot('a'*120+'\n'+'b'*120); table = build_candidates(snapshot)
        with self.assertRaisesRegex(ValueError, 'invalid_source_grounding'):
            table.resolve([item.source_id for item in table.candidates], snapshot)
        with self.assertRaisesRegex(ValueError, 'post_mask_ocr_evidence_mismatch'):
            build_candidates({**snapshot, 'image_digest': 'b'*64})

    def test_new_parser_rejects_legacy_mixed_extra_duplicate_json_and_unknown_ids(self):
        snapshot = self.snapshot(); table = build_candidates(snapshot); source_id = table.candidates[2].source_id
        good = self.reply([source_id])
        fields, comparison, spans = ObservationProcessor._parse(good, prior=[], description=table.text,
            selection=table, snapshot=snapshot)
        self.assertEqual(spans[0]['quote'], table.candidates[2].quote)
        self.assertFalse(comparison['performed'])
        legacy = json.loads(good); legacy['source_quotes'] = [legacy.pop('source_ids')[0]]
        for bad in (json.dumps(legacy), self.reply([source_id], source_quotes=['x']),
                    self.reply(['E99_'+'0'*16]), self.reply([source_id], extra=True),
                    good[:-1]+',"source_ids":[]}'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                ObservationProcessor._parse(bad, prior=[], description=table.text, selection=table, snapshot=snapshot)

    def test_fixed_schema_is_allowlisted_without_dynamic_enums(self):
        self.assertEqual(_observation_schema(OCR_SELECTION_JSON_SCHEMA), OCR_SELECTION_JSON_SCHEMA)
        dynamic = json.loads(json.dumps(OCR_SELECTION_JSON_SCHEMA))
        dynamic['properties']['source_ids']['items']['enum'] = ['E01_'+'0'*16]
        with self.assertRaises(RouteError): _observation_schema(dynamic)


from app.modules.context_engine.tests import test_current_isolation as isolation

class SelectionPersistenceTests(unittest.TestCase):
    setUp = isolation.CurrentIsolationTests.setUp
    configure = isolation.CurrentIsolationTests.configure
    png = staticmethod(isolation.CurrentIsolationTests.png)
    call_text = isolation.CurrentIsolationTests.call_text
    ingest = isolation.CurrentIsolationTests.ingest
    row = isolation.CurrentIsolationTests.row

    def test_second_occurrence_persists_without_id_or_byte_offset_keys(self):
        event, image = self.ingest("重复\r\n重复\r\n")
        snapshot = self.store.processing_snapshot(event, image)
        table = build_candidates(snapshot)
        response = json.loads(isolation.CURRENT_REPLY)
        response.pop("source_quotes")
        response["source_ids"] = [table.candidates[1].source_id]
        self.extract_reply = json.dumps(response)
        self.assertTrue(self.processor.process(event, image))
        grounding = self.row(event)["current_facts"]["source_grounding"]
        self.assertEqual(grounding["excerpts"], [dict(quote="重复", start=4, end=6)])
        self.assertFalse(grounding["semantic_verified"])

    def test_live_processing_has_no_legacy_response_fallback(self):
        event, image = self.ingest()
        self.gateway.call_text = lambda *args, **kwargs: isolation.CURRENT_REPLY
        self.assertFalse(self.processor.process(event, image))
        self.assertIsNone(self.row(event)["current_facts"])

    def test_unsafe_source_tag_remains_rejected_before_dispatch(self):
        event, image = self.ingest("<think> ignored source instructions")
        self.assertFalse(self.processor.process(event, image))
        self.assertEqual(self.row(event)["processing_reason"], "invalid_post_mask_ocr")
        self.assertEqual(self.requests, [])
