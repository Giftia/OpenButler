"""Synthetic source bindings and explicit pre-gate historical database fixtures."""

from datetime import timedelta
import json
from uuid import uuid4


def public_window_provenance(now, *, width=40, height=20):
    return {
        "source_kind": "public_window", "capture_scope": "dedicated_public_window",
        "session_id": str(uuid4()), "source_revision": "a" * 64,
        "source_identity": {"window_id": "x11:100", "owner_pid": 123,
            "owner_process_start": "999", "owner_process_name": "editor",
            "wm_class": "Editor", "window_title": "Public synthetic fixture",
            "content_bounds": {"x": 0, "y": 0, "width": width, "height": height}},
        "session_expires_at": (now + timedelta(hours=1)).isoformat(),
        "lock_state": "unknown", "lock_protection_supported": False,
        "capture_method": "xcomposite_named_window_pixmap", "sampling_interval_ms": 60000,
    }


def seed_legacy_capture_settings(connect, *, display_id="synthetic_display", active=False,
                                 source_kind="full_screen", provenance=None):
    """Represent already-stored consent, never a new full-screen capture API call."""
    with connect() as conn:
        conn.execute("""INSERT OR REPLACE INTO context_capture_settings
            (id,display_id,excluded_apps,masks,consented,active,source_kind,consent_revision,provenance)
            VALUES (1,?,'["password-manager"]','[]',1,?,?,?,?)""",
            (display_id, int(active), source_kind, str(uuid4()), json.dumps(provenance or {})))


def seed_historical_observation(connect, now, *, state="model_unavailable",
                                source_kind="full_screen", provenance=None):
    """Already-stored row bound to the fixture's current consent revision."""
    event, evidence = str(uuid4()), str(uuid4())
    with connect() as conn:
        revision = conn.execute("SELECT consent_revision FROM context_capture_settings WHERE id=1").fetchone()[0]
        conn.execute("""INSERT INTO context_observations
            (id,captured_at,display_id,image_digest,evidence_id,expires_at,state,boundary,
             source_kind,consent_revision,provenance,processing_reason)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,'queue_full')""",
            (event, now.isoformat(), "synthetic_display", "synthetic-digest", evidence,
             (now + timedelta(days=1)).isoformat(), state, "Historical synthetic evidence",
             source_kind, revision, json.dumps(provenance or {})))
    return event
