# OpenClaw Integration

OpenButler exposes a base OpenClaw skill at `openclaw/SKILL.md` and a local-context skill declaration under `openclaw-skill/`.

## Vision Tools

- `get_workstation_status`: calls `GET /api/vision/status`.
- `get_today_workstation_summary`: calls `GET /api/vision/summary/today`.
- `get_workstation_fatigue_suggestions`: calls `GET /api/vision/fatigue`.
- `get_workstation_posture_suggestions`: calls `GET /api/vision/posture`.

OpenClaw callers must read `/api/privacy-mode` and `/api/vision/settings` before invoking tools. In strict mode, callers must not route frames, transcripts, derived events, or summaries to cloud models, external APIs, or external webhooks.

## PC Activity Tools

- `query_pc_activity_at_time`: calls `POST /api/pc-activity/minecontext/query-at-time`.
- `search_pc_activity_by_keyword`: calls `POST /api/pc-activity/minecontext/search`.
- `get_today_pc_activity_summary`: calls `GET /api/pc-activity/summary/today`.
- `get_pc_workflow_candidates`: calls `GET /api/pc-activity/workflow-candidates`.
- `get_context_recovery_pack`: calls `GET /api/butler/context-recovery`.

OpenClaw must call these tools for questions about historical PC actions. It must not answer from chat memory. Returned answers must include whether the action can be objectively confirmed, matching time ranges, activity/context ids when available, screenshot paths when available, and an evidence boundary. MineContext-derived context can show what was visible or done locally; remote system state still requires live source verification.

## Proactive Butler Tools

- `get_today_butler_overview`: calls `GET /api/butler/home`.
- `get_active_insights`: calls `GET /api/butler/insights`.
- `get_butler_briefing`: calls `POST /api/butler/briefings/generate`.
- `explain_insight_evidence`: reads the relevant `GET /api/butler/insights` card and its evidence fields.
- `submit_insight_feedback`: calls `POST /api/butler/insights/{insight_id}/feedback`.

OpenClaw must call OpenButler tools for questions about recent activity, today's main work, next actions, context recovery, and repeated workflow suggestions. It must keep the evidence boundary and avoid claiming remote deployment, Git, CI, Yunxiao, or API state as confirmed unless those source systems are checked live.

### Proactive Butler Examples

Request:

```json
{"tool": "get_today_butler_overview"}
```

Response shape:

```json
{
  "date": "2026-05-29",
  "overview": {
    "headline": "记录显示今天 PC 活跃约 214 分钟，深度工作约 96 分钟。",
    "evidence_boundary": "结论来自 MineContext PC 活动事件和 OpenButler 时间线聚合；不代表远程仓库、云效任务、部署或线上服务的实时状态。"
  },
  "metrics": {
    "pc_active_minutes": 214,
    "focus_minutes": 96,
    "context_switch_count": 38,
    "source_event_count": 14
  },
  "privacy": {
    "external_model_used": false,
    "system_notification_enabled": false
  }
}
```

Data-insufficient response shape:

```json
{
  "overview": {
    "headline": "当前 PC 活动数据不足，暂不生成强结论。"
  },
  "metrics": {
    "source_event_count": 0
  },
  "insights": [
    {"type": "data_quality_notice", "title": "PC 活动数据不足"}
  ],
  "suggested_next_actions": [
    {"type": "import_pc_activity", "label": "导入今日 PC 活动"}
  ]
}
```

Required data-insufficient wording:

```text
当前 PC 活动数据不足，无法客观判断。可以先导入今日 PC 活动，或检查 MineContext/godview 连接状态。
```
