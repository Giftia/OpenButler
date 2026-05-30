from __future__ import annotations

import unittest

from app.integrations.minecontext.normalizer import (
    classify_search_match,
    query_result_from_json,
    redact_sensitive_text,
    search_results_from_json,
)


class PCActivityNormalizerTests(unittest.TestCase):
    def test_query_result_from_activity_json(self) -> None:
        result = query_result_from_json(
            {
                "target_time": "2026-05-29T09:10:00",
                "window_minutes": 10,
                "direct_activities": [
                    {
                        "id": 1,
                        "title": "查看 OpenButler 文档",
                        "content": "用户正在 Chrome 查看 OpenButler 项目文档，并切换到 VS Code。",
                        "resources": [{"type": "image", "path": r"C:\MineContext\screenshots\090012.png"}],
                    }
                ],
                "nearby_activities": [],
                "nearby_contexts": [],
            },
            include_raw_output=False,
        )
        self.assertTrue(result.can_confirm)
        self.assertEqual(result.evidence_level, "activity_record")
        self.assertIn("1", result.activity_ids)
        self.assertEqual(len(result.screenshot_paths), 1)

    def test_keyword_alias_confirmed(self) -> None:
        results = search_results_from_json(
            {
                "query": "小红书网站",
                "activity_matches": [
                    {
                        "source_id": "activity/1555",
                        "start_time": "2026-05-29 15:09:07",
                        "end_time": "2026-05-29 15:24:07",
                        "summary": "通过 Chrome 浏览小红书页面。",
                        "matched_keywords": ["小红书"],
                        "evidence_refs": [{"path": r"C:\MineContext\screenshots\xhs.png"}],
                    }
                ],
            },
            {"小红书": ["小红书", "XHS", "Rednote", "xiaohongshu", "xhslink"]},
        )
        self.assertEqual(results[0].match_level, "confirmed_match")
        self.assertTrue(results[0].can_confirm)

    def test_generic_browser_terms_do_not_confirm_target(self) -> None:
        match_level, can_confirm, confidence, _ = classify_search_match(
            "小红书网站",
            ["网站", "Chrome"],
            "activity",
            [r"C:\MineContext\screenshots\browser.png"],
            {"小红书": ["小红书", "XHS", "Rednote", "xiaohongshu", "xhslink"]},
        )
        self.assertEqual(match_level, "not_confirmed")
        self.assertFalse(can_confirm)
        self.assertLess(confidence, 0.3)

    def test_sensitive_text_redaction(self) -> None:
        redacted = redact_sensitive_text("token=abcdef123456 password: secret 13800138000 user@example.com")
        self.assertIn("[REDACTED]", redacted)
        self.assertIn("[REDACTED_PHONE]", redacted)
        self.assertIn("[REDACTED_EMAIL]", redacted)


if __name__ == "__main__":
    unittest.main()
