"""Deterministic contracts only; no capture, OCR engine, or real model invocation.

The guitar failure is reconstructed from an earlier verified report, not a raw
response replay. Synthetic adversarial extensions test containment, not detection.
"""
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from uuid import uuid4
import unittest

from app.modules.context_engine.daily_review import DailyReviewRequest, DailyReviewService
from app.modules.context_engine.processor import ObservationProcessor, MAX_PROMPT_BYTES
from app.modules.context_engine.tests import test_current_isolation as isolation

CURRENT_REPLY, GUITAR_OCR = isolation.CURRENT_REPLY, isolation.GUITAR_OCR
from app.modules.model_gateway.gateway import OCR_SELECTION_JSON_SCHEMA

NEGATIVE = json.loads(Path(__file__).with_name("fixtures").joinpath("reconstructed-guitar-negative.json").read_text())


class SourceGroundingTests(unittest.TestCase):
    # Reuse fixtures without inheriting and rerunning the isolation test suite.
    setUp = isolation.CurrentIsolationTests.setUp
    configure = isolation.CurrentIsolationTests.configure
    png = staticmethod(isolation.CurrentIsolationTests.png)
    call_text = isolation.CurrentIsolationTests.call_text
    ingest = isolation.CurrentIsolationTests.ingest
    seed_prior = isolation.CurrentIsolationTests.seed_prior
    row = isolation.CurrentIsolationTests.row

    def reply(self, **changes):
        payload = json.loads(CURRENT_REPLY)
        payload.update(changes)
        return json.dumps(payload, ensure_ascii=False)

    def test_reconstructed_negative_without_citations_is_not_accepted(self):
        self.assertEqual(NEGATIVE["source_ocr"], GUITAR_OCR)
        payload = json.loads(self.reply(summary=NEGATIVE["unsupported_summary"]))
        del payload["source_quotes"]
        self.extract_reply = json.dumps(payload, ensure_ascii=False)
        event, image = self.ingest(NEGATIVE["source_ocr"])
        self.assertFalse(self.processor.process(event, image))
        row = self.row(event)
        self.assertIsNone(row["summary"])
        self.assertIsNone(row["current_facts"])
        self.assertTrue(row["evidence_available"])

    def test_valid_quotes_do_not_verify_or_promote_unsupported_model_claim(self):
        # Synthetic extension: the inaccurate proposal has plausible valid citations.
        self.extract_reply = self.reply(title="真实琴弦", summary=NEGATIVE["unsupported_summary"])
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual(row["title"], "文档 OCR 摘录")
        self.assertEqual(row["summary"], '屏幕文档 OCR 文字：“guitar notes”；“standard tuning e a d g b e”。')
        grounding = row["current_facts"]["source_grounding"]
        self.assertFalse(grounding["semantic_verified"])
        self.assertEqual(grounding["model_proposal"]["summary"], NEGATIVE["unsupported_summary"])
        self.assertEqual(grounding["model_proposal"]["verification"], "unverified_inference")
        self.assertEqual(grounding["source_text_digest"], sha256(GUITAR_OCR.encode()).hexdigest())
        self.assertEqual(grounding["image_digest"], sha256(image).hexdigest())
        self.assertEqual(grounding["evidence_id"], row["evidence_id"])
        self.assertEqual(grounding["observation_id"], event)
        for span in grounding["excerpts"]:
            self.assertEqual(GUITAR_OCR[span["start"]:span["end"]], span["quote"])
        self.assertNotIn("post_mask_ocr_text", row)
        self.assertNotIn(GUITAR_OCR, json.dumps(row, ensure_ascii=False))

    def test_quotes_must_be_bounded_unique_nonempty_exact_source_text(self):
        for quotes in ([], [""], [" "], [3], [True], "guitar notes", ["Guitar notes"],
                       ["物理琴弦"], ["guitar notes"] * 2, ["x"] * 4, ["x" * 121],
                       ["a" * 100, "b" * 101]):
            with self.subTest(quotes=quotes), self.assertRaisesRegex(ValueError, "invalid_source_grounding"):
                ObservationProcessor.parse_current(self.reply(source_quotes=quotes),
                    description=GUITAR_OCR + "x" * 130 + "a" * 100 + "b" * 101,
                    observation_mode="masked_ocr_text")

    def test_unicode_crlf_whitespace_and_repeated_quotes_have_exact_codepoint_offsets(self):
        source = "🎸 标题\r\n  tuning\tE A D  \r\n重复\r\n重复"
        quotes = ["  tuning\tE A D  ", "重复"]
        self.extract_reply = self.reply(source_quotes=quotes)
        event, image = self.ingest(source)
        self.assertTrue(self.processor.process(event, image))
        grounding = self.row(event)["current_facts"]["source_grounding"]
        self.assertEqual(grounding["offset_unit"], "unicode_codepoints")
        for span in grounding["excerpts"]:
            self.assertEqual(span["start"], source.index(span["quote"]))
            self.assertEqual(source[span["start"]:span["end"]], span["quote"])

    def test_source_association_contains_no_model_proposals_and_returns_source_spans(self):
        self.seed_prior(summary="历史模型幻想内容")
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        prompt = self.requests[-1][1]
        self.assertNotIn("历史模型幻想内容", prompt)
        self.assertNotIn("文档 OCR 摘录", prompt)
        self.assertNotIn("吉他标准调弦", prompt)
        self.assertLessEqual(len(prompt.encode()), MAX_PROMPT_BYTES)
        context = self.row(event)["temporal_context"]
        self.assertEqual(context["citation_basis"], "post_mask_ocr_spans")
        self.assertEqual(context["association_state"], "ready")
        relation = context["relations"][0]
        span = relation["current_source_span"]
        self.assertEqual(span["observation_id"], event)
        self.assertEqual(GUITAR_OCR[span["start"]:span["end"]], relation["current_quote"])
        self.assertEqual(relation["prior_source_span"]["offset_unit"], "unicode_codepoints")

    def test_generated_summary_cannot_supply_association_evidence(self):
        previous = self.seed_prior()
        self.association_reply = json.dumps({"relations": [{"prior_observation_id": previous,
            "relation": "same_topic", "current_quote": "文档 OCR 摘录", "prior_quote": "文档 OCR 摘录"}]})
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        self.assertEqual(row["state"], "ready")
        self.assertEqual(row["temporal_context"]["association_reason"], "invalid_association_result")
        self.assertEqual(row["temporal_context"]["relations"], [])
        self.assertNotIn("真实琴弦", row["summary"])

    def test_legacy_ocr_summary_is_preserved_and_skipped_without_fallback(self):
        previous, _ = self.ingest("old source OCR")
        self.store.set_result(previous, state="ready", title="legacy", summary="old generated summary", boundary="unverified")
        before = deepcopy(self.row(previous))
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        context = self.row(event)["temporal_context"]
        self.assertEqual(context["association_reason"], "no_source_grounded_prior")
        self.assertEqual(context["prior_omitted_count"], 1)
        self.assertEqual(self.row(previous), before)
        self.assertEqual(len(self.requests), 1)

    def test_stale_or_malformed_prior_grounding_is_never_summary_fallback(self):
        self.seed_prior()
        event, image = self.ingest()
        current = self.store.processing_snapshot(event, image)
        prior = self.store.temporal_records(current)[0]
        self.assertTrue(ObservationProcessor.grounded_prior(prior))
        for mutate in (lambda row: row.update(post_mask_ocr_text="changed"),
                       lambda row: row["current_facts"]["source_grounding"].update(image_digest="f" * 64),
                       lambda row: row["current_facts"]["source_grounding"].update(semantic_verified=True),
                       lambda row: row["current_facts"]["source_grounding"]["excerpts"][0].update(start=True),
                       lambda row: row["current_facts"]["source_grounding"]["excerpts"][0].update(quote="changed"),
                       lambda row: row["current_facts"].update(summary="unrelated assertion")):
            invalid = deepcopy(prior); mutate(invalid)
            self.assertFalse(ObservationProcessor.grounded_prior(invalid))
        with self.assertRaisesRegex(ValueError, "invalid_source_grounding"):
            ObservationProcessor.build_association_prompt({"observation_route": "post_mask_ocr_to_text_model",
                "title": "legacy", "summary": "not source", "source_grounding": {}}, [prior])

    def test_prior_source_mutated_during_association_cannot_publish_relation(self):
        for target in ("ocr", "grounding"):
            with self.subTest(target=target):
                self.configure(session_id=str(uuid4()), observation_mode="masked_ocr_text")
                previous = self.seed_prior()
                def mutate(stage, options):
                    if stage != "association":
                        return
                    with self.db() as conn:
                        if target == "ocr":
                            conn.execute("UPDATE context_observations SET post_mask_ocr_text=? WHERE id=?", ("changed", previous))
                        else:
                            conn.execute("UPDATE context_observations SET current_facts=? WHERE id=?", ("{}", previous))
                self.hook = mutate
                event, image = self.ingest()
                self.assertTrue(self.processor.process(event, image))
                row = self.row(event)
                self.assertEqual(row["temporal_context"]["association_reason"], "temporal_context_changed")
                self.assertEqual(row["temporal_context"]["relations"], [])
                self.assertEqual(row["summary"], row["current_facts"]["summary"])
                self.assertIsNotNone(row["current_facts"]["source_grounding"])
                self.hook = None

    def test_daily_review_receives_only_attributed_excerpts_not_proposal(self):
        self.extract_reply = self.reply(summary=NEGATIVE["unsupported_summary"])
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        row = self.row(event)
        request = DailyReviewRequest(day="2026-10-02", timezone="UTC", confirmed=True)
        service = DailyReviewService(self.store, self.gateway, lambda: self.auth)
        prompt, _ = service._prompt(request, {"counts": {}}, [row])
        self.assertIn("attributed_ocr_excerpt_not_action_fact", prompt)
        self.assertNotIn(NEGATIVE["unsupported_summary"], prompt)
        self.assertNotIn("model_proposal", prompt)
        self.assertIn("standard tuning e a d g b e", prompt)

    def test_current_prompt_uses_new_bounded_schema_without_history(self):
        self.seed_prior()
        event, image = self.ingest()
        self.assertTrue(self.processor.process(event, image))
        _, prompt, schema = self.requests[0]
        self.assertEqual(schema, OCR_SELECTION_JSON_SCHEMA)
        self.assertLessEqual(len(prompt.encode()), MAX_PROMPT_BYTES)
        self.assertEqual([item[1] for item in json.loads(prompt.split("\n", 1)[1])["source_candidates"]], GUITAR_OCR.splitlines())
