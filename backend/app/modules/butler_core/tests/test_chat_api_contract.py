from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

import app.main as main
from app.modules.butler_core.service import ButlerCoreService
from app.modules.pc_activity_context.service import PCActivityContextService


class ChatApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_data_dir = main.DATA_DIR
        self.original_db_path = main.DB_PATH
        self.tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        self.tmp.mkdir(parents=True, exist_ok=True)
        main.DATA_DIR = self.tmp
        main.DB_PATH = self.tmp / "openbutler.sqlite3"
        main.init_db()

    def tearDown(self) -> None:
        main.DATA_DIR = self.original_data_dir
        main.DB_PATH = self.original_db_path

    def seed_pc_events(self) -> None:
        pc = PCActivityContextService(main.DB_PATH, self.tmp / "minecontext_runtime")
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
                    "source_activity_id": f"chat_contract_act_{index}",
                    "source_context_id": f"chat_contract_ctx_{index}",
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
                    "evidence": {"contract_fixture": True},
                    "screenshot_paths": [],
                    "raw_ref": f"minecontext:activity/chat_contract_act_{index}",
                    "privacy_level": "local_sensitive",
                }
            )

    def ask(self, message: str) -> str:
        response = main.chat(main.ChatRequest(message=message))
        self.assertEqual(response["privacy_mode"], "basic")
        return response["answer"]

    def test_today_main_work_uses_butler_overview(self) -> None:
        self.seed_pc_events()

        answer = self.ask("今天我主要做了什么？")

        self.assertIn("关键数字", answer)
        self.assertIn("PC 活跃约 102 分钟", answer)
        self.assertIn("当前有", answer)
        self.assertIn("边界说明", answer)
        self.assertIn("远程仓库", answer)

    def test_evening_review_uses_butler_briefing(self) -> None:
        self.seed_pc_events()

        answer = self.ask("帮我生成晚间复盘")

        self.assertIn("晚间复盘", answer)
        self.assertIn("深度工作约", answer)
        self.assertIn("边界说明", answer)

    def test_inaccurate_feedback_writes_to_butler_feedback(self) -> None:
        self.seed_pc_events()
        butler = ButlerCoreService(main.DB_PATH, self.tmp / "minecontext_runtime")
        butler.rebuild_timeline()
        butler.generate_insights(force=True)

        answer = self.ask("这个建议不准确，以后少提醒")
        penalties = butler.feedback_penalties()

        self.assertIn("已记录", answer)
        self.assertIn("边界说明", answer)
        self.assertTrue(any(value["inaccurate_count"] == 1 for value in penalties.values()))

    def test_data_insufficient_does_not_fabricate_overview(self) -> None:
        answer = self.ask("今天我主要做了什么？")

        self.assertIn("当前 PC 活动数据不足", answer)
        self.assertIn("边界说明", answer)
        self.assertNotIn("关键数字", answer)

    def test_chat_contract_does_not_delete_minecontext_source(self) -> None:
        self.seed_pc_events()
        before = len(PCActivityContextService(main.DB_PATH, self.tmp / "minecontext_runtime").events())

        self.ask("今天我主要做了什么？")
        self.ask("这个建议不准确")
        after = len(PCActivityContextService(main.DB_PATH, self.tmp / "minecontext_runtime").events())

        self.assertEqual(before, after)
        with closing(sqlite3.connect(main.DB_PATH)) as conn:
            count = conn.execute("SELECT COUNT(*) FROM pc_activity_events").fetchone()[0]
        self.assertEqual(count, before)


if __name__ == "__main__":
    unittest.main()
