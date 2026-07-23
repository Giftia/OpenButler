from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.modules.butler_core.service import ButlerCoreService, init_butler_core_db  # noqa: E402
from app.modules.pc_activity_context.service import init_pc_activity_context_db  # noqa: E402


def main() -> int:
    run_dir = Path(os.environ["OPENBUTLER_NIGHTLY_REAL_DATA_DIR"]).resolve()
    allowed_root = (ROOT / "data" / "nightly" / "real-data").resolve()
    if allowed_root not in run_dir.parents:
        raise RuntimeError("Nightly real-data directory is outside the isolated root")

    run_dir.mkdir(parents=True, exist_ok=True)
    db_path = run_dir / "openbutler-nightly.db"
    runtime_dir = run_dir / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        init_pc_activity_context_db(connection)
        init_butler_core_db(connection)

    service = ButlerCoreService(db_path, runtime_dir)
    preview = service.preview_pc_activity_import(
        lookback_days=2,
        dry_run=True,
        include_screenshot_paths=False,
        copy_screenshots=False,
        limit=5000,
    )
    aggregate = {
        "status": preview.get("status", "unknown"),
        "lookback_hours": 48,
        "estimated_source_events": int(preview.get("estimated_source_events", 0)),
        "estimated_new_events": int(preview.get("estimated_new_events", 0)),
        "estimated_duplicate_events": int(preview.get("estimated_duplicate_events", 0)),
        "warnings_count": len(preview.get("warnings", [])),
        "privacy_mode": preview.get("privacy_mode", "strict"),
        "source_read_only": bool(preview.get("read_only", True)),
        "source_modified": bool(preview.get("minecontext_source_mutated", False)),
        "screenshots_copied": bool(preview.get("screenshots_copied", False)),
        "external_model_called": bool(preview.get("external_model_used", False)),
        "external_webhook_called": bool(preview.get("external_webhook_used", False)),
        "nightly_database_written": True,
        "raw_output_persisted": False,
    }
    print(json.dumps(aggregate, ensure_ascii=False))
    return 0 if aggregate["status"] in {"preview_ready", "source_unavailable"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
