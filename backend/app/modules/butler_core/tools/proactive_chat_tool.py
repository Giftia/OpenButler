from __future__ import annotations

from typing import Any

from app.modules.butler_core.service import ButlerCoreService


def render_proactive_butler_chat(message: str, butler: ButlerCoreService) -> str:
    if _is_feedback_message(message):
        return _record_feedback(message, butler)
    if _is_evening_review_message(message):
        return _render_evening_briefing(butler)
    if _is_context_recovery_message(message):
        return _render_context_recovery(butler)
    if _is_timeline_message(message):
        return _render_timeline_lookup(butler)
    if _is_evidence_message(message):
        return _render_evidence_explanation(butler)
    if _is_preference_message(message):
        return _render_preference_guidance()
    return _render_today_overview(butler)


def _compose_answer(
    *,
    conclusion: str,
    key_numbers: str | None,
    evidence: str,
    boundary: str,
    next_step: str,
) -> str:
    parts = [f"结论：{conclusion}"]
    if key_numbers:
        parts.append(f"关键数字：{key_numbers}")
    parts.extend(
        [
            f"依据：{evidence}",
            f"边界说明：{boundary}",
            f"下一步：{next_step}",
        ]
    )
    return "\n".join(parts)


def _is_feedback_message(message: str) -> bool:
    return any(keyword in message for keyword in ["建议不准确", "不准确", "以后少提醒", "少提醒", "太频繁"])


def _is_evening_review_message(message: str) -> bool:
    return any(keyword in message for keyword in ["晚间复盘", "今晚复盘", "生成复盘", "帮我复盘"])


def _is_context_recovery_message(message: str) -> bool:
    return any(keyword in message for keyword in ["开工恢复", "应该先做", "提醒我下一步", "现在该先做", "下一步"])


def _is_timeline_message(message: str) -> bool:
    return any(keyword in message for keyword in ["查看今日记录", "查时间线", "时间线", "今天记录"])


def _is_evidence_message(message: str) -> bool:
    return any(keyword in message for keyword in ["解释依据", "依据是什么", "为什么提醒", "提醒的依据"])


def _is_preference_message(message: str) -> bool:
    return any(keyword in message for keyword in ["修改偏好", "提醒偏好", "调整偏好"])


