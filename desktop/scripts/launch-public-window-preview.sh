#!/bin/sh
# Run from the actual native desktop terminal. Never sets DISPLAY or bypasses
# Electron's sandbox. This opens the app; it does not authorize/start capture.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RUNTIME="$ROOT/native-runtime/electron-31.7.7/electron"
PYTHON="$ROOT/../.venv/bin/python"
[ -x "$RUNTIME" ] || { echo 'Verified Electron runtime is missing'; exit 1; }
[ -x "$PYTHON" ] || { echo 'Project Python environment is missing'; exit 1; }
[ -n "${DISPLAY:-}" ] || { echo 'Launch in the native X11 desktop terminal'; exit 1; }
export OPENBUTLER_PYTHON="$PYTHON"
export OPENBUTLER_DESKTOP_CHANNEL=preview
export OPENBUTLER_DESKTOP_USER_DATA_DIR="$ROOT/native-runtime/user-data-public-window"
export PYTHONDONTWRITEBYTECODE=1
# Explicit temporary CPU trial budget, per local inference request only.
# External provider requests retain their production 10-second limit.
export OPENBUTLER_LOCAL_MODEL_TOTAL_TIMEOUT_SECONDS=90
# Scoped to this explicit native trial launcher; normal product launches keep
# their defaults. Set either variable to 0 to opt out for comparison.
export OPENBUTLER_SOFTWARE_RENDERING="${OPENBUTLER_SOFTWARE_RENDERING:-1}"
export OPENBUTLER_STARTUP_DIAGNOSTICS="${OPENBUTLER_STARTUP_DIAGNOSTICS:-1}"
cd "$ROOT/desktop"
exec "$RUNTIME" .
