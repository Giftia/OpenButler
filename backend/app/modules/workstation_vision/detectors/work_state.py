from __future__ import annotations

from typing import Any


def estimate_work_state(
    presence_state: str,
    posture_state: str,
    attention_metrics: dict[str, float],
    fatigue_signal: dict[str, Any],
) -> dict[str, Any]:
    if presence_state == "away":
        state = "away"
        confidence = 0.9
        reasons = ["not_present"]
    elif presence_state == "unknown":
        state = "unknown"
        confidence = 0.45
        reasons = ["low_confidence_presence"]
    elif fatigue_signal.get("severity") in {"medium", "high"}:
        state = "possibly_tired"
        confidence = 0.61
        reasons = fatigue_signal.get("reason_codes", [])
    elif attention_metrics.get("phone_focus_ratio", 0) > 0.35 or attention_metrics.get("off_screen_ratio", 0) > 0.25:
        state = "possibly_distracted"
        confidence = 0.58
        reasons = ["phone_or_off_screen_focus"]
    elif attention_metrics.get("screen_focus_ratio", 0) >= 0.6 and posture_state in {"sitting", "standing"}:
        state = "focused"
        confidence = 0.67
        reasons = ["screen_focus", "stable_posture"]
    else:
        state = "neutral"
        confidence = 0.55
        reasons = ["mixed_observable_signals"]
    return {
        "type": "observable_work_state",
        "state": state,
        "confidence": confidence,
        "reason_codes": reasons,
        "safe_text": safe_work_state_text(state),
    }


def safe_work_state_text(state: str) -> str:
    texts = {
        "focused": "当前状态估计为较专注。这个判断只基于本地摄像头画面中的可观察线索。",
        "neutral": "当前状态估计为中性，数据不足以给出更具体判断。",
        "possibly_tired": "可能有疲劳迹象，建议暂停 3 到 5 分钟。这个判断只基于本地摄像头画面中的可观察线索，不代表医学结论。",
        "possibly_distracted": "当前状态估计为可能分心，主要依据是手机或离屏相关可观察线索。",
        "away": "当前未检测到稳定在场信号。",
        "unknown": "数据不足，无法判断当前视觉状态。",
    }
    return texts.get(state, texts["unknown"])
