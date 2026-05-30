from __future__ import annotations

from typing import Any


def detect_fatigue(
    frame: dict[str, Any],
    continuous_present_minutes: float = 0,
    looking_down_minutes: float = 0,
) -> dict[str, Any]:
    lighting = frame.get("lighting", {}) or {}
    movement_score = float(frame.get("movement_score", 0.5))
    brightness = float(lighting.get("brightness", lighting.get("lux_proxy", 0.5)))
    reason_codes: list[str] = []
    if continuous_present_minutes >= 80:
        reason_codes.append("long_session")
    if looking_down_minutes >= 15:
        reason_codes.append("looking_down")
    if movement_score < 0.2:
        reason_codes.append("low_movement")
    if brightness < 0.25:
        reason_codes.append("low_light")
    severity = "low"
    if len(reason_codes) >= 3 or continuous_present_minutes >= 120:
        severity = "high"
    elif len(reason_codes) >= 2 or continuous_present_minutes >= 80:
        severity = "medium"
    suggestion = "当前没有明显疲劳提示。"
    if severity != "low":
        suggestion = "可能有疲劳迹象，建议短暂休息 3 到 5 分钟，活动肩颈并补充光照。"
    return {
        "type": "fatigue_signal",
        "state": severity,
        "severity": severity,
        "confidence": 0.66 if reason_codes else 0.54,
        "reason_codes": reason_codes,
        "suggestion": suggestion,
        "evidence": {
            "continuous_present_minutes": continuous_present_minutes,
            "looking_down_minutes": looking_down_minutes,
            "movement_score": movement_score,
            "brightness": brightness,
        },
    }

