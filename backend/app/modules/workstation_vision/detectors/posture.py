from __future__ import annotations

from typing import Any


def detect_posture(frame: dict[str, Any]) -> dict[str, Any]:
    pose = frame.get("pose", {}) or {}
    head_pose = frame.get("head_pose", {}) or {}
    sitting = float(pose.get("sitting_probability", 0))
    standing = float(pose.get("standing_probability", 0))
    pitch = float(head_pose.get("pitch", 0))
    if not frame.get("body_detected") and not frame.get("face_detected"):
        state = "unknown"
        confidence = 0.45
    elif standing > 0.65 and standing > sitting:
        state = "standing"
        confidence = standing
    elif sitting > 0.55:
        state = "sitting"
        confidence = sitting
    else:
        state = "unknown"
        confidence = max(sitting, standing, 0.5)
    sub_state = "looking_down" if pitch < -18 else None
    return {
        "type": "posture_state",
        "state": state,
        "sub_state": sub_state,
        "confidence": min(confidence, 0.95),
        "reason_codes": ["looking_down"] if sub_state else [],
        "evidence": {"pose": pose, "head_pose": head_pose},
    }

