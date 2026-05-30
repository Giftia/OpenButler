from __future__ import annotations

from typing import Any


def render_query_result(result: dict[str, Any]) -> str:
    can = "可以作为较高置信度线索确认" if result.get("can_confirm") else "无法客观确认"
    activities = "、".join(result.get("activity_ids") or []) or "无"
    contexts = "、".join(result.get("context_ids") or []) or "无"
    screenshots = "；".join(result.get("screenshot_paths") or []) or "无"
    return (
        f"{can}：{result.get('summary', '')}\n"
        f"activity id：{activities}；context id：{contexts}。\n"
        f"截图证据路径：{screenshots}。\n"
        f"边界说明：{result.get('evidence_boundary', '')}"
    )
