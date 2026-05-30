from __future__ import annotations

from typing import Any


def estimate_attention(frame: dict[str, Any]) -> dict[str, Any]:
    objects = frame.get("objects", []) or []
    labels = {item.get("label"): float(item.get("confidence", 0)) for item in objects}
    head_pose = frame.get("head_pose", {}) or {}
    yaw = abs(float(head_pose.get("yaw", 0)))
    pitch = float(head_pose.get("pitch", 0))
    if labels.get("phone", 0) >= 0.6 and pitch < -5:
        metrics = {
            "screen_focus_ratio": 0.2,
            "desk_focus_ratio": 0.18,
            "phone_focus_ratio": 0.48,
            "off_screen_ratio": 0.06,
            "unknown_ratio": 0.08,
        }
        method = "head_pose_plus_phone_object"
        confidence = 0.68
    elif yaw <= 15 and "laptop" in labels:
        metrics = {
            "screen_focus_ratio": 0.68,
            "desk_focus_ratio": 0.14,
            "phone_focus_ratio": 0.09,
            "off_screen_ratio": 0.06,
            "unknown_ratio": 0.03,
        }
        method = "head_pose_plus_object_context"
        confidence = 0.71
    else:
        metrics = {
            "screen_focus_ratio": 0.25,
            "desk_focus_ratio": 0.1,
            "phone_focus_ratio": 0.05,
            "off_screen_ratio": 0.2,
            "unknown_ratio": 0.4,
        }
        method = "low_confidence_context"
        confidence = 0.48
    return {
        "type": "attention_heatmap",
        "state": None,
        "metrics": metrics,
        "confidence": confidence,
        "reason_codes": [],
        "evidence": {"sample_count": 1, "method": method},
    }

