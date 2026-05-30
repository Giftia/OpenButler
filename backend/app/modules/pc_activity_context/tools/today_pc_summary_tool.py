from __future__ import annotations

from typing import Any


def render_today_pc_summary(summary: dict[str, Any]) -> str:
    metrics = summary.get("metrics", {})
    apps = summary.get("app_usage", {})
    app_text = "、".join(list(apps.keys())[:3]) or "暂无"
    return (
        f"记录显示今天 PC 活跃约 {metrics.get('total_pc_active_minutes', 0)} 分钟，"
        f"估计深度工作 {metrics.get('estimated_focus_minutes', 0)} 分钟，"
        f"上下文切换约 {metrics.get('estimated_context_switch_count', 0)} 次。"
        f"主要应用/类型：{app_text}。"
        "这些结论来自 OpenButler 已导入的 MineContext 本地活动记录；远程系统状态需要回源验证。"
    )
