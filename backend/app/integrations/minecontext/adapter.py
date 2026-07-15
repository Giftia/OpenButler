from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import MineContextSettings
from .godview_client import MineContextGodviewClient
from .normalizer import parse_dt
from .schemas import MineContextActivity, MineContextGodviewResult, MineContextHealth, MineContextSearchResult


class MineContextAdapter:
    def __init__(self, settings: MineContextSettings, runtime_dir: Path | str) -> None:
        self.settings = settings
        self.client = MineContextGodviewClient(settings, runtime_dir)

    def health_check(self) -> MineContextHealth:
        query_exists = self.settings.query_script_path().exists()
        search_exists = self.settings.search_script_path().exists()
        app_db_exists = self.settings.app_db_path().exists()
        workspace_exists = bool(self.settings.workspace_dir) and Path(self.settings.workspace_dir).exists()
        data_exists = Path(self.settings.data_dir).exists()
        script_available = workspace_exists and query_exists and search_exists
        database_available = data_exists and app_db_exists
        available = script_available or database_available
        capabilities = []
        if query_exists:
            capabilities.append("query_at_time")
        if search_exists:
            capabilities.append("keyword_search")
        if app_db_exists:
            capabilities.append("db_readonly_import")
        return MineContextHealth(
            available=available,
            mode="godview_script" if script_available else "db_readonly" if database_available else "unavailable",
            workspace_dir="configured" if self.settings.workspace_dir else "not_configured",
            data_dir="configured" if self.settings.data_dir else "not_configured",
            query_script_exists=query_exists,
            search_script_exists=search_exists,
            app_db_exists=app_db_exists,
            capabilities=capabilities,
            error=None if available else "MineContext workspace, data directory, or godview scripts are unavailable.",
        )

    def query_at_time(self, when: str, window_minutes: int = 10, include_raw_output: bool = False) -> MineContextGodviewResult:
        return self.client.query_at_time(when, window_minutes, include_raw_output)

    def search(self, query: str, limit: int = 20, include_raw_output: bool = False) -> list[MineContextSearchResult]:
        return self.client.search(query, limit, include_raw_output)

    def export_recent_activities(self, start_time: datetime, end_time: datetime, limit: int = 1000) -> list[MineContextActivity]:
        db_path = self.settings.app_db_path()
        if not db_path.exists():
            return []
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT id, title, content, resources, metadata, start_time, end_time
                FROM activity
                WHERE coalesce(start_time, end_time) >= ?
                  AND coalesce(start_time, end_time) <= ?
                ORDER BY start_time ASC
                LIMIT ?
                """,
                (
                    start_time.strftime("%Y-%m-%d %H:%M:%S"),
                    end_time.strftime("%Y-%m-%d %H:%M:%S"),
                    limit,
                ),
            ).fetchall()
        finally:
            conn.close()
        activities: list[MineContextActivity] = []
        for row in rows:
            resources = row["resources"]
            metadata = row["metadata"]
            try:
                resources = json.loads(resources) if isinstance(resources, str) and resources else []
            except json.JSONDecodeError:
                resources = []
            try:
                metadata = json.loads(metadata) if isinstance(metadata, str) and metadata else {}
            except json.JSONDecodeError:
                metadata = {}
            started = parse_dt(row["start_time"] or row["end_time"])
            if not started:
                continue
            activities.append(
                MineContextActivity(
                    source_activity_id=str(row["id"]),
                    started_at=started,
                    ended_at=parse_dt(row["end_time"]),
                    title=row["title"],
                    summary=row["content"],
                    resources=resources if isinstance(resources, list) else [],
                    metadata=metadata if isinstance(metadata, dict) else {},
                )
            )
        return activities

    def get_observation_pack(self) -> dict[str, Any] | None:
        path = self.settings.observation_pack_path()
        if not path.exists():
            return None
        return {"path": str(path), "text": path.read_text(encoding="utf-8", errors="replace")}
