from __future__ import annotations

import unittest

from app.modules.butler_core.unified_timeline import pc_activity_to_unified


class UnifiedTimelineTests(unittest.TestCase):
    def test_pc_activity_event_converts_to_unified_event(self) -> None:
        item = pc_activity_to_unified(
            {
                "id": "pc_1",
                "user_id": "demo-user",
                "source": "minecontext",
                "source_activity_id": "act_1",
                "started_at": "2026-05-29T09:00:00+08:00",
                "ended_at": "2026-05-29T09:40:00+08:00",
                "duration_seconds": 2400,
                "title": "VS Code 编码",
                "summary": "OpenButler 项目开发",
                "app_name": "VS Code",
                "project_name": "OpenButler",
                "activity_type": "coding",
                "confidence": 0.82,
                "evidence_level": "activity_record",
                "screenshot_paths": [r"C:\MineContext\screenshots\1.png"],
                "privacy_level": "local_sensitive",
            }
        )
        self.assertEqual(item["source"], "pc_activity")
        self.assertEqual(item["event_type"], "pc_activity")
        self.assertEqual(item["entities"]["project_name"], "OpenButler")
        self.assertEqual(item["evidence_level"], "activity_record")
        self.assertTrue(any(ref["kind"] == "screenshot_path" for ref in item["evidence_refs"]))


if __name__ == "__main__":
    unittest.main()
