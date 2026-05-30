from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from app.modules.pc_activity_context.service import PCActivityContextService, init_pc_activity_context_db


class PCActivityServiceTests(unittest.TestCase):
    def make_service(self) -> PCActivityContextService:
        tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        tmp.mkdir(parents=True, exist_ok=True)
        db_path = tmp / "openbutler.sqlite3"
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            init_pc_activity_context_db(conn)
            conn.commit()
        return PCActivityContextService(db_path, tmp / "runtime")

    def event_payload(self, source_activity_id: str | None = "act_001") -> dict:
        started_at = datetime.now().replace(microsecond=0)
        ended_at = started_at
        return {
            "user_id": "demo-user",
            "household_id": None,
            "source": "minecontext",
            "source_activity_id": source_activity_id,
            "source_context_id": None,
            "started_at": started_at.isoformat(),
            "ended_at": ended_at.isoformat(),
            "duration_seconds": 3600,
            "title": "VS Code coding",
            "summary": "Mock PC activity.",
            "app_name": "VS Code",
            "window_title": "VS Code",
            "url": None,
            "domain": None,
            "project_name": "OpenButler",
            "repo_name": "OpenButler",
            "document_name": None,
            "activity_type": "coding",
            "confidence": 0.8,
            "evidence_level": "activity_record",
            "evidence": {},
            "screenshot_paths": [r"C:\MineContext\screenshots\code.png"],
            "raw_ref": None,
            "privacy_level": "local_sensitive",
        }

    def test_default_settings_are_strict_readonly_path_only(self) -> None:
        service = self.make_service()
        settings = service.get_settings()
        self.assertFalse(settings.enabled)
        self.assertEqual(settings.privacy_mode, "strict")
        self.assertTrue(settings.minecontext.read_only)
        self.assertTrue(settings.minecontext.store_screenshot_paths)
        self.assertFalse(settings.minecontext.copy_screenshot_evidence)

    def test_summary_aggregates_imported_events(self) -> None:
        service = self.make_service()
        service.create_event(
            {
                "user_id": "demo-user",
                "household_id": None,
                "source": "minecontext",
                "source_activity_id": "act_001",
                "source_context_id": None,
                "started_at": datetime.now().isoformat(),
                "ended_at": datetime.now().isoformat(),
                "duration_seconds": 3600,
                "title": "VS Code 编码",
                "summary": "记录显示用户在 VS Code 编码。",
                "app_name": "VS Code",
                "window_title": "VS Code",
                "url": None,
                "domain": None,
                "project_name": None,
                "repo_name": None,
                "document_name": None,
                "activity_type": "coding",
                "confidence": 0.8,
                "evidence_level": "activity_record",
                "evidence": {},
                "screenshot_paths": [r"C:\MineContext\screenshots\code.png"],
                "raw_ref": "minecontext:activity/act_001",
                "privacy_level": "local_sensitive",
            }
        )
        summary = service.summary()
        self.assertEqual(summary["metrics"]["total_pc_active_minutes"], 60)
        self.assertEqual(summary["app_usage"]["VS Code"], 3600)
        self.assertEqual(len(summary["focus_blocks"]), 1)

    def test_create_event_is_idempotent_by_source_activity_id(self) -> None:
        service = self.make_service()
        first = service.create_event(self.event_payload("act_001"))
        second = service.create_event(self.event_payload("act_001"))

        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(service.events()), 1)

    def test_create_event_is_idempotent_by_stable_fingerprint_without_source_activity_id(self) -> None:
        service = self.make_service()
        payload = self.event_payload(None)
        first = service.create_event(payload)
        second = service.create_event({**payload, "source_activity_id": None})

        self.assertEqual(first["id"], second["id"])
        self.assertTrue(first["source_fingerprint"].startswith("pcact_"))
        self.assertEqual(len(service.events()), 1)


if __name__ == "__main__":
    unittest.main()
