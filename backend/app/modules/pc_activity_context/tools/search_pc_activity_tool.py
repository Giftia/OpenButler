from __future__ import annotations

from typing import Any


def render_search_result(result: dict[str, Any]) -> str:
    items = result.get("items") or []
    if not items:
        return f"MineContext 没有返回可确认命中。{result.get('evidence_boundary', '无法客观确认。')}"
    item = items[0]
    screenshots = "；".join(item.get("screenshot_paths") or []) or "无"
    return (
        f"匹配等级：{item.get('match_level')}，时间段：{item.get('started_at') or '未知'} 到 {item.get('ended_at') or '未知'}。"
        f"记录显示：{item.get('summary', '')} "
        f"source id：{item.get('source_id') or '无'}。截图证据路径：{screenshots}。"
        f"边界说明：{item.get('evidence_boundary', '')}"
    )
