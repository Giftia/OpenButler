from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

from app.modules.butler_core.service import ButlerCoreService, init_butler_core_db
from app.modules.butler_core.tools.proactive_chat_tool import render_proactive_butler_chat
from app.modules.pc_activity_context.service import PCActivityContextService, init_pc_activity_context_db


class ProactiveChatToolTests(unittest.TestCase):
    def make_service(self, with_events: bool = True) -> ButlerCoreService:
        tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        tmp.mkdir(parents=True, exist_ok=True)
        db_path = tmp / "openbutler.sqlite3"
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            init_pc_activity_context_db(conn)
            init_butler_core_db(conn)
            conn.commit()
        if with_events:
            self.seed_pc_events(db_path, tmp / "runtime")
        return ButlerCoreService(db_path, tmp / "runtime")

    def seed_pc_events(self, db_path: Path, runtime_dir: Path) -> None:
        pc = PCActivityContextService(db_path, runtime_dir)
        start = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
        samples = [
            ("VS Code 编码", "VS Code", 40),
            ("Chrome 查看 GitHub", "Chrome", 30),
            ("VS Code 编码", "VS Code", 32),
        ]
        elapsed = 0
        for index, (title, app, minutes) in enumerate(samples):
            started_at = start + timedelta(minutes=elapsed)
            ended_at = started_at + timedelta(minutes=minutes)
            elapsed += minutes
            pc.create_event(
                {
                    "user_id": "demo-user",
                    "household_id": None,
                    "source": "minecontext",
                    "source_activity_id": f"chat_act_{index}",
                    "source_context_id": f"chat_ctx_{index}",
                    "started_at": started_at.isoformat(),
                    "ended_at": ended_at.isoformat(),
                    "duration_seconds": minutes * 60,
                    "title": title,
                    "summary": "记录显示用户在 OpenButler 项目工作；远程状态需要回源确认。",
                    "app_name": app,
                    "window_title": title,
                    "url": None,
                    "domain": "github.com" if app == "Chrome" else None,
                    "project_name": "OpenButler",
                    "repo_name": "OpenButler",
                    "document_name": None,
                    "activity_type": "coding" if app == "VS Code" else "browser",
                    "confidence": 0.82,
                    "evidence_level": "activity_record",
                    "evidence": {},
                    "screenshot_paths": [],
                    "raw_ref": f"minecontext:activity/chat_act_{index}",
                    "privacy_level": "local_sensitive",
                }
            )

    def test_inaccurate_feedback_is_recorded_from_chat(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        service.generate_insights(force=True)

        answer = render_proactive_butler_chat("这个建议不准确", service)
        penalties = service.feedback_penalties()

        self.assertIn("已记录", answer)
        self.assertIn("不准确", answer)
        self.assertIn("边界说明", answer)
        self.assertTrue(any(value["inaccurate_count"] == 1 for value in penalties.values()))

    def test_too_frequent_feedback_lowers_future_priority(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        service.generate_insights(force=True)

        answer = render_proactive_butler_chat("以后少提醒", service)
        penalties = service.feedback_penalties()

        self.assertIn("以后少提醒", answer)
        self.assertTrue(any(value["dismiss_count"] == 1 for value in penalties.values()))

    def test_feedback_without_active_insight_does_not_invent_target(self) -> None:
        service = self.make_service(with_events=False)

        answer = render_proactive_butler_chat("这个建议不准确", service)

        self.assertIn("现在没有可反馈", answer)
        self.assertEqual(service.feedback_penalties(), {})

    def test_data_insufficient_overview_keeps_boundary(self) -> None:
        service = self.make_service(with_events=False)

        answer = render_proactive_butler_chat("今天我主要做了什么", service)

        self.assertIn("数据还不够", answer)
        self.assertIn("边界说明", answer)

    def test_evidence_explanation_uses_user_language(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        service.generate_insights(force=True)

        answer = render_proactive_butler_chat("解释这条提醒的依据", service)

        self.assertIn("结论：", answer)
        self.assertIn("关键数字", answer)
        self.assertIn("依据：", answer)
        self.assertIn("边界说明", answer)
        self.assertIn("下一步：", answer)
        self.assertNotIn("evidence_refs", answer)
        self.assertNotIn("source_event_id", answer)

    def test_preference_guidance_does_not_silently_change_settings(self) -> None:
        service = self.make_service(with_events=False)

        answer = render_proactive_butler_chat("修改提醒偏好", service)

        self.assertIn("不会在没有确认时替你改设置", answer)
        self.assertIn("边界说明", answer)
        self.assertIn("下一步：", answer)


if __name__ == "__main__":
    unittest.main()
