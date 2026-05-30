# User-Facing Terminology

Date: 2026-05-30

OpenButler should keep technical names in code and developer docs, but ordinary pages should use product language.

| Internal term | User-facing term |
|---|---|
| MineContext | 电脑活动 / 本机观察 |
| godview | 本机回溯 |
| PC Activity | 电脑使用 |
| Proactive Butler Core | 主动管家 |
| Insight | 管家提醒 |
| InsightCard | 管家提醒 |
| Metric | 今日量化 |
| Evidence | 依据 |
| evidence_refs | 依据 |
| evidence_boundary | 边界说明 |
| UnifiedTimelineEvent | 时间线事件 |
| workflow candidate | 可自动化流程 |
| context switch | 切换较多 |
| focus block | 专注时段 |
| strict mode | 完全本地 |
| basic mode | 基础隐私 |
| OpenClaw Skill | OpenClaw 技能 |
| plugin | 技能插件 |
| Productization Harness | 产品化自检 |
| readiness | 可用状态 |

## Rules

- Ordinary pages should avoid class names, route names, and raw API field names.
- Evidence should be available but not shown by default.
- Use "依据" and "边界说明" instead of exposing raw `evidence_refs`.
- Use "电脑活动" when explaining the current main data source.
- Use "完全本地" when explaining strict privacy.
- Developer names can remain in advanced/lab pages when they are genuinely diagnostic.
