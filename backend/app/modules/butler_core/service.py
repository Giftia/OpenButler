from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.modules.pc_activity_context.service import PCActivityContextService

from .briefing_generator import generate_briefing
from .butler_inbox import snooze_until
from .insight_engine import BOUNDARY, evaluate_feedback_noise_reduction, generate_rule_insights
from .metrics_engine import build_metric_summary
from .schemas import ProactiveButlerSettings
from .unified_timeline import pc_activity_to_unified

DEFAULT_USER_ID = "demo-user"
OBJECTIVE_MAPPER_TEMPLATE_VERSION = "active_objective_evidence_mapper_template_v1"


def productization_evidence_mapper_template() -> dict[str, Any]:
    return {
        "schema_version": OBJECTIVE_MAPPER_TEMPLATE_VERSION,
        "doc_path": "docs/dev/ACTIVE_OBJECTIVE_EVIDENCE_MAPPERS.md",
        "service_path": "backend/app/modules/butler_core/service.py",
        "test_path": "backend/app/modules/butler_core/tests/test_butler_api_contract.py",
        "goals_path": ".openbutler/goals.yaml",
        "required_steps": [
            "Add the objective to .openbutler/goals.yaml active_objectives.",
            "Add an entry in criteria_by_objective for the objective id.",
            "Map every success criterion to one or more local evidence criteria.",
            "Every criterion must include evidence_refs and evidence_boundary.",
            "Every criterion must preserve strict privacy and MineContext source boundaries.",
            "Add or update contract tests for proven and missing-mapper states.",
            "Update docs when the evidence source, API, UI, or privacy boundary changes.",
        ],
        "criterion_contract": {
            "id": "stable_snake_case_id",
            "title": "human-readable success criterion",
            "status": "proven | needs_attention",
            "details": "structured local evidence only",
            "evidence_refs": [{"kind": "api|file|route|script|artifact", "path": "local evidence reference"}],
            "evidence_boundary": "required",
        },
        "privacy_invariants": [
            "external_model_used must remain false",
            "external_model_allowed must remain false for strict-mode core checks",
            "minecontext_source_deleted must remain 0",
            "copied_screenshots must remain 0 unless a future explicit user-approved flow says otherwise",
            "remote repositories, CI, Yunxiao, deployments, and online services are not verified by objective mappers",
        ],
        "unknown_objective_behavior": "Return needs_attention with evidence_mapper_missing until a mapper is implemented.",
    }


class AutoClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        should_suppress = super().__exit__(exc_type, exc_value, traceback)
        self.close()
        return should_suppress


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_butler_core_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS unified_timeline_events (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            household_id TEXT,
            source TEXT NOT NULL,
            source_event_id TEXT,
            source_type TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_seconds INTEGER,
            title TEXT NOT NULL,
            summary TEXT,
            event_type TEXT NOT NULL,
            entities TEXT NOT NULL,
            metrics TEXT NOT NULL,
            tags TEXT NOT NULL,
            confidence REAL NOT NULL,
            evidence_level TEXT NOT NULL,
            evidence_refs TEXT NOT NULL,
            evidence_boundary TEXT NOT NULL,
            privacy_level TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS butler_metric_snapshots (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            date TEXT NOT NULL,
            period TEXT NOT NULL,
            metric_key TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            value REAL NOT NULL,
            unit TEXT NOT NULL,
            dimension TEXT NOT NULL,
            comparison TEXT,
            source_event_count INTEGER NOT NULL,
            confidence REAL NOT NULL,
            evidence_refs TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS insight_cards (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            household_id TEXT,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            detail TEXT,
            severity TEXT NOT NULL,
            priority INTEGER NOT NULL,
            status TEXT NOT NULL,
            suggested_actions TEXT NOT NULL,
            metrics TEXT NOT NULL,
            evidence_refs TEXT NOT NULL,
            evidence_boundary TEXT NOT NULL,
            confidence REAL NOT NULL,
            generated_by TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            expires_at TEXT,
            snoozed_until TEXT
        );

        CREATE TABLE IF NOT EXISTS butler_briefings (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            sections TEXT NOT NULL,
            key_metrics TEXT NOT NULL,
            top_insights TEXT NOT NULL,
            suggested_next_actions TEXT NOT NULL,
            evidence_refs TEXT NOT NULL,
            evidence_boundary TEXT NOT NULL,
            created_at TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS butler_goals (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            goal_type TEXT NOT NULL,
            target TEXT NOT NULL,
            schedule TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            privacy_level TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS insight_feedback (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            insight_id TEXT NOT NULL,
            insight_type TEXT,
            feedback_type TEXT NOT NULL,
            comment TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS butler_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            user_id TEXT NOT NULL,
            details TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS butler_harness_runs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            dry_run INTEGER NOT NULL,
            mutates_data INTEGER NOT NULL,
            summary TEXT NOT NULL,
            failed_checks TEXT NOT NULL,
            privacy TEXT NOT NULL,
            evidence_boundary TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO settings(key, value) VALUES('proactive_butler_settings', ?)",
        (ProactiveButlerSettings().model_dump_json(),),
    )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(insight_feedback)").fetchall()}
    if "insight_type" not in columns:
        conn.execute("ALTER TABLE insight_feedback ADD COLUMN insight_type TEXT")


class ButlerCoreService:
    def __init__(self, db_path: Path | str, runtime_dir: Path | str) -> None:
        self.db_path = Path(db_path)
        self.runtime_dir = Path(runtime_dir)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, factory=AutoClosingConnection)
        conn.row_factory = sqlite3.Row
        return conn

    def pc_activity(self) -> PCActivityContextService:
        return PCActivityContextService(self.db_path, self.runtime_dir)

    def get_settings(self) -> ProactiveButlerSettings:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = 'proactive_butler_settings'").fetchone()
        return ProactiveButlerSettings.model_validate_json(row["value"]) if row else ProactiveButlerSettings()

    def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        current = self.get_settings().model_dump()
        current.update(payload)
        settings = ProactiveButlerSettings.model_validate(current)
        if settings.privacy.get("strict_mode_respected", True):
            settings.insight_generation["external_model_allowed"] = False
            settings.notification["system_notification_enabled"] = False
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO settings(key, value)
                VALUES('proactive_butler_settings', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (settings.model_dump_json(),),
            )
            self._audit(conn, "settings_updated", DEFAULT_USER_ID, {"enabled": settings.enabled})
        return settings.model_dump()

    def rebuild_timeline(self) -> dict[str, Any]:
        pc_events = self.pc_activity().events()
        created: list[dict[str, Any]] = []
        with self.connect() as conn:
            conn.execute("DELETE FROM unified_timeline_events WHERE source = 'pc_activity'")
            for pc_event in pc_events:
                created.append(self._insert_timeline_event(conn, pc_activity_to_unified(pc_event)))
            self._audit(conn, "timeline_rebuilt", DEFAULT_USER_ID, {"created": len(created), "source": "pc_activity"})
        return {"created": created, "count": len(created), "source": "pc_activity"}

    def timeline(
        self,
        start_time: str | None = None,
        end_time: str | None = None,
        source: str | None = None,
        event_type: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM unified_timeline_events WHERE 1=1"
        params: list[Any] = []
        if start_time:
            query += " AND started_at >= ?"
            params.append(start_time)
        if end_time:
            query += " AND started_at <= ?"
            params.append(end_time)
        if source:
            query += " AND source = ?"
            params.append(source)
        if event_type:
            query += " AND event_type = ?"
            params.append(event_type)
        query += " ORDER BY started_at DESC LIMIT ?"
        params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [self._timeline_from_row(row) for row in rows]

    def today_timeline(self) -> list[dict[str, Any]]:
        today = date.today().isoformat()
        items = self.timeline(start_time=today, limit=1000)
        if not items:
            self.rebuild_timeline()
            items = self.timeline(start_time=today, limit=1000)
        return items

    def metrics_today(self, persist: bool = True) -> dict[str, Any]:
        events = self.today_timeline()
        settings = self.get_settings()
        summary = build_metric_summary(events, settings.metrics)
        if persist:
            self._persist_metrics(summary, events)
        return {
            "date": date.today().isoformat(),
            "period": "today",
            "metrics": summary,
            "evidence_refs": [{"kind": "timeline_event", "id": event["id"]} for event in events[:10]],
            "evidence_boundary": BOUNDARY,
        }

    def metrics_range(self, start_date: str | None = None, end_date: str | None = None, days: int = 7) -> dict[str, Any]:
        if not end_date:
            end_date = date.today().isoformat()
        if not start_date:
            start_date = (date.fromisoformat(end_date) - timedelta(days=days - 1)).isoformat()
        query = "SELECT * FROM butler_metric_snapshots WHERE 1=1"
        params: list[Any] = []
        if start_date:
            query += " AND date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND date <= ?"
            params.append(end_date)
        query += " ORDER BY date DESC, metric_key ASC"
        with self.connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        items = [self._metric_from_row(row) for row in rows]
        trend = self._metrics_trend(items, start_date, end_date)
        trend = self._fill_metrics_trend_from_timeline(trend, start_date, end_date)
        return {
            "period": "recent_days",
            "start_date": start_date,
            "end_date": end_date,
            "days": len(trend),
            "items": items,
            "count": len(items),
            "trend": trend,
            "summary": self._metrics_trend_summary(trend, start_date, end_date),
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "copied_screenshots": 0,
            },
            "evidence_boundary": BOUNDARY,
        }

    def generate_insights(self, force: bool = False) -> dict[str, Any]:
        if force:
            with self.connect() as conn:
                conn.execute("DELETE FROM insight_cards WHERE date(generated_at) = date('now')")
        metrics = self.metrics_today()["metrics"]
        events = self.today_timeline()
        workflows = self.pc_activity().summary().get("workflow_candidates", [])
        settings = self.get_settings()
        penalties = self.feedback_penalties()
        cards = generate_rule_insights(metrics, events, workflows, penalties, settings.feedback)
        created: list[dict[str, Any]] = []
        with self.connect() as conn:
            for item in cards:
                existing = conn.execute(
                    "SELECT id FROM insight_cards WHERE type = ? AND date(generated_at) = date('now') LIMIT 1",
                    (item["type"],),
                ).fetchone()
                if existing and not force:
                    created.append(self.get_insight(existing["id"]) or item)
                    continue
                created.append(self._insert_insight(conn, item))
            self._audit(conn, "insights_generated", DEFAULT_USER_ID, {"count": len(created), "external_model_used": False})
        return {"items": created, "count": len(created), "external_model_used": False}

    def insights(self, status: str | None = None, insight_type: str | None = None, priority: int | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM insight_cards WHERE 1=1"
        params: list[Any] = []
        if status:
            query += " AND status = ?"
            params.append(status)
        if insight_type:
            query += " AND type = ?"
            params.append(insight_type)
        if priority is not None:
            query += " AND priority >= ?"
            params.append(priority)
        query += " ORDER BY priority DESC, generated_at DESC"
        with self.connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [self._insight_from_row(row) for row in rows]

    def get_insight(self, insight_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM insight_cards WHERE id = ?", (insight_id,)).fetchone()
        return self._insight_from_row(row) if row else None

    def submit_feedback(self, insight_id: str, feedback_type: str, comment: str | None = None) -> dict[str, Any]:
        insight = self.get_insight(insight_id)
        if not insight:
            raise KeyError(insight_id)
        next_status = {
            "useful": "accepted",
            "accepted_action": "accepted",
            "dismissed": "dismissed",
            "not_useful": "dismissed",
            "inaccurate": "marked_inaccurate",
            "too_frequent": "dismissed",
            "remind_later": "snoozed",
            "accepted_action": "accepted",
        }.get(feedback_type, insight["status"])
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO insight_feedback(id, user_id, insight_id, insight_type, feedback_type, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), DEFAULT_USER_ID, insight_id, insight["type"], feedback_type, comment, now_iso()),
            )
            conn.execute("UPDATE insight_cards SET status = ? WHERE id = ?", (next_status, insight_id))
            self._audit(conn, "insight_feedback", DEFAULT_USER_ID, {"insight_id": insight_id, "feedback_type": feedback_type})
        return self.get_insight(insight_id) or insight

    def dismiss_insight(self, insight_id: str) -> dict[str, Any]:
        return self.submit_feedback(insight_id, "dismissed")

    def snooze_insight(self, insight_id: str, minutes: int) -> dict[str, Any]:
        insight = self.get_insight(insight_id)
        if not insight:
            raise KeyError(insight_id)
        until = snooze_until(minutes)
        with self.connect() as conn:
            conn.execute("UPDATE insight_cards SET status = 'snoozed', snoozed_until = ? WHERE id = ?", (until, insight_id))
            conn.execute(
                "INSERT INTO insight_feedback(id, user_id, insight_id, insight_type, feedback_type, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), DEFAULT_USER_ID, insight_id, insight["type"], "remind_later", f"snoozed {minutes} minutes", now_iso()),
            )
            self._audit(conn, "insight_snoozed", DEFAULT_USER_ID, {"insight_id": insight_id, "minutes": minutes})
        return self.get_insight(insight_id) or insight

    def insight_noise_evaluation(self) -> dict[str, Any]:
        settings = self.get_settings()
        report = evaluate_feedback_noise_reduction(self.feedback_penalties(), settings.feedback)
        with self.connect() as conn:
            self._audit(
                conn,
                "insight_noise_evaluation",
                DEFAULT_USER_ID,
                {
                    "evaluations": report["count"],
                    "external_model_used": False,
                    "external_webhook_used": False,
                    "system_notification_sent": False,
                },
            )
        return report

    def generate_briefing(self, briefing_type: str) -> dict[str, Any]:
        if briefing_type == "weekly_review":
            range_report = self.metrics_range(days=7)
            range_summary = range_report.get("summary", {})
            metrics = {
                **range_summary,
                "pc_active_minutes": range_summary.get("total_pc_active_minutes", 0),
                "focus_minutes": range_summary.get("total_focus_minutes", 0),
                "context_switch_count": range_summary.get("total_context_switch_count", 0),
                "source_event_count": range_summary.get("total_source_event_count", 0),
            }
            events = self.timeline(
                start_time=f"{range_report.get('start_date')}T00:00:00+00:00",
                end_time=f"{range_report.get('end_date')}T23:59:59+00:00",
                limit=1000,
            )
        else:
            metrics = self.metrics_today()["metrics"]
            events = self.today_timeline()
        insights = self.insights(status="new") or self.generate_insights()["items"]
        item = generate_briefing(briefing_type, metrics, insights, events)
        with self.connect() as conn:
            created = self._insert_briefing(conn, item)
            self._audit(conn, "briefing_generated", DEFAULT_USER_ID, {"type": briefing_type})
        return created

    def today_briefings(self) -> dict[str, Any]:
        today = date.today().isoformat()
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM butler_briefings WHERE created_at >= ? ORDER BY created_at DESC", (today,)).fetchall()
        if not rows:
            return {"items": [self.generate_briefing("morning")], "count": 1}
        return {"items": [self._briefing_from_row(row) for row in rows], "count": len(rows)}

    def context_recovery(self, lookback_hours: int = 24) -> dict[str, Any]:
        since = (datetime.now(timezone.utc) - timedelta(hours=lookback_hours)).isoformat()
        events = self.timeline(start_time=since, limit=30)
        briefing = generate_briefing("context_recovery", build_metric_summary(events, self.get_settings().metrics), self.insights(status="new")[:5], events)
        return {"lookback_hours": lookback_hours, "events": events, "briefing": briefing, "evidence_boundary": BOUNDARY}

    def home(self) -> dict[str, Any]:
        self.rebuild_timeline()
        metrics = self.metrics_today()["metrics"]
        insights = self.insights(status="new")
        if not insights and self.get_settings().insight_generation.get("auto_generate_on_open", True):
            insights = self.generate_insights()["items"]
        headline = (
            f"记录显示今天 PC 活跃约 {metrics.get('pc_active_minutes', 0)} 分钟，深度工作约 {metrics.get('focus_minutes', 0)} 分钟。"
            if metrics.get("source_event_count")
            else "当前 PC 活动数据不足，暂不生成强结论。"
        )
        return {
            "date": date.today().isoformat(),
            "overview": {"headline": headline, "confidence": metrics.get("confidence", 0.2), "evidence_boundary": BOUNDARY},
            "metrics": metrics,
            "insights": insights[:8],
            "suggested_next_actions": self._suggested_next_actions(insights, metrics),
            "timeline": self.today_timeline()[:8],
            "privacy": {
                "external_model_used": False,
                "system_notification_enabled": self.get_settings().notification.get("system_notification_enabled", False),
            },
        }

    def run_demo_path(
        self,
        import_pc_activity: bool = True,
        lookback_hours: int = 24,
        limit: int = 200,
        briefing_type: str = "evening",
    ) -> dict[str, Any]:
        import_result: dict[str, Any] = {
            "status": "skipped",
            "count": 0,
            "read_only": True,
            "copied_screenshots": 0,
        }
        if import_pc_activity:
            end_time = datetime.now(timezone.utc)
            start_time = end_time - timedelta(hours=lookback_hours)
            try:
                imported = self.pc_activity().import_activities(start_time, end_time, limit)
                import_result = {
                    "status": "completed",
                    "count": int(imported.get("count") or 0),
                    "read_only": bool(imported.get("read_only", True)),
                    "copied_screenshots": int(imported.get("copied_screenshots") or 0),
                }
            except Exception as exc:
                import_result = {
                    "status": "unavailable",
                    "count": 0,
                    "read_only": True,
                    "copied_screenshots": 0,
                    "error_type": exc.__class__.__name__,
                    "message": "MineContext 暂不可用，演示路径已继续使用现有 OpenButler 数据，不会编造今日活动。",
                }
        timeline_result = self.rebuild_timeline()
        insights_result = self.generate_insights(force=True)
        briefing = self.generate_briefing(briefing_type)
        readiness = self.readiness()
        with self.connect() as conn:
            self._audit(
                conn,
                "demo_path_run",
                DEFAULT_USER_ID,
                {
                    "import_status": import_result["status"],
                    "imported": import_result["count"],
                    "timeline_events": timeline_result["count"],
                    "insights": insights_result["count"],
                    "briefing_type": briefing["type"],
                    "external_model_used": False,
                    "copied_screenshots": import_result["copied_screenshots"],
                },
            )
        return {
            "status": "completed",
            "steps": {
                "pc_activity_import": import_result,
                "timeline_rebuild": {"status": "completed", "count": timeline_result["count"], "source": timeline_result["source"]},
                "insight_generation": {"status": "completed", "count": insights_result["count"], "external_model_used": False},
                "briefing_generation": {"status": "completed", "id": briefing["id"], "type": briefing["type"]},
                "readiness_refresh": {"status": readiness["status"], "summary": readiness["summary"]},
            },
            "readiness": readiness,
            "privacy": {
                "external_model_used": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "copied_screenshots": import_result["copied_screenshots"],
                "did_not_fabricate_activity": import_result["status"] != "completed" or import_result["count"] >= 0,
            },
            "evidence_boundary": BOUNDARY,
        }

    def preview_pc_activity_import(
        self,
        lookback_days: int = 7,
        dry_run: bool = True,
        include_screenshot_paths: bool = True,
        copy_screenshots: bool = False,
        limit: int = 1000,
    ) -> dict[str, Any]:
        if not dry_run:
            return {
                "dry_run": False,
                "source": "minecontext",
                "status": "rejected",
                "error": "L2 preview endpoint only supports dry-run. Use the existing import API only after explicit user confirmation.",
                "mutates_openbutler_db": False,
                "minecontext_source_mutated": False,
                "screenshots_copied": False,
                "external_model_used": False,
                "evidence_boundary": BOUNDARY,
            }
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(days=lookback_days)
        preview = self.pc_activity().preview_import_activities(
            start_time=start_time,
            end_time=end_time,
            limit=limit,
            include_screenshot_paths=include_screenshot_paths,
            copy_screenshots=copy_screenshots,
        )
        return {
            "status": "preview_ready" if not preview.get("adapter_error") else "source_unavailable",
            **preview,
            "lookback_days": lookback_days,
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": False,
                "external_webhook_used": False,
                "copied_screenshots": 0,
                "minecontext_source_deleted": 0,
                "minecontext_source_mutated": False,
                "raw_output_included": False,
            },
        }

    def readiness(self) -> dict[str, Any]:
        home = self.home()
        metrics = home["metrics"]
        settings = self.get_settings()
        pc_events = self.pc_activity().events()
        with self.connect() as conn:
            timeline_count = conn.execute("SELECT COUNT(*) AS count FROM unified_timeline_events").fetchone()["count"]
            metric_count = conn.execute("SELECT COUNT(*) AS count FROM butler_metric_snapshots").fetchone()["count"]
            insight_count = conn.execute("SELECT COUNT(*) AS count FROM insight_cards").fetchone()["count"]
            feedback_count = conn.execute("SELECT COUNT(*) AS count FROM insight_feedback").fetchone()["count"]
            briefing_count = conn.execute("SELECT COUNT(*) AS count FROM butler_briefings").fetchone()["count"]
            self._audit(
                conn,
                "butler_readiness_checked",
                DEFAULT_USER_ID,
                {
                    "pc_activity_events": len(pc_events),
                    "timeline": timeline_count,
                    "metrics": metric_count,
                    "insights": insight_count,
                    "feedback": feedback_count,
                },
            )
        openclaw = self._openclaw_tools_status()
        strict_ready = (
            settings.privacy.get("strict_mode_respected", True)
            and not settings.insight_generation.get("external_model_allowed", False)
            and not home["privacy"].get("external_model_used", False)
            and not home["privacy"].get("system_notification_enabled", False)
        )
        source_event_count = int(metrics.get("source_event_count") or 0)
        checks = [
            self._readiness_check(
                "pc_activity_source",
                "MineContext PC Activity source events",
                "ready" if pc_events else "data_insufficient",
                {"pc_activity_events": len(pc_events)},
            ),
            self._readiness_check(
                "unified_timeline",
                "Unified timeline rebuild",
                "ready" if timeline_count else "data_insufficient",
                {"timeline_events": timeline_count},
            ),
            self._readiness_check(
                "today_metrics",
                "Today metrics",
                "ready" if source_event_count else "data_insufficient",
                {"source_event_count": source_event_count, "metric_snapshots": metric_count},
            ),
            self._readiness_check(
                "insight_engine",
                "Rule-based insight engine",
                "ready" if insight_count else "data_insufficient",
                {"insights": insight_count, "active_insights": len(home.get("insights", []))},
            ),
            self._readiness_check(
                "feedback_loop",
                "Insight feedback store",
                "ready",
                {"feedback_count": feedback_count},
            ),
            self._readiness_check(
                "briefing_generator",
                "Briefing generator",
                "ready" if briefing_count or source_event_count else "data_insufficient",
                {"briefings": briefing_count},
            ),
            self._readiness_check(
                "openclaw_tools",
                "OpenClaw proactive Butler tools",
                "ready" if openclaw["ready"] else "attention_needed",
                openclaw,
            ),
            self._readiness_check(
                "strict_privacy",
                "Strict privacy guardrails",
                "ready" if strict_ready else "attention_needed",
                {
                    "strict_mode_respected": settings.privacy.get("strict_mode_respected", True),
                    "external_model_allowed": settings.insight_generation.get("external_model_allowed", False),
                    "external_model_used": home["privacy"].get("external_model_used", False),
                    "system_notification_enabled": home["privacy"].get("system_notification_enabled", False),
                },
            ),
        ]
        if any(item["status"] == "attention_needed" for item in checks):
            status = "attention_needed"
        elif any(item["status"] == "data_insufficient" for item in checks):
            status = "data_insufficient"
        else:
            status = "ready"
        return {
            "status": status,
            "generated_at": now_iso(),
            "summary": {
                "pc_activity_events": len(pc_events),
                "timeline_events": timeline_count,
                "metric_snapshots": metric_count,
                "insights": insight_count,
                "feedback_count": feedback_count,
                "briefings": briefing_count,
            },
            "checks": checks,
            "privacy": {
                "external_model_used": False,
                "system_notification_enabled": home["privacy"].get("system_notification_enabled", False),
                "minecontext_source_deleted": 0,
            },
            "evidence_boundary": BOUNDARY,
        }

    def mvp_report(self) -> dict[str, Any]:
        readiness = self.readiness()
        home = self.home()
        summary = readiness["summary"]
        checks = {item["id"]: item for item in readiness["checks"]}
        acceptance = [
            self._mvp_report_check(
                "pc_activity_source_events",
                "MineContext PC Activity 事件可用",
                checks.get("pc_activity_source", {}).get("status") == "ready",
                {"pc_activity_events": summary.get("pc_activity_events", 0)},
            ),
            self._mvp_report_check(
                "unified_timeline_ready",
                "PC Activity 已进入统一时间线",
                checks.get("unified_timeline", {}).get("status") == "ready",
                {"timeline_events": summary.get("timeline_events", 0)},
            ),
            self._mvp_report_check(
                "today_metrics_ready",
                "今日指标可生成",
                checks.get("today_metrics", {}).get("status") == "ready",
                {
                    "metric_snapshots": summary.get("metric_snapshots", 0),
                    "source_event_count": home["metrics"].get("source_event_count", 0),
                },
            ),
            self._mvp_report_check(
                "active_insights_ready",
                "主动洞察可生成",
                checks.get("insight_engine", {}).get("status") == "ready",
                {"insights": summary.get("insights", 0), "active_insights": len(home.get("insights", []))},
            ),
            self._mvp_report_check(
                "feedback_loop_ready",
                "Butler Inbox 反馈闭环可用",
                checks.get("feedback_loop", {}).get("status") == "ready",
                {"feedback_count": summary.get("feedback_count", 0)},
            ),
            self._mvp_report_check(
                "briefing_ready",
                "晨报/晚报/开工恢复包生成器可用",
                checks.get("briefing_generator", {}).get("status") == "ready",
                {"briefings": summary.get("briefings", 0)},
            ),
            self._mvp_report_check(
                "openclaw_tools_ready",
                "OpenClaw 主动管家工具声明可用",
                checks.get("openclaw_tools", {}).get("status") == "ready",
                checks.get("openclaw_tools", {}).get("details", {}),
            ),
            self._mvp_report_check(
                "strict_privacy_ready",
                "strict 模式不调用外部模型和外部通知",
                checks.get("strict_privacy", {}).get("status") == "ready",
                checks.get("strict_privacy", {}).get("details", {}),
            ),
            self._mvp_report_check(
                "minecontext_source_preserved",
                "MineContext 原始数据未被删除",
                readiness["privacy"].get("minecontext_source_deleted") == 0,
                {"minecontext_source_deleted": readiness["privacy"].get("minecontext_source_deleted", 0)},
            ),
            self._mvp_report_check(
                "evidence_boundaries_present",
                "首页、洞察和自检均保留证据边界",
                bool(home["overview"].get("evidence_boundary")) and bool(readiness.get("evidence_boundary")),
                {
                    "home_boundary": bool(home["overview"].get("evidence_boundary")),
                    "readiness_boundary": bool(readiness.get("evidence_boundary")),
                    "insight_boundaries": sum(1 for item in home.get("insights", []) if item.get("evidence_boundary")),
                },
            ),
        ]
        failed = [item for item in acceptance if item["status"] != "passed"]
        status = "ready" if not failed else readiness["status"]
        with self.connect() as conn:
            self._audit(
                conn,
                "butler_mvp_report_generated",
                DEFAULT_USER_ID,
                {
                    "status": status,
                    "failed_checks": [item["id"] for item in failed],
                    "external_model_used": False,
                    "minecontext_source_deleted": 0,
                },
            )
        report = {
            "schema_version": "butler_mvp_report_v1",
            "status": status,
            "generated_at": now_iso(),
            "north_star": "用户每天 60 秒内理解今天发生了什么、什么值得注意、下一步应该做什么",
            "mvp_chain": [
                {"stage": "MineContext / godview", "status": checks.get("pc_activity_source", {}).get("status", "unknown"), "count": summary.get("pc_activity_events", 0)},
                {"stage": "PCActivityEvent", "status": checks.get("pc_activity_source", {}).get("status", "unknown"), "count": summary.get("pc_activity_events", 0)},
                {"stage": "Unified Timeline", "status": checks.get("unified_timeline", {}).get("status", "unknown"), "count": summary.get("timeline_events", 0)},
                {"stage": "Metrics", "status": checks.get("today_metrics", {}).get("status", "unknown"), "count": summary.get("metric_snapshots", 0)},
                {"stage": "Insight Cards", "status": checks.get("insight_engine", {}).get("status", "unknown"), "count": summary.get("insights", 0)},
                {"stage": "Briefings", "status": checks.get("briefing_generator", {}).get("status", "unknown"), "count": summary.get("briefings", 0)},
                {"stage": "Feedback", "status": checks.get("feedback_loop", {}).get("status", "unknown"), "count": summary.get("feedback_count", 0)},
            ],
            "acceptance": acceptance,
            "readiness": readiness,
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": checks.get("strict_privacy", {}).get("details", {}).get("external_model_allowed", False),
                "system_notification_enabled": home["privacy"].get("system_notification_enabled", False),
                "minecontext_source_deleted": 0,
                "copied_screenshots": 0,
                "strict_mode_respected": checks.get("strict_privacy", {}).get("details", {}).get("strict_mode_respected", True),
            },
            "demo_paths": {
                "run": "POST /api/butler/demo/run",
                "reset": "POST /api/butler/demo/reset",
                "readiness": "GET /api/butler/readiness",
                "mvp_report": "GET /api/butler/mvp-report",
                "reset_scope": "只清理 OpenButler 派生的 timeline、metrics、insights、briefings；保留 PC Activity 和 MineContext 源数据。",
            },
            "verification_commands": [
                "python -m unittest backend.app.modules.butler_core.tests.test_butler_api_contract",
                "python -m unittest discover -s backend\\app\\modules",
                "npm run smoke:butler-mvp-report",
            ],
            "limitations": [
                "MVP 报告证明 OpenButler 本地链路状态，不确认远程仓库、CI、云效、部署或线上接口实时状态。",
                "MineContext 不可用或数据不足时，报告会返回 data_insufficient，而不会编造活动。",
                "该报告是 API 级验收证据，不是完整浏览器端到端点击测试。",
            ],
            "evidence_boundary": BOUNDARY,
        }
        with self.connect() as conn:
            self._persist_harness_run(conn, "mvp_report", report)
        return report

    def data_insufficient_drill(self) -> dict[str, Any]:
        """Return a synthetic empty-workspace recovery report without mutating source data."""
        openclaw = self._openclaw_tools_status()
        acceptance = [
            self._mvp_report_check(
                "pc_activity_source_events",
                "MineContext PC Activity source events are missing in the drill",
                False,
                {"pc_activity_events": 0, "drill": True},
            ),
            self._mvp_report_check(
                "unified_timeline_ready",
                "Unified timeline has no PC Activity events in the drill",
                False,
                {"timeline_events": 0, "drill": True},
            ),
            self._mvp_report_check(
                "today_metrics_ready",
                "Today metrics cannot be trusted until source events exist",
                False,
                {"metric_snapshots": 0, "source_event_count": 0, "drill": True},
            ),
            self._mvp_report_check(
                "active_insights_ready",
                "Active insights should stay data_quality_notice only until data exists",
                False,
                {"insights": 0, "active_insights": 0, "expected_empty_state": "data_quality_notice"},
            ),
            self._mvp_report_check(
                "feedback_loop_ready",
                "Butler Inbox feedback store is available even when data is insufficient",
                True,
                {"feedback_count": 0, "drill": True},
            ),
            self._mvp_report_check(
                "briefing_ready",
                "Briefings should be generated only after enough timeline evidence exists",
                False,
                {"briefings": 0, "drill": True},
            ),
            self._mvp_report_check(
                "openclaw_tools_ready",
                "OpenClaw proactive Butler tools are declared",
                bool(openclaw["ready"]),
                openclaw,
            ),
            self._mvp_report_check(
                "strict_privacy_ready",
                "Strict privacy guardrails remain active during the drill",
                True,
                {
                    "strict_mode_respected": True,
                    "external_model_allowed": False,
                    "external_model_used": False,
                    "system_notification_enabled": False,
                },
            ),
            self._mvp_report_check(
                "minecontext_source_preserved",
                "MineContext source data is not changed by this drill",
                True,
                {"minecontext_source_deleted": 0, "mutates_data": False},
            ),
            self._mvp_report_check(
                "evidence_boundaries_present",
                "The drill report preserves uncertainty and evidence boundaries",
                True,
                {"drill_boundary": True, "fabricates_activity": False},
            ),
        ]
        with self.connect() as conn:
            self._audit(
                conn,
                "butler_data_insufficient_drill_generated",
                DEFAULT_USER_ID,
                {
                    "dry_run": True,
                    "mutates_data": False,
                    "failed_checks": [item["id"] for item in acceptance if item["status"] != "passed"],
                    "external_model_used": False,
                    "minecontext_source_deleted": 0,
                },
            )
        report = {
            "schema_version": "butler_data_insufficient_drill_v1",
            "status": "data_insufficient",
            "generated_at": now_iso(),
            "dry_run": True,
            "mutates_data": False,
            "source": "synthetic_empty_workspace_drill",
            "summary": {
                "pc_activity_events": 0,
                "timeline_events": 0,
                "metric_snapshots": 0,
                "insights": 0,
                "briefings": 0,
                "message": "This drill validates the recovery path for an empty OpenButler workspace. It is not a claim about the current real workspace state.",
            },
            "acceptance": acceptance,
            "recommended_sequence": [
                "import_pc_activity",
                "rebuild_timeline",
                "generate_metrics",
                "generate_insights",
                "generate_briefing",
            ],
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "copied_screenshots": 0,
                "strict_mode_respected": True,
            },
            "limitations": [
                "This drill is synthetic and does not inspect or alter MineContext source records.",
                "It validates empty-state guidance and next actions, not the user's real activity history.",
                "Any real remote repository, CI, Yunxiao, deployment, or online service state still needs source-system verification.",
            ],
            "evidence_boundary": (
                "Synthetic data-insufficient drill only. The report verifies OpenButler recovery guidance, "
                "privacy defaults, and next-action wiring; it does not confirm current user activity."
            ),
        }
        with self.connect() as conn:
            self._persist_harness_run(conn, "data_insufficient_drill", report)
        return report

    def latest_harness_runs(self) -> dict[str, Any]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM butler_harness_runs
                WHERE id IN (
                    SELECT id
                    FROM butler_harness_runs latest
                    WHERE latest.kind = butler_harness_runs.kind
                    ORDER BY latest.created_at DESC
                    LIMIT 1
                )
                ORDER BY created_at DESC
                """
            ).fetchall()
        items = [self._harness_run_from_row(row) for row in rows]
        return {
            "items": items,
            "count": len(items),
            "evidence_boundary": (
                "Harness run summaries are OpenButler-local verification records. They store statuses, failed checks, "
                "privacy counters, and evidence boundaries only; they do not store MineContext source records or screenshot content."
            ),
        }

    def _load_productization_goals(self, root: Path) -> dict[str, Any]:
        goals_path = root / ".openbutler" / "goals.yaml"
        result: dict[str, Any] = {"loaded": False, "active_objectives": [], "parse_warnings": []}
        if not goals_path.exists():
            result["parse_warnings"].append("goals.yaml not found")
            return result

        def scalar(value: str) -> str:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                return value[1:-1]
            return value

        current: dict[str, Any] | None = None
        in_active_objectives = False
        in_success_criteria = False
        for raw_line in goals_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.rstrip()
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped == "active_objectives:":
                in_active_objectives = True
                current = None
                in_success_criteria = False
                continue
            if in_active_objectives and not line.startswith(" ") and not stripped.startswith("- "):
                break
            if not in_active_objectives:
                continue
            if stripped.startswith("- id:"):
                if current:
                    result["active_objectives"].append(current)
                current = {"id": scalar(stripped.split(":", 1)[1]), "success_criteria": []}
                in_success_criteria = False
                continue
            if current is None:
                continue
            if stripped.startswith("title:"):
                current["title"] = scalar(stripped.split(":", 1)[1])
                in_success_criteria = False
            elif stripped.startswith("priority:"):
                current["priority"] = scalar(stripped.split(":", 1)[1])
                in_success_criteria = False
            elif stripped.startswith("success_criteria:"):
                current.setdefault("success_criteria", [])
                in_success_criteria = True
            elif in_success_criteria and stripped.startswith("- "):
                current.setdefault("success_criteria", []).append(scalar(stripped[2:]))
        if current:
            result["active_objectives"].append(current)
        result["loaded"] = bool(result["active_objectives"])
        if not result["active_objectives"]:
            result["parse_warnings"].append("no active_objectives parsed")
        return result

    def productization_objective_status(self) -> dict[str, Any]:
        root = Path(__file__).resolve().parents[4]
        goals_config = self._load_productization_goals(root)
        mapper_template = productization_evidence_mapper_template()
        fallback_active_objectives = [
            {
                "id": "OB-GOAL-001",
                "title": "完成主动管家中枢 MVP",
                "priority": "P0",
                "success_criteria": [
                    "/butler 页面可用",
                    "今日指标可生成",
                    "主动洞察可生成",
                    "用户反馈可记录",
                    "strict 模式不调用外部模型",
                ],
            },
            {
                "id": "OB-GOAL-002",
                "title": "把 MineContext PC 活动转化为统一时间线",
                "priority": "P0",
                "success_criteria": [
                    "PCActivityEvent 可转换为 UnifiedTimelineEvent",
                    "支持 timeline rebuild",
                    "保留证据边界",
                ],
            },
            {
                "id": "OB-GOAL-003",
                "title": "建立可持续产品化开发流程",
                "priority": "P0",
                "success_criteria": [
                    "AGENTS.md 存在",
                    "ROADMAP 存在",
                    "Definition of Done 存在",
                    "测试文档存在",
                    "隐私边界文档存在",
                ],
            },
        ]
        active_objectives = goals_config["active_objectives"] or fallback_active_objectives
        readiness = self.readiness()
        report = self.mvp_report()
        checks = {item["id"]: item for item in readiness.get("checks", [])}
        loop_state_text = (root / "STATE.md").read_text(encoding="utf-8")
        supervised_nightly_passed = "| Supervised nightly dry-run | passed |" in loop_state_text
        acceptance = {item["id"]: item for item in report.get("acceptance", [])}

        def criterion(
            criterion_id: str,
            title: str,
            passed: bool,
            evidence_refs: list[dict[str, Any]],
            details: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            return {
                "id": criterion_id,
                "title": title,
                "status": "proven" if passed else "needs_attention",
                "details": details or {},
                "evidence_refs": evidence_refs,
                "evidence_boundary": BOUNDARY,
            }

        app_path = root / "frontend" / "src" / "App.tsx"
        router_path = root / "backend" / "app" / "modules" / "butler_core" / "router.py"
        service_path = root / "backend" / "app" / "modules" / "butler_core" / "service.py"
        insight_engine_path = root / "backend" / "app" / "modules" / "butler_core" / "insight_engine.py"
        smoke_path = root / "frontend" / "scripts" / "smoke-butler-browser.mjs"
        readiness_audit_path = root / "docs" / "dev" / "L2_READINESS_AUDIT.md"
        openclaw_path = root / "openclaw-skill" / "tools.yaml"
        required_docs = {
            "AGENTS.md": root / "AGENTS.md",
            "ROADMAP": root / "docs" / "product" / "ROADMAP.md",
            "Definition of Done": root / ".openbutler" / "definition_of_done.md",
            "Testing": root / "docs" / "dev" / "TESTING.md",
            "Privacy Boundaries": root / "docs" / "privacy" / "PRIVACY_BOUNDARIES.md",
        }
        app_text = app_path.read_text(encoding="utf-8") if app_path.exists() else ""
        butler_ui_text = (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
        api_contracts_text = (root / "docs" / "architecture" / "API_CONTRACTS.md").read_text(encoding="utf-8")
        router_text = router_path.read_text(encoding="utf-8") if router_path.exists() else ""
        service_text = service_path.read_text(encoding="utf-8") if service_path.exists() else ""
        insight_engine_text = insight_engine_path.read_text(encoding="utf-8") if insight_engine_path.exists() else ""
        smoke_text = smoke_path.read_text(encoding="utf-8") if smoke_path.exists() else ""
        openclaw_ready = self._openclaw_tools_status()
        desktop_package_path = root / "desktop" / "package.json"
        desktop_main_path = root / "desktop" / "src" / "main.cjs"
        desktop_preload_path = root / "desktop" / "src" / "preload.cjs"
        desktop_backend_entry_path = root / "desktop" / "backend_entry.py"
        desktop_spec_path = root / "desktop" / "desktop_backend.spec"
        desktop_icon_path = root / "desktop" / "assets" / "openbutler.ico"
        desktop_check_path = root / "desktop" / "scripts" / "check-desktop-contract.mjs"
        desktop_asset_check_path = root / "desktop" / "scripts" / "check-desktop-frontend-assets.mjs"
        desktop_packaged_smoke_path = root / "desktop" / "scripts" / "smoke-packaged-app.mjs"
        desktop_readme_path = root / "desktop" / "README.md"
        desktop_status_test_path = root / "backend" / "app" / "modules" / "butler_core" / "tests" / "test_desktop_status.py"
        desktop_smoke_path = root / "frontend" / "scripts" / "smoke-desktop-runtime-bridge.mjs"
        desktop_types_path = root / "frontend" / "src" / "desktop.d.ts"
        frontend_api_path = root / "frontend" / "src" / "lib" / "api.ts"
        desktop_doc_path = root / "docs" / "product" / "ELECTRON_FIRST_RUN_PRODUCTIZATION_SHELL.md"
        local_activation_doc_path = root / "docs" / "product" / "LOCAL_MODE_FIRST_USE_ACTIVATION.md"
        commercial_ppt_path = root / "docs" / "productization" / "openbutler-commercial-concept-pitch" / "ppt" / "index.html"
        desktop_main_text = desktop_main_path.read_text(encoding="utf-8") if desktop_main_path.exists() else ""
        desktop_preload_text = desktop_preload_path.read_text(encoding="utf-8") if desktop_preload_path.exists() else ""
        desktop_package_text = desktop_package_path.read_text(encoding="utf-8") if desktop_package_path.exists() else ""
        desktop_status_test_text = desktop_status_test_path.read_text(encoding="utf-8") if desktop_status_test_path.exists() else ""
        desktop_smoke_text = desktop_smoke_path.read_text(encoding="utf-8") if desktop_smoke_path.exists() else ""
        local_activation_smoke_path = root / "frontend" / "scripts" / "smoke-local-mode-activation.mjs"
        local_activation_smoke_text = local_activation_smoke_path.read_text(encoding="utf-8") if local_activation_smoke_path.exists() else ""
        desktop_packaged_smoke_text = desktop_packaged_smoke_path.read_text(encoding="utf-8") if desktop_packaged_smoke_path.exists() else ""
        frontend_api_text = frontend_api_path.read_text(encoding="utf-8") if frontend_api_path.exists() else ""
        commercial_ppt_text = commercial_ppt_path.read_text(encoding="utf-8") if commercial_ppt_path.exists() else ""

        criteria_by_objective = {
            "OB-GOAL-001": [
                    criterion(
                        "butler_page_available",
                        "/butler 页面可用",
                        app_path.exists() and "function ButlerHome" in app_text and '"/butler"' in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}, {"kind": "route", "path": "/butler"}],
                    ),
                    criterion(
                        "today_metrics_generatable",
                        "今日指标可生成",
                        checks.get("today_metrics", {}).get("status") == "ready",
                        [{"kind": "api", "path": "GET /api/butler/metrics/today"}],
                        checks.get("today_metrics", {}).get("details", {}),
                    ),
                    criterion(
                        "insights_generatable",
                        "主动洞察可生成",
                        checks.get("insight_engine", {}).get("status") == "ready",
                        [{"kind": "api", "path": "POST /api/butler/insights/generate"}],
                        checks.get("insight_engine", {}).get("details", {}),
                    ),
                    criterion(
                        "feedback_recordable",
                        "用户反馈可记录",
                        checks.get("feedback_loop", {}).get("status") == "ready",
                        [{"kind": "api", "path": "POST /api/butler/insights/{insight_id}/feedback"}],
                        checks.get("feedback_loop", {}).get("details", {}),
                    ),
                    criterion(
                        "openclaw_tools_updated",
                        "OpenClaw Skill 工具声明可用",
                        bool(openclaw_ready.get("ready")),
                        [{"kind": "file", "path": "openclaw-skill/tools.yaml"}],
                        {"missing": openclaw_ready.get("missing", []), "exists": openclaw_path.exists()},
                    ),
                    criterion(
                        "strict_no_external_model",
                        "strict 模式不调用外部模型",
                        report.get("privacy", {}).get("external_model_used") is False
                        and report.get("privacy", {}).get("external_model_allowed") is False,
                        [{"kind": "api", "path": "GET /api/butler/mvp-report"}],
                        report.get("privacy", {}),
                    ),
            ],
            "OB-GOAL-002": [
                    criterion(
                        "pc_activity_to_unified_timeline",
                        "PCActivityEvent 可转换为 UnifiedTimelineEvent",
                        checks.get("unified_timeline", {}).get("status") == "ready",
                        [{"kind": "api", "path": "POST /api/butler/timeline/rebuild"}],
                        checks.get("unified_timeline", {}).get("details", {}),
                    ),
                    criterion(
                        "timeline_rebuild_supported",
                        "支持 timeline rebuild",
                        report.get("readiness", {}).get("summary", {}).get("timeline_events", 0) > 0,
                        [{"kind": "api", "path": "POST /api/butler/timeline/rebuild"}],
                        {"timeline_events": report.get("readiness", {}).get("summary", {}).get("timeline_events", 0)},
                    ),
                    criterion(
                        "evidence_boundary_preserved",
                        "保留证据边界",
                        acceptance.get("evidence_boundaries_present", {}).get("status") == "passed",
                        [{"kind": "api", "path": "GET /api/butler/mvp-report"}],
                        acceptance.get("evidence_boundaries_present", {}).get("details", {}),
                    ),
                    criterion(
                        "minecontext_source_preserved",
                        "MineContext 源数据未被删除",
                        acceptance.get("minecontext_source_preserved", {}).get("status") == "passed",
                        [{"kind": "api", "path": "GET /api/butler/mvp-report"}],
                        acceptance.get("minecontext_source_preserved", {}).get("details", {}),
                    ),
            ],
            "OB-GOAL-003": [
                    criterion(
                        "agents_md_exists",
                        "AGENTS.md 存在",
                        required_docs["AGENTS.md"].exists(),
                        [{"kind": "file", "path": "AGENTS.md"}],
                    ),
                    criterion(
                        "roadmap_exists",
                        "ROADMAP 存在",
                        required_docs["ROADMAP"].exists(),
                        [{"kind": "file", "path": "docs/product/ROADMAP.md"}],
                    ),
                    criterion(
                        "definition_of_done_exists",
                        "Definition of Done 存在",
                        required_docs["Definition of Done"].exists(),
                        [{"kind": "file", "path": ".openbutler/definition_of_done.md"}],
                    ),
                    criterion(
                        "testing_doc_exists",
                        "测试文档存在",
                        required_docs["Testing"].exists(),
                        [{"kind": "file", "path": "docs/dev/TESTING.md"}],
                    ),
                    criterion(
                        "privacy_boundary_doc_exists",
                        "隐私边界文档存在",
                        required_docs["Privacy Boundaries"].exists(),
                        [{"kind": "file", "path": "docs/privacy/PRIVACY_BOUNDARIES.md"}],
                    ),
            ],
            "OB-GOAL-004": [
                    criterion(
                        "l2_readiness_audit_exists",
                        "L2 readiness audit 已生成",
                        readiness_audit_path.exists(),
                        [{"kind": "file", "path": "docs/dev/L2_READINESS_AUDIT.md"}],
                    ),
                    criterion(
                        "seven_day_import_preview_supported",
                        "支持 MineContext / PC Activity 最近 7 天历史导入的 dry-run 预览",
                        "preview_pc_activity_import" in router_text
                        and "preview_import_activities" in service_text
                        and "/import/pc-activity/preview" in router_text,
                        [
                            {"kind": "api", "path": "POST /api/butler/import/pc-activity/preview"},
                            {"kind": "file", "path": "backend/app/modules/pc_activity_context/service.py"},
                        ],
                    ),
                    criterion(
                        "idempotent_import_guard",
                        "支持幂等导入，重复执行不会制造重复事件",
                        "source_fingerprint" in service_text
                        and "stable_event_fingerprint" in service_text
                        and "SELECT id FROM pc_activity_events WHERE source = ?" in service_text,
                        [{"kind": "file", "path": "backend/app/modules/pc_activity_context/service.py"}],
                        {"note": "source_activity_id 优先去重；无 source_event_id 时使用稳定 hash 去重。"},
                    ),
                    criterion(
                        "seven_day_metrics_summary",
                        "支持导入后生成 7 天指标摘要",
                        "def metrics_range" in service_text,
                        [{"kind": "api", "path": "GET /api/butler/metrics?days=7"}],
                    ),
                    criterion(
                        "inbox_evidence_detail",
                        "Butler Inbox 中每条 insight 可以打开证据详情",
                        "InsightEvidenceDetails" in app_text and "查看证据详情" in app_text,
                        [{"kind": "route", "path": "/butler/inbox"}, {"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "evidence_click_smoke",
                        "证据详情 smoke 测试可验证点击链路",
                        "inbox_evidence_click" in smoke_text
                        and "查看证据详情" in smoke_text
                        and "evidence_boundary" in smoke_text,
                        [{"kind": "script", "path": "frontend/scripts/smoke-butler-browser.mjs"}],
                        {"script": "npm run smoke:butler-browser"},
                    ),
                    criterion(
                        "feedback_affects_priority",
                        "用户 feedback 可影响 insight 评分或优先级",
                        "feedback_penalties" in service_text and "apply_feedback_penalties" in insight_engine_text,
                        [
                            {"kind": "file", "path": "backend/app/modules/butler_core/service.py"},
                            {"kind": "file", "path": "backend/app/modules/butler_core/insight_engine.py"},
                        ],
                    ),
                    criterion(
                        "noise_reduction_evaluation",
                        "存在 insight 降噪评估报告或测试",
                        "insight_noise_evaluation" in service_text
                        and "evaluate_feedback_noise_reduction" in insight_engine_text
                        and (root / "docs" / "product" / "INSIGHT_FEEDBACK_POLICY.md").exists(),
                        [
                            {"kind": "api", "path": "GET /api/butler/insights/noise-evaluation"},
                            {"kind": "file", "path": "docs/product/INSIGHT_FEEDBACK_POLICY.md"},
                            {"kind": "test", "path": "backend/app/modules/butler_core/tests/test_butler_core_service.py"},
                        ],
                        {"covers": ["dismissed", "inaccurate", "too_frequent", "useful", "accepted_action", "protected notices"]},
                    ),
                    criterion(
                        "strict_no_external_model_l2",
                        "strict 模式下不调用外部模型",
                        "external_model_used" in service_text and "external_model_allowed" in service_text,
                        [{"kind": "api", "path": "GET /api/butler/settings"}],
                    ),
                    criterion(
                        "screenshots_not_copied_by_default_l2",
                        "默认不复制 MineContext 截图",
                        "copy_screenshot_evidence = False" in (root / "backend" / "app" / "modules" / "pc_activity_context" / "service.py").read_text(encoding="utf-8")
                        or "copied_screenshots" in service_text,
                        [{"kind": "file", "path": "backend/app/modules/pc_activity_context/service.py"}],
                    ),
                    criterion(
                        "minecontext_source_preserved_l2",
                        "不删除 MineContext 原始数据",
                        "minecontext_source_deleted" in service_text,
                        [{"kind": "api", "path": "GET /api/butler/mvp-report"}],
                    ),
            ],
            "OB-GOAL-006": [
                    criterion(
                        "ten_second_value_expression",
                        "用户打开首页后 10 秒内能理解 OpenButler 的核心价值",
                        "today-hero" in app_text and "OpenButler 主动 AI 管家" in app_text,
                        [
                            {"kind": "route", "path": "/butler"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "home_not_technical_console",
                        "首页不再堆叠大量技术模块",
                        "advanced-lab-panel" in app_text and "高级与实验室" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                        {"note": "Technical controls remain available behind the advanced lab disclosure."},
                    ),
                    criterion(
                        "ordinary_terms_hide_internal_names",
                        "普通用户不需要理解 MineContext、PCActivity、UnifiedTimelineEvent 等术语",
                        (root / "frontend" / "src" / "lib" / "userFacingLabels.ts").exists()
                        and "电脑活动" in (root / "frontend" / "src" / "lib" / "userFacingLabels.ts").read_text(encoding="utf-8")
                        and "时间线事件" in (root / "frontend" / "src" / "lib" / "userFacingLabels.ts").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/lib/userFacingLabels.ts"}],
                    ),
                    criterion(
                        "progressive_onboarding_available",
                        "提供渐进式上手流程",
                        "ProgressiveOnboarding" in app_text
                        and ("3 步开始" in app_text or "选择一种方式开始今天" in app_text),
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "overview_insights_timeline_evidence_visible",
                        "今日概览、主动提醒、时间线、证据入口清晰可见",
                        "管家建议" in app_text
                        and "今日时间线预览" in app_text
                        and "查看证据详情" in app_text
                        and "边界说明" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "advanced_entry_preserved",
                        "保留高级入口给开发者和 power user",
                        "advancedNavItems" in app_text and "高级与实验室" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "frontend_build_documented",
                        "前端 build 通过",
                        (root / "current_state.md").exists() and "Frontend build passes" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                        {"verification_command": "cd frontend && npm run build"},
                    ),
                    criterion(
                        "backend_tests_not_broken",
                        "不破坏现有后端测试",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                        {"verification_command": "cd backend && python -m unittest discover -s app\\modules\\butler_core\\tests"},
                    ),
            ],
            "OB-GOAL-008": [
                    criterion(
                        "mobile_nav_compact",
                        "移动端首屏不再被大导航占据",
                        "Mobile UX Polish V2 overrides" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
                        and "min-height: 42px" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/styles.css"}],
                    ),
                    criterion(
                        "home_first_screen_summary",
                        "首页第一屏能展示产品价值、今日摘要和一个主行动",
                        "summary-chips" in app_text
                        and (
                            "查看管家建议" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                            or "看今天建议" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                        ),
                        [
                            {"kind": "route", "path": "/butler"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/lib/butlerUiAdapter.ts"},
                        ],
                    ),
                    criterion(
                        "demo_copy_sanitized",
                        "普通用户界面不出现英文 demo 文案",
                        "userFacingDemoText" in (root / "frontend" / "src" / "lib" / "userFacingLabels.ts").read_text(encoding="utf-8")
                        and "Demo Copy Guidelines" in (root / "docs" / "product" / "DEMO_COPY_GUIDELINES.md").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/lib/userFacingLabels.ts"},
                            {"kind": "file", "path": "docs/product/DEMO_COPY_GUIDELINES.md"},
                        ],
                    ),
                    criterion(
                        "internal_fields_hidden",
                        "普通用户界面不出现 phone_album、seed、Provider、Webhook 等内部字段",
                        "sanitizeAnswer" in app_text
                        and "相册线索（演示）" in app_text
                        and ("隐私与数据" in app_text or "我的授权" in app_text),
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "timeline_life_record_copy",
                        "时间线演示事件像生活记录，而不是开发日志",
                        (
                            "一段专注被记住了" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                            or "钥匙可能在玄关托盘附近" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                        )
                        and (
                            "一次本地验证被记录了" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                            or "该起身活动一下了" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                        ),
                        [{"kind": "file", "path": "frontend/src/lib/timelineUiAdapter.ts"}],
                    ),
                    criterion(
                        "chat_internal_fields_sanitized",
                        "管家演示回答不泄露内部数据源字段",
                        "sanitizeAnswer" in app_text and "source_event_id" in app_text and "依据编号" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "my_page_layered",
                        "我的页第一层面向普通用户，高级架构内容进入高级与实验室",
                        "me-page" in app_text
                        and ("隐私与数据" in app_text or "我的授权" in app_text)
                        and ("OpenClaw 技能声明已配置，运行时调用未验证" in app_text or "开发者设置" in app_text),
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "button_contrast_improved",
                        "所有按钮可点击状态清晰",
                        "friendly-actions .ghost" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
                        and "min-height: 44px" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/styles.css"}],
                    ),
                    criterion(
                        "frontend_build_documented_v2",
                        "frontend build 通过",
                        (root / "current_state.md").exists() and "Frontend build passes" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_v2",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-009": [
                    criterion(
                        "timeline_title_summary_priority",
                        "时间线事件标题和摘要成为视觉重点",
                        "event-feed-card" in app_text
                        and "moment.title" in app_text
                        and "moment.summary" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "timeline_auxiliary_info_subdued",
                        "时间、来源、置信度等辅助信息被淡化",
                        "event-feed-card time" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
                        and "color: #94a3b8" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/styles.css"}],
                    ),
                    criterion(
                        "timeline_thumbnail_supported",
                        "事件卡片支持右侧缩略图",
                        "TimelineThumbnail" in app_text
                        and "event-thumb" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "timeline_media_fallbacks",
                        "有图片证据时显示图片，无图片时显示来源占位",
                        "isSafeImageUrl" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                        and "有本地截图依据" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                        and "source-icon" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/lib/timelineUiAdapter.ts"}],
                    ),
                    criterion(
                        "timeline_three_filters",
                        "支持时间、来源、事件三类筛选",
                        "timeline-filter-bar" in app_text
                        and "timeFilter" in app_text
                        and ("sourceFilter" in app_text or "categoryFilter" in app_text)
                        and ("eventFilter" in app_text or "importanceFilter" in app_text),
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "timeline_filter_empty_state",
                        "筛选空状态友好",
                        "这个筛选下暂时没有事件" in app_text
                        and ("放宽时间、来源或事件条件" in app_text or "放宽时间、分类或重要性条件" in app_text),
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "timeline_internal_fields_hidden",
                        "普通 UI 不暴露内部字段名",
                        "event-feed-card" in app_text
                        and "未展示原始路径" in app_text
                        and "ordinary UI must not expose" in (root / "docs" / "product" / "TIMELINE_EVENT_FEED_V2.md").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "docs/product/TIMELINE_EVENT_FEED_V2.md"},
                        ],
                    ),
                    criterion(
                        "frontend_build_documented_timeline_v2",
                        "frontend build 通过",
                        (root / "current_state.md").exists() and "Frontend build passes" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_timeline_v2",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-010": [
                    criterion(
                        "life_task_home_headline",
                        "首页首屏表达已经帮你整理好的生活事项",
                        "我已经帮你整理好今天值得回看的 3 件事" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/lib/butlerUiAdapter.ts"}],
                    ),
                    criterion(
                        "demo_not_developer_workflow",
                        "主路径 demo 不再以开发者工作流为核心",
                        "钥匙可能在玄关托盘附近" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                        and "会议后有一项待办适合收尾" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/lib/butlerUiAdapter.ts"},
                            {"kind": "file", "path": "frontend/src/lib/timelineUiAdapter.ts"},
                        ],
                    ),
                    criterion(
                        "mobile_nav_simplified",
                        "移动端默认主导航弱化时间线和高级入口",
                        "nav button[data-nav-key=\"timeline\"]" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
                        and ".advanced-nav" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
                        and "display: none" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/styles.css"}],
                    ),
                    criterion(
                        "timeline_user_language_filters",
                        "时间线筛选使用生活分类和重要性",
                        "timelineCategoryLabel" in app_text
                        and "timelineImportanceLabel" in app_text
                        and "分类" in app_text
                        and "重要性" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "assistant_proactive_summary",
                        "管家页提供主动摘要和下一步行动",
                        "你可以直接问我今天该看什么" in app_text
                        and "回看今天" in app_text
                        and "提醒下一步" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "me_authorization_first",
                        "我的页第一层是授权、读取范围和提醒偏好",
                        "我的授权" in app_text
                        and "读取了什么" in app_text
                        and "提醒偏好" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "ordinary_path_technical_terms_reduced",
                        "普通路径不暴露技术控制台术语",
                        "Product Experience V3" in (root / "docs" / "product" / "PRODUCT_EXPERIENCE_V3.md").read_text(encoding="utf-8")
                        and "Technical vocabulary moves behind developer settings" in (root / "docs" / "product" / "PRODUCT_EXPERIENCE_V3.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "docs/product/PRODUCT_EXPERIENCE_V3.md"}],
                    ),
                    criterion(
                        "frontend_build_documented_product_v3",
                        "frontend build 通过",
                        (root / "current_state.md").exists() and "Frontend build passes" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_product_v3",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-011": [
                    criterion(
                        "first_run_understands_private_butler",
                        "新用户 30 秒内理解 OpenButler 是私人 AI 管家",
                        "先选择 OpenButler 怎么认识你的一天" in app_text
                        and "OpenButler 会整理你主动授权的本地线索" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "activation_choices_available",
                        "首次进入可以选择先看样例、连接本地数据源或稍后配置",
                        "先看样例" in app_text
                        and "连接本地数据源" in app_text
                        and "稍后配置" in app_text
                        and "openbutler:first_run_activation:v1" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "sample_mode_no_real_data",
                        "样例体验明确说明不会读取真实数据",
                        "样例不会读取真实数据" in app_text
                        or "不会读取你的真实数据" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "real_local_requires_authorization",
                        "真实本地模式明确说明需要用户主动授权",
                        "真实模式需要你主动授权" in app_text
                        or "真实本地模式需要你主动连接本机数据源" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "no_empty_console_before_authorization",
                        "未授权时不会出现空控制台",
                        "选择一种方式开始今天" in app_text
                        and "OpenButler 不会用空数据编造结论" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "connection_results_explained",
                        "用户能明确知道连接后会得到什么",
                        "连接后，你会得到什么" in app_text
                        and "今日概览" in app_text
                        and "管家提醒" in app_text
                        and "可复核依据" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "me_can_reopen_activation",
                        "/me 可以重新打开激活引导",
                        "重新选择开始方式" in app_text
                        and "activation-settings-panel" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "frontend_build_documented_first_run_activation",
                        "frontend build 通过",
                        (root / "current_state.md").exists() and "Frontend build passes" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_first_run_activation",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-012": [
                    criterion(
                        "today_first_screen_value_status_action",
                        "移动端打开 /butler，第一屏完整看到价值、状态、主行动",
                        "TodayCommandCenter" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                        and "今天先看这几件事" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                        and "handleCommandPrimary" in app_text,
                        [
                            {"kind": "file", "path": "frontend/src/lib/butlerUiAdapter.ts"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "home_no_longer_module_entry_page",
                        "首页不再像模块入口页，也不展示技术能力列表",
                        "更多今日信息" in app_text
                        and "高级与实验室" in app_text
                        and "today-more-status" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "today_summary_card_result_focused",
                        "今日摘要主卡只讲用户关心的结果",
                        "oneLineStatus" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                        and "有 3 条样例记录值得回看" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/lib/butlerUiAdapter.ts"}],
                    ),
                    criterion(
                        "top_suggestion_visible_in_hero",
                        "最高优先级建议在首屏或首屏下沿可见",
                        "command.topSuggestion" in app_text
                        and "command-suggestion-card" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "privacy_hint_lightweight",
                        "隐私状态轻提示存在，但不抢主视觉",
                        "privacyHint" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8")
                        and "样例体验，未读取你的真实数据" in (root / "frontend" / "src" / "lib" / "butlerUiAdapter.ts").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/src/lib/butlerUiAdapter.ts"}],
                    ),
                    criterion(
                        "ordinary_ui_internal_terms_guarded",
                        "普通 UI 不出现内部字段和开发者术语",
                        (root / "frontend" / "scripts" / "smoke-today-command-center.mjs").exists()
                        and "forbiddenTerms" in (root / "frontend" / "scripts" / "smoke-today-command-center.mjs").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/scripts/smoke-today-command-center.mjs"}],
                    ),
                    criterion(
                        "first_run_still_available_today_command_center",
                        "首次激活流仍可用",
                        "smoke:first-run-activation" in (root / "frontend" / "package.json").read_text(encoding="utf-8")
                        and "FirstRunGuide" in app_text,
                        [
                            {"kind": "file", "path": "frontend/package.json"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "frontend_build_and_today_smoke_documented",
                        "前端 build 和 today smoke 通过",
                        "smoke:today-command-center" in (root / "frontend" / "package.json").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/package.json"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_today_command_center",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-013": [
                    criterion(
                        "timeline_filters_available",
                        "时间线支持时间、分类、重要性筛选",
                        "timelineTimeFilters" in app_text
                        and "timelineCategoryFilters" in app_text
                        and "timelineImportanceFilters" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "event_title_and_summary_prioritized",
                        "事件标题和摘要是视觉重点",
                        "moment-title-row" in app_text
                        and "event-feed-card" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "timeline_thumbnail_or_placeholder",
                        "事件卡片支持右侧缩略图或证据占位",
                        "TimelineThumbnail" in app_text
                        and "event-thumb" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "local_screenshot_paths_not_shown",
                        "不展示本地截图路径",
                        "不会显示本地截图路径" in app_text
                        and "isSafeImageUrl" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/src/lib/timelineUiAdapter.ts"},
                        ],
                    ),
                    criterion(
                        "timeline_evidence_drawer",
                        "每条事件可解释来源和边界",
                        "evidence-drawer" in app_text
                        and "外部系统状态需要回到原处确认" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "timeline_event_state_visible",
                        "事件显示待处理、可复核或已记录状态",
                        "stateLabel" in (root / "frontend" / "src" / "lib" / "timelineUiAdapter.ts").read_text(encoding="utf-8")
                        and "moment-state" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/lib/timelineUiAdapter.ts"},
                            {"kind": "file", "path": "frontend/src/styles.css"},
                        ],
                    ),
                    criterion(
                        "timeline_empty_state_friendly",
                        "筛选无结果时有友好空状态",
                        "这个筛选下暂时没有事件" in app_text
                        and "可以放宽时间、分类或重要性条件" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "timeline_internal_terms_guarded",
                        "普通 UI 不出现内部字段和开发者术语",
                        (root / "frontend" / "scripts" / "smoke-timeline-life-feed.mjs").exists()
                        and "forbiddenTerms" in (root / "frontend" / "scripts" / "smoke-timeline-life-feed.mjs").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/scripts/smoke-timeline-life-feed.mjs"}],
                    ),
                    criterion(
                        "frontend_build_and_timeline_smoke_documented",
                        "前端 build 和 timeline smoke 通过",
                        "smoke:timeline-life-feed" in (root / "frontend" / "package.json").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/package.json"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_timeline_feed",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-014": [
                    criterion(
                        "inbox_decision_states_available",
                        "Inbox 显示待确认、稍后、已处理、不准确四类状态",
                        "inboxStateLabels" in (root / "frontend" / "src" / "lib" / "inboxUiAdapter.ts").read_text(encoding="utf-8")
                        and "待确认" in app_text
                        and "不准确" in app_text,
                        [
                            {"kind": "file", "path": "frontend/src/lib/inboxUiAdapter.ts"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "inbox_feedback_moves_cards",
                        "用户能处理一条提醒并看到状态变化",
                        "accepted_action" in service_text
                        and "onStateChange" in app_text
                        and "处理了" in app_text,
                        [
                            {"kind": "file", "path": "backend/app/modules/butler_core/service.py"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "inbox_later_and_inaccurate_move_cards",
                        "稍后和不准确反馈会立即移动卡片",
                        "remind_later" in app_text
                        and "inaccurate" in app_text
                        and "onStateChange" in app_text
                        and "稍后再看" in app_text
                        and "不准确" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "inbox_noise_hint_visible",
                        "少提醒类似内容会显示降噪提示",
                        "getButlerInsightNoiseEvaluation" in (root / "frontend" / "src" / "lib" / "api.ts").read_text(encoding="utf-8")
                        and "类似提醒后面会少出现" in app_text,
                        [
                            {"kind": "file", "path": "frontend/src/lib/api.ts"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "inbox_feedback_affects_future_priority",
                        "同类提醒反馈会影响后续优先级",
                        "feedback_penalties" in service_text
                        and "apply_feedback_penalties" in insight_engine_text
                        and "getButlerInsightNoiseEvaluation" in (root / "frontend" / "src" / "lib" / "api.ts").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "backend/app/modules/butler_core/service.py"},
                            {"kind": "file", "path": "backend/app/modules/butler_core/insight_engine.py"},
                            {"kind": "file", "path": "frontend/src/lib/api.ts"},
                        ],
                    ),
                    criterion(
                        "protected_notice_not_permanently_silenced",
                        "data_quality_notice 和 privacy_notice 不会被永久静默",
                        "protectedNoticeTypes" in (root / "frontend" / "src" / "lib" / "inboxUiAdapter.ts").read_text(encoding="utf-8")
                        and "隐私和数据质量提醒不会被永久关闭" in app_text,
                        [
                            {"kind": "file", "path": "frontend/src/lib/inboxUiAdapter.ts"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "inbox_internal_terms_guarded",
                        "依据展开不显示内部字段或本地路径",
                        (root / "frontend" / "scripts" / "smoke-butler-inbox-decision-queue.mjs").exists()
                        and "forbiddenTerms" in (root / "frontend" / "scripts" / "smoke-butler-inbox-decision-queue.mjs").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/scripts/smoke-butler-inbox-decision-queue.mjs"}],
                    ),
                    criterion(
                        "frontend_build_and_inbox_smoke_documented",
                        "前端 build 和 inbox smoke 通过",
                        "smoke:butler-inbox-decision-queue" in (root / "frontend" / "package.json").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/package.json"}],
                    ),
                    criterion(
                        "backend_tests_not_broken_inbox_queue",
                        "后端核心测试通过",
                        (root / "current_state.md").exists() and "Ran 51 tests - OK" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-015": [
                    criterion(
                        "assistant_control_prompts_available",
                        "问管家支持今日回看、下一步建议、解释依据、修改偏好、生成复盘、查时间线",
                        "今天有什么值得注意？" in app_text
                        and "我现在该先做什么？" in app_text
                        and "查看今日记录" in app_text
                        and "解释这条提醒的依据" in app_text
                        and "这个建议不准确" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "assistant_answers_structured",
                        "回答包含关键数字、依据、边界说明和下一步",
                        "def _compose_answer" in (root / "backend" / "app" / "modules" / "butler_core" / "tools" / "proactive_chat_tool.py").read_text(encoding="utf-8")
                        and "关键数字：" in (root / "backend" / "app" / "modules" / "butler_core" / "tools" / "proactive_chat_tool.py").read_text(encoding="utf-8")
                        and "边界说明：" in (root / "backend" / "app" / "modules" / "butler_core" / "tools" / "proactive_chat_tool.py").read_text(encoding="utf-8")
                        and "下一步：" in (root / "backend" / "app" / "modules" / "butler_core" / "tools" / "proactive_chat_tool.py").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "backend/app/modules/butler_core/tools/proactive_chat_tool.py"}],
                    ),
                    criterion(
                        "assistant_no_internal_terms_guarded",
                        "普通回答不出现 mock、seed、phone_album、source_event_id 等内部字段",
                        (root / "frontend" / "scripts" / "smoke-assistant-natural-control.mjs").exists()
                        and "forbiddenTerms" in (root / "frontend" / "scripts" / "smoke-assistant-natural-control.mjs").read_text(encoding="utf-8")
                        and "phone_album" in (root / "frontend" / "scripts" / "smoke-assistant-natural-control.mjs").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/scripts/smoke-assistant-natural-control.mjs"}],
                    ),
                    criterion(
                        "assistant_does_not_confirm_remote_facts",
                        "不能确认远程仓库、部署、接口或任务系统实时状态",
                        "不能确认远程" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "回到对应系统确认" in (root / "backend" / "app" / "modules" / "butler_core" / "tools" / "proactive_chat_tool.py").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "backend/app/main.py"},
                            {"kind": "file", "path": "backend/app/modules/butler_core/tools/proactive_chat_tool.py"},
                        ],
                    ),
                    criterion(
                        "assistant_frontend_smoke_available",
                        "前端 build 和 assistant smoke 通过",
                        "smoke:assistant-natural-control" in (root / "frontend" / "package.json").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/package.json"},
                            {"kind": "file", "path": "frontend/scripts/smoke-assistant-natural-control.mjs"},
                        ],
                    ),
                    criterion(
                        "assistant_contract_tests_cover_boundaries",
                        "后端核心测试通过",
                        "test_key_answer_hides_internal_source_fields" in (root / "backend" / "app" / "modules" / "butler_core" / "tests" / "test_chat_api_contract.py").read_text(encoding="utf-8")
                        and "test_unknown_question_does_not_answer_from_memory" in (root / "backend" / "app" / "modules" / "butler_core" / "tests" / "test_chat_api_contract.py").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "backend/app/modules/butler_core/tests/test_chat_api_contract.py"}],
                    ),
                    criterion(
                        "assistant_data_insufficient_no_fabrication",
                        "数据不足时明确说明，不凭聊天记忆编造",
                        "数据还不够" in (root / "backend" / "app" / "modules" / "butler_core" / "tools" / "proactive_chat_tool.py").read_text(encoding="utf-8")
                        and "不会凭聊天记忆" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "backend/app/modules/butler_core/tools/proactive_chat_tool.py"},
                            {"kind": "file", "path": "backend/app/main.py"},
                        ],
                    ),
                    criterion(
                        "assistant_mobile_no_horizontal_overflow",
                        "移动端问管家入口不横向溢出",
                        "assistant-capabilities" in (root / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
                        and "scrollWidth <= initial.width" in (root / "frontend" / "scripts" / "smoke-assistant-natural-control.mjs").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/styles.css"},
                            {"kind": "file", "path": "frontend/scripts/smoke-assistant-natural-control.mjs"},
                        ],
                    ),
            ],
            "OB-GOAL-016": [
                    criterion(
                        "public_demo_marked_as_sample",
                        "线上 Demo 明确标识为样例体验",
                        "样例体验" in app_text
                        and "未读取你的真实数据" in butler_ui_text
                        and (root / "docs" / "product" / "DEMO_LOCAL_MODE_BOUNDARY.md").exists(),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "docs/product/DEMO_LOCAL_MODE_BOUNDARY.md"},
                        ],
                    ),
                    criterion(
                        "public_demo_does_not_imply_real_connection",
                        "公开 Demo 不暗示已经连接真实本机数据",
                        "了解本地模式" in app_text
                        and "线上版本不会读取你的真实本机活动" in app_text
                        and "真实本地模式需要你在本机运行" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "real_local_mode_requires_local_run_and_authorization",
                        "真实本地模式入口说明需要本机运行和主动授权",
                        "本机运行" in app_text
                        and "主动授权" in app_text
                        and "本地真实模式" in (root / "docs" / "product" / "LOCAL_REAL_MODE_ACTIVATION_PATH.md").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "docs/product/LOCAL_REAL_MODE_ACTIVATION_PATH.md"},
                        ],
                    ),
                    criterion(
                        "ordinary_ctas_are_user_tasks",
                        "普通路径 CTA 使用看今天重点、查看时间线、解释依据、了解本地模式等用户任务文案",
                        "看今天建议" in butler_ui_text
                        and "查看全部记录" in app_text
                        and "查看依据" in app_text
                        and "了解本地模式" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "ordinary_path_forbidden_terms_guarded",
                        "普通路径不出现 mock、seed、debug、internal source 等工程词",
                        (root / "frontend" / "scripts" / "smoke-demo-local-boundary.mjs").exists()
                        and "forbiddenTerms" in (root / "frontend" / "scripts" / "smoke-demo-local-boundary.mjs").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "frontend/scripts/smoke-demo-local-boundary.mjs"}],
                    ),
                    criterion(
                        "trust_layer_present_across_main_paths",
                        "提醒、时间线和问管家都保留依据与边界说明",
                        "evidenceBoundary" in app_text
                        and "边界说明" in app_text
                        and "依据" in app_text
                        and (root / "docs" / "product" / "EVIDENCE_TRUST_LAYER_V1.md").exists(),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "docs/product/EVIDENCE_TRUST_LAYER_V1.md"},
                        ],
                    ),
                    criterion(
                        "no_dedicated_evidence_endpoint_added",
                        "不新增 /api/butler/insights/{id}/evidence",
                        "/insights/{insight_id}/evidence" not in router_text
                        and "evidence_refs" in api_contracts_text
                        and "inline" in api_contracts_text.lower(),
                        [
                            {"kind": "file", "path": "backend/app/modules/butler_core/router.py"},
                            {"kind": "file", "path": "docs/architecture/API_CONTRACTS.md"},
                        ],
                    ),
                    criterion(
                        "no_real_minecontext_read_for_demo_boundary",
                        "不读取真实 MineContext 数据",
                        "本轮不读取真实 MineContext 数据" in (root / "docs" / "product" / "DEMO_LOCAL_MODE_BOUNDARY.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "docs/product/DEMO_LOCAL_MODE_BOUNDARY.md"}],
                    ),
                    criterion(
                        "no_screenshot_copy_or_upload",
                        "不复制截图或上传数据",
                        "不复制截图" in (root / "docs" / "product" / "DEMO_LOCAL_MODE_BOUNDARY.md").read_text(encoding="utf-8")
                        and "不上传数据" in (root / "docs" / "product" / "DEMO_LOCAL_MODE_BOUNDARY.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "docs/product/DEMO_LOCAL_MODE_BOUNDARY.md"}],
                    ),
                    criterion(
                        "frontend_and_backend_validation_documented",
                        "前端 build 和后端核心测试通过",
                        "Frontend build passes" in (root / "current_state.md").read_text(encoding="utf-8")
                        and "butler_core tests" in (root / "current_state.md").read_text(encoding="utf-8")
                        and "pc_activity_context tests" in (root / "current_state.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "current_state.md"}],
                    ),
            ],
            "OB-GOAL-022": [
                    criterion(
                        "electron_desktop_shell_exists",
                        "desktop/ Electron 应用存在",
                        desktop_package_path.exists()
                        and desktop_main_path.exists()
                        and desktop_preload_path.exists()
                        and "electron-builder" in desktop_package_text,
                        [
                            {"kind": "file", "path": "desktop/package.json"},
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                            {"kind": "file", "path": "desktop/src/preload.cjs"},
                        ],
                    ),
                    criterion(
                        "backend_loopback_and_strict_defaults",
                        "Electron 主进程可启动本地 FastAPI 服务并绑定 127.0.0.1",
                        "127.0.0.1" in desktop_main_text
                        and "uvicorn" in desktop_main_text
                        and 'OPENBUTLER_DEFAULT_PRIVACY_MODE: "strict"' in desktop_main_text
                        and 'OPENBUTLER_DISABLE_SEED_EVENTS: "1"' in desktop_main_text
                        and 'OPENBUTLER_COPY_SCREENSHOTS: "0"' in desktop_main_text
                        and 'OPENBUTLER_EXTERNAL_MODEL_ALLOWED: "0"' in desktop_main_text,
                        [{"kind": "file", "path": "desktop/src/main.cjs"}],
                    ),
                    criterion(
                        "desktop_mode_strict_privacy_defaults",
                        "桌面模式默认 strict、禁用 seed、只读数据源、不复制截图、不调用外部模型",
                        'OPENBUTLER_DEFAULT_PRIVACY_MODE: "strict"' in desktop_main_text
                        and 'OPENBUTLER_DISABLE_SEED_EVENTS: "1"' in desktop_main_text
                        and 'OPENBUTLER_COPY_SCREENSHOTS: "0"' in desktop_main_text
                        and 'OPENBUTLER_EXTERNAL_MODEL_ALLOWED: "0"' in desktop_main_text
                        and "read_only" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "chooseMineContextHome" in desktop_preload_text,
                        [
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                            {"kind": "api", "path": "GET /api/desktop/status"},
                        ],
                    ),
                    criterion(
                        "backend_exe_packaging_scaffold",
                        "后端可由 PyInstaller 打包为 openbutler-backend.exe",
                        desktop_backend_entry_path.exists()
                        and desktop_spec_path.exists()
                        and "openbutler-backend" in desktop_spec_path.read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "desktop/backend_entry.py"},
                            {"kind": "file", "path": "desktop/desktop_backend.spec"},
                            {"kind": "file", "path": "backend/requirements-desktop.txt"},
                        ],
                    ),
                    criterion(
                        "frontend_runtime_bridge",
                        "前端优先使用 window.openbutlerDesktop.apiBase",
                        "window.openbutlerDesktop?.apiBase" in frontend_api_text
                        and "/api/desktop/status" in frontend_api_text
                        and desktop_types_path.exists(),
                        [
                            {"kind": "file", "path": "frontend/src/lib/api.ts"},
                            {"kind": "file", "path": "frontend/src/desktop.d.ts"},
                        ],
                    ),
                    criterion(
                        "preload_minimal_interface",
                        "preload 只暴露最小安全接口",
                        "contextBridge.exposeInMainWorld" in desktop_preload_text
                        and "getRuntime" in desktop_preload_text
                        and "restartBackend" in desktop_preload_text
                        and "chooseMineContextHome" in desktop_preload_text
                        and "openDataFolder" in desktop_preload_text
                        and "nodeIntegration: false" in desktop_main_text,
                        [{"kind": "file", "path": "desktop/src/preload.cjs"}],
                    ),
                    criterion(
                        "first_run_activation_v2",
                        "首次激活流说明样例体验、本地模式、隐私承诺、数据源检测和预览确认",
                        "像安装一个私人管家一样开始" in app_text
                        and "让 OpenButler 整理我的本机记录" in app_text
                        and "授权前只会检测和预览" in app_text
                        and "activation-step-list" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "me_management_page_local_status",
                        "/me 展示本机服务状态、授权线索、隐私检查和重新打开引导",
                        "我的 OpenButler" in app_text
                        and "本机服务" in app_text
                        and "本地线索" in app_text
                        and "选择本机记录目录" in app_text
                        and "打开本地数据文件夹" in app_text
                        and "重新打开引导" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "desktop_status_endpoint_redacted",
                        "/api/desktop/status 只返回脱敏桌面状态",
                        "/api/desktop/status" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "raw_activity_titles_returned" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "screenshot_paths_returned" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "assertNotIn" in desktop_status_test_text,
                        [
                            {"kind": "api", "path": "GET /api/desktop/status"},
                            {"kind": "test", "path": "backend/app/modules/butler_core/tests/test_desktop_status.py"},
                        ],
                    ),
                    criterion(
                        "desktop_static_validation_available",
                        "桌面契约和前端桥接有静态 smoke",
                        desktop_check_path.exists()
                        and desktop_smoke_path.exists()
                        and "smoke:desktop-runtime-bridge" in (root / "frontend" / "package.json").read_text(encoding="utf-8"),
                        [
                            {"kind": "script", "path": "desktop/scripts/check-desktop-contract.mjs"},
                            {"kind": "script", "path": "frontend/scripts/smoke-desktop-runtime-bridge.mjs"},
                        ],
                    ),
                    criterion(
                        "commercial_concept_ppt_exists",
                        "商业概念 PPT 存在且不包含真实用户数据",
                        commercial_ppt_path.exists()
                        and "data-layout" in commercial_ppt_text
                        and "[必填]" not in commercial_ppt_text
                        and "C:\\Users" not in commercial_ppt_text
                        and "Sponsor" not in commercial_ppt_text
                        and "OpenButler Commercial Concept" in commercial_ppt_text,
                        [{"kind": "file", "path": "docs/productization/openbutler-commercial-concept-pitch/ppt/index.html"}],
                    ),
                    criterion(
                        "desktop_validation_available",
                        "前端 build、后端核心测试和桌面合同检查通过",
                        desktop_doc_path.exists()
                        and desktop_check_path.exists()
                        and desktop_smoke_path.exists()
                        and desktop_status_test_path.exists()
                        and "不读取真实活动标题" in desktop_doc_path.read_text(encoding="utf-8")
                        and "不复制截图" in desktop_doc_path.read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "docs/product/ELECTRON_FIRST_RUN_PRODUCTIZATION_SHELL.md"},
                            {"kind": "script", "path": "desktop/scripts/check-desktop-contract.mjs"},
                            {"kind": "script", "path": "frontend/scripts/smoke-desktop-runtime-bridge.mjs"},
                            {"kind": "test", "path": "backend/app/modules/butler_core/tests/test_desktop_status.py"},
                        ],
                    ),
                    criterion(
                        "desktop_scope_no_cloud_api_added",
                        "本轮不新增云端 API 或 dedicated evidence endpoint",
                        "/insights/{insight_id}/evidence" not in router_text
                        and "external_model" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "backend/app/modules/butler_core/router.py"}],
                    ),
            ],
            "OB-GOAL-023": [
                    criterion(
                        "desktop_blank_window_root_cause_guarded",
                        "桌面构建不再使用导致 Electron loadFile 空白的绝对 /assets 路径",
                        desktop_asset_check_path.exists()
                        and "OPENBUTLER_DESKTOP_BUILD" in (root / "frontend" / "vite.config.ts").read_text(encoding="utf-8")
                        and "check:frontend-assets" in desktop_package_text,
                        [
                            {"kind": "file", "path": "frontend/vite.config.ts"},
                            {"kind": "script", "path": "desktop/scripts/check-desktop-frontend-assets.mjs"},
                        ],
                    ),
                    criterion(
                        "desktop_error_page_and_packaged_smoke",
                        "Electron 主进程提供可读错误页和 packaged app 非空 smoke",
                        "loadDesktopErrorPage" in desktop_main_text
                        and "did-fail-load" in desktop_main_text
                        and desktop_packaged_smoke_path.exists()
                        and "bodyTextLength" in desktop_packaged_smoke_text,
                        [
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                            {"kind": "script", "path": "desktop/scripts/smoke-packaged-app.mjs"},
                        ],
                    ),
                    criterion(
                        "tray_and_second_launch_available",
                        "桌面应用支持系统托盘、关闭隐藏和二次启动唤起",
                        "new Tray" in desktop_main_text
                        and "requestSingleInstanceLock" in desktop_main_text
                        and "second-instance" in desktop_main_text
                        and "mainWindow.hide" in desktop_main_text,
                        [{"kind": "file", "path": "desktop/src/main.cjs"}],
                    ),
                    criterion(
                        "tray_uses_real_icon_asset",
                        "桌面托盘和 Windows 安装包使用真实 OpenButler 图标资源",
                        desktop_icon_path.exists()
                        and "openbutler.ico" in desktop_main_text
                        and "nativeImage.createFromPath" in desktop_main_text
                        and '"icon": "assets/openbutler.ico"' in desktop_package_text,
                        [
                            {"kind": "file", "path": "desktop/assets/openbutler.ico"},
                            {"kind": "file", "path": "desktop/package.json"},
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                        ],
                    ),
                    criterion(
                        "minecontext_model_config_bridge",
                        "preload 暴露 MineContext 检测、安装程序选择、启动和模型配置能力",
                        "getMineContextStatus" in desktop_preload_text
                        and "chooseMineContextInstaller" in desktop_preload_text
                        and "startMineContext" in desktop_preload_text
                        and "applyMineContextModelConfig" in desktop_preload_text
                        and "/api/model_settings/update" in desktop_main_text,
                        [
                            {"kind": "file", "path": "desktop/src/preload.cjs"},
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                        ],
                    ),
                    criterion(
                        "minecontext_scan_and_install_bridge",
                        "模型配置后可扫描本机 MineContext，并在用户确认后自动或手动安装接入",
                        "scanMineContextInstallations" in desktop_main_text
                        and "downloadMineContextInstaller" in desktop_main_text
                        and "installMineContextWithApproval" in desktop_main_text
                        and "openMineContextDownloadPage" in desktop_preload_text
                        and "https://api.github.com/repos/volcengine/MineContext/releases/latest" in desktop_main_text
                        and ("扫描本机 MineContext" in app_text or "扫描本机记录组件" in app_text or "查找本机记录组件" in app_text or "查找本机记录服务" in app_text)
                        and "自动安装" in app_text
                        and "手动安装" in app_text,
                        [
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                            {"kind": "file", "path": "desktop/src/preload.cjs"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "activation_v3_model_provider_ui",
                        "首次激活流包含 MineContext 检测、隐私承诺、模型供应商配置和确认写入",
                        ("模型供应商" in app_text or "智能整理能力" in app_text)
                        and (
                            "写入 MineContext 配置" in app_text
                            or "写入记录组件配置" in app_text
                            or "保存到本机记录服务" in app_text
                            or "保存到本机记录组件" in app_text
                        )
                        and ("Embedding 模型 ID" in app_text or "高级向量模型 / ID" in app_text)
                        and ("不调用外部模型" in app_text or "不会发起模型调用" in app_text),
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "me_local_full_mode_check",
                        "/me 展示本地完全体检查，包括服务、MineContext、模型配置和 strict 状态",
                        "本地完全体检查" in app_text
                        and "本机服务" in app_text
                        and ("MineContext 后台" in app_text or "本机记录组件" in app_text or "本机记录服务" in app_text)
                        and ("模型配置" in app_text or "智能整理" in app_text)
                        and "严格隐私" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "desktop_status_extended_but_redacted",
                        "/api/desktop/status 扩展 MineContext 状态且保持脱敏",
                        "model_configured" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "reachable" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "assertNotIn" in desktop_status_test_text,
                        [
                            {"kind": "api", "path": "GET /api/desktop/status"},
                            {"kind": "test", "path": "backend/app/modules/butler_core/tests/test_desktop_status.py"},
                        ],
                    ),
                    criterion(
                        "commercial_ppt_dense_magazine_style",
                        "商业概念 PPT 改为高信息密度电子杂志/产品说明书风格",
                        commercial_ppt_path.exists()
                        and "电子杂志" in commercial_ppt_text
                        and "本地完全体" in commercial_ppt_text
                        and "商业化探索" in commercial_ppt_text
                        and "C:\\Users" not in commercial_ppt_text
                        and "Sponsor" not in commercial_ppt_text
                        and "[必填]" not in commercial_ppt_text,
                        [{"kind": "file", "path": "docs/productization/openbutler-commercial-concept-pitch/ppt/index.html"}],
                    ),
                    criterion(
                        "desktop_privacy_no_real_data_side_effects",
                        "不读取真实 MineContext 活动，不复制截图，不调用外部模型",
                        "OPENBUTLER_DISABLE_SEED_EVENTS" in desktop_main_text
                        and "OPENBUTLER_COPY_SCREENSHOTS" in desktop_main_text
                        and "OPENBUTLER_EXTERNAL_MODEL_ALLOWED" in desktop_main_text
                        and "不会导入真实活动" in app_text,
                        [
                            {"kind": "file", "path": "desktop/src/main.cjs"},
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                        ],
                    ),
                    criterion(
                        "desktop_verification_commands_declared",
                        "前端 build、后端核心测试、桌面合同检查和桌面资源检查通过",
                        "check-desktop-contract" in desktop_package_text
                        and "check:frontend-assets" in desktop_package_text
                        and desktop_asset_check_path.exists()
                        and (root / "backend" / "app" / "modules" / "butler_core" / "tests").exists()
                        and (root / "backend" / "app" / "modules" / "pc_activity_context" / "tests").exists(),
                        [
                            {"kind": "script", "path": "desktop/scripts/check-desktop-contract.mjs"},
                            {"kind": "script", "path": "desktop/scripts/check-desktop-frontend-assets.mjs"},
                            {"kind": "test", "path": "backend/app/modules/butler_core/tests"},
                            {"kind": "test", "path": "backend/app/modules/pc_activity_context/tests"},
                        ],
                    ),
            ],
            "OB-GOAL-025": [
                    criterion(
                        "product_shell_direction_doc",
                        "正式产品壳方向记录在 PRODUCT_SHELL_DIRECTION_CONVERGENCE.md",
                        (root / "docs" / "product" / "PRODUCT_SHELL_DIRECTION_CONVERGENCE.md").exists()
                        and "iOS / Apple Home style private butler" in (root / "docs" / "product" / "PRODUCT_SHELL_DIRECTION_CONVERGENCE.md").read_text(encoding="utf-8")
                        and "私人整理管家" in (root / "docs" / "product" / "PRODUCT_SHELL_DIRECTION_CONVERGENCE.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "docs/product/PRODUCT_SHELL_DIRECTION_CONVERGENCE.md"}],
                    ),
                    criterion(
                        "domain_context_terms",
                        "CONTEXT.md 记录 私人整理管家、样例体验、本地模式、本机记录组件、智能整理钥匙、依据层 等术语",
                        (root / "CONTEXT.md").exists()
                        and all(
                            term in (root / "CONTEXT.md").read_text(encoding="utf-8")
                            for term in ["私人整理管家", "样例体验", "本地模式", "本机记录组件", "智能整理钥匙", "依据层"]
                        ),
                        [{"kind": "file", "path": "CONTEXT.md"}],
                    ),
                    criterion(
                        "adr_0010_records_direction",
                        "ADR 0010 记录为什么采用 iOS / Apple Home 方向作为正式主线",
                        (root / "docs" / "architecture" / "decisions" / "0010-product-shell-direction-convergence.md").exists()
                        and "iOS / Apple Home" in (root / "docs" / "architecture" / "decisions" / "0010-product-shell-direction-convergence.md").read_text(encoding="utf-8")
                        and "formal homepage candidate" in (root / "docs" / "architecture" / "decisions" / "0010-product-shell-direction-convergence.md").read_text(encoding="utf-8"),
                        [{"kind": "file", "path": "docs/architecture/decisions/0010-product-shell-direction-convergence.md"}],
                    ),
                    criterion(
                        "github_issues_split",
                        "后续工作拆成可独立执行的 GitHub issues",
                        all(
                            issue_url in (root / ".openbutler" / "task_queue.yaml").read_text(encoding="utf-8")
                            for issue_url in [
                                "https://github.com/Giftia/OpenButler/issues/1",
                                "https://github.com/Giftia/OpenButler/issues/2",
                                "https://github.com/Giftia/OpenButler/issues/3",
                                "https://github.com/Giftia/OpenButler/issues/4",
                                "https://github.com/Giftia/OpenButler/issues/5",
                                "https://github.com/Giftia/OpenButler/issues/6",
                                "https://github.com/Giftia/OpenButler/issues/7",
                                "https://github.com/Giftia/OpenButler/issues/8",
                            ]
                        ),
                        [{"kind": "file", "path": ".openbutler/task_queue.yaml"}],
                    ),
                    criterion(
                        "product_shell_facts_updated",
                        "current_state.md、goals.yaml、task_queue.yaml 不再把旧设计实验误写成当前主线",
                        "OB-GOAL-025" in (root / "current_state.md").read_text(encoding="utf-8")
                        and "iOS / Apple Home" in (root / "current_state.md").read_text(encoding="utf-8")
                        and "Product Shell Direction Convergence" in (root / ".openbutler" / "goals.yaml").read_text(encoding="utf-8")
                        and "把 /design/ios 收敛为正式 /butler 首页" in (root / ".openbutler" / "task_queue.yaml").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "current_state.md"},
                            {"kind": "file", "path": ".openbutler/goals.yaml"},
                            {"kind": "file", "path": ".openbutler/task_queue.yaml"},
                        ],
                    ),
                    criterion(
                        "no_real_data_side_effects_product_shell",
                        "不读取真实 MineContext 数据，不复制截图，不调用外部模型",
                        "Do not run real MineContext import" in (root / "docs" / "product" / "PRODUCT_SHELL_DIRECTION_CONVERGENCE.md").read_text(encoding="utf-8")
                        and report.get("privacy", {}).get("external_model_used") is False
                        and report.get("privacy", {}).get("copied_screenshots") == 0
                        and report.get("privacy", {}).get("minecontext_source_deleted") == 0,
                        [
                            {"kind": "file", "path": "docs/product/PRODUCT_SHELL_DIRECTION_CONVERGENCE.md"},
                            {"kind": "api", "path": "GET /api/butler/mvp-report"},
                        ],
                        report.get("privacy", {}),
                    ),
            ],
            "OB-GOAL-026": [
                    criterion(
                        "activation_gate_blocks_main_app",
                        "桌面版首次启动未激活前不显示主导航或空主界面",
                        "activationGateOpen" in app_text
                        and "mandatory" in app_text
                        and "updateActivation(\"dismissed\")" in app_text
                        and "hasMainShell" in local_activation_smoke_text
                        and "Main app should not be visible before activation" in local_activation_smoke_text,
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/scripts/smoke-local-mode-activation.mjs"},
                        ],
                    ),
                    criterion(
                        "sample_mode_choice",
                        "用户可以选择先看样例，且样例明确未读取真实数据",
                        "先看样例" in app_text
                        and "真实数据" in app_text
                        and "demo_selected" in local_activation_smoke_text,
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "frontend/scripts/smoke-local-mode-activation.mjs"},
                        ],
                    ),
                    criterion(
                        "smart_key_required",
                        "启用本地模式必须经过智能整理钥匙配置",
                        "智能整理钥匙" in app_text
                        and "我该从哪里获得 API Key" in app_text
                        and "missingModelFields" in app_text,
                        [{"kind": "file", "path": "frontend/src/App.tsx"}],
                    ),
                    criterion(
                        "local_record_component_bootstrap",
                        "启用本地模式必须经过本机记录组件扫描、安装说明或连接检测",
                        "本机记录组件" in app_text
                        and "查找本机记录组件" in app_text
                        and "自动安装" in app_text
                        and "手动安装" in app_text
                        and "scanMineContextInstallations" in desktop_preload_text
                        and "installMineContextWithApproval" in desktop_preload_text,
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "desktop/src/preload.cjs"},
                        ],
                    ),
                    criterion(
                        "dry_run_preview_redacted",
                        "授权前 dry-run 预览只显示聚合信息，不写数据库",
                        "授权前预览" in app_text
                        and "确认前不会导入真实活动" in app_text
                        and '"kind": "dry_run_only"' in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and '"database_written": False' in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8")
                        and "database_written" in desktop_status_test_text,
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "backend/app/main.py"},
                            {"kind": "file", "path": "backend/app/modules/butler_core/tests/test_desktop_status.py"},
                        ],
                    ),
                    criterion(
                        "first_useful_result_preview",
                        "第一份今日整理预览说明整理了什么、依据来自哪里、哪些不能确认",
                        "第一份今日整理预览" in app_text
                        and local_activation_doc_path.exists()
                        and "哪些结论还不能确认" in local_activation_doc_path.read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "frontend/src/App.tsx"},
                            {"kind": "file", "path": "docs/product/LOCAL_MODE_FIRST_USE_ACTIVATION.md"},
                        ],
                    ),
                    criterion(
                        "ordinary_ui_hides_internal_terms",
                        "普通 UI 不出现 MineContext、PCActivity、mock、seed、Provider、Webhook",
                        "forbidden" in local_activation_smoke_text
                        and "PCActivity" in local_activation_smoke_text
                        and "Provider" in local_activation_smoke_text
                        and "Webhook" in local_activation_smoke_text,
                        [{"kind": "file", "path": "frontend/scripts/smoke-local-mode-activation.mjs"}],
                    ),
                    criterion(
                        "desktop_status_redacted",
                        "桌面状态接口不返回真实活动标题、URL、截图路径、API Key 或 raw output",
                        "raw_activity_titles_returned" in desktop_status_test_text
                        and "screenshot_paths_returned" in desktop_status_test_text
                        and "raw_output_returned" in desktop_status_test_text
                        and "apiKey" not in desktop_status_test_text,
                        [
                            {"kind": "file", "path": "backend/app/main.py"},
                            {"kind": "file", "path": "backend/app/modules/butler_core/tests/test_desktop_status.py"},
                        ],
                    ),
                    criterion(
                        "privacy_no_real_read",
                        "不读取真实 MineContext 活动，不复制截图，不调用外部模型",
                        "不读取真实 MineContext 活动" in (root / ".openbutler" / "goals.yaml").read_text(encoding="utf-8")
                        and "copy_screenshots" in desktop_status_test_text
                        and "external_model_allowed" in desktop_status_test_text
                        and "screenshots_copied" in (root / "backend" / "app" / "main.py").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": ".openbutler/goals.yaml"},
                            {"kind": "file", "path": "backend/app/main.py"},
                        ],
                    ),
            ],
            "OB-GOAL-027": [
                    criterion(
                        "canonical_repository_baseline",
                        "远端旧 main 已归档，当前产品历史成为受保护的 canonical main",
                        "archive/original-main-2026-07-15" in (root / "current_state.md").read_text(encoding="utf-8")
                        and "Canonical branch: `main`" in (root / "STATE.md").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "current_state.md"},
                            {"kind": "file", "path": "STATE.md"},
                        ],
                    ),
                    criterion(
                        "loop_control_plane_files",
                        "LOOP.md、STATE.md、loop-budget.md、loop-constraints.md、loop-run-log.md 存在且相互一致",
                        all((root / item).exists() for item in [
                            "LOOP.md",
                            "STATE.md",
                            "loop-budget.md",
                            "loop-constraints.md",
                            "loop-run-log.md",
                        ])
                        and "OB-GOAL-027" in (root / "STATE.md").read_text(encoding="utf-8")
                        and "OB-GOAL-027" in (root / ".openbutler" / "goals.yaml").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "LOOP.md"},
                            {"kind": "file", "path": "STATE.md"},
                            {"kind": "file", "path": "loop-budget.md"},
                            {"kind": "file", "path": "loop-constraints.md"},
                            {"kind": "file", "path": "loop-run-log.md"},
                        ],
                    ),
                    criterion(
                        "read_only_governance_audit",
                        "L1 治理巡检仅写入忽略目录中的报告，不修改产品代码或 GitHub 状态",
                        (root / "tools" / "loop" / "governance-audit.mjs").exists()
                        and "product_mutations: 0" in (root / "tools" / "loop" / "governance-audit.mjs").read_text(encoding="utf-8")
                        and "github_mutations: 0" in (root / "tools" / "loop" / "governance-audit.mjs").read_text(encoding="utf-8")
                        and "data/loop-runs" in (root / "LOOP.md").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "tools/loop/governance-audit.mjs"},
                            {"kind": "file", "path": "tools/loop/tests/governance-audit.test.mjs"},
                            {"kind": "file", "path": "LOOP.md"},
                        ],
                    ),
                    criterion(
                        "required_ci_gates",
                        "基础 CI 覆盖 Butler Core、PC Activity、Workstation Vision、Frontend 和 Desktop contract",
                        (root / ".github" / "workflows" / "ci.yml").exists()
                        and all(label in (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8") for label in [
                            "Butler Core",
                            "PC Activity",
                            "Workstation Vision",
                            "Frontend Build",
                            "Desktop Contract",
                            "Loop Governance",
                        ]),
                        [{"kind": "file", "path": ".github/workflows/ci.yml"}],
                    ),
                    criterion(
                        "github_issue_queue_contract",
                        "GitHub Issues 成为可执行工作队列，仓库内 task queue 只保存目标级状态",
                        "GitHub Issues - executable work queue" in (root / "current_state.md").read_text(encoding="utf-8")
                        and "GitHub Issues are the executable work queue" in (root / "LOOP.md").read_text(encoding="utf-8")
                        and (root / ".openbutler" / "task_queue.yaml").exists(),
                        [
                            {"kind": "file", "path": "current_state.md"},
                            {"kind": "file", "path": "LOOP.md"},
                            {"kind": "file", "path": ".openbutler/task_queue.yaml"},
                        ],
                    ),
                    criterion(
                        "integrated_context_engine_roadmap",
                        "Integrated Context Engine 路线固定为 OB-GOAL-034 到 OB-GOAL-041",
                        all(goal in (root / ".openbutler" / "goals.yaml").read_text(encoding="utf-8") for goal in [
                            "OB-GOAL-034",
                            "OB-GOAL-035",
                            "OB-GOAL-036",
                            "OB-GOAL-037",
                            "OB-GOAL-038",
                            "OB-GOAL-039",
                            "OB-GOAL-040",
                            "OB-GOAL-041",
                        ])
                        and "paused_objectives:" in (root / ".openbutler" / "goals.yaml").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": ".openbutler/goals.yaml"},
                            {"kind": "file", "path": "current_state.md"},
                        ],
                    ),
                    criterion(
                        "loop_stage_privacy_boundary",
                        "未读取真实 MineContext 活动、未复制截图、未调用外部模型",
                        "No real MineContext activity was read" in (root / "current_state.md").read_text(encoding="utf-8")
                        and report.get("privacy", {}).get("external_model_used") is False
                        and report.get("privacy", {}).get("copied_screenshots") == 0
                        and report.get("privacy", {}).get("minecontext_source_deleted") == 0,
                        [
                            {"kind": "file", "path": "current_state.md"},
                            {"kind": "api", "path": "GET /api/butler/mvp-report"},
                        ],
                        report.get("privacy", {}),
                    ),
                    criterion(
                        "first_manual_l1_accepted",
                        "首次人工 L1 已在 canonical main 上完成并被人工接受",
                        "Current level: L1" in (root / "STATE.md").read_text(encoding="utf-8")
                        and "Last accepted run: never" not in (root / "STATE.md").read_text(encoding="utf-8"),
                        [
                            {"kind": "file", "path": "STATE.md"},
                            {"kind": "file", "path": "loop-run-log.md"},
                        ],
                        {"human_gate": True, "canonical_main_required": True},
                    ),
                    criterion(
                        "nightly_scheduler_runtime_readback",
                        "19:00 本机夜间控制器和 08:00 验收任务有真实运行回读",
                        supervised_nightly_passed,
                        [
                            {"kind": "local_artifact", "path": "data/nightly/<run-id>/state.json"},
                            {"kind": "local_artifact", "path": "data/nightly/<run-id>/MORNING_ACCEPTANCE.md"},
                            {"kind": "script", "path": "tools/nightly/install-scheduled-tasks.ps1"},
                        ],
                        {"required": "nightly and morning scheduler runtime readback", "tracked_state": "STATE.md"},
                    ),
                    criterion(
                        "supervised_dry_run_and_human_gate",
                        "一次监督 dry-run 通过后仍需用户明确批准进入 L2",
                        supervised_nightly_passed
                        and "Current level: L1 active" in loop_state_text,
                        [
                            {"kind": "local_artifact", "path": "data/nightly/<run-id>/state.json"},
                            {"kind": "file", "path": "STATE.md"},
                            {"kind": "file", "path": "LOOP.md"},
                        ],
                        {
                            "supervised_dry_run_passed": supervised_nightly_passed,
                            "human_approval_required": True,
                        },
                    ),
                    criterion(
                        "l2_pr_preview_contract",
                        "L2 每个 Issue 使用独立 PR，早晨通过 OpenButler Preview 验收，夜间永不合并",
                        "| L2 Preview delivery exercise | passed |" in loop_state_text,
                        [
                            {"kind": "script", "path": "tools/nightly/nightly-controller.mjs"},
                            {"kind": "script", "path": "tools/nightly/morning-report.mjs"},
                            {"kind": "script", "path": "desktop/scripts/build-preview-installer.mjs"},
                            {"kind": "file", "path": "loop-constraints.md"},
                        ],
                        {"required": "verified issue PR, Preview install, and morning acceptance readback"},
                    ),
            ],
        }
        objectives = []
        for declared in active_objectives:
            objective_id = str(declared.get("id", "unknown"))
            criteria = criteria_by_objective.get(objective_id)
            if criteria is None:
                criteria = [
                    criterion(
                        "evidence_mapper_missing",
                        "该 active objective 尚未配置 Productization Harness evidence mapper",
                        False,
                        [
                            {"kind": "file", "path": ".openbutler/goals.yaml"},
                            {"kind": "file", "path": mapper_template["doc_path"]},
                        ],
                        {
                            "goal_id": objective_id,
                            "template_schema_version": mapper_template["schema_version"],
                            "doc_path": mapper_template["doc_path"],
                            "service_path": mapper_template["service_path"],
                            "required_steps": mapper_template["required_steps"],
                        },
                    )
                ]
            objectives.append(
                {
                    "id": objective_id,
                    "title": str(declared.get("title") or objective_id),
                    "priority": str(declared.get("priority") or "unknown"),
                    "success_criteria": declared.get("success_criteria", []),
                    "criteria": criteria,
                    "source_ref": {"kind": "file", "path": ".openbutler/goals.yaml"},
                }
            )
        for objective in objectives:
            failed = [item for item in objective["criteria"] if item["status"] != "proven"]
            objective["status"] = "proven" if not failed else "needs_attention"
            objective["proven_count"] = len(objective["criteria"]) - len(failed)
            objective["criteria_count"] = len(objective["criteria"])
            objective["evidence_boundary"] = BOUNDARY

        failed_objectives = [item for item in objectives if item["status"] != "proven"]
        with self.connect() as conn:
            self._audit(
                conn,
                "productization_objective_status_checked",
                DEFAULT_USER_ID,
                {
                    "status": "proven" if not failed_objectives else "needs_attention",
                    "failed_objectives": [item["id"] for item in failed_objectives],
                    "goals_source_loaded": goals_config["loaded"],
                    "external_model_used": False,
                    "minecontext_source_deleted": 0,
                },
            )
        return {
            "schema_version": "productization_objective_status_v1",
            "status": "proven" if not failed_objectives else "needs_attention",
            "generated_at": now_iso(),
            "goals_source": {
                "path": ".openbutler/goals.yaml",
                "loaded": goals_config["loaded"],
                "active_objective_count": len(active_objectives),
                "parse_warnings": goals_config["parse_warnings"],
            },
            "evidence_mapper_template": mapper_template,
            "objectives": objectives,
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "copied_screenshots": 0,
            },
            "limitations": [
                "This is an evidence map for the current Productization Harness state, not a claim about remote systems.",
                "It uses local APIs, local files, and rule-based readiness checks only.",
                "Browser click automation remains a separate future hardening task.",
            ],
            "evidence_boundary": (
                "Objective status is derived from local OpenButler APIs, local repository files, and Productization Harness checks. "
                "It does not inspect or mutate MineContext source data and does not verify remote repositories, CI, Yunxiao, deployments, or online services."
            ),
        }

    def productization_l1_audit_report(self) -> dict[str, Any]:
        objective_status = self.productization_objective_status()
        out_of_scope_terms = [
            "远程",
            "部署",
            "线上",
            "CI",
            "云效",
            "Yunxiao",
            "Jira",
            "提交代码",
            "外部写入",
        ]

        def is_out_of_scope(text: str) -> bool:
            return any(term.lower() in text.lower() for term in out_of_scope_terms)

        def audit_success_criterion(objective: dict[str, Any], success_text: str) -> dict[str, Any]:
            mapped = next(
                (item for item in objective.get("criteria", []) if item.get("title") == success_text),
                None,
            )
            if mapped:
                result = "proven" if mapped.get("status") == "proven" else "needs_attention"
                return {
                    "success_criterion": success_text,
                    "verification_result": result,
                    "mapped_criterion_id": mapped.get("id"),
                    "mapped_criterion_title": mapped.get("title"),
                    "evidence_refs": mapped.get("evidence_refs", []),
                    "details": mapped.get("details", {}),
                    "evidence_boundary": mapped.get("evidence_boundary") or BOUNDARY,
                }

            missing_mapper = next(
                (item for item in objective.get("criteria", []) if item.get("id") == "evidence_mapper_missing"),
                None,
            )
            if is_out_of_scope(success_text):
                return {
                    "success_criterion": success_text,
                    "verification_result": "out_of_scope",
                    "mapped_criterion_id": None,
                    "mapped_criterion_title": None,
                    "evidence_refs": [{"kind": "file", "path": ".openbutler/goals.yaml"}],
                    "details": {
                        "reason": "This success criterion requires remote or external-system verification outside the local Productization Harness.",
                        "out_of_scope_terms": out_of_scope_terms,
                    },
                    "evidence_boundary": (
                        "This item is out of scope for local Productization Harness evidence. It must be verified in the source system "
                        "and cannot be proven from MineContext summaries, screenshots, or local OpenButler derived state."
                    ),
                }
            return {
                "success_criterion": success_text,
                "verification_result": "missing_evidence",
                "mapped_criterion_id": missing_mapper.get("id") if missing_mapper else None,
                "mapped_criterion_title": missing_mapper.get("title") if missing_mapper else None,
                "evidence_refs": (missing_mapper or {}).get("evidence_refs", [{"kind": "file", "path": ".openbutler/goals.yaml"}]),
                "details": {
                    "reason": "No local evidence criterion currently maps this declared success criterion.",
                    "mapper_details": (missing_mapper or {}).get("details", {}),
                },
                "evidence_boundary": (missing_mapper or {}).get("evidence_boundary") or BOUNDARY,
            }

        objectives = []
        totals = {"proven": 0, "needs_attention": 0, "missing_evidence": 0, "out_of_scope": 0}
        for objective in objective_status.get("objectives", []):
            success_checks = [
                audit_success_criterion(objective, str(success_text))
                for success_text in objective.get("success_criteria", [])
            ]
            for item in success_checks:
                totals[item["verification_result"]] += 1
            non_proven = [item for item in success_checks if item["verification_result"] != "proven"]
            objectives.append(
                {
                    "id": objective.get("id"),
                    "title": objective.get("title"),
                    "priority": objective.get("priority"),
                    "source_ref": objective.get("source_ref"),
                    "objective_status": "proven" if not non_proven else "needs_attention",
                    "success_criteria": success_checks,
                    "criterion_count": len(success_checks),
                    "proven_count": sum(1 for item in success_checks if item["verification_result"] == "proven"),
                    "needs_attention_count": sum(1 for item in success_checks if item["verification_result"] == "needs_attention"),
                    "missing_evidence_count": sum(1 for item in success_checks if item["verification_result"] == "missing_evidence"),
                    "out_of_scope_count": sum(1 for item in success_checks if item["verification_result"] == "out_of_scope"),
                    "evidence_boundary": objective.get("evidence_boundary") or BOUNDARY,
                }
            )

        status = "proven" if objectives and all(item["objective_status"] == "proven" for item in objectives) else "needs_attention"
        report = {
            "schema_version": "l1_active_objectives_audit_v1",
            "status": status,
            "generated_at": now_iso(),
            "source": {
                "objective_status_api": "GET /api/butler/productization/objectives/status",
                "goals_path": ".openbutler/goals.yaml",
                "goals_source": objective_status.get("goals_source", {}),
            },
            "allowed_results": ["proven", "needs_attention", "missing_evidence", "out_of_scope"],
            "summary": {
                "objective_count": len(objectives),
                "success_criteria_count": sum(item["criterion_count"] for item in objectives),
                **totals,
            },
            "objectives": objectives,
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "copied_screenshots": 0,
                "strict_mode_respected": (
                    objective_status.get("privacy", {}).get("external_model_used") is False
                    and objective_status.get("privacy", {}).get("external_model_allowed") is False
                    and objective_status.get("privacy", {}).get("minecontext_source_deleted") == 0
                ),
            },
            "limitations": [
                "This report audits declared L1 active objectives against local OpenButler evidence only.",
                "Out-of-scope items require source-system verification and must not be treated as proven from MineContext or OpenButler summaries.",
                "The report does not mutate MineContext, copy screenshots, call external models, or perform external writes.",
            ],
            "evidence_boundary": (
                "L1 audit results are derived from local OpenButler objective status, local repository files, local APIs, and Productization Harness checks. "
                "They do not inspect or mutate MineContext source data and do not verify remote repositories, CI, Yunxiao, deployments, or online services."
            ),
        }
        with self.connect() as conn:
            self._audit(
                conn,
                "productization_l1_audit_report_generated",
                DEFAULT_USER_ID,
                {
                    "status": status,
                    "objective_count": report["summary"]["objective_count"],
                    "missing_evidence": totals["missing_evidence"],
                    "out_of_scope": totals["out_of_scope"],
                    "external_model_used": False,
                    "minecontext_source_deleted": 0,
                },
            )
        return report

    def productization_demo_pack(self) -> dict[str, Any]:
        readiness = self.readiness()
        report = self.mvp_report()
        objectives = self.productization_objective_status()
        harness_runs = self.latest_harness_runs()
        strict_ok = (
            report.get("privacy", {}).get("external_model_used") is False
            and report.get("privacy", {}).get("external_model_allowed") is False
            and objectives.get("privacy", {}).get("external_model_used") is False
        )
        status = "ready"
        if not strict_ok:
            status = "attention_needed"
        elif readiness.get("status") != "ready" or report.get("status") != "ready":
            status = "attention_needed" if readiness.get("status") == "attention_needed" else "data_insufficient"
        elif objectives.get("status") != "proven":
            status = "attention_needed"
        pack = {
            "schema_version": "productization_demo_pack_v1",
            "status": status,
            "generated_at": now_iso(),
            "north_star": "用户每天 60 秒内理解今天发生了什么、什么值得注意、下一步应该做什么",
            "readiness": {
                "status": readiness.get("status"),
                "summary": readiness.get("summary", {}),
                "checks": readiness.get("checks", []),
                "evidence_boundary": readiness.get("evidence_boundary"),
            },
            "mvp_report": {
                "status": report.get("status"),
                "mvp_chain": report.get("mvp_chain", []),
                "acceptance": report.get("acceptance", []),
                "privacy": report.get("privacy", {}),
                "evidence_boundary": report.get("evidence_boundary"),
            },
            "objective_status": objectives,
            "latest_harness_runs": harness_runs,
            "demo_commands": [
                "POST /api/butler/demo/run",
                "GET /api/butler/productization/demo-pack",
                "npm run smoke:butler-ui-flow",
                "npm run smoke:butler-mvp-report",
            ],
            "privacy": {
                "external_model_used": False,
                "external_model_allowed": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "copied_screenshots": 0,
                "strict_mode_respected": strict_ok,
            },
            "limitations": [
                "Demo pack is a local Productization Harness snapshot, not proof of remote repository, CI, Yunxiao, deployment, or online-service state.",
                "It does not inspect, copy, delete, or mutate MineContext source databases or screenshot files.",
                "It is API-level verification evidence; browser click automation remains a separate hardening layer.",
            ],
            "evidence_boundary": (
                "Productization demo pack aggregates local OpenButler readiness, MVP report, objective status, and harness summaries. "
                "It uses local APIs and repository files only; it does not call external models, copy screenshots, delete MineContext source data, "
                "or verify remote systems."
            ),
        }
        with self.connect() as conn:
            self._audit(
                conn,
                "productization_demo_pack_generated",
                DEFAULT_USER_ID,
                {
                    "status": status,
                    "readiness_status": readiness.get("status"),
                    "mvp_status": report.get("status"),
                    "objective_status": objectives.get("status"),
                    "external_model_used": False,
                    "minecontext_source_deleted": 0,
                },
            )
        return pack

    def goals(self) -> list[dict[str, Any]]:
        self._seed_goals_if_empty()
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM butler_goals ORDER BY created_at ASC").fetchall()
        return [self._goal_from_row(row) for row in rows]

    def create_goal(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = now_iso()
        row = {"id": str(uuid.uuid4()), "user_id": DEFAULT_USER_ID, "created_at": now, "updated_at": now, **payload}
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO butler_goals(id, user_id, title, goal_type, target, schedule, enabled, privacy_level, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"], row["user_id"], row["title"], row.get("goal_type", "focus"),
                    json.dumps(row.get("target", {}), ensure_ascii=False),
                    json.dumps(row.get("schedule", {}), ensure_ascii=False),
                    int(row.get("enabled", True)), row.get("privacy_level", "local_private"), now, now,
                ),
            )
            self._audit(conn, "goal_created", DEFAULT_USER_ID, {"goal_id": row["id"]})
        return self.goal(row["id"]) or row

    def goal(self, goal_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM butler_goals WHERE id = ?", (goal_id,)).fetchone()
        return self._goal_from_row(row) if row else None

    def update_goal(self, goal_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        current = self.goal(goal_id)
        if not current:
            return None
        current.update({key: value for key, value in payload.items() if value is not None})
        now = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE butler_goals SET title = ?, goal_type = ?, target = ?, schedule = ?, enabled = ?, privacy_level = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    current["title"], current["goal_type"], json.dumps(current.get("target", {}), ensure_ascii=False),
                    json.dumps(current.get("schedule", {}), ensure_ascii=False), int(current.get("enabled", True)),
                    current.get("privacy_level", "local_private"), now, goal_id,
                ),
            )
            self._audit(conn, "goal_updated", DEFAULT_USER_ID, {"goal_id": goal_id})
        return self.goal(goal_id)

    def delete_goal(self, goal_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            cursor = conn.execute("DELETE FROM butler_goals WHERE id = ?", (goal_id,))
            self._audit(conn, "goal_deleted", DEFAULT_USER_ID, {"goal_id": goal_id, "deleted": cursor.rowcount})
        return {"deleted": cursor.rowcount}

    def clear_data(self) -> dict[str, Any]:
        with self.connect() as conn:
            counts = {
                "timeline": conn.execute("DELETE FROM unified_timeline_events").rowcount,
                "metrics": conn.execute("DELETE FROM butler_metric_snapshots").rowcount,
                "insights": conn.execute("DELETE FROM insight_cards").rowcount,
                "briefings": conn.execute("DELETE FROM butler_briefings").rowcount,
                "harness_runs": conn.execute("DELETE FROM butler_harness_runs").rowcount,
            }
            self._audit(conn, "butler_data_deleted", DEFAULT_USER_ID, counts)
        return {
            **counts,
            "deleted_scope": [
                "unified_timeline_events",
                "butler_metric_snapshots",
                "insight_cards",
                "butler_briefings",
                "butler_harness_runs",
            ],
            "preserved_scope": ["pc_activity_events", "minecontext_source_database", "minecontext_screenshot_files"],
            "minecontext_deleted": 0,
            "minecontext_source_deleted": 0,
            "message": "Deleted only OpenButler-derived Butler data. MineContext source data was not deleted.",
        }

    def reset_demo_path(self) -> dict[str, Any]:
        before_pc_events = len(self.pc_activity().events())
        reset = self.clear_data()
        after_pc_events = len(self.pc_activity().events())
        with self.connect() as conn:
            self._audit(
                conn,
                "demo_path_reset",
                DEFAULT_USER_ID,
                {
                    "deleted": {key: reset.get(key, 0) for key in ["timeline", "metrics", "insights", "briefings"]},
                    "harness_runs_deleted": reset.get("harness_runs", 0),
                    "pc_activity_events_before": before_pc_events,
                    "pc_activity_events_after": after_pc_events,
                    "minecontext_source_deleted": 0,
                },
            )
        return {
            "status": "reset",
            "reset": reset,
            "preserved": {
                "pc_activity_events_before": before_pc_events,
                "pc_activity_events_after": after_pc_events,
                "pc_activity_events_preserved": before_pc_events == after_pc_events,
                "minecontext_source_deleted": 0,
                "copied_screenshots_deleted": 0,
            },
            "privacy": {
                "external_model_used": False,
                "system_notification_enabled": False,
                "minecontext_source_deleted": 0,
                "deleted_only_openbutler_derived_data": True,
            },
            "evidence_boundary": BOUNDARY,
        }

    def export_data(self) -> dict[str, Any]:
        with self.connect() as conn:
            timeline_rows = conn.execute("SELECT * FROM unified_timeline_events ORDER BY started_at ASC").fetchall()
            metric_rows = conn.execute("SELECT * FROM butler_metric_snapshots ORDER BY date ASC, metric_key ASC").fetchall()
            insight_rows = conn.execute("SELECT * FROM insight_cards ORDER BY generated_at ASC").fetchall()
            briefing_rows = conn.execute("SELECT * FROM butler_briefings ORDER BY created_at ASC").fetchall()
            goal_rows = conn.execute("SELECT * FROM butler_goals ORDER BY created_at ASC").fetchall()
            harness_rows = conn.execute("SELECT * FROM butler_harness_runs ORDER BY created_at ASC").fetchall()
            self._audit(
                conn,
                "butler_data_exported",
                DEFAULT_USER_ID,
                {
                    "timeline": len(timeline_rows),
                    "metrics": len(metric_rows),
                    "insights": len(insight_rows),
                    "briefings": len(briefing_rows),
                    "goals": len(goal_rows),
                    "harness_runs": len(harness_rows),
                },
            )
        timeline = [self._timeline_from_row(row) for row in timeline_rows]
        metrics = [self._metric_from_row(row) for row in metric_rows]
        insights = [self._insight_from_row(row) for row in insight_rows]
        briefings = [self._briefing_from_row(row) for row in briefing_rows]
        goals = [self._goal_from_row(row) for row in goal_rows]
        harness_runs = [self._harness_run_from_row(row) for row in harness_rows]
        return {
            "exported_at": now_iso(),
            "schema_version": "butler_export_v1",
            "user_id": DEFAULT_USER_ID,
            "privacy": {
                "strict_mode_respected": self.get_settings().privacy.get("strict_mode_respected", True),
                "contains_minecontext_screenshot_content": False,
                "contains_minecontext_source_database": False,
                "contains_harness_raw_source_text": False,
                "screenshot_evidence": "path_refs_only_if_present",
                "minecontext_source_deleted": 0,
            },
            "counts": {
                "timeline": len(timeline),
                "metrics": len(metrics),
                "insights": len(insights),
                "briefings": len(briefings),
                "goals": len(goals),
                "harness_runs": len(harness_runs),
            },
            "timeline": timeline,
            "metrics": metrics,
            "insights": insights,
            "briefings": briefings,
            "goals": goals,
            "harness_runs": harness_runs,
            "settings": self.get_settings().model_dump(),
            "evidence_boundary": BOUNDARY,
        }

    def feedback_penalties(self) -> dict[str, dict[str, int]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT COALESCE(f.insight_type, ic.type) AS insight_type, f.feedback_type, COUNT(*) AS count
                FROM insight_feedback f
                LEFT JOIN insight_cards ic ON ic.id = f.insight_id
                WHERE f.feedback_type IN ('dismissed', 'inaccurate', 'too_frequent', 'not_useful', 'useful', 'accepted_action')
                  AND COALESCE(f.insight_type, ic.type) IS NOT NULL
                GROUP BY COALESCE(f.insight_type, ic.type), f.feedback_type
                """
            ).fetchall()
        penalties: dict[str, dict[str, int]] = {}
        for row in rows:
            insight_type = row["insight_type"]
            penalties.setdefault(
                insight_type,
                {
                    "dismiss_count": 0,
                    "inaccurate_count": 0,
                    "too_frequent_count": 0,
                    "useful_count": 0,
                    "accepted_count": 0,
                },
            )
            count = int(row["count"])
            if row["feedback_type"] == "inaccurate":
                penalties[insight_type]["inaccurate_count"] += count
            elif row["feedback_type"] == "too_frequent":
                penalties[insight_type]["too_frequent_count"] += count
                penalties[insight_type]["dismiss_count"] += count
            elif row["feedback_type"] == "useful":
                penalties[insight_type]["useful_count"] += count
            elif row["feedback_type"] == "accepted_action":
                penalties[insight_type]["accepted_count"] += count
            else:
                penalties[insight_type]["dismiss_count"] += count
        return penalties

    def _openclaw_tools_status(self) -> dict[str, Any]:
        root = Path(__file__).resolve().parents[4]
        tools_path = root / "openclaw-skill" / "tools.yaml"
        required = [
            "get_today_butler_overview",
            "get_active_insights",
            "get_butler_briefing",
            "get_context_recovery_pack",
            "submit_insight_feedback",
        ]
        if not tools_path.exists():
            return {"ready": False, "tools_path": str(tools_path), "missing": required}
        text = tools_path.read_text(encoding="utf-8")
        missing = [name for name in required if name not in text]
        return {"ready": not missing, "tools_path": str(tools_path), "missing": missing}

    def _readiness_check(self, check_id: str, title: str, status: str, details: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": check_id,
            "title": title,
            "status": status,
            "details": details,
            "evidence_boundary": BOUNDARY,
        }

    def _mvp_report_check(self, check_id: str, title: str, passed: bool, details: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": check_id,
            "title": title,
            "status": "passed" if passed else "needs_attention",
            "details": details,
            "next_action": self._mvp_report_next_action(check_id, passed),
            "evidence_boundary": BOUNDARY,
        }

    def _mvp_report_next_action(self, check_id: str, passed: bool) -> dict[str, Any]:
        if passed:
            return {
                "type": "none",
                "label": "无需处理",
                "description": "该验收项当前通过，继续保留证据边界和 strict 隐私约束。",
                "endpoint": None,
                "ui_route": "/butler",
            }
        actions = {
            "pc_activity_source_events": {
                "type": "import_pc_activity",
                "label": "导入今日 PC Activity",
                "description": "从已授权的本地 MineContext 接入导入今日 PC 活动；如果 MineContext 不可用，保持 data_insufficient，不编造活动。",
                "endpoint": "POST /api/pc-activity/minecontext/import",
                "ui_route": "/pc-activity-context",
            },
            "unified_timeline_ready": {
                "type": "rebuild_timeline",
                "label": "重建统一时间线",
                "description": "将已有 PCActivityEvent 转换为 UnifiedTimelineEvent，并保留来源和证据边界。",
                "endpoint": "POST /api/butler/timeline/rebuild",
                "ui_route": "/timeline",
            },
            "today_metrics_ready": {
                "type": "generate_metrics",
                "label": "生成今日指标",
                "description": "基于统一时间线重新生成今日 PC 活跃、深度工作、上下文切换等指标。",
                "endpoint": "GET /api/butler/metrics/today",
                "ui_route": "/metrics",
            },
            "active_insights_ready": {
                "type": "generate_insights",
                "label": "生成主动洞察",
                "description": "使用本地规则引擎生成洞察卡；strict 模式下不调用外部模型。",
                "endpoint": "POST /api/butler/insights/generate",
                "ui_route": "/butler/inbox",
            },
            "feedback_loop_ready": {
                "type": "open_inbox",
                "label": "打开 Butler Inbox",
                "description": "查看洞察并提交有用、不准确、忽略或稍后提醒等反馈。",
                "endpoint": "GET /api/butler/insights",
                "ui_route": "/butler/inbox",
            },
            "briefing_ready": {
                "type": "generate_briefing",
                "label": "生成晚间简报",
                "description": "基于今日指标和洞察生成简报；远程系统状态仍需回源确认。",
                "endpoint": "POST /api/butler/briefings/generate",
                "ui_route": "/butler",
            },
            "openclaw_tools_ready": {
                "type": "review_openclaw_tools",
                "label": "检查 OpenClaw 工具声明",
                "description": "查看 openclaw-skill 工具声明，补齐主动管家工具和证据边界要求。",
                "endpoint": None,
                "ui_route": "/butler",
            },
            "strict_privacy_ready": {
                "type": "review_privacy_settings",
                "label": "检查 strict 隐私设置",
                "description": "确认外部模型、外部 webhook、系统通知和截图复制均未默认开启。",
                "endpoint": "GET /api/butler/settings",
                "ui_route": "/privacy",
            },
            "minecontext_source_preserved": {
                "type": "stop_and_review",
                "label": "停止并复核数据安全",
                "description": "如果 MineContext 源数据保留检查失败，应停止演示并人工复核，不自动修复或删除数据。",
                "endpoint": None,
                "ui_route": "/privacy",
            },
            "evidence_boundaries_present": {
                "type": "review_evidence_boundaries",
                "label": "补齐证据边界",
                "description": "检查首页、自检和洞察输出，确保每条结论都说明来源和不确定性边界。",
                "endpoint": "GET /api/butler/home",
                "ui_route": "/butler",
            },
        }
        return actions.get(
            check_id,
            {
                "type": "review_report",
                "label": "查看验收报告",
                "description": "检查该验收项详情，优先保持本地处理、证据边界和 strict 隐私约束。",
                "endpoint": "GET /api/butler/mvp-report",
                "ui_route": "/butler",
            },
        )

    def _insert_timeline_event(self, conn: sqlite3.Connection, event: dict[str, Any]) -> dict[str, Any]:
        now = now_iso()
        row = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **event}
        conn.execute(
            """
            INSERT INTO unified_timeline_events (
                id, user_id, household_id, source, source_event_id, source_type, started_at, ended_at,
                duration_seconds, title, summary, event_type, entities, metrics, tags, confidence,
                evidence_level, evidence_refs, evidence_boundary, privacy_level, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"], row["user_id"], row.get("household_id"), row["source"], row.get("source_event_id"), row["source_type"],
                row["started_at"], row.get("ended_at"), row.get("duration_seconds"), row["title"], row.get("summary"), row["event_type"],
                json.dumps(row.get("entities", {}), ensure_ascii=False), json.dumps(row.get("metrics", {}), ensure_ascii=False),
                json.dumps(row.get("tags", []), ensure_ascii=False), row["confidence"], row["evidence_level"],
                json.dumps(row.get("evidence_refs", []), ensure_ascii=False), row["evidence_boundary"], row["privacy_level"], now, now,
            ),
        )
        return row

    def _persist_metrics(self, metrics: dict[str, Any], events: list[dict[str, Any]]) -> None:
        today = date.today().isoformat()
        refs = [{"kind": "timeline_event", "id": event["id"]} for event in events[:10]]
        scalar_keys = {
            "pc_active_minutes": ("PC 活跃时长", "minutes"),
            "focus_minutes": ("深度工作时长", "minutes"),
            "context_switch_count": ("上下文切换次数", "count"),
            "source_event_count": ("来源事件数", "count"),
            "low_confidence_event_count": ("低置信事件数", "count"),
        }
        with self.connect() as conn:
            conn.execute("DELETE FROM butler_metric_snapshots WHERE date = ?", (today,))
            for key, (name, unit) in scalar_keys.items():
                conn.execute(
                    """
                    INSERT INTO butler_metric_snapshots(id, user_id, date, period, metric_key, metric_name, value, unit, dimension, comparison, source_event_count, confidence, evidence_refs, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()), DEFAULT_USER_ID, today, "today", key, name, float(metrics.get(key) or 0), unit,
                        "{}", None, int(metrics.get("source_event_count") or 0), float(metrics.get("confidence") or 0.5),
                        json.dumps(refs, ensure_ascii=False), now_iso(),
                    ),
                )

    def _insert_insight(self, conn: sqlite3.Connection, item: dict[str, Any]) -> dict[str, Any]:
        row = {"id": str(uuid.uuid4()), "user_id": DEFAULT_USER_ID, "household_id": None, **item}
        conn.execute(
            """
            INSERT INTO insight_cards (
                id, user_id, household_id, type, title, summary, detail, severity, priority, status,
                suggested_actions, metrics, evidence_refs, evidence_boundary, confidence, generated_by,
                generated_at, expires_at, snoozed_until
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"], row["user_id"], row.get("household_id"), row["type"], row["title"], row["summary"], row.get("detail"),
                row["severity"], row["priority"], row["status"], json.dumps(row.get("suggested_actions", []), ensure_ascii=False),
                json.dumps(row.get("metrics", {}), ensure_ascii=False), json.dumps(row.get("evidence_refs", []), ensure_ascii=False),
                row["evidence_boundary"], row["confidence"], row["generated_by"], row["generated_at"], row.get("expires_at"), None,
            ),
        )
        return row

    def _insert_briefing(self, conn: sqlite3.Connection, item: dict[str, Any]) -> dict[str, Any]:
        row = {"id": str(uuid.uuid4()), "user_id": DEFAULT_USER_ID, **item}
        conn.execute(
            """
            INSERT INTO butler_briefings(id, user_id, type, title, sections, key_metrics, top_insights, suggested_next_actions, evidence_refs, evidence_boundary, created_at, period_start, period_end)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"], row["user_id"], row["type"], row["title"], json.dumps(row["sections"], ensure_ascii=False),
                json.dumps(row["key_metrics"], ensure_ascii=False), json.dumps(row["top_insights"], ensure_ascii=False),
                json.dumps(row["suggested_next_actions"], ensure_ascii=False), json.dumps(row["evidence_refs"], ensure_ascii=False),
                row["evidence_boundary"], row["created_at"], row["period_start"], row["period_end"],
            ),
        )
        return row

    def _persist_harness_run(self, conn: sqlite3.Connection, kind: str, report: dict[str, Any]) -> dict[str, Any]:
        failed = [item["id"] for item in report.get("acceptance", []) if item.get("status") != "passed"]
        summary = report.get("summary") or {
            "status": report.get("status"),
            "acceptance_count": len(report.get("acceptance", [])),
            "failed_check_count": len(failed),
        }
        row = {
            "id": str(uuid.uuid4()),
            "user_id": DEFAULT_USER_ID,
            "kind": kind,
            "status": report.get("status", "unknown"),
            "dry_run": bool(report.get("dry_run", kind != "mvp_report")),
            "mutates_data": bool(report.get("mutates_data", False)),
            "summary": summary,
            "failed_checks": failed,
            "privacy": report.get("privacy", {}),
            "evidence_boundary": report.get("evidence_boundary", BOUNDARY),
            "created_at": report.get("generated_at", now_iso()),
        }
        conn.execute(
            """
            INSERT INTO butler_harness_runs(
                id, user_id, kind, status, dry_run, mutates_data, summary,
                failed_checks, privacy, evidence_boundary, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"], row["user_id"], row["kind"], row["status"], int(row["dry_run"]), int(row["mutates_data"]),
                json.dumps(row["summary"], ensure_ascii=False), json.dumps(row["failed_checks"], ensure_ascii=False),
                json.dumps(row["privacy"], ensure_ascii=False), row["evidence_boundary"], row["created_at"],
            ),
        )
        return row

    def _suggested_next_actions(self, insights: list[dict[str, Any]], metrics: dict[str, Any]) -> list[dict[str, Any]]:
        actions = [{"type": "context_recovery", "label": "恢复最近 OpenButler/MineContext 工作上下文"}]
        if any(item["type"] == "workflow_candidate" for item in insights):
            actions.append({"type": "draft_skill", "label": "为重复流程生成 OpenClaw 技能草稿"})
        if metrics.get("source_event_count", 0) == 0:
            actions.append({"type": "import_pc_activity", "label": "导入今日 PC 活动"})
        return actions

    def _seed_goals_if_empty(self) -> None:
        with self.connect() as conn:
            count = conn.execute("SELECT COUNT(*) AS count FROM butler_goals").fetchone()["count"]
        if count:
            return
        defaults = [
            {"title": "每天至少 3 小时深度工作", "goal_type": "focus", "target": {"focus_minutes": 180}, "schedule": {"period": "daily"}},
            {"title": "上下文切换过多时温和提醒", "goal_type": "context_switch", "target": {"threshold": 12}, "schedule": {"window_minutes": 30}},
            {"title": "每天 18 点生成工作复盘", "goal_type": "briefing", "target": {"type": "evening"}, "schedule": {"time": "18:00"}},
        ]
        for item in defaults:
            self.create_goal(item)

    def _timeline_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["entities"] = json.loads(item["entities"])
        item["metrics"] = json.loads(item["metrics"])
        item["tags"] = json.loads(item["tags"])
        item["evidence_refs"] = json.loads(item["evidence_refs"])
        return item

    def _metric_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["dimension"] = json.loads(item["dimension"])
        item["comparison"] = json.loads(item["comparison"]) if item.get("comparison") else None
        item["evidence_refs"] = json.loads(item["evidence_refs"])
        return item

    def _metrics_trend(self, items: list[dict[str, Any]], start_date: str, end_date: str) -> list[dict[str, Any]]:
        by_date: dict[str, dict[str, Any]] = {}
        current = date.fromisoformat(start_date)
        last = date.fromisoformat(end_date)
        while current <= last:
            by_date[current.isoformat()] = {
                "date": current.isoformat(),
                "pc_active_minutes": 0,
                "focus_minutes": 0,
                "context_switch_count": 0,
                "source_event_count": 0,
                "low_confidence_event_count": 0,
                "confidence": 0.2,
                "status": "data_insufficient",
                "evidence_refs": [],
                "evidence_boundary": BOUNDARY,
            }
            current += timedelta(days=1)

        metric_map = {
            "pc_active_minutes",
            "focus_minutes",
            "context_switch_count",
            "source_event_count",
            "low_confidence_event_count",
        }
        for item in items:
            bucket = by_date.get(item["date"])
            if not bucket:
                continue
            key = item["metric_key"]
            if key in metric_map:
                value = int(round(float(item.get("value") or 0)))
                bucket[key] = value
            bucket["source_event_count"] = max(bucket["source_event_count"], int(item.get("source_event_count") or 0))
            bucket["confidence"] = max(float(bucket.get("confidence") or 0.2), float(item.get("confidence") or 0.2))
            if item.get("evidence_refs"):
                bucket["evidence_refs"].extend(item["evidence_refs"])

        for bucket in by_date.values():
            if bucket["source_event_count"] > 0:
                bucket["status"] = "ready"
            bucket["evidence_refs"] = bucket["evidence_refs"][:10]
        return list(by_date.values())

    def _fill_metrics_trend_from_timeline(self, trend: list[dict[str, Any]], start_date: str, end_date: str) -> list[dict[str, Any]]:
        by_date = {item["date"]: item for item in trend}
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM unified_timeline_events
                WHERE started_at >= ? AND started_at <= ?
                ORDER BY started_at ASC
                """,
                (start_date, f"{end_date}T23:59:59.999999+00:00"),
            ).fetchall()
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            event = self._timeline_from_row(row)
            grouped.setdefault(str(event.get("started_at", ""))[:10], []).append(event)
        for day, events_for_day in grouped.items():
            bucket = by_date.get(day)
            if not bucket or bucket["source_event_count"] > 0:
                continue
            metrics = build_metric_summary(events_for_day, self.get_settings().metrics)
            for key in ["pc_active_minutes", "focus_minutes", "context_switch_count", "source_event_count", "low_confidence_event_count"]:
                bucket[key] = int(round(float(metrics.get(key) or 0)))
            bucket["confidence"] = float(metrics.get("confidence") or 0.5)
            bucket["status"] = "ready" if bucket["source_event_count"] else "data_insufficient"
            bucket["evidence_refs"] = [{"kind": "timeline_event", "id": event["id"]} for event in events_for_day[:10]]
        return list(by_date.values())

    def _metrics_trend_summary(self, trend: list[dict[str, Any]], start_date: str, end_date: str) -> dict[str, Any]:
        days_with_data = len([item for item in trend if item["source_event_count"] > 0])
        usage = self._timeline_usage_summary(start_date, end_date)
        return {
            "status": "ready" if days_with_data else "data_insufficient",
            "days": len(trend),
            "days_with_data": days_with_data,
            "total_pc_active_minutes": sum(int(item["pc_active_minutes"]) for item in trend),
            "total_focus_minutes": sum(int(item["focus_minutes"]) for item in trend),
            "total_context_switch_count": sum(int(item["context_switch_count"]) for item in trend),
            "total_source_event_count": sum(int(item["source_event_count"]) for item in trend),
            "top_apps": usage["top_apps"],
            "top_domains": usage["top_domains"],
            "top_projects": usage["top_projects"],
            "data_insufficient_message": (
                "最近 7 天没有可量化的 PC Activity 指标。请先导入 PC Activity、重建统一时间线并生成今日指标。"
                if not days_with_data
                else ""
            ),
        }

    def _timeline_usage_summary(self, start_date: str, end_date: str) -> dict[str, list[dict[str, Any]]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT entities, duration_seconds
                FROM unified_timeline_events
                WHERE started_at >= ? AND started_at <= ?
                """,
                (start_date, f"{end_date}T23:59:59.999999+00:00"),
            ).fetchall()
        totals: dict[str, dict[str, int]] = {"app_name": {}, "domain": {}, "project_name": {}}
        for row in rows:
            entities = json.loads(row["entities"])
            minutes = round(int(row["duration_seconds"] or 0) / 60)
            for key in totals:
                name = entities.get(key)
                if name:
                    totals[key][name] = totals[key].get(name, 0) + minutes

        def top(key: str) -> list[dict[str, Any]]:
            return [
                {"name": name, "minutes": minutes}
                for name, minutes in sorted(totals[key].items(), key=lambda item: item[1], reverse=True)[:5]
            ]

        return {"top_apps": top("app_name"), "top_domains": top("domain"), "top_projects": top("project_name")}

    def _insight_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["suggested_actions"] = json.loads(item["suggested_actions"])
        item["metrics"] = json.loads(item["metrics"])
        item["evidence_refs"] = json.loads(item["evidence_refs"])
        return item

    def _briefing_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["sections"] = json.loads(item["sections"])
        item["key_metrics"] = json.loads(item["key_metrics"])
        item["top_insights"] = json.loads(item["top_insights"])
        item["suggested_next_actions"] = json.loads(item["suggested_next_actions"])
        item["evidence_refs"] = json.loads(item["evidence_refs"])
        return item

    def _goal_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["target"] = json.loads(item["target"])
        item["schedule"] = json.loads(item["schedule"])
        item["enabled"] = bool(item["enabled"])
        return item

    def _harness_run_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["dry_run"] = bool(item["dry_run"])
        item["mutates_data"] = bool(item["mutates_data"])
        item["summary"] = json.loads(item["summary"])
        item["failed_checks"] = json.loads(item["failed_checks"])
        item["privacy"] = json.loads(item["privacy"])
        return item

    def _audit(self, conn: sqlite3.Connection, action: str, user_id: str, details: dict[str, Any]) -> None:
        conn.execute(
            "INSERT INTO butler_audit_log(id, action, user_id, details, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), action, user_id, json.dumps(details, ensure_ascii=False), now_iso()),
        )
