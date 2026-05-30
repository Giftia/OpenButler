from __future__ import annotations

from typing import Any


def workflow_candidates(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    app_counts: dict[str, int] = {}
    for event in events:
        app = event.get("app_name") or event.get("activity_type") or "unknown"
        app_counts[str(app)] = app_counts.get(str(app), 0) + 1
    for app, count in sorted(app_counts.items(), key=lambda item: item[1], reverse=True):
        if count >= 2:
            candidates.append(
                {
                    "title": f"重复使用 {app} 的上下文恢复流程",
                    "occurrences": count,
                    "average_duration_minutes": 15,
                    "automation_fit": "OpenClaw 技能" if app in {"VS Code", "Chrome", "Xshell", "PowerShell"} else "OpenButler 工具",
                    "evidence_boundary": "候选来自 OpenButler 已导入的 MineContext 活动记录频次，尚未验证完整操作序列。",
                }
            )
    if events and not candidates:
        candidates.append(
            {
                "title": "今日 PC 操作复盘流程",
                "occurrences": len(events),
                "average_duration_minutes": 10,
                "automation_fit": "OpenButler 工具",
                "evidence_boundary": "当前样本不足以确认重复流程，只能作为弱建议。",
            }
        )
    return candidates[:5]
