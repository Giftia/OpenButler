from __future__ import annotations

from typing import Any


def render_status_text(status: dict[str, Any]) -> str:
    current = status.get("current", {})
    return (
        f"当前视觉状态估计为 {current.get('presence', 'unknown')}，"
        f"姿态为 {current.get('posture', 'unknown')}，"
        f"专注状态为 {current.get('work_state', 'unknown')}。"
        "这些判断只基于本地摄像头的可观察线索。"
    )
