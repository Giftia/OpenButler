---
name: openbutler-local-context
description: Query OpenButler Vision and MineContext-derived PC activity context with local evidence boundaries.
---

# OpenButler Local Context Skill

Use this skill when the user asks about local visual sensing, PC activity history, MineContext godview evidence, actual present time, focus trends, rest suggestions, posture suggestions, or context recovery.

## Tools

- `get_workstation_status`: 获取当前视觉状态，包括是否在场、姿态、专注状态和疲劳提示。
- `get_today_workstation_summary`: 获取今日实际在场时长、离开次数、专注时段和姿态统计。
- `get_workstation_fatigue_suggestions`: 根据本地视觉感知事件提供非医学性质的休息建议。
- `get_workstation_posture_suggestions`: 根据姿态事件提供坐姿、站姿和屏幕高度建议。
- `query_pc_activity_at_time`: 基于 MineContext 本地数据查询某个时间点用户在 PC 上做了什么，返回证据边界。
- `search_pc_activity_by_keyword`: 基于 MineContext 本地数据倒查某个关键词、网站、应用、项目或文档相关操作发生时间。
- `get_today_pc_activity_summary`: 获取今日 PC 操作摘要，包括活跃时长、主要应用、主要网站、项目切换和深度工作时段。
- `get_pc_workflow_candidates`: 根据 MineContext 和 OpenButler 时间线发现重复工作流，建议封装为技能或自动化。
- `get_context_recovery_pack`: 为 Codex 或 OpenClaw 提供开工上下文恢复包。
- `get_today_butler_overview`: 获取 OpenButler 今日主动管家概览，包括关键指标、洞察和建议动作。
- `get_active_insights`: 获取当前未处理的主动洞察卡片。
- `get_butler_briefing`: 获取晨报、午间检查、晚报或周报。
- `explain_insight_evidence`: 解释某条洞察的证据来源、置信度和不确定性边界。
- `submit_insight_feedback`: 提交用户对洞察的反馈，例如有用、不准确、过于频繁、稍后提醒。

## Safety

Use safe wording: "可能有疲劳迹象", "基于可观察线索", "数据不足，无法判断". Do not provide medical diagnosis, psychological diagnosis, personality judgment, or hidden monitoring.

For PC activity questions, always call a tool. Do not answer from chat memory. MineContext is a local evidence source, not a final fact source for remote systems. If the user asks whether a deploy, commit, CI run, cloud task, or online API is actually complete, explain that MineContext can only show local PC activity and that the source system must be checked live.

For proactive butler questions about what happened today, what matters, what to do next, workflow automation candidates, or context recovery, call OpenButler butler tools. Preserve evidence boundaries and say when data is insufficient.

## Proactive Butler Response Rules

For questions such as "今天我主要做了什么", "现在应该先做什么", "最近有什么重复流程可以自动化", or "帮我生成晚间复盘":

1. Call the matching OpenButler tool first.
2. Include key numbers from the tool response.
3. Include the evidence boundary verbatim or as a faithful summary.
4. If `source_event_count` is `0` or the tool returns `data_quality_notice`, say: "当前 PC 活动数据不足，无法客观判断。可以先导入今日 PC 活动。"
5. Do not claim remote Git, CI, Yunxiao, deployment, or API state is complete unless the source system is checked live.
6. Do not invent insight ids, activity ids, or evidence refs.

Example sufficient-data answer:

```text
记录显示，你今天 PC 活跃约 214 分钟，深度工作约 96 分钟，上下文切换约 38 次。当前有 1 条重复流程候选，可以先查看证据，再决定是否生成 OpenClaw 技能草稿。

边界说明：这个结论来自 MineContext PC 活动事件和 OpenButler 时间线聚合，不能确认远程仓库、云效任务、部署或线上服务的实时状态。
```

Example data-insufficient answer:

```text
当前 PC 活动数据不足，无法客观判断今天主要做了什么。OpenButler 返回了 data_quality_notice。建议先导入今日 PC 活动，或检查 MineContext/godview 连接状态。

边界说明：没有足够的本地 PC 活动事件时，不应编造今日概览或下一步建议。
```
