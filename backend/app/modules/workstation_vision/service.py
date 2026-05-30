from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.integrations.local_eyes_adapter import LocalEyesAdapter, LocalEyesUnavailable

from .detectors.attention import estimate_attention
from .detectors.fatigue import detect_fatigue
from .detectors.posture import detect_posture
from .detectors.presence import detect_presence
from .detectors.work_state import estimate_work_state
from .schemas import StartSessionRequest, WorkstationVisionSettings
from .timeline.summaries import build_summary

DEFAULT_USER_ID = "demo-user"


class AutoClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        should_suppress = super().__exit__(exc_type, exc_value, traceback)
        self.close()
        return should_suppress


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_workstation_vision_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS workstation_vision_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            household_id TEXT,
            camera_id TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            stopped_at TEXT,
            fps REAL NOT NULL,
            privacy_mode TEXT NOT NULL,
            save_raw_frames INTEGER NOT NULL,
            enabled_detectors TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workstation_vision_events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            state TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_seconds INTEGER,
            confidence REAL NOT NULL,
            reason_codes TEXT NOT NULL,
            metrics TEXT NOT NULL,
            evidence TEXT NOT NULL,
            privacy_level TEXT NOT NULL,
            raw_frame_ref TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workstation_vision_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            user_id TEXT NOT NULL,
            details TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO settings(key, value) VALUES('workstation_vision_settings', ?)",
        (WorkstationVisionSettings().model_dump_json(),),
    )


