"""Owned, masked screen evidence and resumable observation state.

The desktop main process must perform OCR and mask the image before invoking
this service. Raw desktop captures have no storage API here.
"""

import base64
import json
import re
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
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.modules.context_engine.audit import PrivacyAuditLedger
from app.modules.context_engine.privacy import AuditedPrivacyGuard
from app.security.privacy_guard import PrivacyRequest

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_POST_MASK_OCR_CHARS = 2000
MAX_POST_MASK_OCR_BYTES = 6000
RETENTION_DAYS = 7
STATES = Literal["recorded_pending", "processing", "ready", "model_unavailable"]


def synchronized(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return guarded


def evidence_synchronized(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self._evidence_lock:
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
    # Additive migration: existing screen records retain their original evidence.
    for table, columns in {
        "context_capture_settings": {
            "source_kind": "TEXT NOT NULL DEFAULT 'full_screen'",
            "consent_revision": "TEXT NOT NULL DEFAULT ''",
            "provenance": "TEXT NOT NULL DEFAULT '{}'",
            "last_capture_at": "TEXT",
            "last_sampling_sequence": "INTEGER NOT NULL DEFAULT 0",
        },
        "context_observations": {
            "source_kind": "TEXT NOT NULL DEFAULT 'full_screen'",
            "consent_revision": "TEXT NOT NULL DEFAULT ''",
            "provenance": "TEXT NOT NULL DEFAULT '{}'",
            "recorded_at": "TEXT",
            "temporal_context": "TEXT NOT NULL DEFAULT '{}'",
            "processing_reason": "TEXT",
            "post_mask_ocr_text": "TEXT",
            "post_mask_ocr_image_digest": "TEXT",
            "post_mask_ocr_engine": "TEXT",
            "extraction_version": "INTEGER NOT NULL DEFAULT 1",
            "current_facts": "TEXT NOT NULL DEFAULT '{}'",
        },
    }.items():
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    if reset_active:
        # Consent persists for settings review, but a restarted process never resumes capture.
        conn.execute("UPDATE context_capture_settings SET active = 0 WHERE id = 1")
        conn.execute("""UPDATE context_observations SET state='model_unavailable', processing_reason='process_restarted'
            WHERE state IN ('processing','recorded_pending')""")
        _interrupt_associations(conn, "process_restarted")


def _interrupt_associations(conn, reason):
    # Only new in-flight associations change; legacy observations and committed
    # current extraction are never rewritten or relabeled on restart/pause.
    rows = conn.execute("""SELECT id,temporal_context FROM context_observations
        WHERE state='ready' AND extraction_version=2 AND
        (temporal_context LIKE '%"association_state": "pending"%'
         OR temporal_context LIKE '%"association_state": "running"%')""").fetchall()
    for event_id, raw in rows:
        context = json.loads(raw)
        if context.get("association_state") in ("pending", "running"):
            context.update(association_state="failed", association_reason=reason, relations=[])
            conn.execute("UPDATE context_observations SET temporal_context=? WHERE id=? AND temporal_context=?",
                         (json.dumps(context), event_id, raw))


class MaskRect(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class WindowBounds(MaskRect):
    width: int = Field(gt=0, le=16000)
    height: int = Field(gt=0, le=16000)


class WindowIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    window_id: str = Field(pattern=r"^x11:[1-9][0-9]{0,19}$", max_length=24)
    owner_pid: int = Field(gt=0)
    owner_process_start: str = Field(pattern=r"^[0-9]{1,30}$")
    owner_process_name: str = Field(min_length=1, max_length=120)
    wm_class: str = Field(min_length=1, max_length=240)
    window_title: str = Field(min_length=1, max_length=240)
    content_bounds: WindowBounds

    @field_validator("owner_process_name", "wm_class", "window_title")
    @classmethod
    def valid_label(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("invalid_window_identity")
        return value


class SourceProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    source_kind: Literal["full_screen", "public_window"] = "full_screen"
    observation_mode: Literal["vision", "masked_ocr_text"] = "vision"
    capture_scope: Literal["full_screen", "dedicated_public_window"] = "full_screen"
    session_id: str | None = Field(default=None, pattern=r"^[0-9a-f-]{36}$")
    source_revision: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    source_identity: WindowIdentity | None = None
    session_expires_at: str | None = None
    lock_state: Literal["unknown"] | None = None
    lock_protection_supported: StrictBool | None = None
    capture_method: Literal["xcomposite_named_window_pixmap"] | None = None
    sampling_interval_ms: int | None = Field(default=None, strict=True, ge=1000, le=300000)

    @model_validator(mode="after")
    def validate_source(self):
        if self.source_kind == "public_window":
            from uuid import UUID
            if (self.capture_scope != "dedicated_public_window" or not self.session_id
                    or not self.source_revision or self.source_identity is None
                    or not self.session_expires_at or self.lock_state != "unknown"
                    or self.lock_protection_supported is not False
                    or self.capture_method != "xcomposite_named_window_pixmap"
                    or self.sampling_interval_ms is None):
                raise ValueError("incomplete_public_window_provenance")
            try:
                if str(UUID(self.session_id)) != self.session_id:
                    raise ValueError
                expiry = datetime.fromisoformat(self.session_expires_at.replace("Z", "+00:00"))
                if expiry.tzinfo is None or expiry.utcoffset() is None:
                    raise ValueError
            except (ValueError, TypeError):
                raise ValueError("invalid_public_window_session") from None
        elif (self.observation_mode != "vision" or self.capture_scope != "full_screen" or any(getattr(self, key) is not None for key in
                ("session_id", "source_revision", "source_identity", "session_expires_at",
                 "lock_state", "lock_protection_supported", "capture_method", "sampling_interval_ms"))):
            raise ValueError("unexpected_source_provenance")
        return self


class CaptureSettings(SourceProvenance):
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


class MaskedObservation(SourceProvenance):
    model_config = ConfigDict(extra="forbid", frozen=True)
    display_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9:_.-]+$")
    captured_at: datetime
    masked_png_base64: str = Field(min_length=40, max_length=MAX_IMAGE_BYTES * 2)
    local_ocr_complete: StrictBool = False
    masks_applied: StrictBool = False
    post_mask_ocr_complete: StrictBool = False
    post_mask_ocr_text: str | None = Field(default=None, strict=True, min_length=1, max_length=MAX_POST_MASK_OCR_CHARS)
    post_mask_ocr_image_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    post_mask_ocr_engine: Literal["tesseract.js"] | None = None
    consent_revision: str | None = Field(default=None, pattern=r"^[0-9a-f-]{36}$")
    source_verified_before: StrictBool = False
    source_verified_after: StrictBool = False
    sampling_sequence: int | None = Field(default=None, strict=True, ge=1)
    sampling_gap_ms: int | None = Field(default=None, strict=True, ge=0)

    @field_validator("captured_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("captured_at_requires_timezone")
        return value

    @model_validator(mode="after")
    def verified_window(self):
        if self.source_kind == "public_window" and (not self.consent_revision
                or not self.source_verified_before or not self.source_verified_after
                or self.sampling_sequence is None or self.sampling_gap_ms is None):
            raise ValueError("unverified_public_window_frame")
        if self.observation_mode == "masked_ocr_text":
            if (self.source_kind != "public_window" or not self.post_mask_ocr_complete
                    or not self.post_mask_ocr_text or not self.post_mask_ocr_text.strip()
                    or not self.post_mask_ocr_image_digest or not self.post_mask_ocr_engine):
                raise ValueError("post_mask_ocr_required")
            if (len(self.post_mask_ocr_text.encode("utf-8")) > MAX_POST_MASK_OCR_BYTES
                    or any((ord(c) < 32 and c not in "\n\r\t") or ord(c) == 127 for c in self.post_mask_ocr_text)):
                raise ValueError("invalid_post_mask_ocr")
        elif self.post_mask_ocr_complete or any(value is not None for value in (
                self.post_mask_ocr_text, self.post_mask_ocr_image_digest, self.post_mask_ocr_engine)):
            raise ValueError("unexpected_post_mask_ocr")
        return self


def provenance_of(value):
    return {key: getattr(value, key).model_dump() if isinstance(getattr(value, key), BaseModel)
            else getattr(value, key) for key in SourceProvenance.model_fields}




class ProcessingCancellation(Event):
    """One job's cancellable evidence lease, polled by the bounded HTTP watchdog."""
    def __init__(self, generation_event, rows, clock):
        super().__init__()
        self.generation_event = generation_event
        self.evidence_ids = frozenset(row["evidence_id"] for row in rows)
        self.clock = clock
        self.evidence_expiry = min(datetime.fromisoformat(row["expires_at"]) for row in rows)
        provenance = rows[0]["provenance"]
        self.session_expiry = (datetime.fromisoformat(provenance["session_expires_at"].replace("Z", "+00:00"))
                               if provenance.get("session_expires_at") else None)
        self.reason = None

    def cancel(self, reason):
        self.reason = self.reason or reason
        super().set()

    def is_set(self):
        if self.generation_event.is_set():
            self.cancel("authorization_revoked")
        now = self.clock()
        if self.session_expiry is not None and now >= self.session_expiry:
            self.cancel("session_expired")
        elif now >= self.evidence_expiry:
            self.cancel("evidence_changed")
        return super().is_set()


class CaptureStore:
    def __init__(self, connect: Callable[[], sqlite3.Connection], data_dir: Path,
                 privacy_mode: Callable[[], str], clock=None) -> None:
        self._connect = connect
        self._media = Path(data_dir) / "context_engine" / "media"
        self._privacy_mode = privacy_mode
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._guard = AuditedPrivacyGuard(PrivacyAuditLedger(connect, self._clock))
        self._lock = RLock()
        self._evidence_lock = RLock()
        self._revocation_requested = Event()
        self._invalidation_lock = RLock()
        self._generation = 0
        self._processing_cancel = Event()
        self._processing_lease = None

    def _invalidate(self):
        # Announce cancellation before waiting for an in-flight model operation.
        with self._invalidation_lock:
            self._processing_cancel.set()
            self._generation += 1
            self._processing_cancel = Event()

    def configure(self, settings: CaptureSettings) -> dict:
        if not settings.confirmed:
            raise PermissionError("authorization_required")
        if settings.source_kind == "public_window":
            expiry = datetime.fromisoformat(settings.session_expires_at.replace("Z", "+00:00"))
            if not 0 < (expiry - self._clock()).total_seconds() <= 3600:
                raise ValueError("public_window_session_expiry_out_of_range")
        self._invalidate()
        with self._lock:
            self.cancel_pending("source_reconfigured")
            revision = str(uuid4())
            with self._connect() as conn:
                conn.execute("""INSERT INTO context_capture_settings
                    (id,display_id,excluded_apps,masks,consented,active,source_kind,consent_revision,provenance)
                    VALUES (1,?,?,?,?,0,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      display_id=excluded.display_id, excluded_apps=excluded.excluded_apps,
                      masks=excluded.masks, consented=excluded.consented, active=0,
                      source_kind=excluded.source_kind,consent_revision=excluded.consent_revision,
                      provenance=excluded.provenance,last_capture_at=NULL,last_sampling_sequence=0""",
                    (settings.display_id, json.dumps(settings.excluded_apps),
                     json.dumps([item.model_dump() for item in settings.masks]), 1,
                     settings.source_kind, revision, json.dumps(provenance_of(settings))))
            self._revocation_requested.clear()
            return {"configured": True, "active": False, "consent_revision": revision,
                    "source_kind": settings.source_kind, "session_id": settings.session_id,
                    "source_revision": settings.source_revision}

    @synchronized
    def start(self) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT consented,provenance FROM context_capture_settings WHERE id=1").fetchone()
            authorized = bool(row and row[0])
        if row and json.loads(row[1]).get("source_kind") == "public_window":
            if datetime.fromisoformat(json.loads(row[1])["session_expires_at"].replace("Z", "+00:00")) <= self._clock():
                raise PermissionError("public_window_session_expired")
        self._guard.require(PrivacyRequest(
            action="capture", mode=self._mode(), authorized=authorized, paused=False,
        ))
        with self._connect() as conn:
            conn.execute("UPDATE context_capture_settings SET active=1 WHERE id=1 AND consented=1")

    def pause(self) -> None:
        self._invalidate()
        with self._lock:
            with self._connect() as conn:
                conn.execute("UPDATE context_capture_settings SET active=0 WHERE id=1")
            self.cancel_pending("capture_paused")

    def revoke(self) -> None:
        self._invalidate()
        self._revocation_requested.set()
        with self._lock:
            with self._connect() as conn:
                conn.execute("UPDATE context_capture_settings SET active=0,consented=0 WHERE id=1")
            self.cancel_pending("authorization_revoked")

    def _mode(self) -> Literal["strict", "basic"]:
        mode = self._privacy_mode()
        if mode not in ("strict", "basic"):
            raise PermissionError("privacy_mode_unavailable")
        return mode

    def state(self) -> dict:
        with self._connect() as conn:
            row = conn.execute("""SELECT display_id,consented,active,source_kind,consent_revision,
                provenance FROM context_capture_settings WHERE id=1""").fetchone()
            count = conn.execute("SELECT count(*) FROM context_observations").fetchone()[0]
        provenance = json.loads(row[5]) if row else {}
        return {"configured": bool(row), "authorized": bool(row and row[1]),
                "active": bool(row and row[2]), "record_count": count,
                "source_kind": row[3] if row else None, "consent_revision": row[4] if row else None,
                "provenance": provenance,
                "lock_protection_supported": provenance.get("lock_protection_supported"),
                "coverage": "dedicated_window_only" if row and row[3] == "public_window" else "full_screen"}

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
        generation = self._generation
        with self._connect() as conn:
            row = conn.execute("""SELECT display_id,consented,active,source_kind,consent_revision,provenance,last_capture_at,last_sampling_sequence
                FROM context_capture_settings WHERE id=1""").fetchone()
        allowed = bool(row and row[1] and row[2] and row[0] == observation.display_id
                       and row[3] == observation.source_kind
                       and observation.local_ocr_complete and observation.masks_applied)
        if observation.source_kind == "public_window":
            allowed = bool(allowed and observation.consent_revision == row[4]
                           and provenance_of(observation) == {"observation_mode": "vision", **json.loads(row[5])}
                           and datetime.fromisoformat(observation.session_expires_at.replace("Z", "+00:00")) > self._clock())
        self._guard.require(PrivacyRequest(action="capture", mode=self._mode(), authorized=allowed,
                                           paused=not bool(row and row[2])))
        raw = self._validate_png(observation.masked_png_base64)
        if observation.source_kind == "public_window":
            bounds = observation.source_identity.content_bounds
            with Image.open(BytesIO(raw)) as image:
                if image.size != (bounds.width, bounds.height):
                    raise ValueError("public_window_frame_dimensions_mismatch")
        digest = sha256(raw).hexdigest()
        if (observation.observation_mode == "masked_ocr_text"
                and observation.post_mask_ocr_image_digest != digest):
            raise ValueError("post_mask_ocr_evidence_mismatch")
        observed = observation.captured_at.astimezone(timezone.utc)
        now = self._clock()
        if (abs((now - observed).total_seconds()) > 300
                or (observation.source_kind == "public_window" and observed > now + timedelta(seconds=5))):
            raise ValueError("capture_time_out_of_range")
        if observation.source_kind == "public_window" and (
                (row[6] and observed <= datetime.fromisoformat(row[6]))
                or observation.sampling_sequence <= row[7]):
            raise ValueError("late_public_window_frame")
        if self._generation != generation or self._revocation_requested.is_set():
            raise PermissionError("capture_consent_revoked")
        with self._invalidation_lock:
            if self._generation != generation or self._revocation_requested.is_set():
                raise PermissionError("capture_consent_revoked")
            with self._connect() as conn:
                if observation.source_kind == "public_window":
                    conn.execute("""UPDATE context_capture_settings SET last_capture_at=?,last_sampling_sequence=?
                        WHERE id=1 AND consent_revision=?""", (observed.isoformat(), observation.sampling_sequence, row[4]))
                last = conn.execute("""SELECT id,image_digest,captured_at,provenance FROM context_observations
                    WHERE display_id=? AND source_kind=? AND consent_revision=?
                    ORDER BY captured_at DESC LIMIT 1""", (observation.display_id, observation.source_kind, row[4])).fetchone()
                if last and observation.source_kind == "public_window":
                    if (observed <= datetime.fromisoformat(last[2]) or observation.sampling_sequence
                            <= json.loads(last[3]).get("sampling_sequence", 0)):
                        raise ValueError("late_public_window_frame")
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
                        (id,captured_at,display_id,image_digest,evidence_id,expires_at,state,boundary,
                         source_kind,consent_revision,provenance,recorded_at,
                         post_mask_ocr_text,post_mask_ocr_image_digest,post_mask_ocr_engine,extraction_version)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,2)""",
                        (event_id, observed.isoformat(), observation.display_id, digest,
                         evidence_id, expires.isoformat(), "recorded_pending",
                         "仅根据授权时段内的隐私遮挡画面，尚未生成整理结论。",
                         observation.source_kind, row[4], json.dumps({**provenance_of(observation),
                            "sampling_sequence": observation.sampling_sequence,
                            "sampling_gap_ms": observation.sampling_gap_ms,
                            "source_verified_before": observation.source_verified_before,
                            "source_verified_after": observation.source_verified_after}), now.isoformat(),
                         observation.post_mask_ocr_text, observation.post_mask_ocr_image_digest,
                         observation.post_mask_ocr_engine))
            except Exception:
                temporary.unlink(missing_ok=True)
                target.unlink(missing_ok=True)
                raise
            return {"recorded": True, "duplicate": False, "id": event_id, "_generation": generation}

    @staticmethod
    def _public_record(row):
        result = dict(row)
        result["provenance"] = json.loads(result.get("provenance") or "{}")
        result["temporal_context"] = json.loads(result.get("temporal_context") or "{}")
        result["current_facts"] = json.loads(result.get("current_facts") or "{}") or None
        result["extraction_version"] = result.get("extraction_version", 1)
        result["source_label"] = "专用公开窗口" if result["source_kind"] == "public_window" else "本机记录"
        result["evidence_kind"] = "privacy_masked_captured_pixels"
        mode = result["provenance"].get("observation_mode", "vision")
        result["observation_mode"] = mode
        result["observation_route"] = ("post_mask_ocr_to_text_model" if mode == "masked_ocr_text"
                                       else "masked_image_to_vision_to_text")
        if mode == "masked_ocr_text":
            result["ocr_provenance"] = {"engine": result.get("post_mask_ocr_engine"), "stage": "post_mask",
                "image_digest": result.get("post_mask_ocr_image_digest"), "layout": "text_only_no_layout_guarantee"}
        return result

    def list_records(self, limit: int = 100) -> list[dict]:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("record_limit_out_of_range")
        with self._connect() as conn:
            rows = conn.execute("""SELECT id,captured_at,evidence_id,expires_at,state,title,summary,boundary,
                source_kind,consent_revision,provenance,recorded_at,temporal_context,processing_reason,
                post_mask_ocr_image_digest,post_mask_ocr_engine,extraction_version,current_facts
                FROM context_observations ORDER BY captured_at DESC LIMIT ?""", (limit,)).fetchall()
        keys = ("id", "captured_at", "evidence_id", "expires_at", "state", "title", "summary", "boundary",
                "source_kind", "consent_revision", "provenance", "recorded_at", "temporal_context", "processing_reason", "post_mask_ocr_image_digest", "post_mask_ocr_engine", "extraction_version", "current_facts")
        now = self._clock()
        results = []
        for row in rows:
            item = self._public_record(dict(zip(keys, row)))
            item["evidence_available"] = datetime.fromisoformat(item.pop("expires_at")) > now
            if not item["evidence_available"]:
                item["evidence_id"] = None
            results.append(item)
        return results

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
                title,summary,boundary,image_digest,source_kind,consent_revision,provenance,recorded_at,temporal_context,
                post_mask_ocr_image_digest,post_mask_ocr_engine,extraction_version,current_facts FROM context_observations
                WHERE julianday(captured_at)>=julianday(?)
                  AND julianday(captured_at)<julianday(?)""" + selected +
                " ORDER BY julianday(captured_at),id", parameters).fetchall()
        keys = ("id", "captured_at", "evidence_id", "expires_at", "state",
                "title", "summary", "boundary", "image_digest", "source_kind", "consent_revision", "provenance", "recorded_at", "temporal_context",
                "post_mask_ocr_image_digest", "post_mask_ocr_engine", "extraction_version", "current_facts")
        records = []
        for row in rows:
            try:
                observed = datetime.fromisoformat(row[1])
                if observed.tzinfo is not None and start <= observed < end:
                    records.append(self._public_record(dict(zip(keys, row))))
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
                   boundary: str | None = None, temporal_context: dict | None = None,
                   processing_reason: str | None = None, current_facts: dict | None = None) -> None:
        if state == "ready" and (not title or not summary or not boundary):
            raise ValueError("incomplete_result")
        with self._connect() as conn:
            cursor = conn.execute("""UPDATE context_observations
                SET state=?, title=?, summary=?, boundary=?, temporal_context=?, processing_reason=?,
                    current_facts=?,extraction_version=COALESCE(?,extraction_version)
                WHERE id=? AND state IN ('recorded_pending','processing')""",
                (state, title[:100] if title else None, summary[:500] if summary else None,
                 boundary or "已记录画面，但整理模型暂不可用；不能据此推断未记录时段的活动。",
                 json.dumps(temporal_context or {}), processing_reason, json.dumps(current_facts or {}),
                 2 if current_facts else (1 if state == "ready" else None), event_id))
            if cursor.rowcount != 1:
                raise ValueError("observation_not_pending")

    @synchronized
    def set_association_context(self, event_id, facts, context):
        """Only relation metadata can change after immutable extraction commit."""
        with self._connect() as conn:
            row = conn.execute("""SELECT current_facts,temporal_context FROM context_observations
                WHERE id=? AND state='ready' AND extraction_version=2""", (event_id,)).fetchone()
            if row is None or json.loads(row[0]) != facts:
                raise ValueError("current_facts_changed")
            before = json.loads(row[1]).get("association_state")
            after = context.get("association_state")
            if after not in {"pending": {"running", "skipped", "failed"},
                              "running": {"ready", "failed"}}.get(before, set()):
                raise ValueError("association_not_pending")
            cursor = conn.execute("""UPDATE context_observations SET temporal_context=?
                WHERE id=? AND state='ready' AND current_facts=? AND temporal_context=?""",
                (json.dumps(context), event_id, row[0], row[1]))
            if cursor.rowcount != 1:
                raise ValueError("current_facts_changed")

    @synchronized
    def fail_association(self, event_id, facts, reason):
        # Failure metadata may be written after revocation; no model-derived
        # relation or current-fact change can be published through this path.
        with self._connect() as conn:
            row = conn.execute("""SELECT current_facts,temporal_context FROM context_observations
                WHERE id=? AND state='ready' AND extraction_version=2""", (event_id,)).fetchone()
        if row is None or json.loads(row[0]) != facts:
            return False
        context = json.loads(row[1])
        if context.get("association_state") in ("pending", "running"):
            context.update(association_state="failed", association_reason=reason, relations=[])
            self.set_association_context(event_id, facts, context)
        return True

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
                WHERE id=? AND (state='model_unavailable' OR (state='recorded_pending' AND processing_reason='queue_full'))""", (event_id,)).fetchone()
        if not row or datetime.fromisoformat(row[1]) <= self._clock():
            return None
        image = self.evidence(row[0])
        if image is None:
            return None
        with self._connect() as conn:
            cursor = conn.execute("""UPDATE context_observations SET state='processing',processing_reason='running'
                WHERE id=? AND (state='model_unavailable' OR (state='recorded_pending' AND processing_reason='queue_full'))""", (event_id,))
            if cursor.rowcount != 1:
                return None
        return image

    @evidence_synchronized
    def open_processing_lease(self, snapshot, prior, generation_event):
        if self._processing_lease is not None:
            raise PermissionError("processing_busy")
        lease = ProcessingCancellation(generation_event, [snapshot, *prior], self._clock)
        self._processing_lease = lease
        return lease

    @evidence_synchronized
    def close_processing_lease(self, lease):
        if self._processing_lease is lease:
            self._processing_lease = None

    def _cancel_evidence_processing(self, evidence_id):
        # Called only while evidence ownership is serialized by _evidence_lock.
        lease = self._processing_lease
        if lease is not None and evidence_id in lease.evidence_ids:
            lease.cancel("evidence_changed")

    @synchronized
    def processing_ticket(self, event_id: str, *, generation=None, retry=False):
        if generation is not None and generation != self._generation:
            raise PermissionError("authorization_revoked")
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM context_observations WHERE id=?", (event_id,)).fetchone()
        if row is None:
            raise ValueError("record_or_evidence_unavailable")
        eligible = row["state"] == "recorded_pending" or (retry and row["state"] == "model_unavailable")
        if not eligible:
            raise ValueError("observation_not_pending")
        self.with_processing_consent(lambda: None, expected_revision=row["consent_revision"], require_active=True)
        if (datetime.fromisoformat(row["expires_at"]) <= self._clock()
                or self.owned_evidence_fingerprint(row["evidence_id"]) is None):
            raise ValueError("record_or_evidence_unavailable")
        return self._generation, self._processing_cancel

    @synchronized
    def mark_queued(self, event_id, generation, *, reason="queued", retry=False):
        self.processing_ticket(event_id, generation=generation, retry=retry)
        with self._invalidation_lock:
            if generation != self._generation or self._processing_cancel.is_set():
                raise PermissionError("authorization_revoked")
            with self._connect() as conn:
                conn.execute("""UPDATE context_observations SET state='recorded_pending',
                    processing_reason=? WHERE id=? AND state IN ('recorded_pending','model_unavailable')""",
                    (reason, event_id))

    @synchronized
    def begin_processing(self, event_id, generation):
        self.processing_ticket(event_id, generation=generation)
        with self._invalidation_lock:
            if generation != self._generation or self._processing_cancel.is_set():
                raise PermissionError("authorization_revoked")
            with self._connect() as conn:
                row = conn.execute("SELECT evidence_id FROM context_observations WHERE id=?", (event_id,)).fetchone()
                conn.execute("""UPDATE context_observations SET state='processing',processing_reason='running'
                    WHERE id=? AND state='recorded_pending'""", (event_id,))
            image = self.evidence(row[0])
            if image is None:
                raise ValueError("record_or_evidence_unavailable")
            return image

    @synchronized
    def cancel_pending(self, reason):
        with self._connect() as conn:
            conn.execute("""UPDATE context_observations SET state='model_unavailable', processing_reason=?
                WHERE state IN ('recorded_pending','processing')""", (reason,))
            _interrupt_associations(conn, reason)

    def processing_counts(self):
        with self._connect() as conn:
            return dict(conn.execute("""SELECT COALESCE(processing_reason,'not_queued'),count(*)
                FROM context_observations GROUP BY processing_reason""").fetchall())

    def with_processing_consent(self, operation, *, expected_revision=None, require_active=False):
        # Never retain capture ownership while awaiting model/policy/state locks.
        with self._lock:
            generation = self._generation
        def check():
            if self._revocation_requested.is_set() or self._generation != generation:
                raise PermissionError("capture_consent_revoked")
            with self._connect() as conn:
                row = conn.execute("""SELECT consented,active,consent_revision,provenance
                    FROM context_capture_settings WHERE id=1""").fetchone()
            if (not row or not row[0] or (require_active and not row[1])
                    or (expected_revision is not None and row[2] != expected_revision)):
                raise PermissionError("capture_consent_revoked")
            provenance = json.loads(row[3])
            if (require_active and provenance.get("source_kind") == "public_window"
                    and datetime.fromisoformat(provenance["session_expires_at"].replace("Z", "+00:00")) <= self._clock()):
                raise PermissionError("session_expired")
        with self._lock:
            check()
        result = operation()
        with self._lock, self._invalidation_lock:
            check()
            return result

    def processing_snapshot(self, event_id: str, image: bytes) -> dict:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM context_observations WHERE id=?", (event_id,)).fetchone()
        if row is None or row["state"] not in ("recorded_pending", "processing"):
            raise ValueError("observation_not_pending")
        result = self._public_record(row)
        if sha256(image).hexdigest() != result["image_digest"]:
            raise ValueError("evidence_changed")
        result["_fingerprint"] = self.owned_evidence_fingerprint(result["evidence_id"])
        self.verify_processing_snapshot(result)
        return result

    def verify_processing_snapshot(self, original):
        return self._verify_source_snapshot(original, states=("recorded_pending", "processing"))

    def verify_extracted_snapshot(self, original, facts):
        current = self._verify_source_snapshot(original, states=("ready",))
        if (current["extraction_version"] != 2 or current["current_facts"] != facts
                or any(current[key] != facts[key] for key in ("title", "summary", "boundary"))):
            raise ValueError("current_facts_changed")
        return current

    def _verify_source_snapshot(self, original, *, states):
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM context_observations WHERE id=?", (original["id"],)).fetchone()
        if row is None or row["state"] not in states:
            raise ValueError("evidence_changed")
        current = self._public_record(row)
        for key in ("captured_at", "source_kind", "consent_revision", "provenance", "image_digest", "evidence_id",
                    "post_mask_ocr_text", "post_mask_ocr_image_digest", "post_mask_ocr_engine"):
            if current[key] != original[key]:
                raise ValueError("evidence_changed")
        if (datetime.fromisoformat(row["expires_at"]) <= self._clock()
                or self.owned_evidence_fingerprint(row["evidence_id"]) is None
                or self.owned_evidence_fingerprint(row["evidence_id"]) != original.get("_fingerprint")):
            raise ValueError("evidence_changed")
        if current["observation_mode"] == "masked_ocr_text":
            text = current.get("post_mask_ocr_text")
            if (current["source_kind"] != "public_window" or current.get("post_mask_ocr_engine") != "tesseract.js"
                    or current.get("post_mask_ocr_image_digest") != current["image_digest"]
                    or not isinstance(text, str) or not text.strip() or len(text) > MAX_POST_MASK_OCR_CHARS
                    or len(text.encode("utf-8")) > MAX_POST_MASK_OCR_BYTES):
                raise ValueError("post_mask_ocr_evidence_mismatch")
        self.with_processing_consent(lambda: None, expected_revision=row["consent_revision"], require_active=True)
        return current

    def temporal_records(self, current) -> list[dict]:
        # Never enrich from other sources, revisions or private historical channels.
        if current["source_kind"] != "public_window":
            return []
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""SELECT * FROM context_observations
                WHERE source_kind=? AND consent_revision=? AND display_id=? AND state='ready'
                  AND captured_at<? ORDER BY captured_at DESC LIMIT 3""",
                (current["source_kind"], current["consent_revision"], current["display_id"], current["captured_at"])).fetchall()
        valid = []
        for raw in reversed(rows):
            row = self._public_record(raw)
            if (row["provenance"].get("source_revision") != current["provenance"].get("source_revision")
                    or row["provenance"].get("session_id") != current["provenance"].get("session_id")
                    or datetime.fromisoformat(row["expires_at"]) <= self._clock()
                    or self.owned_evidence_fingerprint(row["evidence_id"]) is None):
                continue
            if any(not isinstance(row[key], str) or not row[key].strip() or len(row[key]) > limit
                   or re.search(r"<\s*(?:think|analysis)\b", row[key], re.I)
                   for key, limit in (("title", 100), ("summary", 500), ("boundary", 300))):
                continue
            if row.get("extraction_version") == 2:
                facts = row.get("current_facts")
                if (not isinstance(facts, dict) or facts.get("version") != 2
                        or facts.get("observation_id") != row["id"] or facts.get("image_digest") != row["image_digest"]
                        or any(facts.get(key) != row[key] for key in ("title", "summary", "boundary"))):
                    continue
            fingerprint = self.owned_evidence_fingerprint(row["evidence_id"])
            evidence = self.evidence(row["evidence_id"])
            if (evidence is None or sha256(evidence).hexdigest() != row["image_digest"]
                    or self.owned_evidence_fingerprint(row["evidence_id"]) != fingerprint):
                continue
            row["_fingerprint"] = fingerprint
            valid.append(row)
        return valid

    def verify_temporal_records(self, records):
        for original in records:
            with self._connect() as conn:
                conn.row_factory = sqlite3.Row
                row = conn.execute("SELECT * FROM context_observations WHERE id=?", (original["id"],)).fetchone()
            if row is None:
                raise ValueError("temporal_context_changed")
            current = self._public_record(row)
            if (any(current.get(key) != value for key, value in original.items() if not key.startswith("_"))
                    or datetime.fromisoformat(current["expires_at"]) <= self._clock()
                    or self.owned_evidence_fingerprint(current["evidence_id"]) != original["_fingerprint"]):
                raise ValueError("temporal_context_changed")

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

    @evidence_synchronized
    def expire_owned(self) -> int:
        self._guard.require(PrivacyRequest(action="retention", mode=self._mode(),
                                           authorized=True, target_owned=True))
        now = self._clock().isoformat()
        with self._connect() as conn:
            rows = conn.execute("SELECT evidence_id FROM context_observations WHERE expires_at<=?",
                                (now,)).fetchall()
            for (evidence_id,) in rows:
                self._cancel_evidence_processing(evidence_id)
                target = self._media / f"{evidence_id}.png"
                if not target.is_symlink():
                    target.unlink(missing_ok=True)
            conn.execute("DELETE FROM context_observations WHERE expires_at<=?", (now,))
        return len(rows)

    @evidence_synchronized
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
            self._cancel_evidence_processing(row[0])
            target.unlink(missing_ok=True)
            conn.execute("DELETE FROM context_observations WHERE id=?", (event_id,))
            return True
