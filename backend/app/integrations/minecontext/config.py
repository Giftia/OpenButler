from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


DEFAULT_WORKSPACE = Path(
    os.getenv(
        "OPENBUTLER_MINECONTEXT_WORKSPACE",
        r"C:\Users\admin\Documents\Codex\2026-05-21\pc-windows10-minecontext-volcengine-minecontext-https",
    )
)
DEFAULT_HOME = Path(
    os.getenv(
        "OPENBUTLER_MINECONTEXT_HOME",
        str(Path(os.getenv("LOCALAPPDATA", r"C:\Users\admin\AppData\Local")) / "MineContext"),
    )
)


class MineContextSettings(BaseModel):
    enabled: bool = False
    access_mode: Literal["godview_script", "http_api", "db_readonly", "unavailable"] = "godview_script"
    workspace_dir: str = Field(default_factory=lambda: str(DEFAULT_WORKSPACE))
    data_dir: str = Field(default_factory=lambda: str(DEFAULT_HOME))
    query_script: str = r".\tools\run_minecontext_godview_query.ps1"
    search_script: str = r".\tools\run_minecontext_godview_search.ps1"
    default_window_minutes: int = 10
    command_timeout_seconds: int = 30
    read_only: bool = True
    store_screenshot_paths: bool = True
    copy_screenshot_evidence: bool = False
    include_raw_output: bool = False
    redact_sensitive_text: bool = True
    external_model_allowed: bool = False
    derived_event_retention_days: int = 365
    query_log_retention_days: int = 90
    raw_output_retention_days: int = 0
    auto_import_enabled: bool = False
    default_lookback_hours: int = 24
    batch_size: int = 200
    keyword_aliases: dict[str, list[str]] = Field(
        default_factory=lambda: {
            "小红书": ["小红书", "XHS", "Rednote", "xiaohongshu", "xhslink", "红书"],
            "云效": ["云效", "Yunxiao", "devops.aliyun"],
            "GitHub": ["GitHub", "github.com"],
            "VS Code": ["VS Code", "Visual Studio Code", "Code.exe"],
        }
    )

    def query_script_path(self) -> Path:
        return self._resolve_script(self.query_script)

    def search_script_path(self) -> Path:
        return self._resolve_script(self.search_script)

    def app_db_path(self) -> Path:
        return Path(self.data_dir) / "persist" / "sqlite" / "app.db"

    def observation_pack_path(self) -> Path:
        return Path(self.workspace_dir) / "out" / "minecontext-codex" / "minecontext_observation_pack.md"

    def _resolve_script(self, value: str) -> Path:
        path = Path(value)
        if path.is_absolute():
            return path
        return Path(self.workspace_dir) / value
