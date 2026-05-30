from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]


class OpenClawSkillDocsTests(unittest.TestCase):
    def test_proactive_butler_tools_have_examples(self) -> None:
        text = (ROOT / "openclaw-skill" / "tools.yaml").read_text(encoding="utf-8")
        for tool in [
            "get_today_butler_overview",
            "get_active_insights",
            "get_butler_briefing",
            "explain_insight_evidence",
            "submit_insight_feedback",
            "get_context_recovery_pack",
        ]:
            start = text.index(f"  - name: {tool}")
            next_item = text.find("\n  - name:", start + 1)
            block = text[start:] if next_item == -1 else text[start:next_item]
            self.assertIn("request_example:", block, tool)
            self.assertIn("response_example:", block, tool)
        self.assertIn("data_insufficient_response_example:", text)
        self.assertIn("external_model_used: false", text)
        self.assertIn("system_notification_enabled: false", text)

    def test_skill_and_docs_define_data_insufficient_answer(self) -> None:
        skill = (ROOT / "openclaw-skill" / "SKILL.md").read_text(encoding="utf-8")
        docs = (ROOT / "docs" / "openclaw_integration.md").read_text(encoding="utf-8")
        for text in [skill, docs]:
            self.assertIn("data_quality_notice", text)
            self.assertTrue("evidence_boundary" in text or "evidence boundary" in text)
        self.assertIn("source_event_count", skill)
        self.assertIn("Do not invent insight ids", skill)
        self.assertIn("Required data-insufficient wording", docs)


if __name__ == "__main__":
    unittest.main()
