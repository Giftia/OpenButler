from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from datetime import datetime, timedelta
from importlib import import_module
from pathlib import Path
from uuid import uuid4

from app.integrations.minecontext.schemas import MineContextActivity
from app.modules.butler_core.schemas import (
    BriefingGenerateRequest,
    DemoRunRequest,
    InsightFeedbackRequest,
    PCActivityImportPreviewRequest,
)
from app.modules.butler_core.service import init_butler_core_db
from app.modules.pc_activity_context.service import PCActivityContextService, init_pc_activity_context_db

butler_router = import_module("app.modules.butler_core.router")


class ButlerApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        tmp.mkdir(parents=True, exist_ok=True)
        self.db_path = tmp / "openbutler.sqlite3"
        self.runtime_dir = tmp / "runtime"
        with closing(sqlite3.connect(self.db_path)) as conn:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            init_pc_activity_context_db(conn)
            init_butler_core_db(conn)
            conn.commit()
        self.seed_pc_activity_events()
        butler_router.configure_butler_core(self.db_path, self.runtime_dir)

    def configure_empty_workspace(self) -> None:
        tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        tmp.mkdir(parents=True, exist_ok=True)
        db_path = tmp / "openbutler.sqlite3"
        runtime_dir = tmp / "runtime"
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            init_pc_activity_context_db(conn)
            init_butler_core_db(conn)
            conn.commit()
        butler_router.configure_butler_core(db_path, runtime_dir)

    def seed_pc_activity_events(self) -> None:
        pc_service = PCActivityContextService(self.db_path, self.runtime_dir)
        start = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
        samples = [
            ("VS Code 编码", "VS Code", "OpenButler", "coding", 40),
            ("Chrome 查看 GitHub", "Chrome", "OpenButler", "browser", 30),
            ("VS Code 编码", "VS Code", "OpenButler", "coding", 32),
        ]
        elapsed = 0
        for index, (title, app_name, project_name, activity_type, minutes) in enumerate(samples):
            started_at = start + timedelta(minutes=elapsed)
            ended_at = started_at + timedelta(minutes=minutes)
            elapsed += minutes
            pc_service.create_event(
                {
                    "user_id": "demo-user",
                    "household_id": None,
                    "source": "minecontext",
                    "source_activity_id": f"act_contract_{index}",
                    "source_context_id": f"ctx_contract_{index}",
                    "started_at": started_at.isoformat(),
                    "ended_at": ended_at.isoformat(),
                    "duration_seconds": minutes * 60,
                    "title": title,
                    "summary": "记录显示用户在 OpenButler 项目工作；远程状态需要回源确认。",
                    "app_name": app_name,
                    "window_title": title,
                    "url": None,
                    "domain": "github.com" if app_name == "Chrome" else None,
                    "project_name": project_name,
                    "repo_name": "OpenButler",
                    "document_name": None,
                    "activity_type": activity_type,
                    "confidence": 0.82,
                    "evidence_level": "activity_record",
                    "evidence": {"contract_fixture": True},
                    "screenshot_paths": [rf"C:\MineContext\screenshots\contract_{index}.png"],
                    "raw_ref": f"minecontext:activity/act_contract_{index}",
                    "privacy_level": "local_sensitive",
                }
            )

    def test_timeline_rebuild_contract(self) -> None:
        response = butler_router.rebuild_timeline()

        self.assertEqual(response["source"], "pc_activity")
        self.assertEqual(response["count"], 3)
        self.assertEqual(len(response["created"]), 3)
        first = response["created"][0]
        for key in ["id", "source_event_id", "started_at", "event_type", "evidence_refs", "evidence_boundary", "confidence"]:
            self.assertIn(key, first)
        self.assertEqual(first["event_type"], "pc_activity")
        self.assertTrue(first["evidence_boundary"])

    def test_metrics_today_contract(self) -> None:
        butler_router.rebuild_timeline()
        response = butler_router.metrics_today()

        self.assertEqual(response["period"], "today")
        self.assertIn("metrics", response)
        metrics = response["metrics"]
        self.assertEqual(metrics["pc_active_minutes"], 102)
        self.assertEqual(metrics["focus_minutes"], 72)
        self.assertEqual(metrics["source_event_count"], 3)
        self.assertIn("evidence_refs", response)
        self.assertTrue(response["evidence_boundary"])

    def test_metrics_range_returns_recent_seven_day_trend(self) -> None:
        butler_router.rebuild_timeline()
        butler_router.metrics_today()

        response = butler_router.metrics(days=7)

        self.assertEqual(response["period"], "recent_days")
        self.assertEqual(response["days"], 7)
        self.assertEqual(len(response["trend"]), 7)
        self.assertTrue(response["evidence_boundary"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        today = response["trend"][-1]
        self.assertEqual(today["status"], "ready")
        self.assertEqual(today["pc_active_minutes"], 102)
        self.assertEqual(today["focus_minutes"], 72)
        self.assertEqual(today["context_switch_count"], 0)
        self.assertEqual(response["summary"]["status"], "ready")
        self.assertEqual(response["summary"]["days_with_data"], 1)
        self.assertEqual(response["summary"]["total_source_event_count"], 3)

    def test_metrics_range_returns_data_insufficient_empty_state(self) -> None:
        self.configure_empty_workspace()

        response = butler_router.metrics(days=7)

        self.assertEqual(response["summary"]["status"], "data_insufficient")
        self.assertEqual(response["summary"]["days_with_data"], 0)
        self.assertEqual(len(response["trend"]), 7)
        self.assertTrue(all(item["status"] == "data_insufficient" for item in response["trend"]))
        self.assertIn("PC Activity", response["summary"]["data_insufficient_message"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)

    def test_home_contract_preserves_privacy_and_evidence_boundary(self) -> None:
        response = butler_router.home()

        self.assertIn("overview", response)
        self.assertIn("metrics", response)
        self.assertIn("insights", response)
        self.assertIn("suggested_next_actions", response)
        self.assertIn("timeline", response)
        self.assertTrue(response["overview"]["evidence_boundary"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["system_notification_enabled"])

    def test_home_returns_data_quality_notice_when_pc_activity_is_empty(self) -> None:
        self.configure_empty_workspace()

        response = butler_router.home()

        self.assertEqual(response["metrics"]["source_event_count"], 0)
        self.assertIn("数据不足", response["overview"]["headline"])
        self.assertTrue(response["overview"]["evidence_boundary"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["system_notification_enabled"])
        self.assertTrue(any(item["type"] == "data_quality_notice" for item in response["insights"]))
        self.assertTrue(any(action["type"] == "import_pc_activity" for action in response["suggested_next_actions"]))

    def test_readiness_contract_reports_core_mvp_ready(self) -> None:
        butler_router.generate_briefing(BriefingGenerateRequest(type="evening"))
        response = butler_router.readiness()

        self.assertEqual(response["status"], "ready")
        self.assertGreaterEqual(response["summary"]["pc_activity_events"], 3)
        self.assertGreaterEqual(response["summary"]["timeline_events"], 3)
        self.assertGreaterEqual(response["summary"]["insights"], 1)
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["system_notification_enabled"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        checks = {item["id"]: item for item in response["checks"]}
        for key in ["unified_timeline", "today_metrics", "insight_engine", "feedback_loop", "openclaw_tools", "strict_privacy"]:
            self.assertEqual(checks[key]["status"], "ready", key)
            self.assertTrue(checks[key]["evidence_boundary"])

    def test_readiness_contract_reports_data_insufficient(self) -> None:
        self.configure_empty_workspace()

        response = butler_router.readiness()

        self.assertEqual(response["status"], "data_insufficient")
        checks = {item["id"]: item for item in response["checks"]}
        self.assertEqual(checks["pc_activity_source"]["status"], "data_insufficient")
        self.assertEqual(checks["today_metrics"]["status"], "data_insufficient")
        self.assertEqual(checks["strict_privacy"]["status"], "ready")
        self.assertFalse(response["privacy"]["external_model_used"])

    def test_mvp_report_contract_summarizes_acceptance_and_privacy(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))

        response = butler_router.mvp_report()

        self.assertEqual(response["schema_version"], "butler_mvp_report_v1")
        self.assertEqual(response["status"], "ready")
        self.assertTrue(response["evidence_boundary"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["external_model_allowed"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertIn("GET /api/butler/mvp-report", response["demo_paths"]["mvp_report"])
        self.assertIn("npm run smoke:butler-mvp-report", response["verification_commands"])
        checks = {item["id"]: item for item in response["acceptance"]}
        for key in [
            "pc_activity_source_events",
            "unified_timeline_ready",
            "today_metrics_ready",
            "active_insights_ready",
            "feedback_loop_ready",
            "briefing_ready",
            "openclaw_tools_ready",
            "strict_privacy_ready",
            "minecontext_source_preserved",
            "evidence_boundaries_present",
        ]:
            self.assertEqual(checks[key]["status"], "passed", key)
            self.assertTrue(checks[key]["evidence_boundary"])
            self.assertEqual(checks[key]["next_action"]["type"], "none", key)
        stages = [item["stage"] for item in response["mvp_chain"]]
        self.assertIn("MineContext / godview", stages)
        self.assertIn("Unified Timeline", stages)
        self.assertIn("Insight Cards", stages)

    def test_mvp_report_contract_reports_data_insufficient_without_fabrication(self) -> None:
        self.configure_empty_workspace()

        response = butler_router.mvp_report()

        self.assertEqual(response["status"], "data_insufficient")
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        checks = {item["id"]: item for item in response["acceptance"]}
        self.assertEqual(checks["pc_activity_source_events"]["status"], "needs_attention")
        self.assertEqual(checks["today_metrics_ready"]["status"], "needs_attention")
        self.assertEqual(checks["strict_privacy_ready"]["status"], "passed")
        self.assertEqual(checks["pc_activity_source_events"]["next_action"]["type"], "import_pc_activity")
        self.assertEqual(checks["pc_activity_source_events"]["next_action"]["endpoint"], "POST /api/pc-activity/minecontext/import")
        self.assertEqual(checks["unified_timeline_ready"]["next_action"]["type"], "rebuild_timeline")
        self.assertEqual(checks["today_metrics_ready"]["next_action"]["type"], "generate_metrics")
        self.assertEqual(checks["strict_privacy_ready"]["next_action"]["type"], "none")
        self.assertTrue(response["evidence_boundary"])

    def test_data_insufficient_drill_is_read_only_and_actionable(self) -> None:
        before_events = len(PCActivityContextService(self.db_path, self.runtime_dir).events())

        response = butler_router.data_insufficient_drill()

        after_events = len(PCActivityContextService(self.db_path, self.runtime_dir).events())
        self.assertEqual(response["schema_version"], "butler_data_insufficient_drill_v1")
        self.assertEqual(response["status"], "data_insufficient")
        self.assertTrue(response["dry_run"])
        self.assertFalse(response["mutates_data"])
        self.assertEqual(before_events, after_events)
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["external_model_allowed"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertTrue(response["evidence_boundary"])
        checks = {item["id"]: item for item in response["acceptance"]}
        self.assertEqual(checks["pc_activity_source_events"]["status"], "needs_attention")
        self.assertEqual(checks["pc_activity_source_events"]["next_action"]["type"], "import_pc_activity")
        self.assertEqual(checks["unified_timeline_ready"]["next_action"]["type"], "rebuild_timeline")
        self.assertEqual(checks["today_metrics_ready"]["next_action"]["type"], "generate_metrics")
        self.assertEqual(checks["active_insights_ready"]["next_action"]["type"], "generate_insights")
        self.assertEqual(checks["briefing_ready"]["next_action"]["type"], "generate_briefing")
        self.assertEqual(checks["strict_privacy_ready"]["status"], "passed")
        self.assertEqual(checks["minecontext_source_preserved"]["status"], "passed")
        self.assertIn("import_pc_activity", response["recommended_sequence"])

    def test_pc_activity_import_preview_is_dry_run_and_detects_duplicates(self) -> None:
        delegate = PCActivityContextService(self.db_path, self.runtime_dir)

        class FakeAdapter:
            def export_recent_activities(self, start_time, end_time, limit):
                return [
                    MineContextActivity(
                        source_activity_id="act_contract_0",
                        started_at=start_time,
                        ended_at=start_time + timedelta(minutes=10),
                        title="duplicate activity",
                        summary="already imported",
                        resources=[{"path": r"C:\MineContext\screenshots\duplicate.png"}],
                        metadata={},
                    ),
                    MineContextActivity(
                        source_activity_id="act_preview_new",
                        started_at=start_time + timedelta(minutes=15),
                        ended_at=start_time + timedelta(minutes=25),
                        title="new activity",
                        summary="preview only",
                        resources=[{"path": r"C:\MineContext\screenshots\new.png"}],
                        metadata={},
                    ),
                ]

        delegate.adapter = lambda: FakeAdapter()  # type: ignore[method-assign]
        butler = butler_router.service()
        original_pc_activity = butler.pc_activity
        butler.pc_activity = lambda: delegate  # type: ignore[method-assign]
        before = len(delegate.events())
        try:
            response = butler_router.preview_pc_activity_import(
                PCActivityImportPreviewRequest(lookback_days=7, dry_run=True, copy_screenshots=True)
            )
        finally:
            butler.pc_activity = original_pc_activity  # type: ignore[method-assign]
        after = len(delegate.events())

        self.assertEqual(before, after)
        self.assertTrue(response["dry_run"])
        self.assertEqual(response["status"], "preview_ready")
        self.assertEqual(response["estimated_source_events"], 2)
        self.assertEqual(response["estimated_duplicate_events"], 1)
        self.assertEqual(response["estimated_new_events"], 1)
        self.assertTrue(response["screenshot_paths_included"])
        self.assertEqual(response["estimated_screenshot_path_count"], 2)
        self.assertFalse(response["screenshots_copied"])
        self.assertFalse(response["copy_screenshots_effective"])
        self.assertFalse(response["mutates_openbutler_db"])
        self.assertFalse(response["minecontext_source_mutated"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertIn("不会复制截图文件", response["warnings"])
        self.assertTrue(response["evidence_boundary"])

    def test_pc_activity_import_preview_rejects_non_dry_run(self) -> None:
        before = len(PCActivityContextService(self.db_path, self.runtime_dir).events())

        response = butler_router.preview_pc_activity_import(
            PCActivityImportPreviewRequest(dry_run=False)
        )

        after = len(PCActivityContextService(self.db_path, self.runtime_dir).events())
        self.assertEqual(before, after)
        self.assertEqual(response["status"], "rejected")
        self.assertFalse(response["mutates_openbutler_db"])
        self.assertFalse(response["minecontext_source_mutated"])
        self.assertFalse(response["screenshots_copied"])
        self.assertFalse(response["external_model_used"])
        self.assertTrue(response["evidence_boundary"])

    def test_l2_strict_privacy_regression_for_import_preview(self) -> None:
        response = butler_router.preview_pc_activity_import(
            PCActivityImportPreviewRequest(lookback_days=7, dry_run=True, copy_screenshots=True)
        )

        self.assertTrue(response["dry_run"])
        self.assertFalse(response["screenshots_copied"])
        self.assertFalse(response["copy_screenshots_effective"])
        self.assertFalse(response["mutates_openbutler_db"])
        self.assertFalse(response["minecontext_source_mutated"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["external_model_allowed"])
        self.assertFalse(response["privacy"]["external_webhook_used"])
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertFalse(response["privacy"]["raw_output_included"])
        self.assertNotIn("raw_output", str(response.get("items", [])))

    def test_latest_harness_runs_persist_mvp_and_drill_summaries(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))
        report = butler_router.mvp_report()
        drill = butler_router.data_insufficient_drill()

        response = butler_router.latest_harness_runs()

        self.assertEqual(response["count"], 2)
        self.assertTrue(response["evidence_boundary"])
        items = {item["kind"]: item for item in response["items"]}
        self.assertEqual(items["mvp_report"]["status"], report["status"])
        self.assertFalse(items["mvp_report"]["dry_run"])
        self.assertFalse(items["mvp_report"]["mutates_data"])
        self.assertEqual(items["mvp_report"]["privacy"]["minecontext_source_deleted"], 0)
        self.assertTrue(items["mvp_report"]["evidence_boundary"])
        self.assertEqual(items["data_insufficient_drill"]["status"], drill["status"])
        self.assertTrue(items["data_insufficient_drill"]["dry_run"])
        self.assertFalse(items["data_insufficient_drill"]["mutates_data"])
        self.assertIn("pc_activity_source_events", items["data_insufficient_drill"]["failed_checks"])
        self.assertFalse(items["data_insufficient_drill"]["privacy"]["external_model_used"])
        self.assertEqual(items["data_insufficient_drill"]["privacy"]["copied_screenshots"], 0)

    def test_productization_objective_status_maps_active_goals_to_evidence(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))

        response = butler_router.productization_objective_status()

        self.assertEqual(response["schema_version"], "productization_objective_status_v1")
        self.assertEqual(response["status"], "needs_attention")
        self.assertTrue(response["evidence_boundary"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["external_model_allowed"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertTrue(response["goals_source"]["loaded"])
        self.assertEqual(response["goals_source"]["path"], ".openbutler/goals.yaml")
        self.assertGreaterEqual(response["goals_source"]["active_objective_count"], 1)
        template = response["evidence_mapper_template"]
        self.assertEqual(template["schema_version"], "active_objective_evidence_mapper_template_v1")
        self.assertEqual(template["goals_path"], ".openbutler/goals.yaml")
        self.assertEqual(template["doc_path"], "docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md")
        self.assertIn("Add an entry in criteria_by_objective", " ".join(template["required_steps"]))
        self.assertIn("evidence_boundary", template["criterion_contract"])
        self.assertIn("minecontext_source_deleted must remain 0", template["privacy_invariants"])
        objectives = {item["id"]: item for item in response["objectives"]}
        self.assertEqual(set(objectives), {"OB-GOAL-027"})
        objective = objectives["OB-GOAL-027"]
        self.assertEqual(objective["status"], "needs_attention")
        self.assertEqual(objective["title"], "Loop-Driven Ambient OpenButler")
        self.assertEqual(objective["proven_count"], objective["criteria_count"] - 3)
        self.assertEqual(objective["priority"], "P0")
        self.assertTrue(objective["success_criteria"])
        self.assertEqual(objective["source_ref"]["path"], ".openbutler/goals.yaml")
        for criterion in objective["criteria"]:
            self.assertTrue(criterion["evidence_refs"])
            self.assertTrue(criterion["evidence_boundary"])
        criteria = {item["id"]: item for item in objective["criteria"]}
        self.assertEqual(criteria["canonical_repository_baseline"]["status"], "proven")
        self.assertEqual(criteria["loop_control_plane_files"]["status"], "proven")
        self.assertEqual(criteria["read_only_governance_audit"]["status"], "proven")
        self.assertEqual(criteria["required_ci_gates"]["status"], "proven")
        self.assertEqual(criteria["nightly_scheduler_runtime_readback"]["status"], "needs_attention")
        self.assertEqual(criteria["supervised_dry_run_and_human_gate"]["status"], "needs_attention")
        self.assertEqual(criteria["l2_pr_preview_contract"]["status"], "needs_attention")
        self.assertEqual(criteria["integrated_context_engine_roadmap"]["status"], "proven")
        self.assertEqual(criteria["first_manual_l1_accepted"]["status"], "proven")
        self.assertTrue(criteria["first_manual_l1_accepted"]["details"]["human_gate"])

    def test_productization_objective_status_surfaces_unknown_goals(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))
        butler = butler_router.service()
        original_loader = butler._load_productization_goals
        butler._load_productization_goals = lambda root: {  # type: ignore[method-assign]
            "loaded": True,
            "parse_warnings": [],
            "active_objectives": [
                {
                    "id": "OB-GOAL-FUTURE",
                    "title": "未来产品化目标",
                    "priority": "P0",
                    "success_criteria": ["声明后必须有 evidence mapper"],
                }
            ],
        }
        try:
            response = butler_router.productization_objective_status()
        finally:
            butler._load_productization_goals = original_loader  # type: ignore[method-assign]

        self.assertEqual(response["status"], "needs_attention")
        self.assertTrue(response["goals_source"]["loaded"])
        self.assertEqual(response["goals_source"]["active_objective_count"], 1)
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        objective = response["objectives"][0]
        self.assertEqual(objective["id"], "OB-GOAL-FUTURE")
        self.assertEqual(objective["status"], "needs_attention")
        self.assertEqual(objective["priority"], "P0")
        self.assertEqual(objective["source_ref"]["path"], ".openbutler/goals.yaml")
        self.assertIn("声明后必须有 evidence mapper", objective["success_criteria"])
        criteria = {item["id"]: item for item in objective["criteria"]}
        self.assertEqual(criteria["evidence_mapper_missing"]["status"], "needs_attention")
        self.assertIn("evidence mapper", criteria["evidence_mapper_missing"]["title"])
        self.assertTrue(criteria["evidence_mapper_missing"]["evidence_boundary"])
        self.assertEqual(
            criteria["evidence_mapper_missing"]["details"]["template_schema_version"],
            "active_objective_evidence_mapper_template_v1",
        )
        self.assertEqual(
            criteria["evidence_mapper_missing"]["details"]["doc_path"],
            "docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md",
        )
        evidence_paths = {item["path"] for item in criteria["evidence_mapper_missing"]["evidence_refs"]}
        self.assertIn(".openbutler/goals.yaml", evidence_paths)
        self.assertIn("docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md", evidence_paths)
        self.assertIn(
            "Return needs_attention with evidence_mapper_missing",
            response["evidence_mapper_template"]["unknown_objective_behavior"],
        )

    def test_productization_l1_audit_report_lists_success_criteria_and_evidence(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))

        response = butler_router.productization_l1_audit_report()

        self.assertEqual(response["schema_version"], "l1_active_objectives_audit_v1")
        self.assertEqual(response["status"], "needs_attention")
        self.assertEqual(response["source"]["goals_path"], ".openbutler/goals.yaml")
        self.assertIn("missing_evidence", response["allowed_results"])
        self.assertIn("out_of_scope", response["allowed_results"])
        self.assertEqual(response["summary"]["objective_count"], 1)
        self.assertGreaterEqual(response["summary"]["success_criteria_count"], 6)
        self.assertEqual(response["summary"]["missing_evidence"], 0)
        self.assertEqual(response["summary"]["out_of_scope"], 0)
        self.assertEqual(response["summary"]["needs_attention"], 3)
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["external_model_allowed"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertTrue(response["privacy"]["strict_mode_respected"])
        self.assertTrue(response["evidence_boundary"])
        objectives = {item["id"]: item for item in response["objectives"]}
        goal = objectives["OB-GOAL-027"]
        self.assertEqual(goal["objective_status"], "needs_attention")
        checks = {item["success_criterion"]: item for item in goal["success_criteria"]}
        self.assertEqual(checks["LOOP.md、STATE.md、loop-budget.md、loop-constraints.md、loop-run-log.md 存在且相互一致"]["verification_result"], "proven")
        self.assertEqual(checks["L1 治理巡检仅写入忽略目录中的报告，不修改产品代码或 GitHub 状态"]["verification_result"], "proven")
        self.assertEqual(checks["基础 CI 覆盖 Butler Core、PC Activity、Workstation Vision、Frontend 和 Desktop contract"]["verification_result"], "proven")
        self.assertEqual(checks["Integrated Context Engine 路线固定为 OB-GOAL-034 到 OB-GOAL-041"]["verification_result"], "proven")
        self.assertEqual(checks["未读取真实 MineContext 活动、未复制截图、未调用外部模型"]["verification_result"], "proven")
        self.assertEqual(checks["首次人工 L1 已在 canonical main 上完成并被人工接受"]["verification_result"], "proven")
        self.assertEqual(checks["19:00 本机夜间控制器和 08:00 验收任务有真实运行回读"]["verification_result"], "needs_attention")
        self.assertEqual(checks["一次监督 dry-run 通过后仍需用户明确批准进入 L2"]["verification_result"], "needs_attention")
        self.assertEqual(checks["L2 每个 Issue 使用独立 PR，早晨通过 OpenButler Preview 验收，夜间永不合并"]["verification_result"], "needs_attention")
        self.assertTrue(checks["LOOP.md、STATE.md、loop-budget.md、loop-constraints.md、loop-run-log.md 存在且相互一致"]["evidence_refs"])
        self.assertTrue(checks["未读取真实 MineContext 活动、未复制截图、未调用外部模型"]["evidence_boundary"])

    def test_productization_l1_audit_report_distinguishes_missing_and_out_of_scope(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))
        butler = butler_router.service()
        original_loader = butler._load_productization_goals
        butler._load_productization_goals = lambda root: {  # type: ignore[method-assign]
            "loaded": True,
            "parse_warnings": [],
            "active_objectives": [
                {
                    "id": "OB-GOAL-FUTURE",
                    "title": "未来产品化目标",
                    "priority": "P0",
                    "success_criteria": ["声明后必须有 evidence mapper", "确认远程部署成功"],
                }
            ],
        }
        try:
            response = butler_router.productization_l1_audit_report()
        finally:
            butler._load_productization_goals = original_loader  # type: ignore[method-assign]

        self.assertEqual(response["status"], "needs_attention")
        self.assertEqual(response["summary"]["objective_count"], 1)
        self.assertEqual(response["summary"]["missing_evidence"], 1)
        self.assertEqual(response["summary"]["out_of_scope"], 1)
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        objective = response["objectives"][0]
        self.assertEqual(objective["objective_status"], "needs_attention")
        checks = {item["success_criterion"]: item for item in objective["success_criteria"]}
        self.assertEqual(checks["声明后必须有 evidence mapper"]["verification_result"], "missing_evidence")
        self.assertEqual(checks["声明后必须有 evidence mapper"]["mapped_criterion_id"], "evidence_mapper_missing")
        self.assertEqual(checks["确认远程部署成功"]["verification_result"], "out_of_scope")
        self.assertIn("source system", checks["确认远程部署成功"]["evidence_boundary"])

    def test_productization_demo_pack_aggregates_local_harness_evidence(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))

        response = butler_router.productization_demo_pack()

        self.assertEqual(response["schema_version"], "productization_demo_pack_v1")
        self.assertEqual(response["status"], "attention_needed")
        self.assertEqual(response["readiness"]["status"], "ready")
        self.assertEqual(response["mvp_report"]["status"], "ready")
        self.assertEqual(response["objective_status"]["status"], "needs_attention")
        self.assertGreaterEqual(response["latest_harness_runs"]["count"], 1)
        self.assertIn("POST /api/butler/demo/run", response["demo_commands"])
        self.assertIn("GET /api/butler/productization/demo-pack", response["demo_commands"])
        self.assertIn("npm run smoke:butler-ui-flow", response["demo_commands"])
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertFalse(response["privacy"]["external_model_allowed"])
        self.assertFalse(response["privacy"]["system_notification_enabled"])
        self.assertTrue(response["privacy"]["strict_mode_respected"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertTrue(response["evidence_boundary"])
        self.assertIn("does not inspect, copy, delete, or mutate MineContext", " ".join(response["limitations"]))

    def test_demo_run_contract_continues_when_minecontext_import_is_unavailable(self) -> None:
        butler = butler_router.service()
        delegate = PCActivityContextService(self.db_path, self.runtime_dir)

        class FailingImportPCActivity:
            def import_activities(self, start_time, end_time, limit):
                raise RuntimeError("mock MineContext unavailable")

            def events(self):
                return delegate.events()

            def summary(self):
                return delegate.summary()

        butler.pc_activity = lambda: FailingImportPCActivity()  # type: ignore[method-assign]

        response = butler_router.run_demo(DemoRunRequest())

        self.assertEqual(response["status"], "completed")
        self.assertEqual(response["steps"]["pc_activity_import"]["status"], "unavailable")
        self.assertIn("不会编造今日活动", response["steps"]["pc_activity_import"]["message"])
        self.assertEqual(response["steps"]["timeline_rebuild"]["count"], 3)
        self.assertGreaterEqual(response["steps"]["insight_generation"]["count"], 1)
        self.assertEqual(response["steps"]["briefing_generation"]["type"], "evening")
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertEqual(response["privacy"]["copied_screenshots"], 0)
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertTrue(response["evidence_boundary"])

    def test_insight_feedback_contract(self) -> None:
        butler_router.rebuild_timeline()
        created = butler_router.generate_insights()
        insight = created["items"][0]

        response = butler_router.feedback(
            insight["id"],
            InsightFeedbackRequest(feedback_type="inaccurate", comment="合约测试：该洞察不准确"),
        )

        self.assertEqual(response["id"], insight["id"])
        self.assertEqual(response["status"], "marked_inaccurate")
        self.assertTrue(response["evidence_boundary"])

    def test_briefing_generate_contract(self) -> None:
        butler_router.rebuild_timeline()
        butler_router.generate_insights()

        response = butler_router.generate_briefing(BriefingGenerateRequest(type="evening"))

        self.assertEqual(response["type"], "evening")
        self.assertIn("title", response)
        self.assertIn("sections", response)
        self.assertIn("key_metrics", response)
        self.assertIn("suggested_next_actions", response)
        self.assertTrue(response["evidence_boundary"])

    def test_weekly_review_briefing_uses_seven_day_metrics(self) -> None:
        butler_router.rebuild_timeline()
        butler_router.generate_insights()

        response = butler_router.generate_briefing(BriefingGenerateRequest(type="weekly_review"))

        self.assertEqual(response["type"], "weekly_review")
        self.assertIn("total_pc_active_minutes", response["key_metrics"])
        self.assertIn("total_focus_minutes", response["key_metrics"])
        self.assertEqual(response["key_metrics"]["pc_active_minutes"], response["key_metrics"]["total_pc_active_minutes"])
        self.assertTrue(response["evidence_refs"])
        self.assertTrue(response["evidence_boundary"])

    def test_export_contract_contains_only_butler_structured_data(self) -> None:
        butler_router.rebuild_timeline()
        butler_router.metrics_today()
        butler_router.generate_insights()
        butler_router.generate_briefing(BriefingGenerateRequest(type="evening"))
        butler_router.mvp_report()
        butler_router.data_insufficient_drill()

        response = butler_router.export_data()

        self.assertEqual(response["schema_version"], "butler_export_v1")
        self.assertGreaterEqual(response["counts"]["timeline"], 3)
        self.assertGreaterEqual(response["counts"]["metrics"], 5)
        self.assertGreaterEqual(response["counts"]["insights"], 1)
        self.assertGreaterEqual(response["counts"]["briefings"], 1)
        self.assertGreaterEqual(response["counts"]["harness_runs"], 2)
        self.assertIn("timeline", response)
        self.assertIn("metrics", response)
        self.assertIn("insights", response)
        self.assertIn("harness_runs", response)
        self.assertNotIn("pc_activity_events", response)
        self.assertFalse(response["privacy"]["contains_minecontext_screenshot_content"])
        self.assertFalse(response["privacy"]["contains_minecontext_source_database"])
        self.assertFalse(response["privacy"]["contains_harness_raw_source_text"])
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        harness = {item["kind"]: item for item in response["harness_runs"]}
        self.assertIn("mvp_report", harness)
        self.assertIn("data_insufficient_drill", harness)
        self.assertIn("evidence_boundary", harness["mvp_report"])
        self.assertFalse(harness["mvp_report"]["privacy"]["external_model_used"])
        serialized = str(response).lower()
        self.assertNotIn("image_bytes", serialized)
        self.assertNotIn("base64", serialized)
        self.assertNotIn("raw_screenshot_data", serialized)
        self.assertNotIn("raw_godview_output", serialized)

    def test_delete_data_contract_preserves_minecontext_source(self) -> None:
        butler_router.rebuild_timeline()
        butler_router.metrics_today()
        butler_router.generate_insights()
        butler_router.mvp_report()
        butler_router.data_insufficient_drill()
        before = len(PCActivityContextService(self.db_path, self.runtime_dir).events())

        response = butler_router.delete_data()
        after = len(PCActivityContextService(self.db_path, self.runtime_dir).events())

        self.assertGreaterEqual(response["timeline"], 1)
        self.assertGreaterEqual(response["harness_runs"], 2)
        self.assertEqual(before, after)
        self.assertEqual(response["minecontext_source_deleted"], 0)
        self.assertIn("minecontext_source_database", response["preserved_scope"])
        self.assertIn("unified_timeline_events", response["deleted_scope"])
        self.assertIn("butler_harness_runs", response["deleted_scope"])
        self.assertEqual(butler_router.latest_harness_runs()["count"], 0)

    def test_demo_reset_contract_preserves_pc_activity_and_minecontext_source(self) -> None:
        butler_router.run_demo(DemoRunRequest(import_pc_activity=False))
        before = len(PCActivityContextService(self.db_path, self.runtime_dir).events())

        response = butler_router.reset_demo()
        after = len(PCActivityContextService(self.db_path, self.runtime_dir).events())

        self.assertEqual(response["status"], "reset")
        self.assertGreaterEqual(response["reset"]["timeline"], 1)
        self.assertEqual(before, after)
        self.assertTrue(response["preserved"]["pc_activity_events_preserved"])
        self.assertEqual(response["preserved"]["minecontext_source_deleted"], 0)
        self.assertEqual(response["privacy"]["minecontext_source_deleted"], 0)
        self.assertFalse(response["privacy"]["external_model_used"])
        self.assertTrue(response["privacy"]["deleted_only_openbutler_derived_data"])
        self.assertIn("pc_activity_events", response["reset"]["preserved_scope"])
        self.assertTrue(response["evidence_boundary"])


if __name__ == "__main__":
    unittest.main()
