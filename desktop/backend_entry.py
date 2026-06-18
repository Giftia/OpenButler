from __future__ import annotations

import os
import sys

import uvicorn


def _ensure_standard_streams() -> None:
    """PyInstaller windowed apps can have None stdout/stderr."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def main() -> None:
    _ensure_standard_streams()
    os.environ.setdefault("OPENBUTLER_DESKTOP", "1")
    os.environ.setdefault("OPENBUTLER_DEFAULT_PRIVACY_MODE", "strict")
    os.environ.setdefault("OPENBUTLER_DISABLE_SEED_EVENTS", "1")
    os.environ.setdefault("OPENBUTLER_COPY_SCREENSHOTS", "0")
    os.environ.setdefault("OPENBUTLER_EXTERNAL_MODEL_ALLOWED", "0")
    os.environ.setdefault("OPENBUTLER_EXTERNAL_WEBHOOK_ALLOWED", "0")
    host = os.getenv("OPENBUTLER_HOST", "127.0.0.1")
    port = int(os.getenv("OPENBUTLER_PORT", "8010"))
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level="warning",
        log_config=None,
        access_log=False,
    )


if __name__ == "__main__":
    main()
