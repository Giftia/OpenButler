from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

from app.modules.butler_core.service import ButlerCoreService, init_butler_core_db
from app.modules.pc_activity_context.service import PCActivityContextService, init_pc_activity_context_db


class ButlerCoreServiceTests(unittest.TestCase):
    def make_empty_service(self) -> ButlerCoreService:
        tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        tmp.mkdir(parents=True, exist_ok=True)
        db_path = tmp / "openbutler.sqlite3"
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            init_pc_activity_context_db(conn)
            init_butler_core_db(conn)
            conn.commit()
        return ButlerCoreService(db_path, tmp / "runtime")

    def make_service(self) -> ButlerCoreService:
        tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        tmp.mkdir(parents=True, exist_ok=True)
        db_path = tmp / "openbutler.sqlite3"
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            init_pc_activity_context_db(conn)
            init_butler_core_db(conn)
            conn.commit()
        pc = PCActivityContextService(db_path, tmp / "runtime")
        start = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
        samples = [
            ("VS Code 编码", "VS Code", "OpenButler", "coding", 40),
            ("Chrome 查看 GitHub", "Chrome", "OpenButler", "browser", 30),
            ("VS Code 编码", "VS Code", "OpenButler", "coding", 32),
        ]
        for index, (title, app, project, activity_type, minutes) in enumerate(samples):
            s = start + timedelta(minutes=sum(item[4] for item in samples[:index]))
            e = s + timedelta(minutes=minutes)
            pc.create_event(
                {
                    "user_id": "demo-user",
                    "household_id": None,
                    "source": "minecontext",
                    "source_activity_id": f"act_{index}",
                    "source_context_id": None,
                    "started_at": s.isoformat(),
                    "ended_at": e.isoformat(),
                    "duration_seconds": minutes * 60,
                    "title": title,
                    "summary": "记录显示用户在 OpenButler 项目工作。",
                    "app_name": app,
                    "window_title": title,
                    "url": None,
                    "domain": "github.com" if app == "Chrome" else None,
                    "project_name": project,
                    "repo_name": "OpenButler",
                    "document_name": None,
                    "activity_type": activity_type,
                    "confidence": 0.82,
                    "evidence_level": "activity_record",
                    "evidence": {},
                    "screenshot_paths": [],
                    "raw_ref": f"minecontext:activity/act_{index}",
                    "privacy_level": "local_sensitive",
                }
            )
        return ButlerCoreService(db_path, tmp / "runtime")

    def test_rebuild_timeline_and_metrics(self) -> None:
        service = self.make_service()
        rebuilt = service.rebuild_timeline()
        self.assertEqual(rebuilt["count"], 3)
        metrics = service.metrics_today()["metrics"]
        self.assertEqual(metrics["pc_active_minutes"], 102)
        self.assertEqual(metrics["focus_minutes"], 72)
        self.assertEqual(metrics["source_event_count"], 3)

    def test_metrics_range_can_build_seven_day_summary_from_timeline(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()

        response = service.metrics_range(days=7)

        self.assertEqual(response["summary"]["status"], "ready")
        self.assertGreaterEqual(response["summary"]["days_with_data"], 1)
        self.assertEqual(response["summary"]["total_source_event_count"], 3)
        self.assertTrue(response["summary"]["top_apps"])
        self.assertTrue(response["summary"]["top_projects"])

    def test_generate_insights_and_briefing_have_boundaries(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        insights = service.generate_insights(force=True)["items"]
        types = {item["type"] for item in insights}
        self.assertIn("daily_overview", types)
        self.assertIn("focus_summary", types)
        self.assertTrue(all(item["evidence_boundary"] for item in insights))
        briefing = service.generate_briefing("evening")
        self.assertIn("远程仓库", briefing["evidence_boundary"])

    def test_feedback_changes_status(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        insight = service.generate_insights(force=True)["items"][0]
        updated = service.dismiss_insight(insight["id"])
        self.assertEqual(updated["status"], "dismissed")
        inaccurate = service.submit_feedback(insight["id"], "inaccurate", "不准确")
        self.assertEqual(inaccurate["status"], "marked_inaccurate")

    def test_repeated_dismiss_reduces_same_type_priority(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        overview = next(item for item in service.generate_insights(force=True)["items"] if item["type"] == "daily_overview")
        original_priority = overview["priority"]
        for _ in range(3):
            service.submit_feedback(overview["id"], "dismissed", "太频繁")

        regenerated = service.generate_insights(force=True)["items"]
        adjusted = next(item for item in regenerated if item["type"] == "daily_overview")

        self.assertEqual(adjusted["priority"], original_priority - 10)
        self.assertEqual(adjusted["metrics"]["feedback_adjustment"]["dismiss_count"], 3)

    def test_repeated_inaccurate_suppresses_same_type_insight(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        focus = next(item for item in service.generate_insights(force=True)["items"] if item["type"] == "focus_summary")
        for _ in range(3):
            service.submit_feedback(focus["id"], "inaccurate", "深度工作判断不准确")

        regenerated = service.generate_insights(force=True)["items"]
        types = {item["type"] for item in regenerated}

        self.assertIn("daily_overview", types)
        self.assertNotIn("focus_summary", types)

    def test_too_frequent_feedback_adds_cooldown_and_lowers_priority(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        overview = next(item for item in service.generate_insights(force=True)["items"] if item["type"] == "daily_overview")
        service.submit_feedback(overview["id"], "too_frequent", "以后少提醒")

        regenerated = service.generate_insights(force=True)["items"]
        adjusted = next(item for item in regenerated if item["type"] == "daily_overview")
        adjustment = adjusted["metrics"]["feedback_adjustment"]

        self.assertEqual(adjustment["too_frequent_count"], 1)
        self.assertEqual(adjustment["cooldown_minutes"], 240)
        self.assertEqual(adjusted["priority"], overview["priority"] - 10)

    def test_useful_feedback_boosts_same_type_priority(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        overview = next(item for item in service.generate_insights(force=True)["items"] if item["type"] == "daily_overview")
        service.submit_feedback(overview["id"], "useful", "有用")
        service.submit_feedback(overview["id"], "accepted_action", "接受建议")

        regenerated = service.generate_insights(force=True)["items"]
        adjusted = next(item for item in regenerated if item["type"] == "daily_overview")
        adjustment = adjusted["metrics"]["feedback_adjustment"]

        self.assertEqual(adjustment["useful_count"], 1)
        self.assertEqual(adjustment["accepted_count"], 1)
        self.assertEqual(adjustment["priority_boost"], 10)
        self.assertEqual(adjusted["priority"], overview["priority"] + 10)

    def test_data_quality_notice_is_not_permanently_suppressed(self) -> None:
        service = self.make_empty_service()
        notice = next(item for item in service.generate_insights(force=True)["items"] if item["type"] == "data_quality_notice")
        for _ in range(3):
            service.submit_feedback(notice["id"], "inaccurate", "数据质量提醒不准确")

        regenerated = service.generate_insights(force=True)["items"]
        adjusted = next(item for item in regenerated if item["type"] == "data_quality_notice")
        adjustment = adjusted["metrics"]["feedback_adjustment"]

        self.assertEqual(adjustment["inaccurate_count"], 3)
        self.assertTrue(adjustment["protected_notice"])
        self.assertFalse(adjustment["suppressed"])

    def test_insight_noise_evaluation_report_keeps_privacy_boundary(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        overview = next(item for item in service.generate_insights(force=True)["items"] if item["type"] == "daily_overview")
        service.submit_feedback(overview["id"], "too_frequent", "太频繁")
        service.submit_feedback(overview["id"], "useful", "有用")

        report = service.insight_noise_evaluation()
        daily = next(item for item in report["evaluations"] if item["insight_type"] == "daily_overview")

        self.assertEqual(report["schema_version"], "insight_noise_reduction_evaluation_v1")
        self.assertEqual(daily["too_frequent_count"], 1)
        self.assertEqual(daily["useful_count"], 1)
        self.assertIn("too_frequent", daily["reason_codes"])
        self.assertFalse(report["privacy"]["external_model_used"])
        self.assertFalse(report["privacy"]["external_webhook_used"])
        self.assertTrue(report["evidence_boundary"])

    def test_clear_butler_data_does_not_delete_pc_activity(self) -> None:
        service = self.make_service()
        service.rebuild_timeline()
        before = len(service.pc_activity().events())
        result = service.clear_data()
        after = len(service.pc_activity().events())
        self.assertEqual(before, after)
        self.assertEqual(result["minecontext_deleted"], 0)
        self.assertEqual(result["minecontext_source_deleted"], 0)
        self.assertIn("minecontext_source_database", result["preserved_scope"])
        self.assertIn("unified_timeline_events", result["deleted_scope"])

    def test_settings_include_local_retention_policy(self) -> None:
        service = self.make_service()
        settings = service.get_settings().model_dump()
        self.assertEqual(settings["retention"]["derived_data_retention_days"], 365)
        self.assertEqual(settings["retention"]["audit_log_retention_days"], 90)


if __name__ == "__main__":
    unittest.main()
