from __future__ import annotations

import json
import sqlite3
import uuid
import hashlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.integrations.minecontext import MineContextAdapter
from app.integrations.minecontext.config import MineContextSettings
from app.integrations.minecontext.errors import MineContextError
from app.integrations.minecontext.normalizer import pc_event_from_activity, redact_sensitive_text

from .schemas import PCActivitySettings
from .timeline.activity_timeline import app_usage, domain_usage, focus_blocks
from .timeline.project_switching import context_switch_count
from .timeline.workflow_patterns import workflow_candidates

DEFAULT_USER_ID = "demo-user"


class AutoClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        should_suppress = super().__exit__(exc_type, exc_value, traceback)
        self.close()
        return should_suppress


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_event_fingerprint(event: dict[str, Any]) -> str:
    payload = {
        "source": event.get("source"),
        "started_at": event.get("started_at"),
        "ended_at": event.get("ended_at"),
        "title": event.get("title"),
        "app_name": event.get("app_name"),
        "window_title": event.get("window_title"),
        "url": event.get("url"),
        "domain": event.get("domain"),
        "project_name": event.get("project_name"),
        "repo_name": event.get("repo_name"),
        "activity_type": event.get("activity_type"),
        "duration_seconds": event.get("duration_seconds"),
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return f"pcact_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]}"


def init_pc_activity_context_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS pc_activity_events (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            household_id TEXT,
            source TEXT NOT NULL,
            source_activity_id TEXT,
            source_context_id TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_seconds INTEGER,
            title TEXT,
            summary TEXT,
            app_name TEXT,
            window_title TEXT,
            url TEXT,
            domain TEXT,
            project_name TEXT,
            repo_name TEXT,
            document_name TEXT,
            activity_type TEXT NOT NULL,
            confidence REAL NOT NULL,
            evidence_level TEXT NOT NULL,
            evidence TEXT NOT NULL,
            screenshot_paths TEXT NOT NULL,
            raw_ref TEXT,
            source_fingerprint TEXT,
            privacy_level TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pc_activity_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            user_id TEXT NOT NULL,
            details TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO settings(key, value) VALUES('pc_activity_context_settings', ?)",
        (PCActivitySettings().model_dump_json(),),
    )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(pc_activity_events)").fetchall()}
    if "source_fingerprint" not in columns:
        conn.execute("ALTER TABLE pc_activity_events ADD COLUMN source_fingerprint TEXT")


class PCActivityContextService:
    def __init__(self, db_path: Path | str, runtime_dir: Path | str) -> None:
        self.db_path = Path(db_path)
        self.runtime_dir = Path(runtime_dir)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, factory=AutoClosingConnection)
        conn.row_factory = sqlite3.Row
        return conn

    def get_settings(self) -> PCActivitySettings:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = 'pc_activity_context_settings'").fetchone()
        if not row:
            return PCActivitySettings()
        return PCActivitySettings.model_validate_json(row["value"])

    def update_settings(self, payload: dict[str, Any]) -> PCActivitySettings:
        current = self.get_settings().model_dump()
        current.update(payload)
        settings = PCActivitySettings.model_validate(current)
        if settings.privacy_mode == "strict":
            settings.minecontext.external_model_allowed = False
            settings.minecontext.copy_screenshot_evidence = False
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO settings(key, value)
                VALUES('pc_activity_context_settings', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (settings.model_dump_json(),),
            )
            self._audit(conn, "settings_updated", DEFAULT_USER_ID, {"enabled": settings.enabled})
        return settings

    def adapter(self) -> MineContextAdapter:
        return MineContextAdapter(self.get_settings().minecontext, self.runtime_dir)

    def status(self) -> dict[str, Any]:
        settings = self.get_settings()
        health = self.adapter().health_check()
        latest_query = self._latest_audit("query_at_time")
        latest_import = self._latest_audit("import_completed")
        return {
            "enabled": settings.enabled,
            "privacy_mode": settings.privacy_mode,
            "read_only": settings.minecontext.read_only,
            "store_screenshot_paths": settings.minecontext.store_screenshot_paths,
            "copy_screenshot_evidence": settings.minecontext.copy_screenshot_evidence,
            "minecontext": health.model_dump(),
            "last_successful_query_at": latest_query,
            "last_import_at": latest_import,
            "safe_notice": "MineContext 是本地观察线索来源，不是远程系统最终事实来源。",
        }

    def query_at_time(self, when: str, window_minutes: int, include_raw_output: bool = False) -> dict[str, Any]:
        try:
            result = self.adapter().query_at_time(when, window_minutes, include_raw_output and self.get_settings().minecontext.include_raw_output)
            output = result.model_dump()
            if not self.get_settings().minecontext.store_screenshot_paths:
                output["screenshot_paths"] = []
            with self.connect() as conn:
                self._audit(conn, "query_at_time", DEFAULT_USER_ID, {"when": when, "can_confirm": output["can_confirm"]})
            return output
        except MineContextError as exc:
            with self.connect() as conn:
                self._audit(conn, "query_failed", DEFAULT_USER_ID, {"when": when, "error": str(exc)})
            return self._unavailable_query(str(exc))

    def search(self, query: str, limit: int = 20, include_raw_output: bool = False) -> dict[str, Any]:
        try:
            results = [item.model_dump() for item in self.adapter().search(query, limit, include_raw_output)]
            if not self.get_settings().minecontext.store_screenshot_paths:
                for item in results:
                    item["screenshot_paths"] = []
            with self.connect() as conn:
                self._audit(conn, "search", DEFAULT_USER_ID, {"query": query, "count": len(results)})
            return {"items": results, "count": len(results), "query": query}
        except MineContextError as exc:
            with self.connect() as conn:
                self._audit(conn, "search_failed", DEFAULT_USER_ID, {"query": query, "error": str(exc)})
            return {"items": [], "count": 0, "query": query, "error": str(exc), "evidence_boundary": "MineContext 不可用，无法客观确认。"}

    def import_activities(self, start_time: datetime, end_time: datetime, limit: int) -> dict[str, Any]:
        activities = self.adapter().export_recent_activities(start_time, end_time, limit)
        created: list[dict[str, Any]] = []
        for activity in activities:
            event = pc_event_from_activity(activity, DEFAULT_USER_ID)
            if not self.get_settings().minecontext.store_screenshot_paths:
                event["screenshot_paths"] = []
            created.append(self.create_event(event))
        with self.connect() as conn:
            self._audit(conn, "import_completed", DEFAULT_USER_ID, {"created": len(created), "start_time": start_time.isoformat(), "end_time": end_time.isoformat()})
        return {"created": created, "count": len(created), "read_only": True, "copied_screenshots": 0}

    def preview_import_activities(
        self,
        start_time: datetime,
        end_time: datetime,
        limit: int,
        include_screenshot_paths: bool = True,
        copy_screenshots: bool = False,
    ) -> dict[str, Any]:
        settings = self.get_settings()
        effective_copy_screenshots = bool(copy_screenshots and settings.privacy_mode != "strict")
        warnings = [
            "dry-run 预览不会写入 OpenButler 数据库",
            "不会修改 MineContext 原始数据",
            "不会调用外部模型",
        ]
        if settings.privacy_mode == "strict":
            warnings.append("strict 模式下禁止外部模型、外部 webhook 和截图复制")
        if not effective_copy_screenshots:
            warnings.append("不会复制截图文件")
        try:
            activities = self.adapter().export_recent_activities(start_time, end_time, limit)
            adapter_error = None
        except Exception as exc:
            activities = []
            adapter_error = f"{exc.__class__.__name__}: {exc}"
            warnings.append("MineContext 当前不可用或 schema 不匹配，无法估算真实来源事件数")

        source_ids = [item.source_activity_id for item in activities if item.source_activity_id]
        fingerprints = [
            stable_event_fingerprint(pc_event_from_activity(item, DEFAULT_USER_ID))
            for item in activities
            if not item.source_activity_id
        ]
        existing_ids: set[str] = set()
        if source_ids:
            placeholders = ",".join("?" for _ in source_ids)
            with self.connect() as conn:
                rows = conn.execute(
                    f"""
                    SELECT source_activity_id
                    FROM pc_activity_events
                    WHERE source = 'minecontext'
                      AND source_activity_id IN ({placeholders})
                    """,
                    tuple(source_ids),
                ).fetchall()
            existing_ids = {str(row["source_activity_id"]) for row in rows if row["source_activity_id"]}
        existing_fingerprints: set[str] = set()
        if fingerprints:
            placeholders = ",".join("?" for _ in fingerprints)
            with self.connect() as conn:
                rows = conn.execute(
                    f"""
                    SELECT source_fingerprint
                    FROM pc_activity_events
                    WHERE source = 'minecontext'
                      AND source_fingerprint IN ({placeholders})
                    """,
                    tuple(fingerprints),
                ).fetchall()
            existing_fingerprints = {str(row["source_fingerprint"]) for row in rows if row["source_fingerprint"]}

        duplicate_count = len([source_id for source_id in source_ids if source_id in existing_ids])
        duplicate_count += len([fingerprint for fingerprint in fingerprints if fingerprint in existing_fingerprints])
        new_count = max(0, len(activities) - duplicate_count)
        screenshot_path_count = 0
        if include_screenshot_paths and settings.minecontext.store_screenshot_paths:
            for activity in activities:
                for resource in activity.resources:
                    value = str(resource.get("path") or resource.get("uri") or "")
                    if value:
                        screenshot_path_count += 1
        return {
            "dry_run": True,
            "source": "minecontext",
            "time_range": {
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            },
            "estimated_source_events": len(activities),
            "estimated_new_events": new_count,
            "estimated_duplicate_events": duplicate_count,
            "duplicate_detection": {
                "source_activity_id_matches": len([source_id for source_id in source_ids if source_id in existing_ids]),
                "stable_fingerprint_matches": len([fingerprint for fingerprint in fingerprints if fingerprint in existing_fingerprints]),
            },
            "limit": limit,
            "screenshot_paths_included": bool(include_screenshot_paths and settings.minecontext.store_screenshot_paths),
            "estimated_screenshot_path_count": screenshot_path_count,
            "screenshots_copied": False,
            "copy_screenshots_requested": bool(copy_screenshots),
            "copy_screenshots_effective": effective_copy_screenshots,
            "privacy_mode": settings.privacy_mode,
            "read_only": True,
            "mutates_openbutler_db": False,
            "minecontext_source_mutated": False,
            "external_model_used": False,
            "external_webhook_used": False,
            "warnings": warnings,
            "adapter_error": adapter_error,
            "evidence_boundary": "该预览只读取 MineContext 本地活动索引并估算导入数量；不会确认远程仓库、云效任务、部署或线上服务的实时状态。",
        }

    def create_event(self, event: dict[str, Any]) -> dict[str, Any]:
        now = now_iso()
        row = {
            "id": str(uuid.uuid4()),
            "created_at": now,
            "updated_at": now,
            **event,
        }
        row["source_fingerprint"] = row.get("source_fingerprint") or stable_event_fingerprint(row)
        with self.connect() as conn:
            source_activity_id = row.get("source_activity_id")
            if source_activity_id:
                existing = conn.execute(
                    "SELECT id FROM pc_activity_events WHERE source = ? AND source_activity_id = ?",
                    (row["source"], source_activity_id),
                ).fetchone()
            else:
                existing = conn.execute(
                    "SELECT id FROM pc_activity_events WHERE source = ? AND source_fingerprint = ?",
                    (row["source"], row["source_fingerprint"]),
                ).fetchone()
            if existing:
                return self.get_event(existing["id"]) or row
            conn.execute(
                """
                INSERT INTO pc_activity_events (
                    id, user_id, household_id, source, source_activity_id, source_context_id,
                    started_at, ended_at, duration_seconds, title, summary, app_name, window_title,
                    url, domain, project_name, repo_name, document_name, activity_type, confidence,
                    evidence_level, evidence, screenshot_paths, raw_ref, source_fingerprint, privacy_level, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"], row["user_id"], row.get("household_id"), row["source"], row.get("source_activity_id"), row.get("source_context_id"),
                    row["started_at"], row.get("ended_at"), row.get("duration_seconds"), row.get("title"), row.get("summary"), row.get("app_name"), row.get("window_title"),
                    row.get("url"), row.get("domain"), row.get("project_name"), row.get("repo_name"), row.get("document_name"), row["activity_type"], row["confidence"],
                    row["evidence_level"], json.dumps(row.get("evidence", {}), ensure_ascii=False), json.dumps(row.get("screenshot_paths", []), ensure_ascii=False),
                    row.get("raw_ref"), row["source_fingerprint"], row.get("privacy_level", "local_sensitive"), row["created_at"], row["updated_at"],
                ),
            )
            self._audit(conn, "event_created", row["user_id"], {"event_id": row["id"], "source_activity_id": row.get("source_activity_id"), "source_fingerprint": row["source_fingerprint"]})
        return row

    def events(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM pc_activity_events ORDER BY started_at DESC").fetchall()
        return [self._event_from_row(row) for row in rows]

    def today_events(self) -> list[dict[str, Any]]:
        today = date.today().isoformat()
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM pc_activity_events WHERE started_at >= ? ORDER BY started_at ASC", (today,)).fetchall()
        return [self._event_from_row(row) for row in rows]

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM pc_activity_events WHERE id = ?", (event_id,)).fetchone()
        return self._event_from_row(row) if row else None

    def summary(self, events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        items = events if events is not None else self.today_events()
        total = sum(int(item.get("duration_seconds") or 0) for item in items)
        focus = focus_blocks(items)
        usage = app_usage(items)
        domains = domain_usage(items)
        workflows = workflow_candidates(items)
        low_conf = len([item for item in items if float(item.get("confidence") or 0) < 0.55])
        return {
            "date": date.today().isoformat(),
            "metrics": {
                "total_pc_active_minutes": round(total / 60),
                "estimated_focus_minutes": round(sum(int(block["duration_seconds"]) for block in focus) / 60),
                "estimated_context_switch_count": context_switch_count(items),
                "source_event_count": len(items),
                "low_confidence_event_count": low_conf,
            },
            "app_usage": usage,
            "domain_usage": domains,
            "project_usage": {},
            "focus_blocks": focus,
            "distraction_candidates": [item for item in items if item.get("activity_type") == "entertainment"][:5],
            "workflow_candidates": workflows,
            "evidence_boundary": "摘要来自已导入 OpenButler 的 MineContext 活动记录；远程系统状态需要回源验证。",
        }

    def clear_events(self) -> dict[str, Any]:
        with self.connect() as conn:
            cursor = conn.execute("DELETE FROM pc_activity_events")
            self._audit(conn, "events_deleted", DEFAULT_USER_ID, {"deleted": cursor.rowcount})
        return {"deleted": cursor.rowcount}

    def context_recovery_pack(self, lookback_hours: int = 24) -> dict[str, Any]:
        since = (datetime.now() - timedelta(hours=lookback_hours)).isoformat()
        items = [event for event in self.events() if event.get("started_at", "") >= since]
        return {"lookback_hours": lookback_hours, "events": items[:20], "summary": self.summary(items), "evidence_boundary": "恢复包只基于本地 OpenButler 已导入事件。"}

    def _unavailable_query(self, error: str) -> dict[str, Any]:
        return {
            "can_confirm": False,
            "confidence": 0.0,
            "time_range": {},
            "activity_ids": [],
            "context_ids": [],
            "summary": "MineContext 当前不可用，无法客观确认该时间点的 PC 操作。",
            "evidence_level": "generated_report",
            "evidence_boundary": f"无法调用 MineContext godview：{error}",
            "screenshot_paths": [],
            "raw_source": "minecontext_godview",
        }

    def _event_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["evidence"] = json.loads(item["evidence"])
        item["screenshot_paths"] = json.loads(item["screenshot_paths"])
        item["title"] = redact_sensitive_text(item.get("title"))
        item["summary"] = redact_sensitive_text(item.get("summary"))
        return item

    def _latest_audit(self, action: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT created_at FROM pc_activity_audit_log WHERE action = ? ORDER BY created_at DESC LIMIT 1",
                (action,),
            ).fetchone()
        return row["created_at"] if row else None

    def _audit(self, conn: sqlite3.Connection, action: str, user_id: str, details: dict[str, Any]) -> None:
        conn.execute(
            "INSERT INTO pc_activity_audit_log(id, action, user_id, details, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), action, user_id, json.dumps(details, ensure_ascii=False), now_iso()),
        )
