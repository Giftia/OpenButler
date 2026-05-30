from __future__ import annotations

from typing import Any

from app.modules.butler_core.service import ButlerCoreService


def render_proactive_butler_chat(message: str, butler: ButlerCoreService) -> str:
    if _is_feedback_message(message):
        return _record_feedback(message, butler)
    if any(keyword in message for keyword in ["晚间复盘", "今晚复盘"]):
        return _render_evening_briefing(butler)
    if "开工恢复" in message or "应该先做" in message:
        return _render_context_recovery(butler)
    return _render_today_overview(butler)


def _is_feedback_message(message: str) -> bool:
    return any(keyword in message for keyword in ["建议不准确", "不准确", "以后少提醒", "少提醒", "太频繁"])


def _record_feedback(message: str, butler: ButlerCoreService) -> str:
    insight = _latest_actionable_insight(butler)
    if not insight:
        return (
            "当前没有可反馈的主动洞察卡片，我不会编造反馈目标。"
            "可以先生成今日洞察，再对具体建议标记有用、不准确或以后少提醒。"
        )

    feedback_type = "inaccurate" if "不准确" in message else "too_frequent"
    label = "不准确" if feedback_type == "inaccurate" else "以后少提醒"
    updated = butler.submit_feedback(insight["id"], feedback_type, f"chat feedback: {label}")
    return (
        f"已记录对「{insight['title']}」的反馈：{label}。"
        f"后续同类洞察会根据反馈降低优先级或被抑制。"
        f"当前状态：{updated['status']}。边界说明：{updated['evidence_boundary']}"
    )


def _latest_actionable_insight(butler: ButlerCoreService) -> dict[str, Any] | None:
    candidates = [
        insight
        for insight in butler.insights(status="new")
        if insight.get("type") != "data_quality_notice"
    ]
    if candidates:
        return candidates[0]
    fallback = [
        insight
        for insight in butler.insights()
        if insight.get("status") in {"new", "seen", "snoozed"} and insight.get("type") != "data_quality_notice"
    ]
    return fallback[0] if fallback else None


def _render_evening_briefing(butler: ButlerCoreService) -> str:
    briefing = butler.generate_briefing("evening")
    metrics = briefing.get("key_metrics", {})
    return (
        f"{briefing['title']}：记录显示今天 PC 活跃约 {metrics.get('pc_active_minutes', 0)} 分钟，"
        f"深度工作约 {metrics.get('focus_minutes', 0)} 分钟，上下文切换约 {metrics.get('context_switch_count', 0)} 次。"
        f"边界说明：{briefing['evidence_boundary']}"
    )


def _render_context_recovery(butler: ButlerCoreService) -> str:
    recovery = butler.context_recovery()
    briefing = recovery["briefing"]
    first_section = briefing["sections"][0]["items"]
    return (
        f"可以先恢复最近的主要工作上下文。我整理了 {len(recovery.get('events', []))} 条本地时间线事件。"
        f"{first_section[0]}，{first_section[1]}。"
        f"边界说明：{recovery['evidence_boundary']}"
    )


def _render_today_overview(butler: ButlerCoreService) -> str:
    home = butler.home()
    metrics = home["metrics"]
    if metrics.get("source_event_count", 0) == 0:
        return (
            "当前 PC 活动数据不足，无法客观判断今天主要做了什么。"
            "可以先导入今日 PC 活动，或检查 MineContext/godview 连接状态。"
            f"边界说明：{home['overview']['evidence_boundary']}"
        )
    return (
        f"{home['overview']['headline']} 关键数字：PC 活跃约 {metrics.get('pc_active_minutes', 0)} 分钟，"
        f"深度工作约 {metrics.get('focus_minutes', 0)} 分钟，上下文切换约 {metrics.get('context_switch_count', 0)} 次。"
        f"当前有 {len(home.get('insights', []))} 条主动洞察。边界说明：{home['overview']['evidence_boundary']}"
    )
