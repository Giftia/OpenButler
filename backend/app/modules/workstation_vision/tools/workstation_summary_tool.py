from __future__ import annotations

from typing import Any


def render_summary_text(summary: dict[str, Any]) -> str:
    metrics = summary.get("metrics", {})
    present = metrics.get("total_present_minutes", 0)
    longest = metrics.get("longest_presence_minutes", 0)
    breaks = metrics.get("break_count", 0)
    fatigue = metrics.get("fatigue_signal_count", 0)
    return (
        f"你今天被本地视觉感知识别为在场约 {present} 分钟，最长连续在场 {longest} 分钟，"
        f"离座 {breaks} 次，疲劳提示 {fatigue} 次。"
        "这些数据来自本地视觉感知结构化事件，不代表医学结论。"
    )
