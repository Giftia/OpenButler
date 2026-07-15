from __future__ import annotations

import json
import subprocess
import uuid
from pathlib import Path
from typing import Any

from .config import MineContextSettings
from .errors import GodviewScriptError, MineContextUnavailable
from .normalizer import query_result_from_json, search_results_from_json
from .schemas import MineContextGodviewResult, MineContextSearchResult


class MineContextGodviewClient:
    def __init__(self, settings: MineContextSettings, runtime_dir: Path | str) -> None:
        self.settings = settings
        self.runtime_dir = Path(runtime_dir)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)

    def query_at_time(self, when: str, window_minutes: int = 10, include_raw_output: bool = False) -> MineContextGodviewResult:
        script = self.settings.query_script_path()
        json_path = self.runtime_dir / f"godview_query_{uuid.uuid4().hex}.json"
        md_path = self.runtime_dir / f"godview_query_{uuid.uuid4().hex}.md"
        self._run_script(
            [
                "-File",
                str(script),
                "-When",
                when,
                "-WindowMinutes",
                str(window_minutes),
                "-MineContextHome",
                self.settings.data_dir,
                "-Output",
                str(md_path),
                "-JsonOutput",
                str(json_path),
            ],
            script,
        )
        data = self._read_json(json_path)
        return query_result_from_json(data, include_raw_output)

    def search(self, query: str, limit: int = 20, include_raw_output: bool = False) -> list[MineContextSearchResult]:
        script = self.settings.search_script_path()
        json_path = self.runtime_dir / f"godview_search_{uuid.uuid4().hex}.json"
        md_path = self.runtime_dir / f"godview_search_{uuid.uuid4().hex}.md"
        self._run_script(
            [
                "-File",
                str(script),
                "-Query",
                query,
                "-MineContextHome",
                self.settings.data_dir,
                "-Output",
                str(md_path),
                "-JsonOutput",
                str(json_path),
                "-ScreenshotLimit",
                "8",
            ],
            script,
        )
        data = self._read_json(json_path)
        return search_results_from_json(data, self.settings.keyword_aliases)[:limit]

    def _run_script(self, args: list[str], script: Path) -> subprocess.CompletedProcess[str]:
        if not Path(self.settings.workspace_dir).exists():
            raise MineContextUnavailable("MineContext godview workspace does not exist.")
        if not script.exists():
            raise MineContextUnavailable(f"MineContext godview script does not exist: {script.name}")
        command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", *args]
        try:
            result = subprocess.run(
                command,
                cwd=self.settings.workspace_dir,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=self.settings.command_timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise GodviewScriptError("MineContext godview script timed out.") from exc
        except FileNotFoundError as exc:
            raise GodviewScriptError("PowerShell is not available.") from exc
        if result.returncode != 0:
            stderr = (result.stderr or result.stdout or "").strip()
            raise GodviewScriptError(f"MineContext godview script failed: {stderr[:500]}")
        return result

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            raise GodviewScriptError("MineContext godview script did not produce JSON output.")
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise GodviewScriptError("MineContext godview JSON output could not be parsed.") from exc