class WorkstationVisionService:
    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, factory=AutoClosingConnection)
        conn.row_factory = sqlite3.Row
        return conn

    def get_settings(self) -> WorkstationVisionSettings:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = 'workstation_vision_settings'"
            ).fetchone()
        if not row:
            return WorkstationVisionSettings()
        settings = WorkstationVisionSettings.model_validate_json(row["value"])
        if os.getenv("OPENBUTLER_VISION_MOCK") != "1":
            settings.use_mock_local_eyes = False
        return settings

    def update_settings(self, payload: dict[str, Any]) -> WorkstationVisionSettings:
        current = self.get_settings().model_dump()
        current.update(payload)
        settings = WorkstationVisionSettings.model_validate(current)
        if settings.privacy_mode == "strict" and settings.save_raw_frames:
            settings.save_raw_frames = False
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO settings(key, value)
                VALUES('workstation_vision_settings', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (settings.model_dump_json(),),
            )
            self._audit(conn, "settings_updated", DEFAULT_USER_ID, settings.model_dump())
        return settings

    def adapter(self) -> LocalEyesAdapter:
        settings = self.get_settings()
        use_mock = os.getenv("OPENBUTLER_VISION_MOCK") == "1" or settings.use_mock_local_eyes
        return LocalEyesAdapter(use_mock=use_mock)

    def list_cameras(self) -> dict[str, Any]:
        adapter = self.adapter()
        status = adapter.status()
        try:
            cameras = adapter.list_cameras()
            return {"items": cameras, "count": len(cameras), "local_eyes": status}
        except LocalEyesUnavailable as exc:
            return {"items": [], "count": 0, "local_eyes": {"available": False, "error": str(exc)}}

    def start_session(self, request: StartSessionRequest) -> dict[str, Any]:
        if not request.user_confirmed:
            raise ValueError("User confirmation is required before starting workstation vision.")
        if request.privacy_mode == "strict" and request.save_raw_frames:
            request.save_raw_frames = False
        adapter = self.adapter()
        camera_status = adapter.start_camera(request.camera_id)
        session_id = f"wsv_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        timestamp = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO workstation_vision_sessions (
                    id, user_id, household_id, camera_id, status, started_at, stopped_at,
                    fps, privacy_mode, save_raw_frames, enabled_detectors, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    request.user_id,
                    request.household_id,
                    request.camera_id,
                    "running",
                    timestamp,
                    None,
                    request.fps,
                    request.privacy_mode,
                    int(request.save_raw_frames),
                    json.dumps(request.enabled_detectors),
                    timestamp,
                    timestamp,
                ),
            )
            self._audit(
                conn,
                "session_started",
                request.user_id,
                {"session_id": session_id, "camera_id": request.camera_id, "save_raw_frames": request.save_raw_frames},
            )
        self.analyze_one_frame(session_id, request.camera_id, request.user_id, request.enabled_detectors)
        return {
            "session_id": session_id,
            "status": "running",
            "camera_id": request.camera_id,
            "effective_fps": request.fps,
            "privacy_mode": request.privacy_mode,
            "raw_frame_retention": "keep" if request.save_raw_frames else "discard",
            "started_at": timestamp,
            "local_eyes": camera_status,
        }

    def stop_session(self, session_id: str | None = None) -> dict[str, Any]:
        session = self.current_session() if session_id is None else self.get_session(session_id)
        if not session:
            return {"status": "stopped", "message": "No running workstation vision session."}
        stopped_at = now_iso()
        self.adapter().stop_camera(session["camera_id"])
        with self.connect() as conn:
            conn.execute(
                "UPDATE workstation_vision_sessions SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?",
                (stopped_at, stopped_at, session["id"]),
            )
            self._audit(conn, "session_stopped", session["user_id"], {"session_id": session["id"]})
        return {"session_id": session["id"], "status": "stopped", "stopped_at": stopped_at}

    def status(self) -> dict[str, Any]:
        session = self.current_session()
        settings = self.get_settings()
        latest = self.latest_events(limit=10)
        current = {
            "presence": self._latest_state(latest, "presence_state"),
            "posture": self._latest_state(latest, "posture_state"),
            "work_state": self._latest_state(latest, "observable_work_state"),
            "fatigue": self._latest_state(latest, "fatigue_signal"),
        }
        return {
            "enabled": bool(session),
            "session": session,
            "settings": settings.model_dump(),
            "local_eyes": self.adapter().status(),
            "current": current,
            "latest_events": latest,
            "safe_notice": "所有状态均为基于可观察线索的估计，不代表医学或心理诊断。",
        }

    def analyze_one_frame(
        self,
        session_id: str,
        camera_id: str,
        user_id: str,
        enabled_detectors: list[str],
    ) -> list[dict[str, Any]]:
        frame = self.adapter().analyze_frame(
            camera_id,
            enabled_detectors,
            keep_raw_frame=self.get_settings().save_raw_frames,
        )
        started = frame.get("timestamp") or now_iso()
        duration = 60
        presence = detect_presence(frame)
        posture = detect_posture(frame)
        attention = estimate_attention(frame)
        fatigue = detect_fatigue(frame, continuous_present_minutes=86, looking_down_minutes=18)
        work_state = estimate_work_state(
            presence.get("state", "unknown"),
            posture.get("sub_state") or posture.get("state", "unknown"),
            attention.get("metrics", {}),
            fatigue,
        )
        raw_frame_ref = frame.get("raw_frame_ref") if self.get_settings().save_raw_frames else None
        events = []
        for item in [presence, posture, attention, fatigue, work_state]:
            events.append(
                self.create_event(
                    session_id=session_id,
                    user_id=user_id,
                    event_type=item["type"],
                    state=item.get("sub_state") or item.get("state"),
                    started_at=started,
                    ended_at=(datetime.fromisoformat(started) + timedelta(seconds=duration)).isoformat(),
                    duration_seconds=duration,
                    confidence=float(item.get("confidence", 0.5)),
                    reason_codes=item.get("reason_codes", []),
                    metrics=item.get("metrics", {"severity": item.get("severity")} if item.get("severity") else {}),
                    evidence=item.get("evidence", {}),
                    raw_frame_ref=raw_frame_ref,
                )
            )
        return events

    def create_event(
        self,
        session_id: str,
        user_id: str,
        event_type: str,
        state: str | None,
        started_at: str,
        confidence: float,
        reason_codes: list[str],
        metrics: dict[str, Any],
        evidence: dict[str, Any],
        ended_at: str | None = None,
        duration_seconds: int | None = None,
        raw_frame_ref: str | None = None,
    ) -> dict[str, Any]:
        event_id = str(uuid.uuid4())
        created_at = now_iso()
        row = {
            "id": event_id,
            "session_id": session_id,
            "user_id": user_id,
            "type": event_type,
            "state": state,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_seconds": duration_seconds,
            "confidence": confidence,
            "reason_codes": reason_codes,
            "metrics": metrics,
            "evidence": evidence,
            "privacy_level": "strict_local",
            "raw_frame_ref": raw_frame_ref,
            "created_at": created_at,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO workstation_vision_events (
                    id, session_id, user_id, type, state, started_at, ended_at, duration_seconds,
                    confidence, reason_codes, metrics, evidence, privacy_level, raw_frame_ref, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    session_id,
                    user_id,
                    event_type,
                    state,
                    started_at,
                    ended_at,
                    duration_seconds,
                    confidence,
                    json.dumps(reason_codes, ensure_ascii=False),
                    json.dumps(metrics, ensure_ascii=False),
                    json.dumps(evidence, ensure_ascii=False),
                    "strict_local",
                    raw_frame_ref,
                    created_at,
                ),
            )
            self._audit(conn, "event_created", user_id, {"event_id": event_id, "type": event_type})
        return row

    def events(self, event_type: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM workstation_vision_events"
        params: tuple[Any, ...] = ()
        if event_type:
            query += " WHERE type = ?"
            params = (event_type,)
        query += " ORDER BY started_at DESC"
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._event_from_row(row) for row in rows]

    def latest_events(self, limit: int = 10) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM workstation_vision_events ORDER BY started_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._event_from_row(row) for row in rows]

    def today_summary(self) -> dict[str, Any]:
        today_prefix = date.today().isoformat()
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM workstation_vision_events WHERE started_at >= ? ORDER BY started_at ASC",
                (today_prefix,),
            ).fetchall()
        return build_summary([self._event_from_row(row) for row in rows], date.today())

    def current_session(self) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM workstation_vision_sessions WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
        return self._session_from_row(row) if row else None

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM workstation_vision_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return self._session_from_row(row) if row else None

    def clear_events(self, today_only: bool = False) -> dict[str, Any]:
        with self.connect() as conn:
            if today_only:
                cursor = conn.execute(
                    "DELETE FROM workstation_vision_events WHERE started_at >= ?",
                    (date.today().isoformat(),),
                )
                action = "today_data_deleted"
            else:
                cursor = conn.execute("DELETE FROM workstation_vision_events")
                action = "all_data_deleted"
            self._audit(conn, action, DEFAULT_USER_ID, {"deleted": cursor.rowcount})
            return {"deleted": cursor.rowcount, "today_only": today_only}

    def export_events(self) -> dict[str, Any]:
        return {"items": self.events(), "summary": self.today_summary()}

    def _event_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["reason_codes"] = json.loads(item["reason_codes"])
        item["metrics"] = json.loads(item["metrics"])
        item["evidence"] = json.loads(item["evidence"])
        return item

    def _session_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["save_raw_frames"] = bool(item["save_raw_frames"])
        item["enabled_detectors"] = json.loads(item["enabled_detectors"])
        return item

    def _latest_state(self, events: list[dict[str, Any]], event_type: str) -> str:
        for event in events:
            if event["type"] == event_type:
                return event.get("state") or "unknown"
        return "unknown"

    def _audit(self, conn: sqlite3.Connection, action: str, user_id: str, details: dict[str, Any]) -> None:
        conn.execute(
            "INSERT INTO workstation_vision_audit_log(id, action, user_id, details, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), action, user_id, json.dumps(details, ensure_ascii=False), now_iso()),
        )
