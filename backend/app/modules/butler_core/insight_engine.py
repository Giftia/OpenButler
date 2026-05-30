from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


BOUNDARY = "结论来自 MineContext PC 活动事件和 OpenButler 时间线聚合；不代表远程仓库、云效任务、部署或线上服务的实时状态。"
DEFAULT_PROTECTED_NOTICE_TYPES = {"data_quality_notice", "privacy_notice"}


def generate_rule_insights(
    metrics: dict[str, Any],
    events: list[dict[str, Any]],
    workflow_candidates: list[dict[str, Any]] | None = None,
    feedback_penalties: dict[str, dict[str, int]] | None = None,
    feedback_settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    feedback_penalties = feedback_penalties or {}
    feedback_settings = feedback_settings or {}
    now = datetime.now(timezone.utc)
    cards: list[dict[str, Any]] = []
    source_count = int(metrics.get("source_event_count") or 0)
    evidence_refs = [{"kind": "timeline_event", "id": event.get("id")} for event in events[:8]]
    if source_count == 0:
        cards.append(
            card(
                "data_quality_notice",
                "PC 活动数据不足",
                "目前还没有足够的 PC 活动事件生成可靠洞察。",
                "可以先在 PC 操作感知页导入今日 MineContext 活动，或检查 MineContext/godview 连接状态。",
                "info",
                80,
                0.3,
                {},
                evidence_refs,
                now,
            )
        )
        return apply_feedback_penalties(cards, feedback_penalties, feedback_settings)

    top_apps = ", ".join(item["name"] for item in metrics.get("top_apps", [])[:2]) or "本机应用"
    cards.append(
        card(
            "daily_overview",
            "今日主动概览",
            f"记录显示今天 PC 活跃约 {metrics.get('pc_active_minutes', 0)} 分钟，主要集中在 {top_apps}。",
            f"较稳定的深度工作约 {metrics.get('focus_minutes', 0)} 分钟，上下文切换约 {metrics.get('context_switch_count', 0)} 次。",
            "info",
            70,
            metrics.get("confidence", 0.7),
            metrics,
            evidence_refs,
            now,
        )
    )
    if metrics.get("focus_minutes", 0) > 0:
        cards.append(
            card(
                "focus_summary",
                "发现较稳定的深度工作段",
                f"今天已有约 {metrics.get('focus_minutes', 0)} 分钟较稳定的深度工作。",
                "这些时段主要来自较长的编码、文档或终端活动块。可以考虑在复盘中保留这类时间段。",
                "positive",
                65,
                0.78,
                {"focus_blocks": metrics.get("focus_blocks", [])},
                evidence_refs,
                now,
            )
        )
    if metrics.get("context_switch_windows"):
        window = metrics["context_switch_windows"][0]
        cards.append(
            card(
                "context_switch_warning",
                "上下文切换偏多",
                f"记录显示 {window.get('started_at')} 后约 30 分钟内出现 {window.get('switch_count')} 次上下文切换。",
                "这只是本地活动时间线的提示，不代表效率判断。可以考虑先恢复到最近的主要项目上下文。",
                "warning",
                60,
                0.66,
                window,
                evidence_refs,
                now,
            )
        )
    for workflow in (workflow_candidates or [])[:1]:
        cards.append(
            card(
                "workflow_candidate",
                "发现重复流程候选",
                str(workflow.get("title") or "有一个流程可能适合自动化"),
                f"出现次数约 {workflow.get('occurrences', 0)} 次。可以先生成 OpenClaw 技能或脚本草稿，执行前仍需你确认。",
                "suggestion",
                55,
                0.64,
                workflow,
                evidence_refs,
                now,
            )
        )
    if metrics.get("focus_minutes", 0) >= 90:
        cards.append(
            card(
                "achievement",
                "今天已有一段扎实工作积累",
                f"记录显示深度工作约 {metrics.get('focus_minutes', 0)} 分钟。",
                "这是基于本地活动时长的温和记录，不代表对产出结果的最终判断。",
                "positive",
                45,
                0.7,
                {"focus_minutes": metrics.get("focus_minutes", 0)},
                evidence_refs,
                now,
            )
        )
    return apply_feedback_penalties(cards, feedback_penalties, feedback_settings)


def card(
    insight_type: str,
    title: str,
    summary: str,
    detail: str,
    severity: str,
    priority: int,
    confidence: float,
    metrics: dict[str, Any],
    evidence_refs: list[dict[str, Any]],
    generated_at: datetime,
) -> dict[str, Any]:
    return {
        "type": insight_type,
        "title": title,
        "summary": summary,
        "detail": detail,
        "severity": severity,
        "priority": priority,
        "status": "new",
        "suggested_actions": suggested_actions_for(insight_type),
        "metrics": metrics,
        "evidence_refs": evidence_refs,
        "evidence_boundary": BOUNDARY,
        "confidence": confidence,
        "generated_by": "rule_engine",
        "generated_at": generated_at.isoformat(),
        "expires_at": (generated_at + timedelta(days=1)).isoformat(),
    }


def suggested_actions_for(insight_type: str) -> list[dict[str, Any]]:
    if insight_type == "workflow_candidate":
        return [{"type": "draft_skill", "label": "生成 OpenClaw 技能草稿"}]
    if insight_type == "context_switch_warning":
        return [{"type": "context_recovery", "label": "恢复最近工作上下文"}]
    if insight_type == "data_quality_notice":
        return [{"type": "import_pc_activity", "label": "导入今日 PC 活动"}]
    return [{"type": "review", "label": "查看证据"}]


def apply_feedback_penalties(
    cards: list[dict[str, Any]],
    penalties: dict[str, dict[str, int]],
    feedback_settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    feedback_settings = feedback_settings or {}
    reduce_after = int(feedback_settings.get("reduce_priority_after_dismiss_count") or 3)
    disable_after = int(feedback_settings.get("disable_type_after_inaccurate_count") or 3)
    too_frequent_reduction = int(feedback_settings.get("too_frequent_priority_reduction") or 10)
    too_frequent_cooldown = int(feedback_settings.get("too_frequent_cooldown_minutes") or 240)
    useful_boost = int(feedback_settings.get("useful_priority_boost") or 5)
    accepted_boost = int(feedback_settings.get("accepted_action_priority_boost") or 5)
    max_positive_boost = int(feedback_settings.get("max_positive_priority_boost") or 10)
    protected_types = set(feedback_settings.get("protected_notice_types") or DEFAULT_PROTECTED_NOTICE_TYPES)
    result: list[dict[str, Any]] = []
    for item in cards:
        signal = penalties.get(item["type"], {})
        dismiss_count = int(signal.get("dismiss_count") or 0)
        inaccurate_count = int(signal.get("inaccurate_count") or 0)
        too_frequent_count = int(signal.get("too_frequent_count") or 0)
        useful_count = int(signal.get("useful_count") or 0)
        accepted_count = int(signal.get("accepted_count") or 0)
        protected_notice = item["type"] in protected_types
        if inaccurate_count >= disable_after and not protected_notice:
            continue
        reduction_steps = dismiss_count // max(1, reduce_after)
        priority_reduction = reduction_steps * 10 + too_frequent_count * too_frequent_reduction
        priority_boost = min(max_positive_boost, useful_count * useful_boost + accepted_count * accepted_boost)
        if protected_notice and inaccurate_count >= disable_after:
            priority_reduction = min(priority_reduction, 10)
        item["priority"] = max(1, min(100, int(item["priority"]) - priority_reduction + priority_boost))
        if dismiss_count or inaccurate_count or too_frequent_count or useful_count or accepted_count:
            item["metrics"] = {
                **item.get("metrics", {}),
                "feedback_adjustment": {
                    "dismiss_count": dismiss_count,
                    "inaccurate_count": inaccurate_count,
                    "too_frequent_count": too_frequent_count,
                    "useful_count": useful_count,
                    "accepted_count": accepted_count,
                    "priority_reduction": priority_reduction,
                    "priority_boost": priority_boost,
                    "cooldown_minutes": too_frequent_cooldown if too_frequent_count else 0,
                    "protected_notice": protected_notice,
                    "suppressed": False,
                },
            }
        result.append(item)
    return result


def evaluate_feedback_noise_reduction(
    penalties: dict[str, dict[str, int]],
    feedback_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    feedback_settings = feedback_settings or {}
    reduce_after = int(feedback_settings.get("reduce_priority_after_dismiss_count") or 3)
    disable_after = int(feedback_settings.get("disable_type_after_inaccurate_count") or 3)
    too_frequent_reduction = int(feedback_settings.get("too_frequent_priority_reduction") or 10)
    too_frequent_cooldown = int(feedback_settings.get("too_frequent_cooldown_minutes") or 240)
    useful_boost = int(feedback_settings.get("useful_priority_boost") or 5)
    accepted_boost = int(feedback_settings.get("accepted_action_priority_boost") or 5)
    max_positive_boost = int(feedback_settings.get("max_positive_priority_boost") or 10)
    protected_types = set(feedback_settings.get("protected_notice_types") or DEFAULT_PROTECTED_NOTICE_TYPES)
    evaluations: list[dict[str, Any]] = []
    for insight_type, signal in sorted(penalties.items()):
        dismiss_count = int(signal.get("dismiss_count") or 0)
        inaccurate_count = int(signal.get("inaccurate_count") or 0)
        too_frequent_count = int(signal.get("too_frequent_count") or 0)
        useful_count = int(signal.get("useful_count") or 0)
        accepted_count = int(signal.get("accepted_count") or 0)
        protected_notice = insight_type in protected_types
        suppression_recommended = inaccurate_count >= disable_after and not protected_notice
        priority_reduction = (dismiss_count // max(1, reduce_after)) * 10 + too_frequent_count * too_frequent_reduction
        priority_boost = min(max_positive_boost, useful_count * useful_boost + accepted_count * accepted_boost)
        if protected_notice and inaccurate_count >= disable_after:
            priority_reduction = min(priority_reduction, 10)
        evaluations.append(
            {
                "insight_type": insight_type,
                "dismiss_count": dismiss_count,
                "inaccurate_count": inaccurate_count,
                "too_frequent_count": too_frequent_count,
                "useful_count": useful_count,
                "accepted_count": accepted_count,
                "priority_delta": priority_boost - priority_reduction,
                "cooldown_minutes": too_frequent_cooldown if too_frequent_count else 0,
                "suppression_recommended": suppression_recommended,
                "protected_notice": protected_notice,
                "reason_codes": [
                    code
                    for code, enabled in [
                        ("dismissed_often", dismiss_count >= reduce_after),
                        ("marked_inaccurate", inaccurate_count >= disable_after),
                        ("too_frequent", too_frequent_count > 0),
                        ("positive_feedback", useful_count + accepted_count > 0),
                        ("protected_notice_not_suppressed", protected_notice and inaccurate_count >= disable_after),
                    ]
                    if enabled
                ],
            }
        )
    return {
        "schema_version": "insight_noise_reduction_evaluation_v1",
        "evaluations": evaluations,
        "count": len(evaluations),
        "policy": {
            "reduce_priority_after_dismiss_count": reduce_after,
            "disable_type_after_inaccurate_count": disable_after,
            "too_frequent_priority_reduction": too_frequent_reduction,
            "too_frequent_cooldown_minutes": too_frequent_cooldown,
            "max_positive_priority_boost": max_positive_boost,
            "protected_notice_types": sorted(protected_types),
        },
        "privacy": {
            "external_model_used": False,
            "external_webhook_used": False,
            "system_notification_sent": False,
        },
        "evidence_boundary": BOUNDARY,
    }
