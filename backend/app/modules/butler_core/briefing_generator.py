from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .insight_engine import BOUNDARY


def generate_briefing(briefing_type: str, metrics: dict[str, Any], insights: list[dict[str, Any]], events: list[dict[str, Any]]) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    title_map = {
        "morning": "晨间开工上下文",
        "midday": "午间状态检查",
        "evening": "晚间复盘",
        "context_recovery": "开工上下文恢复包",
        "weekly_review": "周复盘",
    }
    sections = [
        {
            "title": "今日状态",
            "items": [
                f"PC 活跃约 {metrics.get('pc_active_minutes', 0)} 分钟",
                f"深度工作约 {metrics.get('focus_minutes', 0)} 分钟",
                f"上下文切换约 {metrics.get('context_switch_count', 0)} 次",
            ],
        },
        {
            "title": "主要线索",
            "items": [insight.get("summary", "") for insight in insights[:3]] or ["数据不足，暂不生成强结论。"],
        },
    ]
    return {
        "type": briefing_type,
        "title": title_map.get(briefing_type, "管家简报"),
        "sections": sections,
        "key_metrics": metrics,
        "top_insights": [insight.get("id") or insight.get("title") for insight in insights[:5]],
        "suggested_next_actions": [
            {"type": "context_recovery", "label": "恢复最近工作上下文"},
            {"type": "review_inbox", "label": "查看主动洞察 Inbox"},
        ],
        "evidence_refs": [{"kind": "timeline_event", "id": event.get("id")} for event in events[:10]],
        "evidence_boundary": BOUNDARY,
        "created_at": now.isoformat(),
        "period_start": events[-1].get("started_at") if events else now.isoformat(),
        "period_end": events[0].get("ended_at") or events[0].get("started_at") if events else now.isoformat(),
    }
