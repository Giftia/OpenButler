from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


def detect_presence(frame: dict[str, Any]) -> dict[str, Any]:
    person_count = int(frame.get("person_count", 1 if frame.get("face_detected") or frame.get("body_detected") else 0))
    if person_count > 1:
        return {
            "type": "presence_state",
            "state": "unknown",
            "confidence": 0.5,
            "reason_codes": ["multiple_people"],
            "evidence": {"person_count": person_count},
        }
    face = bool(frame.get("face_detected"))
    body = bool(frame.get("body_detected"))
    if face or body:
        confidence = 0.92 if face and body else 0.76
        state = "present"
    else:
        confidence = 0.88
        state = "away"
    return {
        "type": "presence_state",
        "state": state,
        "confidence": confidence,
        "reason_codes": [],
        "evidence": {"face_detected": face, "body_detected": body, "person_count": person_count},
    }


@dataclass
class DebouncedPresence:
    state: str = "unknown"
    candidate_state: str | None = None
    candidate_since: datetime | None = None
    debounce_seconds: int = 15

    def update(self, observed_state: str, timestamp: datetime) -> tuple[str, bool]:
        if observed_state == "unknown":
            return self.state, False
        if observed_state == self.state:
            self.candidate_state = None
            self.candidate_since = None
            return self.state, False
        if observed_state != self.candidate_state:
            self.candidate_state = observed_state
            self.candidate_since = timestamp
            return self.state, False
        assert self.candidate_since is not None
        elapsed = (timestamp - self.candidate_since).total_seconds()
        if elapsed >= self.debounce_seconds:
            self.state = observed_state
            self.candidate_state = None
            self.candidate_since = None
            return self.state, True
        return self.state, False

