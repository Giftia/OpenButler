from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("OPENBUTLER_DATA_DIR", "/tmp/openbutler")
os.environ.setdefault("OPENBUTLER_DEPLOY_TARGET", "vercel")

from app.main import app  # noqa: E402
