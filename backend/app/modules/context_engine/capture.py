"""Owned, masked screen evidence and resumable observation state.

The desktop main process must perform OCR and mask the image before invoking
this service. Raw desktop captures have no storage API here.
"""

import base64
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import stat
from functools import wraps
from threading import Event, RLock
from typing import Callable, Literal
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from app.modules.context_engine.audit import PrivacyAuditLedger
from app.modules.context_engine.privacy import AuditedPrivacyGuard
from app.security.privacy_guard import PrivacyRequest

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000
RETENTION_DAYS = 7
STATES = Literal["recorded_pending", "processing", "ready", "model_unavailable"]


def synchronized(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return guarded


def init_capture_store(conn: sqlite3.Connection, *, reset_active: bool = False) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS context_capture_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        display_id TEXT NOT NULL,
        excluded_apps TEXT NOT NULL,
        masks TEXT NOT NULL,
        consented INTEGER NOT NULL CHECK(consented IN (0,1)),
        active INTEGER NOT NULL CHECK(active IN (0,1))
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS context_observations (
        id TEXT PRIMARY KEY,
        captured_at TEXT NOT NULL,
        display_id TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        evidence_id TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        boundary TEXT NOT NULL
    )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS context_observations_time
        ON context_observations(captured_at DESC)""")
    if reset_active:
        # Consent persists for settings review, but a restarted process never resumes capture.
        conn.execute("UPDATE context_capture_settings SET active = 0 WHERE id = 1")
        conn.execute("""UPDATE context_observations SET state='model_unavailable'
            WHERE state='processing'""")


class MaskRect(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class CaptureSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    display_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9:_.-]+$")
    excluded_apps: list[str] = Field(min_length=1, max_length=100)
    masks: list[MaskRect] = Field(default_factory=list)
    confirmed: bool = False

    @field_validator("excluded_apps")
    @classmethod
    def validate_exclusions(cls, values: list[str]) -> list[str]:
        if any(not name or len(name) > 120 or any(c in name for c in "\\/:?*\r\n") for name in values):
            raise ValueError("invalid_excluded_application")
        return values


class MaskedObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    display_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9:_.-]+$")
    captured_at: datetime
    masked_png_base64: str = Field(min_length=40, max_length=MAX_IMAGE_BYTES * 2)
    local_ocr_complete: StrictBool = False
    masks_applied: StrictBool = False

    @field_validator("captured_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("captured_at_requires_timezone")
        return value


class CaptureStore:
    def __init__(self, connect: Callable[[], sqlite3.Connection], data_dir: Path,
                 privacy_mode: Callable[[], str], clock=None) -> None:
        self._connect = connect
        self._media = Path(data_dir) / "context_engine" / "media"
        self._privacy_mode = privacy_mode
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._guard = AuditedPrivacyGuard(PrivacyAuditLedger(connect, self._clock))
        self._lock = RLock()
        self._revocation_requested = Event()

    @synchronized
    def configure(self, settings: CaptureSettings) -> None:
        if not settings.confirmed:
            raise PermissionError("authorization_required")
        import json
        with self._connect() as conn:
            conn.execute("""INSERT INTO context_capture_settings
                (id,display_id,excluded_apps,masks,consented,active)
                VALUES (1,?,?,?,?,0)
                ON CONFLICT(id) DO UPDATE SET
                  display_id=excluded.display_id, excluded_apps=excluded.excluded_apps,
                  masks=excluded.masks, consented=excluded.consented, active=0""",
                (settings.display_id, json.dumps(settings.excluded_apps),
                 json.dumps([item.model_dump() for item in settings.masks]), 1))
        self._revocation_requested.clear()

    @synchronized
    def start(self) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT consented FROM context_capture_settings WHERE id=1").fetchone()
            authorized = bool(row and row[0])
        self._guard.require(PrivacyRequest(
            action="capture", mode=self._mode(), authorized=authorized, paused=False,
        ))
        with self._connect() as conn:
            conn.execute("UPDATE context_capture_settings SET active=1 WHERE id=1 AND consented=1")

    @synchronized
    def pause(self) -> None:
        with self._connect() as conn:
            conn.execute("UPDATE context_capture_settings SET active=0 WHERE id=1")

    def revoke(self) -> None:
        self._revocation_requested.set()
        with self._lock:
            with self._connect() as conn:
                conn.execute("UPDATE context_capture_settings SET active=0,consented=0 WHERE id=1")

    def _mode(self) -> Literal["strict", "basic"]:
        mode = self._privacy_mode()
        if mode not in ("strict", "basic"):
            raise PermissionError("privacy_mode_unavailable")
        return mode

    def state(self) -> dict:
        with self._connect() as conn:
            row = conn.execute("SELECT display_id,consented,active FROM context_capture_settings WHERE id=1").fetchone()
            count = conn.execute("SELECT count(*) FROM context_observations").fetchone()[0]
        return {"configured": bool(row), "authorized": bool(row and row[1]),
                "active": bool(row and row[2]), "record_count": count}

    @staticmethod
    def _validate_png(encoded: str) -> bytes:
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception:
            raise ValueError("invalid_masked_image") from None
        if len(raw) > MAX_IMAGE_BYTES or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("invalid_masked_image")
        try:
            with Image.open(BytesIO(raw)) as image:
                if image.format != "PNG" or image.width * image.height > MAX_PIXELS:
                    raise ValueError("invalid_masked_image")
                image.verify()
        except (UnidentifiedImageError, OSError, ValueError):
            raise ValueError("invalid_masked_image") from None
        return raw

    @synchronized
    def ingest(self, observation: MaskedObservation) -> dict:
        with self._connect() as conn:
            row = conn.execute("SELECT display_id,consented,active FROM context_capture_settings WHERE id=1").fetchone()
        allowed = bool(row and row[1] and row[2] and row[0] == observation.display_id
                       and observation.local_ocr_complete and observation.masks_applied)
        self._guard.require(PrivacyRequest(action="capture", mode=self._mode(), authorized=allowed,
                                           paused=not bool(row and row[2])))
        raw = self._validate_png(observation.masked_png_base64)
        digest = sha256(raw).hexdigest()
        observed = observation.captured_at.astimezone(timezone.utc)
        now = self._clock()
        if abs((now - observed).total_seconds()) > 300:
            raise ValueError("capture_time_out_of_range")
        with self._connect() as conn:
            last = conn.execute("""SELECT id,image_digest FROM context_observations
                WHERE display_id=? ORDER BY captured_at DESC LIMIT 1""", (observation.display_id,)).fetchone()
            if last and last[1] == digest:
                return {"recorded": False, "duplicate": True, "id": last[0]}
        event_id, evidence_id = str(uuid4()), str(uuid4())
        expires = observed + timedelta(days=RETENTION_DAYS)
        self._media.mkdir(parents=True, exist_ok=True)
        target = self._media / f"{evidence_id}.png"
        temporary = self._media / f".{evidence_id}.tmp"
        try:
            with temporary.open("xb") as output:
                output.write(raw)
            os.replace(temporary, target)
            with self._connect() as conn:
                conn.execute("""INSERT INTO context_observations
                    (id,captured_at,display_id,image_digest,evidence_id,expires_at,state,boundary)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (event_id, observed.isoformat(), observation.display_id, digest,
                     evidence_id, expires.isoformat(), "recorded_pending",
                     "仅根据授权时段内的本机画面，尚未生成整理结论。"))
        except Exception:
            temporary.unlink(missing_ok=True)
            target.unlink(missing_ok=True)
            raise
        return {"recorded": True, "duplicate": False, "id": event_id}

    def list_records(self, limit: int = 100) -> list[dict]:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("record_limit_out_of_range")
        with self._connect() as conn:
            rows = conn.execute("""SELECT id,captured_at,evidence_id,expires_at,state,title,summary,boundary
                FROM context_observations ORDER BY captured_at DESC LIMIT ?""", (limit,)).fetchall()
        now = self._clock()
        return [{"id": row[0], "captured_at": row[1], "state": row[4],
                 "title": row[5], "summary": row[6], "boundary": row[7],
                 "evidence_available": datetime.fromisoformat(row[3]) > now,
                 "evidence_id": row[2] if datetime.fromisoformat(row[3]) > now else None,
                 "source_label": "本机记录"} for row in rows]

    def review_records(self, start: datetime, end: datetime, *,
                       observation_ids: list[str] | None = None) -> list[dict]:
        """Read owned observation metadata in a UTC half-open window, never images.

        SQLite normalizes offsets before comparison, including older timestamp
        representations. No MineContext tables or external sources are queried.
        """
        parameters = [(start - timedelta(seconds=1)).isoformat(),
                      (end + timedelta(seconds=1)).isoformat()]
        selected = ""
        if observation_ids is not None:
            if not 1 <= len(observation_ids) <= 128:
                raise ValueError("review_selection_out_of_range")
            selected = " AND id IN (" + ",".join("?" for _ in observation_ids) + ")"
            parameters.extend(observation_ids)
        with self._connect() as conn:
            rows = conn.execute("""SELECT id,captured_at,evidence_id,expires_at,state,
                title,summary,boundary,image_digest FROM context_observations
                WHERE julianday(captured_at)>=julianday(?)
                  AND julianday(captured_at)<julianday(?)""" + selected +
                " ORDER BY julianday(captured_at),id", parameters).fetchall()
        keys = ("id", "captured_at", "evidence_id", "expires_at", "state",
                "title", "summary", "boundary", "image_digest")
        records = []
        for row in rows:
            try:
                observed = datetime.fromisoformat(row[1])
                if observed.tzinfo is not None and start <= observed < end:
                    records.append(dict(zip(keys, row)))
            except (ValueError, TypeError):
                continue
        # julianday has millisecond precision; retain exact half-open boundaries
        # and ordering after its coarse SQL window selection.
        records.sort(key=lambda item: (datetime.fromisoformat(item["captured_at"]), item["id"]))
        return records

    def owned_evidence_fingerprint(self, evidence_id: str) -> tuple | None:
        """Check an owned row's opaque media reference without opening its bytes.

        The caller must resolve ownership/expiry from review_records. The stat
        fingerprint also detects a changed or replaced file during a model call.
        """
        from uuid import UUID
        try:
            if str(UUID(evidence_id)) != evidence_id:
                return None
            info = (self._media / f"{evidence_id}.png").lstat()
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_IMAGE_BYTES:
                return None
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        except (ValueError, TypeError, AttributeError, OSError):
            return None

    def set_result(self, event_id: str, *, state: Literal["ready", "model_unavailable"],
                   title: str | None = None, summary: str | None = None,
                   boundary: str | None = None) -> None:
        if state == "ready" and (not title or not summary or not boundary):
            raise ValueError("incomplete_result")
        with self._connect() as conn:
            cursor = conn.execute("""UPDATE context_observations
                SET state=?, title=?, summary=?, boundary=?
                WHERE id=? AND state IN ('recorded_pending','processing')""",
                (state, title[:100] if title else None, summary[:500] if summary else None,
                 boundary or "已记录画面，但整理模型暂不可用；不能据此推断未记录时段的活动。",
                 event_id))
            if cursor.rowcount != 1:
                raise ValueError("observation_not_pending")

    @synchronized
    def prepare_retry(self, event_id: str) -> bytes | None:
        try:
            from uuid import UUID
            if str(UUID(event_id)) != event_id:
                return None
        except (ValueError, TypeError):
            return None
        with self._connect() as conn:
            row = conn.execute("""SELECT evidence_id,expires_at FROM context_observations
                WHERE id=? AND state='model_unavailable'""", (event_id,)).fetchone()
        if not row or datetime.fromisoformat(row[1]) <= self._clock():
            return None
        image = self.evidence(row[0])
        if image is None:
            return None
        with self._connect() as conn:
            cursor = conn.execute("""UPDATE context_observations SET state='processing'
                WHERE id=? AND state='model_unavailable'""", (event_id,))
            if cursor.rowcount != 1:
                return None
        return image

    @synchronized
    def with_processing_consent(self, operation):
        if self._revocation_requested.is_set():
            raise PermissionError("capture_consent_revoked")
        with self._connect() as conn:
            row = conn.execute("SELECT consented FROM context_capture_settings WHERE id=1").fetchone()
        if not row or not row[0] or self._revocation_requested.is_set():
            raise PermissionError("capture_consent_revoked")
        result = operation()
        # revoke() can request cancellation while this lock protects an in-flight
        # operation. Never publish its result after that cancellation request.
        if self._revocation_requested.is_set():
            raise PermissionError("capture_consent_revoked")
        return result

    def evidence(self, evidence_id: str) -> bytes | None:
        from uuid import UUID
        try:
            canonical = str(UUID(evidence_id))
            if canonical != evidence_id:
                return None
        except (ValueError, TypeError):
            return None
        with self._connect() as conn:
            row = conn.execute("SELECT expires_at FROM context_observations WHERE evidence_id=?",
                               (canonical,)).fetchone()
        if not row or datetime.fromisoformat(row[0]) <= self._clock():
            return None
        target = self._media / f"{canonical}.png"
        if target.is_symlink():
            return None
        try:
            return target.read_bytes()
        except OSError:
            return None

    def expire_owned(self) -> int:
        self._guard.require(PrivacyRequest(action="retention", mode=self._mode(),
                                           authorized=True, target_owned=True))
        now = self._clock().isoformat()
        with self._connect() as conn:
            rows = conn.execute("SELECT evidence_id FROM context_observations WHERE expires_at<=?",
                                (now,)).fetchall()
            for (evidence_id,) in rows:
                target = self._media / f"{evidence_id}.png"
                if not target.is_symlink():
                    target.unlink(missing_ok=True)
            conn.execute("DELETE FROM context_observations WHERE expires_at<=?", (now,))
        return len(rows)

    def delete_owned(self, event_id: str) -> bool:
        from uuid import UUID
        try:
            if str(UUID(event_id)) != event_id:
                return False
        except (ValueError, TypeError):
            return False
        self._guard.require(PrivacyRequest(action="retention", mode=self._mode(),
                                           authorized=True, target_owned=True))
        with self._connect() as conn:
            row = conn.execute("SELECT evidence_id FROM context_observations WHERE id=?", (event_id,)).fetchone()
            if not row:
                return False
            target = self._media / f"{row[0]}.png"
            if target.is_symlink():
                raise PermissionError("owned_media_path_unsafe")
            target.unlink(missing_ok=True)
            conn.execute("DELETE FROM context_observations WHERE id=?", (event_id,))
            return True