def _record_feedback(message: str, butler: ButlerCoreService) -> str:
    insight = _latest_actionable_insight(butler)
    if not insight:
        return _compose_answer(
            conclusion="现在没有可反馈的提醒，我不会临时编一个目标。",
            key_numbers=None,
            evidence="我只检查了当前待处理的管家提醒，没有找到可以记录反馈的卡片。",
            boundary="没有具体提醒时，反馈不会写入任何真实活动，也不会影响你的本地数据。",
            next_step="先生成今日提醒，或从收件箱里选择一条提醒再反馈。",
        )

    feedback_type = "inaccurate" if "不准确" in message else "too_frequent"
    label = "不准确" if feedback_type == "inaccurate" else "以后少提醒"
    updated = butler.submit_feedback(insight["id"], feedback_type, f"chat feedback: {label}")
    status_label = {
        "marked_inaccurate": "已记为不准确",
        "dismissed": "已处理",
        "snoozed": "稍后再看",
        "accepted": "已处理",
        "resolved": "已处理",
    }.get(str(updated.get("status")), "已记录")
    return _compose_answer(
        conclusion=f"已记录这条提醒的反馈：{label}。",
        key_numbers=f"1 条提醒已更新，当前状态是「{status_label}」。",
        evidence=f"反馈对象是「{insight['title']}」。同类提醒会在后续排序里下调优先级。",
        boundary=updated["evidence_boundary"],
        next_step="如果你还觉得它打扰，可以继续说“以后少提醒类似内容”。隐私和数据质量提醒不会被永久关闭。",
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
    return _compose_answer(
        conclusion=briefing["title"],
        key_numbers=(
            f"电脑活跃约 {metrics.get('pc_active_minutes', 0)} 分钟，"
            f"专注时段约 {metrics.get('focus_minutes', 0)} 分钟，"
            f"切换约 {metrics.get('context_switch_count', 0)} 次。"
        ),
        evidence="来自今天的本地时间线、今日量化和当前提醒。",
        boundary=briefing["evidence_boundary"],
        next_step="先看最靠前的提醒；涉及代码提交、部署或任务状态时，回到对应系统确认。",
    )


def _render_context_recovery(butler: ButlerCoreService) -> str:
    recovery = butler.context_recovery()
    briefing = recovery["briefing"]
    first_section = briefing["sections"][0]["items"]
    key_hint = "；".join(str(item) for item in first_section[:2]) if first_section else "暂无可恢复上下文"
    return _compose_answer(
        conclusion="可以先恢复最近的主要工作上下文。",
        key_numbers=f"已整理 {len(recovery.get('events', []))} 条本地时间线事件。",
        evidence=key_hint,
        boundary=recovery["evidence_boundary"],
        next_step="先打开时间线回到最近一段工作，再决定是否处理外部任务。",
    )


def _render_timeline_lookup(butler: ButlerCoreService) -> str:
    events = butler.today_timeline()[:5]
    if not events:
        return _compose_answer(
            conclusion="今天的时间线还没有足够记录。",
            key_numbers=None,
            evidence="我检查了今天的统一时间线，没有找到可以回看的事件。",
            boundary="没有数据时我不会补写记录，也不会用聊天记忆猜测你做了什么。",
            next_step="可以先看样例，或在本机环境里连接电脑活动后再回看。",
        )
    titles = "；".join(str(event.get("title") or "未命名事件") for event in events[:3])
    return _compose_answer(
        conclusion="今天的记录可以回看，先看最近几条就够。",
        key_numbers=f"当前可见 {len(events)} 条时间线记录。",
        evidence=f"最近记录包括：{titles}。",
        boundary=events[0].get("evidence_boundary") or "这些记录来自本地时间线整理，不能确认远程系统实时状态。",
        next_step="打开“时间线”查看完整事件；需要查远程状态时回到原系统确认。",
    )


def _render_evidence_explanation(butler: ButlerCoreService) -> str:
    insight = _latest_actionable_insight(butler)
    if not insight:
        return _compose_answer(
            conclusion="现在没有可解释的待处理提醒。",
            key_numbers=None,
            evidence="我检查了当前提醒队列，没有找到需要展开依据的卡片。",
            boundary="没有提醒时，我不会临时生成依据。",
            next_step="先生成今日提醒，或打开时间线查看已有记录。",
        )
    evidence_refs = insight.get("evidence_refs") or []
    return _compose_answer(
        conclusion=f"这条提醒的依据来自本地整理：{insight['title']}。",
        key_numbers=f"包含 {len(evidence_refs)} 条依据引用，可信度约 {round(float(insight.get('confidence', 0)) * 100)}%。",
        evidence="依据会显示来源、时间范围和可信度；普通页面不会展示本地截图路径或原始编号。",
        boundary=insight["evidence_boundary"],
        next_step="如果你觉得依据不对，可以标记“不准确”；如果只是太频繁，可以说“以后少提醒”。",
    )


def _render_preference_guidance() -> str:
    return _compose_answer(
        conclusion="提醒偏好可以调整，但我不会在没有确认时替你改设置。",
        key_numbers="当前对话只会记录明确反馈，例如“不准确”或“以后少提醒”。",
        evidence="偏好入口在“我的”页；具体提醒也可以在收件箱里处理。",
        boundary="本轮不会写入外部系统，也不会自动关闭隐私或数据质量提醒。",
        next_step="如果你只想降低某类提醒，直接说“以后少提醒类似内容”。",
    )


def _render_today_overview(butler: ButlerCoreService) -> str:
    home = butler.home()
    metrics = home["metrics"]
    if metrics.get("source_event_count", 0) == 0:
        return _compose_answer(
            conclusion="现在数据还不够，不能判断今天主要做了什么。",
            key_numbers=None,
            evidence="我检查了本地电脑活动和今日时间线，暂时没有足够事件。",
            boundary=home["overview"]["evidence_boundary"],
            next_step="先看样例，或在本机环境里连接电脑活动；连接前不会读取真实数据。",
        )
    return _compose_answer(
        conclusion=home["overview"]["headline"],
        key_numbers=(
            f"电脑活跃约 {metrics.get('pc_active_minutes', 0)} 分钟，"
            f"专注时段约 {metrics.get('focus_minutes', 0)} 分钟，"
            f"切换约 {metrics.get('context_switch_count', 0)} 次，"
            f"当前有 {len(home.get('insights', []))} 条提醒。"
        ),
        evidence="来自本地时间线、今日量化和当前提醒队列。",
        boundary=home["overview"]["evidence_boundary"],
        next_step="先处理最靠前的提醒；涉及远程仓库、部署或任务状态时，回到原系统确认。",
    )
